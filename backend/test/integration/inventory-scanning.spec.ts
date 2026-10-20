import { Test } from '@nestjs/testing';
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { trackingMongo } from '../helpers/tracking-mongo';
import { InventoryUnitSchema } from '../../src/inventory-units/schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from '../../src/inventory-units/schemas/inventory-unit-event.schema';
import { InventoryUnitOperationSchema } from '../../src/inventory-units/schemas/inventory-unit-operation.schema';
import { InventoryUnitsService } from '../../src/inventory-units/inventory-units.service';
import { UnitManualCodesService } from '../../src/inventory-units/unit-manual-codes.service';
import { InventoryScanningService } from '../../src/inventory-units/inventory-scanning.service';
import { ManualPurchaseReceivingService } from '../../src/inventory-units/manual-purchase-receiving.service';
import { InventoryUnitsController } from '../../src/inventory-units/inventory-units.controller';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { migrateInventoryUnitIndexes } from '../../src/inventory-units/inventory-unit-index.migration';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';

describe('Shared scanning backend: real disposable Mongo transactions and HTTP', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>, Unit: Model<any>, Event: Model<any>, Operation: Model<any>;
  let service: InventoryScanningService, tracking: InventoryUnitsService, stock: any, actor: any, productId: string, saleId: string, unit: any;
  let app: INestApplication, base: string;
  const key = () => new Types.ObjectId().toHexString();
  const raw = (name: string) => mongo.connection.collection(name);
  const dto = (extra: any = {}) => ({ identifier: unit.barcode, intent: 'lookup', sessionKey: 'scanning-session-1', inputMethod: 'keyboard', operationKey: key(), reason: 'Physical scanner test', ...extra });
  const validate = (extra: any = {}) => service.validate(dto(extra), actor);
  const post = (body: any, role = 'admin') => fetch(base + '/scans/validate', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(role ? { 'x-test-role': role } : {}) }, body: JSON.stringify(body) });
  async function fixture(status = 'available', extra: any = {}) {
    return (await new Unit({ productId, status, origin: { kind: 'legacy-unknown', reconciliationRef: 'COUNT-1' },
      registeredByUserId: actor.userId, registeredBy: 'Verified operator', ...extra }).save()).toObject();
  }
  async function balances() {
    return { stock: await stock.getInventory(), money: await raw('vaultentries').find({}).toArray(),
      transactions: await raw('transactions').find({}).toArray(), supplier: await raw('supplierledgerentries').find({}).toArray(), units: await Unit.find({}).lean() };
  }
  beforeAll(async () => {
    mongo = await trackingMongo(); Unit = mongo.connection.model('InventoryUnit', InventoryUnitSchema);
    Event = mongo.connection.model('InventoryUnitEvent', InventoryUnitEventSchema); Operation = mongo.connection.model('InventoryUnitOperation', InventoryUnitOperationSchema);
    stock = Object.create(TransactionsService.prototype); stock.transactionModel = mongo.connection.model('Transaction', TransactionSchema);
    stock.productsService = { findAll: () => raw('products').find({}).toArray() };
    stock.inventoryMovementsService = { getManualAdjustmentQtyByProductCode: async () => new Map(), getManualAdjustmentWarehouseRows: async () => [] };
    const manualCodes = new UnitManualCodesService(mongo.connection); await manualCodes.onModuleInit();
    tracking = new InventoryUnitsService(mongo.connection, Unit, Event, Operation, stock, manualCodes);
    service = new InventoryScanningService(mongo.connection, Unit, Event, Operation, tracking);
    await migrateInventoryUnitIndexes(mongo.connection.db!, true);
    const module = await Test.createTestingModule({ controllers: [InventoryUnitsController], providers: [
      { provide: InventoryUnitsService, useValue: tracking }, { provide: InventoryScanningService, useValue: service },
      { provide: ManualPurchaseReceivingService, useValue: new ManualPurchaseReceivingService(mongo.connection, tracking, stock) }
    ] }).overrideGuard(JwtAuthGuard).useValue({ canActivate(ctx: any) {
      const req = ctx.switchToHttp().getRequest(), role = req.headers['x-test-role'];
      if (!role) throw new UnauthorizedException();
      req.user = { ...actor, role: role === 'admin' ? 'admin' : 'staff', perms: role === 'reader' ? ['inventory-units-view'] : [] }; return true;
    } }).compile();
    app = module.createNestApplication(); app.useLogger(false); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = await app.getUrl() + '/inventory-units';
  }, 40000);
  beforeEach(async () => {
    for (const name of ['products', 'users', 'transactions', 'inventoryunits', 'inventoryunitevents', 'inventoryunitoperations', 'vaultentries', 'supplierledgerentries']) await raw(name).deleteMany({});
    actor = { userId: key(), role: 'admin', name: 'FORGED' }; productId = key(); saleId = key();
    await raw('users').insertOne({ _id: new Types.ObjectId(actor.userId), name: 'Verified operator' });
    await raw('products').insertOne({ _id: new Types.ObjectId(productId), code: 'SKU-1', name: 'Shirt', openingBalance: 10 });
    await raw('transactions').insertOne({ _id: new Types.ObjectId(saleId), type: 'مبيعات', pickupStatus: 'Preparing', items: [{ code: 'SKU-1', qty: 1, lineId: 'line-1' }], total: 20, deposit: 5, remaining: 15 });
    await raw('vaultentries').insertOne({ amount: 5 }); await raw('supplierledgerentries').insertOne({ runningBalance: 100 });
    unit = await fixture();
  });
  afterAll(async () => { await app?.close(); await mongo?.close(); });

  it('validates exact barcode and ID without changing identity, state, quantity, version or finance', async () => {
    const before = await balances(); const result = await validate();
    expect(result).toMatchObject({ outcome: 'accepted', code: 'VALIDATED', lifecycleChanged: false, stockChanged: false });
    expect(await balances()).toEqual(before);
    expect((await validate({ identifier: String(unit._id), sessionKey: 'another-session' })).outcome).toBe('accepted');
    expect(await Event.findOne().lean()).toMatchObject({ action: 'scan-validated', by: 'Verified operator', details: { custodyConfirmed: false } });
  });
  it('persists identical retries across restart and resolves only the requesting actor key', async () => {
    const request = dto(); const first = await service.validate(request, actor);
    const restarted = new InventoryScanningService(mongo.connection, Unit, Event, Operation, tracking);
    expect(await restarted.validate(request, actor)).toEqual(first);
    expect(await service.operation(request.operationKey, actor)).toEqual({ state: 'resolved', result: first });
    expect(await service.operation(request.operationKey, { ...actor, userId: key() })).toMatchObject({ state: 'unresolved', retrySameRequest: true });
    expect(await service.operation(key(), actor)).toMatchObject({ state: 'unresolved' });
    await expect(validate({ ...request, identifier: 'other' })).rejects.toThrow('different payload');
    expect(await Event.countDocuments()).toBe(1);
  });
  it('deduplicates simultaneous identical requests and different keys/ID aliases in one session', async () => {
    const request = dto(); const same = await Promise.all(Array.from({ length: 4 }, () => service.validate(request, actor)));
    expect(new Set(same.map(row => row.operationId)).size).toBe(1);
    expect((await validate({ identifier: String(unit._id) })).code).toBe('DUPLICATE_SCAN');
    expect(await Event.countDocuments()).toBe(1);
  });
  it('serializes different concurrent keys for one unit into one accepted session scan', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => validate()));
    expect(results.filter(row => row.code === 'VALIDATED')).toHaveLength(1);
    expect(results.filter(row => row.code === 'DUPLICATE_SCAN')).toHaveLength(4);
    expect(await Event.countDocuments()).toBe(1); expect(await Operation.countDocuments()).toBe(5);
  });
  it.each(['camera', 'keyboard', 'manual-entry'])('uses authoritative validation for %s input', async inputMethod => {
    expect((await validate({ inputMethod })).code).toBe('VALIDATED');
    expect((await Event.findOne().lean() as any).details.inputMethod).toBe(inputMethod);
  });
  it('normalizes scanner casing/outer spaces and rejects unknown, wrong product, wrong state and unavailable assignment', async () => {
    expect((await validate({ identifier: 'unknown' })).code).toBe('UNKNOWN_BARCODE');
    expect((await validate({ identifier: unit.barcode.toLowerCase() })).code).toBe('VALIDATED');
    expect((await validate({ identifier: ' ' + unit.barcode, sessionKey: 'second-normalization-session' })).code).toBe('VALIDATED');
    expect((await validate({ productId: key() })).code).toBe('WRONG_PRODUCT');
    expect((await validate({ intent: 'inspect', productId })).code).toBe('INVALID_UNIT_STATE');
    const assigned = await fixture('reserved', { assignment: { transactionId: saleId, lineId: 'line-1' } });
    expect((await validate({ identifier: assigned.barcode, intent: 'picking', productId, transactionId: saleId, lineId: 'wrong' })).code).toBe('UNAVAILABLE_UNIT');
  });
  it('does not turn a rejected result into acceptance when replayed after conditions change', async () => {
    const request = dto({ intent: 'inspect', productId });
    const first = await service.validate(request, actor); expect(first.code).toBe('INVALID_UNIT_STATE');
    await raw('inventoryunits').updateOne({ _id: unit._id }, { $set: { status: 'inspection-required' } });
    expect(await service.validate(request, actor)).toEqual(first); expect(await Event.countDocuments()).toBe(0);
  });
  it('filters manual candidates on server and revalidates stale candidates without bypassing any check', async () => {
    const eligible = await service.eligible({ intent: 'reserve', productId, transactionId: saleId, lineId: 'line-1', sessionKey: 'manual-session' }, actor);
    expect(eligible.units.map(row => row._id)).toEqual([String(unit._id)]);
    const request = dto({ identifier: String(unit._id), intent: 'reserve', productId, transactionId: saleId, lineId: 'line-1', sessionKey: 'manual-session', inputMethod: 'manual-selection', manualSelectionConfirmed: true, reason: 'Scanner broken; confirmed exact unit' });
    await expect(service.validate({ ...request, manualSelectionConfirmed: false }, actor)).rejects.toThrow('confirmation');
    const before = await balances(); expect((await service.validate(request, actor)).code).toBe('VALIDATED'); expect(await balances()).toEqual(before);
    expect(await Event.findOne().lean()).toMatchObject({ action: 'manual-selection-confirmed', details: { manualSelectionConfirmed: true } });
    expect((await service.eligible({ intent: 'reserve', productId, transactionId: saleId, lineId: 'line-1', sessionKey: 'manual-session' }, actor)).units).toEqual([]);
    await raw('inventoryunits').updateOne({ _id: unit._id }, { $set: { status: 'damaged' } });
    expect((await validate({ ...request, operationKey: key(), sessionKey: 'new-session' })).code).toBe('INVALID_UNIT_STATE');
  });
  it('supports inspection, picking, return and count contexts without asserting physical custody', async () => {
    const quarantine = await fixture('inspection-required');
    expect((await validate({ identifier: quarantine.barcode, intent: 'inspect', productId })).code).toBe('VALIDATED');
    const assigned = await fixture('reserved', { assignment: { transactionId: saleId, lineId: 'line-1' } });
    expect((await validate({ identifier: assigned.barcode, intent: 'picking', productId, transactionId: saleId, lineId: 'line-1' })).code).toBe('VALIDATED');
    const shipped = await fixture('shipped', { assignment: { transactionId: saleId, lineId: 'line-1' } });
    await raw('transactions').updateOne({ _id: new Types.ObjectId(saleId) }, { $set: { cancelled: true } });
    expect((await validate({ identifier: shipped.barcode, intent: 'return', productId, transactionId: saleId, lineId: 'line-1' })).code).toBe('VALIDATED');
    const damaged = await fixture('damaged');
    expect((await validate({ identifier: damaged.barcode, intent: 'count', productId })).code).toBe('VALIDATED');
    expect(await Event.countDocuments({ 'details.custodyConfirmed': true })).toBe(0);
  });
  it('blocks filled dispatch capacity and invalid/cancelled sale lines', async () => {
    const claimed = await fixture('reserved', { assignment: { transactionId: saleId, lineId: 'line-1' } });
    expect((await validate({ intent: 'reserve', productId, transactionId: saleId, lineId: 'line-1' })).code).toBe('UNAVAILABLE_UNIT');
    await raw('transactions').updateOne({ _id: new Types.ObjectId(saleId) }, { $set: { cancelled: true } });
    expect((await validate({ identifier: claimed.barcode, intent: 'picking', productId, transactionId: saleId, lineId: 'line-1' })).code).toBe('UNAVAILABLE_UNIT');
  });
  it('atomically picks a physical unit for one exact sale line and supports an audited undo', async () => {
    const request = { operationKey: key(), reason: 'Scanned physical unit at pickup', identifier: unit.barcode,
      lineId: 'line-1', physicalPossessionConfirmed: true };
    const picked = await tracking.pickScan(saleId, request, actor);
    expect(picked).toMatchObject({ outcome: 'accepted', transactionId: saleId, lineId: 'line-1', unit: { status: 'picking', barcode: unit.barcode } });
    expect(await Unit.findById(unit._id).lean()).toMatchObject({ status: 'picking', assignment: { transactionId: saleId, lineId: 'line-1' } });
    await expect(tracking.pickScan(saleId, { ...request, operationKey: key() }, actor)).rejects.toThrow('DUPLICATE_SCAN');
    const undone = await tracking.action(unit.barcode, { operationKey: key(), reason: 'Wrong order selected; returned to available stock', action: 'undo-picking',
      expectedVersion: picked.unit.version, transactionId: saleId, lineId: 'line-1' }, actor);
    expect(undone).toMatchObject({ stockChanged: false, unit: { status: 'available', assignment: null } });
    expect((await Event.find({ unitId: String(unit._id) }).sort({ sequence: 1 }).lean()).map(row => row.action)).toEqual(['picking-started', 'picking-undone']);
  });
  it('replays the same pickup scan operation without creating a second event', async () => {
    const request = { operationKey: key(), reason: 'Scanned physical unit at pickup', identifier: unit.barcode,
      lineId: 'line-1', physicalPossessionConfirmed: true };
    const first = await tracking.pickScan(saleId, request, actor);
    const retry = await tracking.pickScan(saleId, request, actor);
    expect(retry).toEqual(first);
    expect(await Event.countDocuments({ unitId: String(unit._id), action: 'picking-started' })).toBe(1);
  });
  it('rejects barcode picking when the requested sale-line quantity is already covered', async () => {
    const first = await tracking.pickScan(saleId, { operationKey: key(), reason: 'Scanned unit', identifier: unit.barcode,
      lineId: 'line-1', physicalPossessionConfirmed: true }, actor);
    const extra = await fixture('available');
    await expect(tracking.pickScan(saleId, { operationKey: key(), reason: 'Scanned extra unit', identifier: extra.barcode,
      lineId: 'line-1', physicalPossessionConfirmed: true }, actor)).rejects.toThrow('full quantity allocated');
    expect(first.unit.status).toBe('picking');
    expect((await Unit.findById(extra._id).lean() as any).status).toBe('available');
  });
  it('blocks padded duplicate SKUs and reversed or mismatched receipt origins', async () => {
    await raw('products').insertOne({ code: ' SKU-1 ' });
    expect((await validate()).code).toBe('UNAVAILABLE_UNIT');
    await raw('products').deleteOne({ code: ' SKU-1 ' });
    const purchaseId = key();
    await raw('transactions').insertOne({ _id: new Types.ObjectId(purchaseId), type: 'مشتريات', items: [{ lineId: 'purchase-line', code: 'SKU-1', qty: 1 }] });
    await raw('inventoryunits').updateOne({ _id: unit._id }, { $set: { origin: { kind: 'purchase', purchaseOrderId: key(), purchaseTransactionId: purchaseId, purchaseLineId: 'purchase-line' } } });
    const context = { intent: 'reserve', productId, transactionId: saleId, lineId: 'line-1' };
    expect((await validate(context)).code).toBe('VALIDATED');
    await raw('transactions').updateOne({ _id: new Types.ObjectId(purchaseId) }, { $set: { cancelled: true } });
    expect((await validate({ ...context, sessionKey: 'reversed-receipt' })).code).toBe('UNAVAILABLE_UNIT');
    await raw('transactions').updateOne({ _id: new Types.ObjectId(purchaseId) }, { $unset: { cancelled: '' }, $set: { 'items.0.qty': 2 } });
    expect((await validate({ ...context, sessionKey: 'edited-receipt' })).code).toBe('UNAVAILABLE_UNIT');
  });
  it('exposes permission-guarded eligible and actor-scoped operation HTTP routes', async () => {
    const context = new URLSearchParams({ intent: 'lookup', sessionKey: 'http-session' });
    expect((await fetch(base + '/scans/eligible?' + context, { headers: { 'x-test-role': 'reader' } })).status).toBe(403);
    const eligible = await fetch(base + '/scans/eligible?' + context, { headers: { 'x-test-role': 'admin' } });
    expect(eligible.status).toBe(200); expect((await eligible.json() as any).units[0]._id).toBe(String(unit._id));
    const request = dto(); const result = await (await post(request)).json();
    const found = await fetch(base + '/scans/operations/' + request.operationKey, { headers: { 'x-test-role': 'reader' } });
    expect(await found.json()).toEqual({ state: 'resolved', result });
    expect((await fetch(base + '/scans/operations/not-valid!', { headers: { 'x-test-role': 'reader' } })).status).toBe(400);
  });
  it('paginates the server-filtered manual list without duplicate or ineligible units', async () => {
    for (let index = 0; index < 24; index++) await fixture();
    await fixture('damaged');
    const context = { intent: 'reserve', productId, transactionId: saleId, lineId: 'line-1', sessionKey: 'paginated-session' };
    const first = await service.eligible(context, actor); expect(first.units).toHaveLength(20); expect(first.nextCursor).toBeTruthy();
    const second = await service.eligible({ ...context, cursor: first.nextCursor! }, actor); expect(second.units).toHaveLength(5); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.units, ...second.units].map(row => row._id)).size).toBe(25);
    expect([...first.units, ...second.units].every(row => row.status === 'available' && row.productId === productId)).toBe(true);
  });
  it('rolls back an interrupted audit append and permits safe same-key recovery', async () => {
    const request = dto(); const before = await balances();
    const fail = jest.spyOn(Event.prototype, 'save').mockRejectedValueOnce(new Error('Injected interruption'));
    await expect(service.validate(request, actor)).rejects.toThrow('interruption'); fail.mockRestore();
    expect(await Operation.countDocuments()).toBe(0); expect(await Event.countDocuments()).toBe(0);
    expect(await balances()).toEqual(before); expect((await service.operation(request.operationKey, actor)).state).toBe('unresolved');
    expect((await service.validate(request, actor)).code).toBe('VALIDATED');
  });
  it('enforces active actor, context permissions, manual permission and strict HTTP DTOs', async () => {
    expect((await post(dto(), '')).status).toBe(401); expect((await post(dto(), 'none')).status).toBe(403);
    expect((await post(dto(), 'reader')).status).toBe(201);
    expect((await post(dto({ intent: 'reserve', productId, transactionId: saleId, lineId: 'line-1' }), 'reader')).status).toBe(403);
    expect((await post(dto({ inputMethod: 'manual-selection', manualSelectionConfirmed: true }), 'reader')).status).toBe(403);
    expect((await post(dto({ intent: 'invalid' }))).status).toBe(400);
    expect((await post(dto({ identifier: unit.barcode + '\n' }))).status).toBe(400);
    expect((await post(dto({ intent: 'reserve' }))).status).toBe(400);
    await raw('users').updateOne({ _id: new Types.ObjectId(actor.userId) }, { $set: { isActive: false } });
    await expect(validate()).rejects.toThrow('inactive');
  });
  it('fails closed on missing required indexes without creating or repairing them', async () => {
    await raw('inventoryunitoperations').dropIndex('inventory_unit_operation_actor');
    await expect(validate()).rejects.toThrow('index migration'); expect(await Event.countDocuments()).toBe(0);
    await migrateInventoryUnitIndexes(mongo.connection.db!, true);
  });
});
