import { ShopifyService } from '../../src/shopify/shopify.service';
import { mergeShopifyItems } from '../../src/shopify/shopify-item-merge.util';
import mongoose from 'mongoose';
import { ShopifyOrder, ShopifyOrderSchema } from '../../src/shopify/schemas/shopify-order.schema';

const row = (code: string, qty = 1, price = 100) => ({ productId: 'p-' + code, code, name: code, qty, price, total: qty * price });
const line = (code: string, qty = 1) => ({ sku: code, title: code, quantity: qty, current_quantity: qty, price: '100' });
const payload = (lines: any[]) => ({ id: 111, line_items: lines, shipping_lines: [{ price: '50' }], total_discounts: '0' });
function fixture() {
  const order: any = { _id: 'o1', shopifyId: '111', ref: '2771', status: 'pending', items: [row('A')],
    itemsTotal: 100, total: 150, shipCost: 50, discount: 0, manualDiscount: 0,
    rawData: payload([line('A')]), editHistory: [], depositReceipts: [], save: jest.fn(async () => {}), markModified: jest.fn() };
  const service: any = Object.create(ShopifyService.prototype);
  service.shopifyOrderModel = { findById: jest.fn(async () => order), findOne: jest.fn(async () => order) };
  service.productModel = { findOne: ({ code }: any) => ({ lean: async () => ({ _id: 'p-' + code, name: code, sellPrice: 100 }) }) };
  service.txModel = { findOne: () => ({ select: () => ({ lean: async () => null }) }), updateOne: jest.fn(async () => ({})) };
  service.employeeScoringService = { scoreDepositDetection: jest.fn(async () => {}) };
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  service.presence = { emitEvent: jest.fn() };
  return { service, order };
}
describe('Local item edits survive Shopify updates', () => {
  it('tracks the first remote baseline and keeps locally added products on unrelated Shopify updates', async () => {
    const { service, order } = fixture();
    await service.updateOrderItems('o1', [row('A'), row('C')], 'Staff');
    expect(order.localItemsBaseline.map((i: any) => i.code)).toEqual(['A']);
    await service.handleOrderUpdate({ ...payload([line('A')]), note: 'phone call' });
    expect(order.items.map((i: any) => i.code)).toEqual(['A', 'C']);
    expect(order.total).toBe(250);
    expect(order.itemSyncConflict).toBeNull();
    expect(order.notes).toBe('phone call');
  });
  it('merges Shopify additions and deletions independently of a local addition', async () => {
    const { service, order } = fixture();
    await service.updateOrderItems('o1', [row('A'), row('C')]);
    await service.handleOrderUpdate(payload([line('A', 0), line('B')]));
    expect(order.items.map((i: any) => i.code)).toEqual(['C', 'B']);
    expect(order.total).toBe(250);
    expect(order.itemSyncConflict).toBeNull();
  });
  it('preserves local deletions, prices and quantities when those Shopify rows did not change', async () => {
    const { service, order } = fixture();
    order.items = [row('A'), row('B')]; order.rawData = payload([line('A'), line('B')]);
    await service.updateOrderItems('o1', [row('A', 2, 75)]);
    await service.handleOrderUpdate(payload([line('A'), line('B'), line('D')]));
    expect(order.items).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'A', qty: 2, price: 75 }), expect.objectContaining({ code: 'D' })]));
    expect(order.items.find((i: any) => i.code === 'B')).toBeUndefined();
    expect(order.total).toBe(300);
  });
  it('holds conflicting edits without erasing local changes, including on repeated webhook delivery', async () => {
    const { service, order } = fixture();
    await service.updateOrderItems('o1', [row('A', 2), row('C')]);
    await service.handleOrderUpdate(payload([line('A', 3)]));
    expect(order.items.find((i: any) => i.code === 'A').qty).toBe(2);
    expect(order.itemSyncConflict).toMatchObject({ conflictingKeys: ['product:p-A'], shopifyItems: [expect.objectContaining({ qty: 3 })] });
    const revision = order.itemSyncConflict.revision;
    await service.handleOrderUpdate({ ...payload([line('A', 3)]), tags: 'VIP' });
    expect(order.itemSyncConflict.revision).toBe(revision);
    expect(order.items.find((i: any) => i.code === 'A').qty).toBe(2);
  });
  it.each(['local', 'shopify'])('resolves the conflicting product using %s and preserves unrelated local additions', async source => {
    const { service, order } = fixture();
    await service.updateOrderItems('o1', [row('A', 2), row('C')]);
    await service.handleOrderUpdate(payload([line('A', 3)]));
    const revision = order.itemSyncConflict.revision;
    await service.resolveItemSyncConflict('o1', source, revision, 'Reviewer');
    expect(order.itemSyncConflict).toBeNull();
    expect(order.items.find((i: any) => i.code === 'A').qty).toBe(source === 'local' ? 2 : 3);
    expect(order.items.find((i: any) => i.code === 'C').qty).toBe(1);
    await service.handleOrderUpdate(payload([line('A', 3)]));
    expect(order.itemSyncConflict).toBeNull();
    expect(order.items.find((i: any) => i.code === 'C')).toBeDefined();
  });
  it('rejects outdated conflict decisions and decisions on confirmed orders', async () => {
    const { service, order } = fixture();
    await service.updateOrderItems('o1', [row('A', 2)]);
    await service.handleOrderUpdate(payload([line('A', 3)]));
    await expect(service.resolveItemSyncConflict('o1', 'shopify', 'old-revision')).rejects.toThrow('تغيّرت حالة التعارض');
    expect(order.items[0].qty).toBe(2);
    order.status = 'approved';
    await expect(service.resolveItemSyncConflict('o1', 'shopify', order.itemSyncConflict.revision)).rejects.toThrow('معلق');
  });
  it('protects existing manual edits recorded before explicit baseline tracking was added', async () => {
    const { service, order } = fixture();
    order.items = [row('A'), row('C')];
    order.editHistory = [{ action: 'تعديل الأصناف', after: { items: [row('A'), row('C')] } }];
    await service.handleOrderUpdate(payload([line('A'), line('B')]));
    expect(order.items.map((i: any) => i.code)).toEqual(['A', 'C', 'B']);
  });
  it('automatically clears a conflict when Shopify converges to the chosen local rows', async () => {
    const { service, order } = fixture();
    await service.updateOrderItems('o1', [row('A', 2)]);
    await service.handleOrderUpdate(payload([line('A', 3)]));
    await service.handleOrderUpdate(payload([line('A', 2)]));
    expect(order.itemSyncConflict).toBeNull();
    expect(order.items[0].qty).toBe(2);
  });
  it('keeps duplicate rows for the same product instead of collapsing their quantities', () => {
    const base = [row('A'), row('A', 2)];
    const result = mergeShopifyItems(base, [...base, row('C')], [...base, row('B')]);
    expect(result.items.filter(i => i.code === 'A').map(i => i.qty)).toEqual([1, 2]);
    expect(result.conflictingKeys).toEqual([]);
  });
  it('does not confirm an unresolved item conflict into financial records', async () => {
    const { service, order } = fixture();
    await service.updateOrderItems('o1', [row('A', 2)]);
    await service.handleOrderUpdate(payload([line('A', 3)]));
    await expect(service.approveOrder('o1', 'Reviewer')).rejects.toThrow('راجع تعارض');
    expect(order.status).toBe('pending');
  });
  it('detects stale decisions even when remote changes share the same timestamp', async () => {
    const { service, order } = fixture();
    await service.updateOrderItems('o1', [row('A', 2)]);
    await service.handleOrderUpdate(payload([line('A', 3)]));
    const revision = order.itemSyncConflict.revision;
    await service.handleOrderUpdate(payload([line('A', 4)]));
    expect(order.itemSyncConflict.revision).not.toBe(revision);
    await expect(service.resolveItemSyncConflict('o1', 'shopify', revision)).rejects.toThrow('تغيّرت حالة التعارض');
  });
  it('persists the baseline and conflict through real MongoDB reloads and later webhook delivery', async () => {
    const dbName = `soulia_test_item_merge_${process.pid}_${Date.now()}`;
    const connection = await mongoose.createConnection(`mongodb://localhost:27017/${dbName}`, { serverSelectionTimeoutMS: 3000 }).asPromise();
    try {
      const model = connection.model(ShopifyOrder.name, ShopifyOrderSchema);
      const doc = await model.create({ shopifyId: '111', ref: '2771', status: 'pending', items: [row('A')],
        itemsTotal: 100, total: 150, shipCost: 50, rawData: payload([line('A')]) });
      const { service } = fixture();
      service.shopifyOrderModel = model;
      await service.updateOrderItems(String(doc._id), [row('A', 2), row('C')]);
      expect((await model.findById(doc._id).lean())?.localItemsBaseline?.[0].qty).toBe(1);
      await service.handleOrderUpdate(payload([line('A', 3), line('B')]));
      const saved = await model.findById(doc._id).lean();
      expect(saved?.items.find((i: any) => i.code === 'A')?.qty).toBe(2);
      expect(saved?.items.find((i: any) => i.code === 'C')).toBeDefined();
      expect(saved?.items.find((i: any) => i.code === 'B')).toBeDefined();
      expect(saved?.itemSyncConflict?.conflictingKeys).toEqual(['product:p-A']);
      await service.resolveItemSyncConflict(String(doc._id), 'local', saved!.itemSyncConflict!.revision, 'Reviewer');
      await service.handleOrderUpdate(payload([line('A', 3), line('B')]));
      const final = await model.findById(doc._id).lean();
      expect(final?.itemSyncConflict).toBeNull();
      expect(final?.items.find((i: any) => i.code === 'A')?.qty).toBe(2);
    } finally {
      if (!/^soulia_test_item_merge_\d+_\d+$/.test(connection.name)) throw new Error('Unexpected scratch database');
      await connection.dropDatabase(); await connection.close();
    }
  }, 15000);
});
