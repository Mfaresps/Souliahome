import { Types, Schema } from 'mongoose';
import { trackingMongo } from '../helpers/tracking-mongo';
import { InventoryUnitSchema } from '../../src/inventory-units/schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from '../../src/inventory-units/schemas/inventory-unit-event.schema';
import { finishFailedDeliveryIdentities } from '../../src/inventory-units/failed-delivery-identities';
import { InventoryUnitsService } from '../../src/inventory-units/inventory-units.service';

describe('Failed delivery physical identities', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>, Unit: any, Event: any, Tx: any;
  let saleId: string, actorId: string, unitId: string;
  const id = () => new Types.ObjectId().toHexString();
  beforeAll(async () => {
    mongo = await trackingMongo();
    Unit = mongo.connection.model('InventoryUnit', InventoryUnitSchema);
    Event = mongo.connection.model('InventoryUnitEvent', InventoryUnitEventSchema);
    Tx = mongo.connection.model('IdentityTestTransaction', new Schema({}, { strict: false, collection: 'transactions' }));
    await mongo.connection.createCollection('inventoryunitevents');
  }, 40000);
  beforeEach(async () => {
    for (const name of ['users', 'products', 'transactions', 'inventoryunits', 'inventoryunitevents']) await mongo.connection.collection(name).deleteMany({});
    saleId = id(); actorId = id(); const productId = id();
    await mongo.connection.collection('users').insertOne({ _id: new Types.ObjectId(actorId), name: 'Returns operator' });
    await mongo.connection.collection('products').insertOne({ _id: new Types.ObjectId(productId), code: 'RETURN-1' });
    await mongo.connection.collection('transactions').insertOne({ _id: new Types.ObjectId(saleId), type: 'مبيعات',
      items: [{ lineId: 'sale-line', code: 'RETURN-1', qty: 1 }] });
    const unit = await Unit.create({ productId, status: 'shipped', assignment: { transactionId: saleId, lineId: 'sale-line' },
      warehouseCode: 'MAIN', origin: { kind: 'legacy-unknown', reconciliationRef: 'isolated-failed-delivery-test' },
      registeredByUserId: actorId, registeredBy: 'Returns operator' });
    unitId = String(unit._id);
  });
  afterAll(async () => { await mongo?.close(); });
  const finalize = (session?: any) => Tx.findByIdAndUpdate(saleId, { $set: { shipIssueState: 'closed' }, $inc: { unitTrackingRevision: 1 } }, { new: true, session }).exec();
  it('releases a piece from a cancelled invoice and keeps its immutable barcode and history', async () => {
    await Tx.updateOne({ _id: saleId }, { $set: { cancelled: true } });
    const before = await Unit.findById(unitId).lean();
    await finishFailedDeliveryIdentities(Tx, saleId, 'stock', [{ unitId, labelState: 'intact', labelAttached: true }], 'Returns operator', actorId, finalize);
    const after = await Unit.findById(unitId).lean();
    expect(after).toMatchObject({ status: 'available', assignment: null, barcode: before.barcode });
    expect(await Event.findOne({ unitId }).lean()).toMatchObject({ action: 'returned', transactionId: saleId, lineId: 'sale-line', details: { stockChanged: false } });
  });
  it('keeps the same invoice and identity when preparing another shipping attempt', async () => {
    await Event.create({ unitId, sequence: 1, operationKey: 'original-shipment', action: 'shipped', fromStatus: 'prepared', toStatus: 'shipped',
      transactionId: saleId, lineId: 'sale-line', byUserId: actorId, by: 'Returns operator' });
    await finishFailedDeliveryIdentities(Tx, saleId, 'reship', [], 'Returns operator', actorId, finalize);
    expect(await Unit.findById(unitId).lean()).toMatchObject({ status: 'prepared', assignment: { transactionId: saleId, lineId: 'sale-line' } });
    const tracking: any = Object.create(InventoryUnitsService.prototype);
    Object.assign(tracking, { connection: mongo.connection, units: Unit, events: Event, withManualCodes: async (units: any[]) => units });
    const invoice = await tracking.invoiceIdentities(saleId);
    expect(invoice.lines[0].current[0]).toMatchObject({ active: true, orderStatus: 'prepared', shippedAt: null });
    expect(await Event.countDocuments({ unitId, action: 'shipped' })).toBe(1);
  });
  it('rolls identity and audit writes back when the order update fails', async () => {
    await expect(finishFailedDeliveryIdentities(Tx, saleId, 'stock', [{ unitId, labelState: 'intact', labelAttached: true }],
      'Returns operator', actorId, async () => { throw new Error('order write failed'); })).rejects.toThrow('order write failed');
    expect(await Unit.findById(unitId).lean()).toMatchObject({ status: 'shipped', assignment: { transactionId: saleId } });
    expect(await Event.countDocuments({ unitId })).toBe(0);
  });
});
