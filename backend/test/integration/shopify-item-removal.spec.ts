import { ShopifyService } from '../../src/shopify/shopify.service';
import { shopifyLineQuantity } from '../../src/shopify/shopify-line-quantity.util';

function line(sku: string, quantity: number, current_quantity?: number) {
  return { sku, title: sku, price: '100', quantity, ...(current_quantity === undefined ? {} : { current_quantity }) };
}
function fixture(status = 'pending') {
  const service: any = Object.create(ShopifyService.prototype);
  const order: any = { _id: 'order-1', shopifyId: '111', ref: '2771', status,
    items: [{ productId: 'p-A', code: 'A', name: 'A', qty: 2, price: 100, total: 200 }],
    itemsTotal: 200, total: 250, shipCost: 50, discount: 0, depositReceipts: [],
    rawData: { id: 111, line_items: [line('A', 2)] }, save: jest.fn(async () => {}) };
  service.productModel = { findOne: jest.fn(({ code }) => ({ lean: async () => ({ _id: 'p-' + code, name: code, sellPrice: 100 }) })) };
  service.shopifyOrderModel = { findOne: jest.fn(async () => order) };
  service.txModel = { findOne: () => ({ select: () => ({ lean: async () => null }) }), updateOne: jest.fn(async () => ({})) };
  service.employeeScoringService = { scoreDepositDetection: jest.fn(async () => {}) };
  service.presence = { emitEvent: jest.fn() };
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, order };
}
function payload(lines: any[]) { return { id: 111, line_items: lines, shipping_lines: [{ price: '50' }], total_discounts: '0' }; }

describe('Shopify current quantities and removed products', () => {
  it('removes zero-current-quantity lines, keeps added lines and recalculates the pending order', async () => {
    const { service, order } = fixture();
    expect(await service.handleOrderUpdate(payload([line('A', 2, 0), line('B', 1, 1)]))).toEqual({ updated: true });
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({ code: 'B', qty: 1, total: 100 });
    expect(order.itemsTotal).toBe(100);
    expect(order.total).toBe(150);
    expect(service.productModel.findOne).not.toHaveBeenCalledWith({ code: 'A' });
    expect(service.presence.emitEvent).toHaveBeenCalledWith('shopify:items-changed', { shopifyOrderId: '111', ref: '2771' });
  });
  it('uses reduced current quantity rather than historical quantity', async () => {
    const { service, order } = fixture();
    await service.handleOrderUpdate(payload([line('A', 2, 1)]));
    expect(order.items[0]).toMatchObject({ qty: 1, total: 100 });
    expect(order.total).toBe(150);
  });
  it('allows all lines to be removed without recreating a quantity of one', async () => {
    const { service, order } = fixture();
    await service.handleOrderUpdate(payload([line('A', 2, 0)]));
    expect(order.items).toEqual([]);
    expect(order.itemsTotal).toBe(0);
    expect(order.total).toBe(50);
  });
  it('supports older payloads and explicit zero quantity without current_quantity', async () => {
    const { service } = fixture();
    const mapped = await service.mapItems([line('A', 2), line('B', 0)]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ code: 'A', qty: 2, total: 200 });
  });
  it('keeps fully fulfilled products whose fulfillable quantity is zero', async () => {
    const { service } = fixture();
    const mapped = await service.mapItems([{ ...line('A', 2, 2), fulfillable_quantity: 0 }]);
    expect(mapped[0].qty).toBe(2);
  });
  it('preserves local prices and the saved manual discount after removing a line', async () => {
    const { service, order } = fixture();
    order.manualDiscount = 20;
    await service.handleOrderUpdate(payload([line('A', 2, 0), { ...line('B', 1, 1), price: '999' }]));
    expect(order.items[0].price).toBe(100);
    expect(order.manualDiscount).toBe(20);
    expect(order.total).toBe(130);
  });
  it('repeated identical updates do not repeat the item-change event', async () => {
    const { service } = fixture();
    const data = payload([line('A', 2, 0), line('B', 1, 1)]);
    await service.handleOrderUpdate(data);
    service.presence.emitEvent.mockClear();
    await service.handleOrderUpdate(data);
    expect(service.presence.emitEvent).not.toHaveBeenCalledWith('shopify:items-changed', expect.anything());
  });
  it('retains confirmed financial records and reports a value conflict for removal', async () => {
    const { service, order } = fixture('approved');
    await service.handleOrderUpdate(payload([line('A', 2, 0)]));
    expect(order.items[0].qty).toBe(2);
    expect(order.total).toBe(250);
    expect(order.valueChangeConflict).toMatchObject({ oldTotal: 250, newTotal: 50, newItemsCount: 0, resolved: false });
    expect(service.txModel.updateOne.mock.calls[0][1].$set.items).toBeUndefined();
  });
  it.each([{ quantity: 3, current_quantity: 0 }, { quantity: 0 }, { quantity: -1 }, { quantity: 'bad' }])('does not manufacture a product quantity from %j', item => {
    expect(shopifyLineQuantity(item)).toBe(0);
  });
});
