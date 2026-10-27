import { Schema, Types } from 'mongoose';
import { trackingMongo } from '../helpers/tracking-mongo';
import { AfterSalesService } from '../../src/after-sales/after-sales.service';
import { ReturnRequestSchema } from '../../src/returns/schemas/return-request.schema';
import { ReturnsValidationService } from '../../src/returns/returns-validation.service';
import { InventoryUnitsService } from '../../src/inventory-units/inventory-units.service';
import { InventoryUnitSchema } from '../../src/inventory-units/schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from '../../src/inventory-units/schemas/inventory-unit-event.schema';
import { afterSalesQuote } from '../../src/after-sales/after-sales.policy';
import { UnitManualCodesService } from '../../src/inventory-units/unit-manual-codes.service';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';
import { VaultService } from '../../src/vault/vault.service';
import { VaultEntrySchema } from '../../src/vault/schemas/vault-entry.schema';
import { InventoryUnitOperationSchema } from '../../src/inventory-units/schemas/inventory-unit-operation.schema';
import { migrateInventoryUnitIndexes } from '../../src/inventory-units/inventory-unit-index.migration';
import { BostaService } from '../../src/bosta/bosta.service';

describe('After-sales atomic workflow (isolated Mongo replica set)', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>, Cases: any, Unit: any, Event: any, Tx: any, Vault: any, Operations: any, tracking: InventoryUnitsService, service: AfterSalesService;
  let actor: any, saleId: string, unitId: string, productId: string, carrier: any, vault: any, transactions: any, notifications: any;
  const oid = () => new Types.ObjectId();
  const op = (extra: any = {}) => ({ operationKey: new Types.ObjectId().toHexString(), ...extra });
  beforeAll(async () => {
    mongo = await trackingMongo();
    Cases = mongo.connection.model('ReturnRequest', ReturnRequestSchema);
    Unit = mongo.connection.model('InventoryUnit', InventoryUnitSchema);
    Event = mongo.connection.model('InventoryUnitEvent', InventoryUnitEventSchema);
    Tx = mongo.connection.model('Transaction', TransactionSchema);
    Vault = mongo.connection.model('VaultEntry', VaultEntrySchema);
    Operations = mongo.connection.model('InventoryUnitOperation', InventoryUnitOperationSchema);
    for (const name of ['returnrequests', 'inventoryunitevents', 'vaultentries']) await mongo.connection.createCollection(name);
    await migrateInventoryUnitIndexes(mongo.connection.db!, true);
  }, 40000);
  afterAll(async () => { await mongo?.close(); });
  beforeEach(async () => {
    for (const name of ['transactions', 'returnrequests', 'users', 'products', 'inventoryunits', 'inventoryunitevents', 'inventoryunitoperations', 'settings', 'vaultentries', 'inventorymovements']) await mongo.connection.collection(name).deleteMany({});
    actor = { userId: String(oid()), role: 'admin' }; saleId = String(oid()); productId = String(oid());
    await mongo.connection.collection('users').insertOne({ _id: new Types.ObjectId(actor.userId), name: 'Test operator' });
    await mongo.connection.collection('settings').insertOne({ vaultCash: 10000, vaultBalance: 10000, afterSalesPolicy: { customerFeesEnabled: true, returnFee: 50, exchangeFee: 50, feePolicyNote: 'Eligible policy exception' } });
    await mongo.connection.collection('products').insertOne({ _id: new Types.ObjectId(productId), code: 'ITEM', name: 'Product', sellPrice: 600, buyPrice: 200, openingBalance: 10 });
    await Tx.create({ _id: saleId, ref: '1001', date: '2026-10-24', client: 'Test customer', employee: 'Test operator', type: 'مبيعات', total: 500, remaining: 0,
      deliveredAt: new Date().toISOString(), pickupStatus: 'Delivered', warehouseCode: 'MAIN', items: [{ lineId: 'line1', code: 'ITEM', name: 'Product', qty: 1, price: 500, total: 500 }] });
    const unit = await Unit.create({ productId, status: 'delivered', warehouseCode: 'MAIN', assignment: { transactionId: saleId, lineId: 'line1' },
      origin: { kind: 'legacy-unknown', reconciliationRef: 'after-sales-test' }, registeredByUserId: actor.userId, registeredBy: 'Test operator' });
    unitId = String(unit._id);
    const settings: any = { getSettings: (session?: any) => mongo.connection.collection('settings').findOne({}, { session }),
      adjustVaultBalance: async (seg: string, amount: number, session?: any) => {
        const field = { cash: 'vaultCash', bank: 'vaultBank', vodafone: 'vaultVodafone', instapay: 'vaultInstapay' }[seg]!;
        return mongo.connection.collection('settings').findOneAndUpdate({}, { $inc: { [field]: amount, vaultBalance: amount } }, { session, returnDocument: 'after' });
      } };
    vault = new VaultService(Vault, settings, { emitEvent() {} } as any);
    transactions = Object.create(TransactionsService.prototype);
    Object.assign(transactions, { transactionModel: Tx, returnRequestModel: Cases, settingsService: settings, vaultService: vault,
      presence: { emitEvent() {} }, productsService: { findAll: (session?: any) => mongo.connection.collection('products').find({}, { session }).toArray() },
      inventoryMovementsService: { getManualAdjustmentQtyByProductCode: async () => new Map(), getManualAdjustmentWarehouseRows: async () => [],
        record: async (rows: any[], ctx: any) => { if (rows.length) await mongo.connection.collection('inventorymovements').insertMany(rows, { session: ctx.session }); } } });
    carrier = { createAfterSalesShipment: jest.fn(async () => ({ deliveryId: 'carrier-one', trackingNumber: '123456' })) };
    const codes = new UnitManualCodesService(mongo.connection); await codes.onModuleInit();
    tracking = new InventoryUnitsService(mongo.connection, Unit, Event, Operations, transactions, codes);
    notifications = { enqueue: jest.fn(async () => {}) };
    service = new AfterSalesService(mongo.connection, Cases, transactions, new ReturnsValidationService(Cases, vault), tracking, vault, carrier, notifications);
  });
  const request = (kind = 'return', reason = 'customer-choice') => op({ originalTransactionId: saleId, kind, reason,
    items: [{ lineIndex: 0, qty: 1, unitIds: [unitId] }], feeBasis: 'Eligible exception', ...(kind === 'exchange' ? { exchangeItems: [{ productId, qty: 1 }] } : {}) });
  const receive = () => op({ physicalPossessionConfirmed: true, items: [{ lineIndex: 0, condition: 'سليم' }], identities: [{ unitId, labelState: 'intact', labelAttached: true }] });
  const settle = (kind: string, extra: any = {}) => op({ kind, method: 'كاش', confirmed: true, reference: 'physical-payment-reference', ...extra });
  it('calculates exchange differences and keeps company errors free of shipping fees', () => {
    expect(afterSalesQuote('exchange', 'customer-choice', 500, 600, 50)).toMatchObject({ collectDue: 150, refundDue: 0, creditApplied: 500 });
    expect(afterSalesQuote('exchange', 'customer-choice', 500, 300, 50)).toMatchObject({ collectDue: 0, refundDue: 150, creditApplied: 350 });
    expect(afterSalesQuote('return', 'customer-choice', 500, 0, 50)).toMatchObject({ refundDue: 450 });
    expect(() => afterSalesQuote('exchange', 'defect', 500, 500, 50)).toThrow();
  });
  const undo = async (id: string) => {
    const view: any = await service.get(id);
    return op({ step: view.rollback.step, expectedToken: view.rollback.token, note: 'Correct accidental workflow action', confirmed: true });
  };
  it('undoes approval once, restores replacement stock, and permits a fresh approval', async () => {
    const row: any = await service.create(request('exchange'), actor), id = String(row._id);
    const before = (await transactions.getInventory())[0].current;
    const approved: any = await service.approve(id, op(), actor), replacementId = approved.workflow.replacementTxId;
    expect((await transactions.getInventory())[0].current).toBe(before - 1);
    const body = await undo(id);
    expect(body.step).toBe('approval');
    const reverted: any = await service.rollback(id, body, actor);
    expect(reverted.workflow.stage).toBe('requested'); expect(reverted.workflow.approvedAt).toBeUndefined(); expect(reverted.workflow.replacementTxId).toBeUndefined();
    expect((await Tx.findById(replacementId).lean()).cancelled).toBe(true);
    expect((await transactions.getInventory())[0].current).toBe(before);
    await service.rollback(id, body, actor);
    expect((await Cases.findById(id).lean()).workflow.history.filter((h: any) => h.action === 'step-rolled-back')).toHaveLength(1);
    expect(await mongo.connection.collection('vaultentries').countDocuments()).toBe(0);
    const again: any = await service.approve(id, op(), actor);
    expect(again.workflow.replacementTxId).not.toBe(replacementId);
    expect((await transactions.getInventory())[0].current).toBe(before - 1);
    await expect(service.rollback(id, { ...body, operationKey: op().operationKey }, actor)).rejects.toThrow('تغيرت');
  });
  it('undoes replacement preparation and releases scanned identities without cancelling approval', async () => {
    const row: any = await service.create(request('exchange'), actor), id = String(row._id);
    const approved: any = await service.approve(id, op(), actor), replacementId = approved.workflow.replacementTxId;
    await Tx.updateOne({ _id: replacementId }, { $set: { pickupStatus: 'Preparing', prepChecked: true, 'items.0.lineId': 'replacement-line' } });
    const piece = await Unit.create({ productId, status: 'prepared', warehouseCode: 'MAIN', assignment: { transactionId: replacementId, lineId: 'replacement-line' },
      origin: { kind: 'legacy-unknown', reconciliationRef: 'undo-prep' }, registeredByUserId: actor.userId, registeredBy: 'Test operator' });
    const before = (await transactions.getInventory())[0].current, body = await undo(id);
    expect(body.step).toBe('preparation');
    await service.rollback(id, body, actor);
    expect(await Unit.findById(piece._id).lean()).toMatchObject({ status: 'available', assignment: null });
    expect(await Tx.findById(replacementId).lean()).toMatchObject({ pickupStatus: 'Pending', prepChecked: false, cancelled: false });
    expect((await service.get(id)).rollback.step).toBe('approval');
    expect((await transactions.getInventory())[0].current).toBe(before);
    expect(await Event.countDocuments({ unitId: String(piece._id), action: 'picking-undone' })).toBe(1);
  });
  it('undoes initial submission explicitly as cancellation and rejects stale or unauthorized undo', async () => {
    const row: any = await service.create(request(), actor), id = String(row._id), body = await undo(id);
    expect(body.step).toBe('request');
    expect(() => service.rollback(id, body, { ...actor, role: 'staff' })).toThrow();
    expect(() => service.rollback(id, { ...body, confirmed: false }, actor)).toThrow();
    await service.approve(id, op(), actor);
    await expect(service.rollback(id, body, actor)).rejects.toThrow('تغيرت');
    await service.rollback(id, await undo(id), actor);
    await service.rollback(id, await undo(id), actor);
    expect((await service.get(id)).workflow.stage).toBe('cancelled');
    expect((await service.get(id)).rollback.available).toBe(false);
  });
  it('blocks undo after shipping or stock receipt and rolls back all partial database effects', async () => {
    const row: any = await service.create(request('exchange'), actor), id = String(row._id);
    const approved: any = await service.approve(id, op(), actor), body = await undo(id);
    await Cases.updateOne({ _id: id }, { $set: { 'workflow.shipment': { status: 'creating' } } });
    expect((await service.get(id)).rollback.available).toBe(false);
    await expect(service.rollback(id, body, actor)).rejects.toThrow('شحن');
    await Cases.updateOne({ _id: id }, { $unset: { 'workflow.shipment': 1 }, $set: { 'workflow.receivedAt': new Date().toISOString() } });
    await expect(service.rollback(id, body, actor)).rejects.toThrow('استلام');
    await Cases.updateOne({ _id: id }, { $unset: { 'workflow.receivedAt': 1 } });
    const cancel = transactions.cancelAfterSalesReplacement.bind(transactions);
    const spy = jest.spyOn(transactions, 'cancelAfterSalesReplacement').mockImplementation(async (...args: any[]) => { await cancel(...args); throw new Error('Injected failure'); });
    await expect(service.rollback(id, await undo(id), actor)).rejects.toThrow('Injected failure'); spy.mockRestore();
    expect((await Cases.findById(id).lean()).workflow.stage).toBe('approved');
    expect((await Tx.findById(approved.workflow.replacementTxId).lean()).cancelled).toBe(false);
  });
  it('receives the original identity once, credits the invoice and refunds only on physical payment', async () => {
    const body = request(), row: any = await service.create(body, actor);
    expect(String((await service.create(body, actor))._id)).toBe(String(row._id));
    await service.approve(String(row._id), op(), actor);
    expect(await Tx.countDocuments({ type: 'مرتجع' })).toBe(0);
    await expect(service.settle(String(row._id), settle('refund'), actor)).rejects.toThrow();
    const receipt = receive(); await service.receive(String(row._id), receipt, actor); await service.receive(String(row._id), receipt, actor);
    expect(await Tx.countDocuments({ type: 'مرتجع' })).toBe(1);
    expect(await Unit.findById(unitId).lean()).toMatchObject({ status: 'available', assignment: null });
    expect(await mongo.connection.collection('vaultentries').countDocuments()).toBe(0);
    expect((await transactions.getInventory())[0].current).toBe(10);
    const payment = settle('refund'); await service.settle(String(row._id), payment, actor); await service.settle(String(row._id), payment, actor);
    const closed: any = await service.settle(String(row._id), settle('carrier', { actualCost: 70 }), actor);
    expect(closed.workflow.stage).toBe('closed');
    const entries = await mongo.connection.collection('vaultentries').find().toArray();
    expect(entries.map(e => e.amount).sort((a,b) => a-b)).toEqual([-450, -70]);
    expect(await Tx.findById(saleId).lean()).toMatchObject({ shipLoss: 20 });
    expect(await mongo.connection.collection('settings').findOne({})).toMatchObject({ vaultCash: 9480 });
    expect(entries.every(e => e.afterSalesId === String(row._id))).toBe(true);
    expect(row.workflow.ref).toMatch(/^AS-\d{4}-\d{6}$/);
    expect(closed.returnTxRef).toMatch(/^RT-\d{4}-\d{6}$/);
    expect(entries.find(e => e.amount === -450)).toMatchObject({ txNo: row.workflow.ref + '-RF', afterSales: { kind: 'refund', originalRef: '1001', net: -450, paymentReference: 'physical-payment-reference' } });
    const original = await Tx.findById(saleId).lean();
    expect(original.afterSalesEvents.map(e => e.action)).toEqual(['requested', 'approved', 'received-and-inspected', 'settlement:refund', 'settlement:carrier']);
    expect(original.afterSalesEvents.every(e => e.kind === 'return')).toBe(true);
    expect(original.afterSalesEvents.at(-1).stage).toBe('closed');
    expect(notifications.enqueue).toHaveBeenCalledTimes(5);
    expect(new Set(notifications.enqueue.mock.calls.map(call => call[1])).size).toBe(5);
  });
  it('serializes concurrent requests for the same physical piece', async () => {
    const results = await Promise.allSettled([service.create(request(), actor), service.create(request(), actor)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await Cases.countDocuments()).toBe(1);
  });
  it('allocates readable references without reusing a cancelled case number', async () => {
    const first: any = await service.create(request('exchange'), actor);
    const approved: any = await service.approve(String(first._id), op(), actor);
    await service.cancel(String(first._id), op({ note: 'Customer cancelled before preparation' }), actor);
    const second: any = await service.create(request('exchange'), actor);
    const next: any = await service.approve(String(second._id), op(), actor);
    expect(second.workflow.ref).not.toBe(first.workflow.ref);
    expect(Number(next.workflow.replacementRef)).toBeGreaterThan(Number(approved.workflow.replacementRef));
    const movements = await mongo.connection.collection('inventorymovements').find({ afterSalesId: String(first._id) }).toArray();
    expect(movements.map(m => m.lifecycle)).toEqual(['replacement-reserved', 'replacement-cancelled']);
    expect(movements.reduce((n, m) => n + m.qtyDelta, 0)).toBe(0);
    expect((await service.list(undefined, next.workflow.replacementRef)).map((r: any) => String(r._id))).toEqual([String(second._id)]);
  });
  it('rejects missing label evidence and rolls back a failed identity inspection', async () => {
    const row: any = await service.create(request(), actor); await service.approve(String(row._id), op(), actor);
    await expect(service.receive(String(row._id), { ...receive(), identities: [{ unitId, labelState: 'reprinted', labelAttached: true }] }, actor)).rejects.toThrow();
    await mongo.connection.collection('inventoryunits').updateOne({ _id: new Types.ObjectId(unitId) }, { $set: { status: 'available' } });
    await expect(service.receive(String(row._id), receive(), actor)).rejects.toThrow();
    expect(await Tx.countDocuments({ type: 'مرتجع' })).toBe(0);
    expect((await Cases.findById(row._id)).status).toBe('معلق');
  });
  it('quarantines damaged pieces and never returns them to available identities', async () => {
    const row: any = await service.create(request('return', 'defect'), actor); await service.approve(String(row._id), op(), actor);
    await service.receive(String(row._id), { ...receive(), items: [{ lineIndex: 0, condition: 'تالف' }] }, actor);
    expect(await Unit.findById(unitId).lean()).toMatchObject({ status: 'damaged', assignment: null });
    expect(await Cases.findById(row._id).lean()).toMatchObject({ damagedValue: 500 });
    expect((await transactions.getInventory())[0].current).toBe(9);
    expect(await mongo.connection.collection('inventorymovements').findOne()).toMatchObject({ qtyDelta: 0, physicalQty: 1, quarantinedQty: 1, lifecycle: 'returned-damaged', afterSalesId: String(row._id), unitIds: [unitId] });
  });
  it('creates a defect replacement at the original price without a fictitious cash deposit', async () => {
    const row: any = await service.create(request('exchange', 'defect'), actor);
    const approved: any = await service.approve(String(row._id), op(), actor);
    expect(await Tx.findById(approved.workflow.replacementTxId).lean()).toMatchObject({ total: 500, deposit: 500, remaining: 0, pickupStatus: 'Pending', afterSales: { kind: 'exchange', creditApplied: 500, returnedQty: 1, replacementQty: 1 } });
    await transactions.setPickupPreparing([approved.workflow.replacementTxId], 'Test operator', 'PREP-EXCHANGE');
    expect(await Tx.findById(approved.workflow.replacementTxId).lean()).toMatchObject({ pickupStatus: 'Preparing', pickupRef: 'PREP-EXCHANGE', afterSales: { role: 'replacement' } });
    expect((await service.get(String(row._id))).workflow.replacementPickupStatus).toBe('Preparing');
    expect(await mongo.connection.collection('vaultentries').countDocuments()).toBe(0);
    expect(await Unit.findById(unitId).lean()).toMatchObject({ assignment: { transactionId: saleId }, status: 'delivered' });
    expect((await transactions.getInventory())[0].current).toBe(8);
  });
  it('never resends an ambiguous carrier request, even when the operator retries', async () => {
    const row: any = await service.create(request(), actor); await service.approve(String(row._id), op(), actor);
    carrier.createAfterSalesShipment.mockRejectedValue(new Error('connection interrupted'));
    const shipping = op(); await expect(service.ship(String(row._id), shipping, actor)).rejects.toThrow();
    await service.ship(String(row._id), shipping, actor);
    expect(carrier.createAfterSalesShipment).toHaveBeenCalledTimes(1);
    expect((await service.get(String(row._id)) as any).workflow.shipment.status).toBe('reconcile');
  });
  it('settles the exchange COD net of actual carrier cost, preserving separate piece identities', async () => {
    const row: any = await service.create(request('exchange'), actor);
    const approved: any = await service.approve(String(row._id), op(), actor);
    const replacement = await Tx.findById(approved.workflow.replacementTxId).lean();
    const newUnit = await Unit.create({ productId, status: 'prepared', warehouseCode: 'MAIN', assignment: { transactionId: String(replacement._id), lineId: replacement.items[0].lineId },
      origin: { kind: 'legacy-unknown', reconciliationRef: 'replacement-fixture' }, registeredByUserId: actor.userId, registeredBy: 'Test operator' });
    await Tx.updateOne({ _id: replacement._id }, { $set: { prepChecked: true } });
    await service.ship(String(row._id), op(), actor);
    await service.receive(String(row._id), receive(), actor);
    await service.delivery(String(row._id), op({ confirmed: true, note: 'Confirmed recipient handover' }), actor);
    expect(await mongo.connection.collection('vaultentries').countDocuments()).toBe(0);
    const closed: any = await service.settle(String(row._id), settle('carrier', { actualCost: 70, includesCollection: true }), actor);
    expect(closed.workflow.stage).toBe('closed');
    expect(await Vault.findOne().lean()).toMatchObject({ amount: 80, afterSalesId: String(row._id) });
    expect(await Vault.findOne().lean()).toMatchObject({ afterSales: { grossCollection: 150, carrierCost: 70, net: 80, creditApplied: 500 } });
    expect(replacement.ref).toMatch(/^\d{4}8\d{6}$/);
    expect(await mongo.connection.collection('inventorymovements').findOne({ lifecycle: 'replacement-delivered' })).toMatchObject({ qtyDelta: 0, physicalQty: -1, unitIds: [String(newUnit._id)] });
    expect(await Tx.findById(replacement._id).lean()).toMatchObject({ deposit: 650, remaining: 0, shipLoss: 20 });
    expect(await Unit.findById(newUnit._id).lean()).toMatchObject({ status: 'delivered', assignment: { transactionId: String(replacement._id) } });
    expect(await Unit.findById(unitId).lean()).toMatchObject({ status: 'available', assignment: null });
    expect((await transactions.getInventory())[0].current).toBe(9);
    await expect(transactions.collect(String(replacement._id), {}, 'operator', 'admin')).rejects.toThrow();
    await expect(vault.freezeEntry(String((await Vault.findOne())._id), 'test', 'operator')).rejects.toThrow();
  });
  it('accepts a real print request for an obscured label and keeps the same identity', async () => {
    const row: any = await service.create(request(), actor); await service.approve(String(row._id), op(), actor);
    const print = op({ unitIds: [unitId], sizeId: '50x30', allowReprint: true, reason: 'Obscured original identity' });
    await tracking.labels(print as any, actor);
    await service.receive(String(row._id), { ...receive(), identities: [{ unitId, labelState: 'reprinted', labelAttached: true, printOperationKey: print.operationKey }] }, actor);
    expect(await Unit.findById(unitId).lean()).toMatchObject({ status: 'available', barcode: 'SU-' + unitId.toUpperCase() });
  });
  it('rolls financial settlement back when the actual vault cannot cover the refund', async () => {
    const row: any = await service.create(request(), actor); await service.approve(String(row._id), op(), actor); await service.receive(String(row._id), receive(), actor);
    await mongo.connection.collection('settings').updateOne({}, { $set: { vaultCash: 0, vaultBalance: 0 } });
    await expect(service.settle(String(row._id), settle('refund'), actor)).rejects.toThrow();
    expect((await service.get(String(row._id)) as any).workflow.refund).toBeUndefined();
    expect(await Vault.countDocuments()).toBe(0);
    expect((await Tx.findById(saleId).lean()).afterSalesEvents.some(e => e.action === 'settlement:refund')).toBe(false);
    expect(notifications.enqueue).toHaveBeenCalledTimes(3);
  });
  it('uses Cairo calendar days including daylight saving for reporting', async () => {
    const row: any = await service.create(request(), actor);
    await mongo.connection.collection('returnrequests').updateOne({ _id: row._id }, { $set: { createdAt: new Date('2026-10-23T21:30:00Z') } });
    expect((await service.report('2026-10-24', '2026-10-24')).rows).toHaveLength(1);
    expect((await service.report('2026-10-23', '2026-10-23')).rows).toHaveLength(0);
  });
  it('splits a mixed receipt into sound and damaged stock without losing piece history', async () => {
    await Tx.updateOne({ _id: saleId }, { $set: { total: 1000, 'items.0.qty': 2, 'items.0.total': 1000 } });
    const second = await Unit.create({ productId, status: 'delivered', warehouseCode: 'MAIN', assignment: { transactionId: saleId, lineId: 'line1' },
      origin: { kind: 'legacy-unknown', reconciliationRef: 'mixed-fixture' }, registeredByUserId: actor.userId, registeredBy: 'Test operator' });
    const secondId = String(second._id), body = request(); body.items = [{ lineIndex: 0, qty: 2, unitIds: [unitId, secondId] }];
    const row: any = await service.create(body, actor); await service.approve(String(row._id), op(), actor);
    await service.receive(String(row._id), op({ physicalPossessionConfirmed: true, items: [{ lineIndex: 0, condition: 'mixed', damagedQty: 1 }], identities: [
      { unitId, condition: 'سليم', labelState: 'intact', labelAttached: true }, { unitId: secondId, condition: 'تالف', labelState: 'intact', labelAttached: true },
    ] }), actor);
    expect((await transactions.getInventory())[0].current).toBe(9);
    expect(await Unit.findById(unitId).lean()).toMatchObject({ status: 'available' });
    expect(await Unit.findById(secondId).lean()).toMatchObject({ status: 'damaged' });
    expect(await Cases.findById(row._id).lean()).toMatchObject({ damagedValue: 500 });
    expect(await mongo.connection.collection('inventorymovements').findOne()).toMatchObject({ qtyDelta: 1 });
  });
  it('projects actual exchange shipping to linked invoices without financial or warehouse side effects', async () => {
    await Tx.updateOne({ _id: saleId }, { $set: { bostaStatus: 'DELIVERED', bostaTrackingNumber: 'original-tracking' } });
    const row: any = await service.create(request('exchange'), actor);
    const approved: any = await service.approve(String(row._id), op(), actor);
    await Cases.updateOne({ _id: row._id }, { $set: { 'workflow.shipment': { deliveryId: 'exchange-shipment', trackingNumber: '12345', status: 'created' } } });
    const bosta: any = Object.create(BostaService.prototype);
    Object.assign(bosta, { txModel: Tx, presence: { emitEvent: jest.fn() }, resolveApiKey: async () => 'test-only' });
    const event = { _id: 'exchange-shipment', state: { code: 30 }, updatedAt: '2026-10-24T12:00:00Z' };
    await bosta.applyAfterSalesUpdate(event);
    expect(await Tx.findById(approved.workflow.replacementTxId).lean()).toMatchObject({ bostaStatus: 'IN_TRANSIT', bostaTrackingNumber: '12345', pickupStatus: 'Shipped' });
    const original = await Tx.findById(saleId).lean();
    expect(original).toMatchObject({ bostaStatus: 'DELIVERED', bostaTrackingNumber: 'original-tracking' });
    expect(original.afterSales.shipments[String(row._id)]).toMatchObject({ status: 'IN_TRANSIT', kind: 'exchange' });
    await Tx.updateOne({ _id: approved.workflow.replacementTxId }, { $unset: { bostaStatus: 1, 'afterSales.shipments': 1 } });
    bosta.fetchAfterSalesShipment = jest.fn(async () => event);
    expect(await bosta.syncStatus(approved.workflow.replacementTxId)).toMatchObject({ success: true, status: 'IN_TRANSIT', trackingNumber: '12345' });
    await bosta.applyAfterSalesUpdate({ ...event, state: { code: 45 }, updatedAt: '2026-10-24T14:00:00Z' });
    await bosta.applyAfterSalesUpdate(event);
    const replacement = await Tx.findById(approved.workflow.replacementTxId).lean();
    expect(replacement).toMatchObject({ bostaStatus: 'DELIVERED', pickupStatus: 'Delivered' });
    expect(replacement.bostaOrderId).toBeFalsy();
    expect(replacement.afterSalesEvents.filter(e => e.action === 'carrier-status')).toHaveLength(2);
    expect((await Cases.findById(row._id).lean()).workflow.receivedAt).toBeUndefined();
    expect(await Unit.findById(unitId).lean()).toMatchObject({ status: 'delivered', assignment: { transactionId: saleId } });
    expect(await Vault.countDocuments()).toBe(0);
    expect((await transactions.getInventory())[0].current).toBe(8);
  });
  it('cancels an unshipped replacement and restores stock with an auditable movement, without cash', async () => {
    const row: any = await service.create(request('exchange'), actor);
    const approved: any = await service.approve(String(row._id), op(), actor);
    await service.cancel(String(row._id), op({ note: 'Customer withdrew before preparation' }), actor);
    expect((await transactions.getInventory())[0].current).toBe(9);
    expect(await Tx.findById(approved.workflow.replacementTxId).lean()).toMatchObject({ cancelled: true });
    const moves = await mongo.connection.collection('inventorymovements').find().toArray();
    expect(moves.map(m => m.qtyDelta)).toEqual([-1, 1]);
    expect(await Vault.countDocuments()).toBe(0);
  });
  it('uses Bosta CRP/EXCHANGE types and never treats carrier receipt as warehouse receipt or cash', async () => {
    await Tx.updateOne({ _id: saleId }, { $set: { shippingAddress: 'Test address', shippingBostaCity: 'Cairo', phone: '01000000000', bostaOrderId: 'original-delivery' } });
    const row: any = await service.create(request(), actor);
    await service.approve(String(row._id), op(), actor);
    const bosta: any = Object.create(BostaService.prototype);
    Object.assign(bosta, { txModel: Tx, settingsService: { getBostaApiKey: async () => 'test-only' }, presence: { emitEvent: jest.fn() },
      fetchDelivery: jest.fn(async () => ({ data: { dropOffAddress: { district: { _id: 'customer-district' }, city: { _id: 'cairo-id' }, floor: '2' }, pickupAddress: { district: { _id: 'business-district' } } } })),
      request: jest.fn(async () => ({ data: { _id: 'return-shipment', trackingNumber: '12345' } })) });
    await bosta.createAfterSalesShipment(row);
    expect(bosta.request.mock.calls[0][2]).toMatchObject({ type: 25, cod: 0, pickupAddress: { firstLine: 'Test address', districtId: 'customer-district', floor: '2' }, returnSpecs: { packageDetails: { itemsCount: 1 } } });
    await Cases.updateOne({ _id: row._id }, { $set: { 'workflow.shipment': { deliveryId: 'return-shipment', trackingNumber: '12345', status: 'created' } } });
    expect(await bosta.processWebhook({ _id: 'return-shipment', state: { code: 46 }, updatedAt: '2026-10-24T12:00:00Z' })).toMatchObject({ success: true, code: 'AFTER_SALES' });
    await bosta.processWebhook({ _id: 'return-shipment', state: { code: 23 }, updatedAt: '2026-10-24T10:00:00Z' });
    const synced: any = await Cases.findById(row._id).lean();
    expect(synced.workflow.shipment.carrierCode).toBe(46);
    await bosta.processWebhook({ _id: 'return-shipment', state: { code: 46 }, updatedAt: '2026-10-24T12:00:00Z' });
    expect((await Tx.findById(saleId).lean()).afterSalesEvents.filter(e => e.action === 'carrier-status')).toHaveLength(1);
    expect(synced.workflow.receivedAt).toBeUndefined();
    expect(await Unit.findById(unitId).lean()).toMatchObject({ status: 'delivered', assignment: { transactionId: saleId } });
    expect(await Vault.countDocuments()).toBe(0);
    expect(await Tx.countDocuments({ type: 'مرتجع' })).toBe(0);
    await bosta.createAfterSalesShipment({ ...row, requestKind: 'exchange', workflow: { ...row.workflow, replacementTxId: saleId, quote: { ...row.workflow.quote, replacement: 600, collectDue: 150 } } });
    expect(bosta.request.mock.calls[1][2]).toMatchObject({ type: 30, cod: 150, dropOffAddress: { firstLine: 'Test address', districtId: 'customer-district' } });
    bosta.request.mockClear();
    bosta.fetchDelivery.mockResolvedValue({ data: { dropOffAddress: { city: { _id: 'cairo-id' }, district: { name: 'Nasr City' } } } });
    await bosta.createAfterSalesShipment(row);
    expect(bosta.request.mock.calls[0][2].pickupAddress).toMatchObject({ districtName: 'Nasr City', cityId: 'cairo-id' });
    bosta.request.mockClear();
    bosta.fetchDelivery.mockResolvedValue({ data: { dropOffAddress: { city: { _id: 'cairo-id' } } } });
    await bosta.createAfterSalesShipment({ ...row, workflow: { ...row.workflow, customerDistrictName: 'Customer confirmed district' } });
    expect(bosta.request.mock.calls[0][2].pickupAddress).toMatchObject({ districtName: 'Customer confirmed district', cityId: 'cairo-id' });
    bosta.request.mockClear();
    bosta.fetchDelivery.mockResolvedValue({ data: { dropOffAddress: {} } });
    await expect(bosta.createAfterSalesShipment(row)).rejects.toMatchObject({ beforeSend: true });
    expect(bosta.request).not.toHaveBeenCalled();
    bosta.fetchDelivery.mockRejectedValue(new Error('Read timed out'));
    await expect(bosta.createAfterSalesShipment(row)).rejects.toMatchObject({ beforeSend: true });
    expect(bosta.request).not.toHaveBeenCalled();
    bosta.fetchDelivery.mockClear();
    bosta.afterSalesCities = jest.fn(async()=>[{id:'manual-city',name:'Cairo',nameAr:'القاهرة'}]);
    bosta.afterSalesDistricts = jest.fn(async()=>[{id:'manual-district',pickupAvailability:true,dropOffAvailability:true}]);
    const manual = { ...row, workflow: { ...row.workflow, customerAddress: { cityId:'manual-city',districtId:'manual-district',firstLine:'Customer confirmed return address' } } };
    await bosta.createAfterSalesShipment(manual);
    expect(bosta.fetchDelivery).not.toHaveBeenCalled();
    expect(bosta.request.mock.calls[0][2].pickupAddress).toMatchObject({city:'Cairo',districtId:'manual-district',firstLine:'Customer confirmed return address'});
    await Tx.updateOne({ _id: saleId }, { $set: { phone: '', shippingAddress: '' } });
    bosta.request.mockClear();
    await bosta.createAfterSalesShipment({ ...manual, phone: '', workflow: { ...manual.workflow, customerAddress: { ...manual.workflow.customerAddress, phone: '٠١٠٠٠٠٠٠٠٠٠', customerName: 'Confirmed Customer' } } });
    expect(bosta.request.mock.calls[0][2].receiver).toMatchObject({ phone: '01000000000', firstName: 'Confirmed', lastName: 'Customer' });
    bosta.request.mockClear();
    await expect(bosta.createAfterSalesShipment({ ...manual, phone: '' })).rejects.toMatchObject({ beforeSend: true, message: expect.stringContaining('هاتف') });
    expect(bosta.request).not.toHaveBeenCalled();
    await Tx.updateOne({ _id: saleId }, { $set: { phone: '01000000000' } });
    bosta.request.mockClear();
    bosta.afterSalesDistricts.mockResolvedValue([{id:'other-district'}]);
    await expect(bosta.createAfterSalesShipment(manual)).rejects.toMatchObject({beforeSend:true});
    expect(bosta.request).not.toHaveBeenCalled();
  });
});
