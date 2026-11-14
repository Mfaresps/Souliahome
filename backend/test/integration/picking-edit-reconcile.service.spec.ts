/**
 * An order edited while it is being prepared, on a real (scratch) MongoDB with the real piece models.
 * Owner's scenario: 4 products, product A scanned, the rest not yet; then A is removed from the order.
 * Run with: TEST_MONGODB_URI=mongodb://127.0.0.1:27018/soulia_test_prep_edit?replicaSet=souliaDev npx jest picking-edit-reconcile.service
 */
import mongoose, { Types } from 'mongoose';
import { InventoryUnitSchema } from '../../src/inventory-units/schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from '../../src/inventory-units/schemas/inventory-unit-event.schema';
import { reconcilePickingAfterEdit } from '../../src/inventory-units/picking-edit-reconcile';

export {};
const URI = process.env.TEST_MONGODB_URI || `mongodb://127.0.0.1:27018/soulia_test_prep_edit_${process.pid}?replicaSet=souliaDev`;
jest.setTimeout(60000);

describe('reconcilePickingAfterEdit (real Mongo)', () => {
  let conn: mongoose.Connection;
  const user = new Types.ObjectId(), sale = new Types.ObjectId();
  const products = ['A', 'B', 'C', 'D'].map(code => ({ _id: new Types.ObjectId(), code, name: 'Basket ' + code }));
  const lines = products.map((p, i) => ({ lineId: 'l' + p.code, code: p.code, name: p.name, qty: i === 1 ? 2 : 1, price: 100 }));

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI).asPromise();
    conn.model('InventoryUnit', InventoryUnitSchema);
    conn.model('InventoryUnitEvent', InventoryUnitEventSchema);
  });
  afterAll(async () => { await conn.dropDatabase(); await conn.close(); });

  async function seed() {
    await conn.dropDatabase();
    await conn.collection('users').insertOne({ _id: user, name: 'Mona', username: 'mona', isActive: true });
    await conn.collection('products').insertMany(products.map(p => ({ ...p, unitTrackingRevision: 0 })));
    await conn.collection('transactions').insertOne({ _id: sale, type: 'مبيعات', ref: '8401', pickupStatus: 'Preparing',
      prepChecked: false, items: lines, pickingExceptions: [], unitTrackingRevision: 3 });
    const Unit = conn.model('InventoryUnit');
    const scanned = await Unit.create({ productId: String(products[0]._id), status: 'picking', origin: { kind: 'legacy-unknown', reconciliationRef: 'TEST-REC-1' },
      assignment: { transactionId: String(sale), lineId: 'lA' }, registeredByUserId: String(user), registeredBy: 'Mona' });
    await conn.collection('inventoryunitcodes').insertOne({ _id: scanned._id, code: '000000017' });
    const other = await Unit.create({ productId: String(products[1]._id), status: 'picking', origin: { kind: 'legacy-unknown', reconciliationRef: 'TEST-REC-1' },
      assignment: { transactionId: String(sale), lineId: 'lB' }, registeredByUserId: String(user), registeredBy: 'Mona' });
    return { scanned, other };
  }

  it('removing the scanned product puts its piece back, names it, and leaves the other pieces alone', async () => {
    const { scanned, other } = await seed();
    const before = lines;
    await conn.collection('transactions').updateOne({ _id: sale }, { $set: { items: lines.filter(l => l.code !== 'A') } });
    const notice: any = await reconcilePickingAfterEdit(conn, String(sale), before, 'Mona', String(user));
    expect(notice.removed).toEqual([{ code: 'A', name: 'Basket A', qty: 1 }]);
    expect(notice.released).toEqual([expect.objectContaining({ unitId: String(scanned._id), manualCode: 'U-0000-0001-7', code: 'A' })]);

    const units = conn.collection('inventoryunits');
    expect(await units.findOne({ _id: scanned._id })).toMatchObject({ status: 'available', assignment: null });
    expect(await units.findOne({ _id: other._id })).toMatchObject({ status: 'picking', assignment: { lineId: 'lB' } });
    const event: any = await conn.collection('inventoryunitevents').findOne({ unitId: String(scanned._id) });
    expect(event).toMatchObject({ action: 'picking-undone', fromStatus: 'picking', toStatus: 'available', byUserId: String(user), lineId: 'lA' });

    const tx: any = await conn.collection('transactions').findOne({ _id: sale });
    expect(tx.prepEditNotice.id).toBe(notice.id);
    expect(tx.unitTrackingRevision).toBe(4);
    expect(tx.pickupHistory.at(-1)).toMatchObject({ action: 'edit-during-prep', released: 1, removed: 1 });
    expect((await conn.collection('products').findOne({ _id: products[0]._id }))!.unitTrackingRevision).toBe(1);
  });

  it('an edit that changes no item is not a preparation event', async () => {
    await seed();
    expect(await reconcilePickingAfterEdit(conn, String(sale), lines, 'Mona', String(user))).toBeNull();
    const tx: any = await conn.collection('transactions').findOne({ _id: sale });
    expect(tx.prepEditNotice).toBeUndefined();
    expect(tx.unitTrackingRevision).toBe(3);
  });

  it('a prepared order loses «prepared» when its lines are no longer covered', async () => {
    const { scanned } = await seed();
    await conn.collection('transactions').updateOne({ _id: sale }, { $set: { prepChecked: true, items: [...lines, { lineId: 'lE', code: 'E', name: 'New', qty: 1 }] } });
    const notice: any = await reconcilePickingAfterEdit(conn, String(sale), lines, 'Mona', String(user));
    expect(notice.added).toEqual([{ code: 'E', name: 'New', qty: 1 }]);
    expect(notice.released).toEqual([]);
    expect(notice.prepReset).toBe(true);
    expect((await conn.collection('transactions').findOne({ _id: sale }))!.prepChecked).toBe(false);
    expect(await conn.collection('inventoryunits').findOne({ _id: scanned._id })).toMatchObject({ status: 'picking' });
  });

  it('does nothing once the order has left preparation', async () => {
    await seed();
    await conn.collection('transactions').updateOne({ _id: sale }, { $set: { pickupStatus: 'Shipped', items: lines.slice(1) } });
    expect(await reconcilePickingAfterEdit(conn, String(sale), lines, 'Mona', String(user))).toBeNull();
  });
});
