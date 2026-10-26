import { Model, Types } from 'mongoose';
import { Test } from '@nestjs/testing';
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { trackingMongo } from '../helpers/tracking-mongo';
import { InventoryUnitSchema } from '../../src/inventory-units/schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from '../../src/inventory-units/schemas/inventory-unit-event.schema';
import { InventoryUnitOperationSchema } from '../../src/inventory-units/schemas/inventory-unit-operation.schema';
import { InventoryUnitsService } from '../../src/inventory-units/inventory-units.service';
import { UnitManualCodesService } from '../../src/inventory-units/unit-manual-codes.service';
import { InventoryUnitsController } from '../../src/inventory-units/inventory-units.controller';
import { InventoryScanningService } from '../../src/inventory-units/inventory-scanning.service';
import { ManualPurchaseReceivingService } from '../../src/inventory-units/manual-purchase-receiving.service';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { migrateInventoryUnitIndexes } from '../../src/inventory-units/inventory-unit-index.migration';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';

describe('Tracking backend on isolated transaction-capable MongoDB', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>, Unit: Model<any>, Event: Model<any>, Operation: Model<any>, service: InventoryUnitsService;
  let productId: string, actorId: string, saleId: string, purchaseId: string, actor: any, app: INestApplication, base: string;
  const key = () => new Types.ObjectId().toHexString();
  const raw = (name: string) => mongo.connection.collection(name);
  const req = () => ({ operationKey: key(), reason: 'Verified test evidence' });
  const registration = (extra = {}) => ({ ...req(), productId, originKind: 'legacy-unknown', countReference: 'COUNT-1', observedPhysicalCount: 20, physicalPossessionConfirmed: true, ...extra });
  const register = (extra = {}) => service.register(registration(extra), actor);
  async function available() {
    const { unit } = await register();
    return (await service.action(String(unit._id), { ...req(), action: 'inspect', expectedVersion: 0, physicalPossessionConfirmed: true, inspectionPassed: true, evidenceReference: 'Inspection-1' }, actor)).unit;
  }
  const action = (unit: any, name: string, extra = {}) => service.action(String(unit._id), { ...req(), action: name, expectedVersion: unit.__v,
    physicalPossessionConfirmed: true, physicalCountConfirmed: true, evidenceReference: 'Custody evidence', ...extra }, actor);
  beforeAll(async () => {
    mongo = await trackingMongo();
    Unit = mongo.connection.model('InventoryUnit', InventoryUnitSchema); Event = mongo.connection.model('InventoryUnitEvent', InventoryUnitEventSchema);
    Operation = mongo.connection.model('InventoryUnitOperation', InventoryUnitOperationSchema);
    const Transaction = mongo.connection.model('Transaction', TransactionSchema);
    const stockService: any = Object.create(TransactionsService.prototype);
    stockService.productsService = { findAll: () => raw('products').find({}).toArray() };
    stockService.transactionModel = Transaction;
    stockService.inventoryMovementsService = { getManualAdjustmentQtyByProductCode: async () => new Map(), getManualAdjustmentWarehouseRows: async () => [] };
    const manualCodes = new UnitManualCodesService(mongo.connection); await manualCodes.onModuleInit();
    service = new InventoryUnitsService(mongo.connection, Unit, Event, Operation, stockService, manualCodes);
    const module = await Test.createTestingModule({ controllers: [InventoryUnitsController], providers: [{ provide: InventoryUnitsService, useValue: service },
      { provide: InventoryScanningService, useValue: new InventoryScanningService(mongo.connection, Unit, Event, Operation, service) },
      { provide: ManualPurchaseReceivingService, useValue: new ManualPurchaseReceivingService(mongo.connection, service, stockService) }] })
      .overrideGuard(JwtAuthGuard).useValue({ canActivate(context: any) {
        const request = context.switchToHttp().getRequest(), role = request.headers['x-test-role'];
        if (!role) throw new UnauthorizedException();
        request.user = { ...actor, role: role === 'admin' ? 'admin' : 'staff', perms: role === 'reader' ? ['inventory-units-view'] : [] }; return true;
      } }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useLogger(false); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.listen(0, '127.0.0.1'); base = (await app.getUrl()) + '/api/inventory-units';
    await migrateInventoryUnitIndexes(mongo.connection.db!, true);
  }, 40000);
  beforeEach(async () => {
    for (const code of ['Main', 'Main shelf', 'COUNTED-SHELF-A']) await raw('warehouses').updateOne({ code }, { $setOnInsert: { code, active: true } }, { upsert: true });
    for (const name of ['products', 'users', 'transactions', 'inventoryunits', 'inventoryunitevents', 'inventoryunitoperations', 'vaultentries']) await raw(name).deleteMany({});
    productId = key(); actorId = key(); saleId = key(); purchaseId = key(); actor = { userId: actorId, role: 'admin', name: 'FORGED' };
    await raw('products').insertOne({ _id: new Types.ObjectId(productId), code: 'SKU-1', name: 'Product One', size: 'XL', colors: ['Red'], openingBalance: 2 });
    await raw('users').insertOne({ _id: new Types.ObjectId(actorId), name: 'Verified Operator' });
    await raw('transactions').insertMany([
      { _id: new Types.ObjectId(purchaseId), type: 'مشتريات', ref: 'P1', deposit: 20, total: 100, remaining: 80, items: [{ code: 'SKU-1', qty: 3 }] },
      { _id: new Types.ObjectId(saleId), type: 'مبيعات', ref: 'S1', deposit: 5, total: 50, remaining: 45, items: [{ code: 'SKU-1', qty: 1, lineId: 'line-1' }] },
    ]);
    await raw('vaultentries').insertOne({ amount: 5 });
  });
  afterAll(async () => { await app?.close(); await mongo?.close(); });
  it('registers the real /api/inventory-units/config route and enforces authentication', async () => {
    expect((await fetch(base + '/config')).status).toBe(401);
    const response = await fetch(base + '/config', { headers: { 'x-test-role': 'reader' } });
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ symbology: 'QR', enforcementEnabled: false });
  });
  it('counts warehouse stock and creates only genuinely uncoded identities with retry protection', async () => {
    const inventory = jest.spyOn((service as any).transactions, 'getInventory').mockResolvedValue([{ _id: productId, code: 'SKU-1', current: 25, warehouseBalances: { MAIN: 25 } }] as never);
    try {
      await raw('inventoryunits').insertMany(Array.from({ length: 20 }, () => { const id = new Types.ObjectId(); return {
        _id: id, barcode: 'SU-' + String(id).toUpperCase(), productId, status: 'available', warehouseCode: 'MAIN', assignment: null,
        origin: { kind: 'legacy-unknown', reconciliationRef: 'stocktake-test' }, registeredByUserId: actorId, registeredBy: 'Verified Operator', __v: 0,
      }; }));
      const assignedId = new Types.ObjectId();
      await raw('inventoryunits').insertOne({ _id: assignedId, productId, status: 'prepared', warehouseCode: 'MAIN', assignment: { transactionId: saleId, lineId: 'line-1' } });
      const endpoint = await fetch(base + '/stocktake?productId=' + productId + '&warehouseCode=MAIN', { headers: { 'x-test-role': 'reader' } });
      expect(endpoint.status).toBe(200);
      const summary = await endpoint.json();
      expect(summary).toMatchObject({ balance: 25, registered: 20, missing: 5, assigned: 1 }); expect(summary.units).toHaveLength(20);
      expect(summary.units.every((unit: any) => unit.manualCode && !unit.assignment)).toBe(true);
      const dto = { ...req(), productId, warehouseCode: 'MAIN', physicalQuantity: 25, expectedRegistered: 20, expectedBalance: 25, physicalPossessionConfirmed: true, inspectionPassed: true };
      const first = await service.identifyLegacyStock(dto, actor);
      const retry = await service.identifyLegacyStock(dto, actor);
      expect(first).toMatchObject({ createdUnits: 5, stockChanged: false, registered: 25 });
      expect(retry.unitIds).toEqual(first.unitIds);
      expect(await Unit.countDocuments({ assignment: null })).toBe(25);
      expect(await Event.countDocuments({ action: 'registered' })).toBe(5);
      expect((await service.stocktake(productId, 'MAIN')).missing).toBe(0);
      const selection = await service.search({ unitIds: [summary.units[18]._id, ...first.unitIds].join(','), productId, warehouseCode: 'MAIN' });
      expect(selection.total).toBe(6); expect(selection.units).toHaveLength(6);
      await expect(service.search({ unitIds: 'bad-id' })).rejects.toThrow('Invalid unit selection');
      await expect(service.identifyLegacyStock({ ...dto, operationKey: key() }, actor)).rejects.toThrow('LEGACY_STOCK_CHANGED');
    } finally { inventory.mockRestore(); }
  });
  it('projects delivered orders in the piece register, filters and lookup without rewriting unit history', async () => {
    await raw('transactions').updateOne({ _id: new Types.ObjectId(saleId) }, { $set: { bostaStatus: 'DELIVERED', pickupStatus: 'Shipped' } });
    const ids = Array.from({ length: 5 }, () => new Types.ObjectId());
    await raw('inventoryunits').insertMany(['prepared', 'shipped', 'returned', 'prepared', 'available'].map((status, index) => ({
      _id: ids[index], barcode: 'SU-' + String(ids[index]).toUpperCase(), productId, status,
      origin: { kind: 'purchase', purchaseTransactionId: purchaseId },
      assignment: index === 3 ? { transactionId: saleId, lineId: 'wrong-line' } : { transactionId: saleId, lineId: 'line-1' },
    })));
    const result = await service.search({});
    expect(result.total).toBe(5);
    expect(result.units.find((unit: any) => String(unit._id) === String(ids[0]))).toMatchObject({ status: 'prepared', displayStatus: 'delivered', statusSource: 'order' });
    const delivered = await service.search({ status: 'delivered', limit: '1', page: '2' });
    expect(delivered.total).toBe(2); expect(delivered.units).toHaveLength(1);
    expect(delivered.units[0].displayStatus).toBe('delivered');
    expect((await service.search({ status: 'prepared' })).total).toBe(1);
    expect((await service.search({ status: 'shipped' })).total).toBe(0);
    expect((await service.search({ status: 'returned' })).total).toBe(1);
    expect((await service.lookup(String(ids[0]))).unit).toMatchObject({ status: 'prepared', displayStatus: 'delivered' });
    expect((await service.purchaseLineUnits(purchaseId, 0)).units.find((unit: any) => String(unit._id) === String(ids[0]))?.displayStatus).toBe('delivered');
    expect((await raw('inventoryunits').findOne({ _id: ids[0] }))?.status).toBe('prepared');
    expect(await Event.countDocuments()).toBe(0);
    await raw('transactions').updateOne({ _id: new Types.ObjectId(saleId) }, { $set: { bostaStatus: '', pickupStatus: 'Delivered' } });
    expect((await service.search({ status: 'delivered' })).total).toBe(2);
    await raw('transactions').updateOne({ _id: new Types.ObjectId(saleId) }, { $set: { bostaStatus: 'RETURNED' } });
    expect((await service.search({ status: 'delivered' })).total).toBe(0);
    await raw('transactions').updateOne({ _id: new Types.ObjectId(saleId) }, { $set: { bostaStatus: 'DELIVERED', cancelled: true } });
    expect((await service.search({ status: 'delivered' })).total).toBe(0);
  });

  it('requires explicit indexes, never applies them during readiness', async () => {
    expect((await service.readiness()).writesReady).toBe(true);
    await raw('inventoryunitoperations').dropIndex('inventory_unit_operation_actor');
    await expect(register()).rejects.toThrow('index migration');
    expect(await Unit.countDocuments()).toBe(0);
    await migrateInventoryUnitIndexes(mongo.connection.db!, true);
  });
  it('registers only attested pieces in quarantine with immutable backend barcode and real actor', async () => {
    const { unit } = await register();
    expect(unit).toMatchObject({ status: 'inspection-required', registeredBy: 'Verified Operator', barcode: 'SU-' + String(unit._id).toUpperCase() });
    expect(await Event.countDocuments()).toBe(1); expect(await Operation.countDocuments()).toBe(1);
    await expect(register({ observedPhysicalCount: 0 })).rejects.toThrow('Positive physical count');
    await expect(register({ physicalPossessionConfirmed: false })).rejects.toThrow('possession');
  });
  it('persists exact replay across service restart and rejects changed payloads', async () => {
    const dto = registration(); const first = await service.register(dto, actor);
    const restarted = new InventoryUnitsService(mongo.connection, Unit, Event, Operation, (service as any).transactions, new UnitManualCodesService(mongo.connection));
    const replay = await restarted.register(dto, actor);
    expect(String(replay.unit._id)).toBe(String(first.unit._id)); expect(await Unit.countDocuments()).toBe(1);
    await expect(service.register({ ...dto, reason: 'Different' }, actor)).rejects.toThrow('different payload');
  });
  it('handles simultaneous registration retries exactly once', async () => {
    const dto = registration();
    const results = await Promise.all(Array.from({ length: 5 }, () => service.register(dto, actor)));
    expect(new Set(results.map(result => String(result.unit._id))).size).toBe(1);
    expect(await Unit.countDocuments()).toBe(1); expect(await Event.countDocuments()).toBe(1);
  });
  it('enforces physical-count admission and purchase quantity caps under concurrency', async () => {
    const attempts = await Promise.allSettled([register({ observedPhysicalCount: 1 }), register({ observedPhysicalCount: 1 })]);
    expect(attempts.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    const attempts2 = await Promise.allSettled(Array.from({ length: 5 }, () => register({ countReference: 'RECEIPT', originKind: 'purchase', purchaseTransactionId: purchaseId })));
    expect(attempts2.filter(row => row.status === 'fulfilled')).toHaveLength(3);
  });
  it('rejects contradictory counts, duplicate normalized SKUs and fabricated opening provenance', async () => {
    await register({ observedPhysicalCount: 1 });
    await expect(register({ observedPhysicalCount: 2 })).rejects.toThrow('different observed count');
    await raw('products').insertOne({ code: ' SKU-1 ', name: 'Duplicate' });
    await expect(register()).rejects.toThrow('Missing/duplicate SKU');
    await raw('products').deleteOne({ code: ' SKU-1 ' });
    await raw('products').updateOne({ _id: new Types.ObjectId(productId) }, { $set: { openingBalance: 0 } });
    await expect(register({ originKind: 'opening-stock', countReference: 'OPENING' })).rejects.toThrow('opening-stock quantity');
  });
  it('rolls back unit and request receipt if audit append fails', async () => {
    const fail = jest.spyOn(Event.prototype, 'save').mockRejectedValueOnce(new Error('Injected event failure'));
    await expect(register()).rejects.toThrow('Injected event failure'); fail.mockRestore();
    expect(await Unit.countDocuments()).toBe(0); expect(await Operation.countDocuments()).toBe(0);
    expect((await raw('products').findOne({ _id: new Types.ObjectId(productId) }))!.unitTrackingRevision).toBeUndefined();
  });
  it('identifies legacy lines only on explicit request, preserving every existing field', async () => {
    await raw('transactions').updateOne({ _id: new Types.ObjectId(saleId) }, { $unset: { 'items.0.lineId': '' } });
    const before = await raw('transactions').findOne({ _id: new Types.ObjectId(saleId) });
    const dto = req(); const result = await service.identifyLines(saleId, dto, actor);
    expect(result.items[0].lineId).toMatch(/^[a-f\d-]{36}$/); expect(result.items[0]).toMatchObject(before!.items[0]);
    expect((await service.identifyLines(saleId, dto, actor)).items).toEqual(result.items);
  });
  it('rejects wrong products, duplicate scans and excess quantity', async () => {
    const first = await available(), second = await available();
    await expect(action(first, 'reserve', { transactionId: saleId })).rejects.toThrow('Stable sale line ID');
    await raw('transactions').updateOne({ _id: new Types.ObjectId(saleId) }, { $set: { 'items.0.code': 'WRONG' } });
    await expect(action(first, 'reserve', { transactionId: saleId, lineId: 'line-1' })).rejects.toThrow('Exact live sale line');
    await raw('transactions').updateOne({ _id: new Types.ObjectId(saleId) }, { $set: { 'items.0.code': 'SKU-1' } });
    const dto: any = { ...req(), action: 'reserve', expectedVersion: first.__v, transactionId: saleId, lineId: 'line-1' };
    const reserved = await service.action(String(first._id), dto, actor);
    expect((await service.action(String(first._id), dto, actor)).unit.status).toBe('reserved');
    await expect(action(reserved.unit, 'reserve', { transactionId: saleId, lineId: 'line-1' })).rejects.toThrow('not available');
    await expect(action(second, 'reserve', { transactionId: saleId, lineId: 'line-1' })).rejects.toThrow('quantity already');
  });
  it('serializes concurrent claims for one unit and for one order-line capacity', async () => {
    const first = await available(), second = await available();
    const outcomes = await Promise.allSettled([action(first, 'reserve', { transactionId: saleId, lineId: 'line-1' }), action(second, 'reserve', { transactionId: saleId, lineId: 'line-1' })]);
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(await Unit.countDocuments({ status: 'reserved' })).toBe(1);
  });
  it('allows only one order to claim the same barcode under concurrency', async () => {
    const unit = await available(), otherSale = key();
    await raw('transactions').insertOne({ _id: new Types.ObjectId(otherSale), type: 'مبيعات', items: [{ code: 'SKU-1', qty: 1, lineId: 'other-line' }] });
    const outcomes = await Promise.allSettled([
      action(unit, 'reserve', { transactionId: saleId, lineId: 'line-1' }),
      action(unit, 'reserve', { transactionId: otherSale, lineId: 'other-line' }),
    ]);
    expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(await Event.countDocuments({ action: 'reserved' })).toBe(1);
  });
  it('rejects adding unassigned identities when the warehouse has no remaining stock', async () => {
    await raw('products').updateOne({ _id: new Types.ObjectId(productId) }, { $set: { openingBalance: 0 } });
    await raw('transactions').updateOne({ _id: new Types.ObjectId(purchaseId) }, { $set: { 'items.0.qty': 1 } });
    const before = await service.reconciliation(); expect(before.rows[0].aggregateAvailable).toBe(0);
    await expect(available()).rejects.toThrow('أكواد القطع تتجاوز');
    expect(await Unit.countDocuments()).toBe(0);
    const after = await service.reconciliation(); expect(after.rows[0]).toMatchObject({ aggregateAvailable: 0, available: 0, onPremisesAllocated: 0 });
  });
  it('does not release automatically on cancellation and requires physical confirmation', async () => {
    let unit = await available(); unit = (await action(unit, 'reserve', { transactionId: saleId, lineId: 'line-1' })).unit;
    await raw('transactions').updateOne({ _id: new Types.ObjectId(saleId) }, { $set: { cancelled: true } });
    expect((await Unit.findById(unit._id))!.status).toBe('reserved');
    await expect(action(unit, 'release', { physicalPossessionConfirmed: false })).rejects.toThrow('custody');
    const released = await action(unit, 'release'); expect(released.unit.status).toBe('inspection-required'); expect(released.unit.assignment).toBeNull();
    expect((await Event.findOne({ action: 'released' }))!.transactionId).toBe(saleId);
  });
  it('blocks unavailable, damaged and lost units from allocation', async () => {
    for (const condition of ['damage', 'lost']) {
      const unit = (await action(await available(), condition)).unit;
      await expect(action(unit, 'reserve', { transactionId: saleId, lineId: 'line-1' })).rejects.toThrow('not available');
    }
  });
  it('retains before/after location, assignment and custody snapshots in immutable audit events', async () => {
    const unit = await available();
    await expect(action(unit, 'warehouse', { warehouseCode: 'COUNTED-SHELF-A' })).rejects.toThrow('استخدم نقل المخزون');
    expect((await Unit.findById(unit._id))!.warehouseCode).toBe('MAIN');
    expect(await Event.countDocuments({ action: 'warehouse-changed' })).toBe(0);
    const reserved = (await action(unit, 'reserve', { transactionId: saleId, lineId: 'line-1' })).unit;
    await action(reserved, 'release');
    expect((await Event.findOne({ action: 'released' }))!.details).toMatchObject({ fromAssignment: { transactionId: saleId, lineId: 'line-1' }, toAssignment: null });
  });
  it('keeps assigned loss recovery blocked and requires a physical loss count for unassigned pieces', async () => {
    const availableUnit = await available();
    await expect(action(availableUnit, 'lost', { physicalCountConfirmed: false })).rejects.toThrow('physical count');
    const unit = (await action(availableUnit, 'reserve', { transactionId: saleId, lineId: 'line-1' })).unit;
    await expect(action(unit, 'lost')).rejects.toThrow('custody recovery');
    await expect(action(unit, 'damage')).rejects.toThrow('custody recovery');
  });
  it('tracks preparation, physical shipment and return without reopening original dispatch entitlement', async () => {
    let unit = await available();
    unit = (await action(unit, 'reserve', { transactionId: saleId, lineId: 'line-1' })).unit;
    for (const step of ['picking', 'prepare']) unit = (await action(unit, step)).unit;
    const shipDto: any = { ...req(), action: 'ship', expectedVersion: unit.__v, physicalPossessionConfirmed: true, evidenceReference: 'Carrier handover' };
    unit = (await service.action(String(unit._id), shipDto, actor)).unit;
    expect((await service.action(String(unit._id), shipDto, actor)).unit.status).toBe('shipped');
    expect(await Event.countDocuments({ action: 'shipped' })).toBe(1);
    for (const step of ['deliver', 'return']) unit = (await action(unit, step)).unit;
    expect(unit.status).toBe('returned'); expect(unit.assignment).toBeNull();
    await expect(action(unit, 'inspect', { inspectionPassed: true })).rejects.toThrow('أكمل تسوية المرتجع');
    await expect(action(unit, 'reserve', { transactionId: saleId, lineId: 'line-1' })).rejects.toThrow();
    expect((await Unit.findById(unit._id))!.status).toBe('returned');
  });
  it('previews exact encoded values with quiet zones without recording a print', async () => {
    const { unit } = await register();
    await raw('products').updateOne({ _id: new Types.ObjectId(productId) }, { $set: { sellPrice: 249.5, buyPrice: 100 } });
    const preview = await service.preview({ ...req(), unitIds: [String(unit._id)], sizeId: '60x40' });
    expect(preview.labels[0].barcode).toBe(unit.barcode);
    expect(preview.labels[0].sellPrice).toBe(249.5);
    expect(preview.labels[0].receivedDate).toBeNull(); // Registration is not a known historical receipt.
    expect(preview.labels[0].svg).toBe(await QRCode.toString(unit.barcode, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 }));
    expect(preview.size).toMatchObject({ widthMm: 60, heightMm: 40 }); expect(await Event.countDocuments()).toBe(1);
  });
  it('logs requests and reprints, handles retries, rejects duplicates and unsupported dimensions', async () => {
    const { unit } = await register(); const dto: any = { ...req(), unitIds: [String(unit._id)], sizeId: '80x50' };
    const before = (await Unit.findById(unit._id).lean());
    const first = await service.labels(dto, actor); expect(first.labels[0].reprint).toBe(false); expect(first.physicalPrintingVerified).toBe(false);
    await service.labels(dto, actor); expect(await Event.countDocuments()).toBe(2);
    await expect(service.labels({ ...dto, operationKey: key() }, actor)).rejects.toMatchObject({ response: { code: 'LABEL_REPRINT_CONFIRMATION_REQUIRED' } });
    const reprint = await service.labels({ ...dto, operationKey: key(), allowReprint: true }, actor); expect(reprint.labels[0].reprint).toBe(true);
    expect(await Unit.findById(unit._id).lean()).toEqual(before);
    await expect(service.labels({ ...dto, unitIds: [String(unit._id), String(unit._id)] }, actor)).rejects.toThrow('distinct');
    await expect(service.labels({ ...dto, sizeId: '50x20' }, actor)).rejects.toThrow('supported');
  });
  it('handles concurrent label retries once and rolls back invalid mixed batches', async () => {
    const { unit } = await register(); const dto: any = { ...req(), unitIds: [String(unit._id)], sizeId: '60x40' };
    const responses = await Promise.all(Array.from({ length: 3 }, () => service.labels(dto, actor)));
    expect(responses.every(response => response.labels[0].reprint === false)).toBe(true);
    expect(await Event.countDocuments({ action: 'label-print-requested' })).toBe(1);
    await expect(service.labels({ ...dto, operationKey: key(), unitIds: [String(unit._id), key()] }, actor)).rejects.toThrow('not found');
    expect(await Event.countDocuments({ action: 'label-reprint-requested' })).toBe(0);
  });
  it('preserves aggregate stock, purchases, sales, deposits, vault entries and financial references', async () => {
    const finances = await raw('transactions').find({}).sort({ _id: 1 }).toArray(), vault = await raw('vaultentries').find({}).toArray();
    const before = await service.reconciliation(); expect(before.rows[0].aggregateAvailable).toBe(4);
    const unit = await available(); const reserved = (await action(unit, 'reserve', { transactionId: saleId, lineId: 'line-1' })).unit;
    await service.labels({ ...req(), unitIds: [String(unit._id)], sizeId: '60x40' }, actor); await action(reserved, 'release');
    const after = await service.reconciliation(); expect(after.rows[0].aggregateAvailable).toBe(4); expect(after.activationAllowed).toBe(false);
    const current = await raw('transactions').find({}).sort({ _id: 1 }).toArray(); current.forEach(row => delete row.unitTrackingRevision);
    expect(current).toEqual(finances); expect(await raw('vaultentries').find({}).toArray()).toEqual(vault);
  });
  it('records discrepancies without changing stock or activating enforcement', async () => {
    const result = await service.attestCount({ ...req(), productId, countReference: 'COUNT-2', observedUnallocated: 0, observedAllocatedOnPremises: 0, physicalPossessionConfirmed: true }, actor);
    expect(result).toMatchObject({ discrepancy: true, disposition: 'blocked-needs-review', activationAllowed: false, stockChanged: false });
    const review = await service.reviewCount({ ...req(), countOperationId: result.operationId, decision: 'accept-evidence' }, actor);
    expect(review).toMatchObject({ disposition: 'evidence-accepted-discrepancy-still-blocked', activationAllowed: false, stockChanged: false });
    const history = await service.countHistory(productId);
    expect(history.counts).toHaveLength(1); expect(history.reviews).toHaveLength(1);
    expect(history.counts[0].actorName).toBe('Verified Operator');
    await expect(service.reviewCount({ ...req(), countOperationId: result.operationId, decision: 'reject-evidence' }, actor)).rejects.toThrow('already reviewed');
    expect(await Unit.countDocuments()).toBe(0);
  });
  it('backs up and restores durable retry receipts into a separate isolated database', async () => {
    const dto = registration(); const original = await service.register(dto, actor);
    const target = mongo.connection.useDb('tracking_recovery_scratch');
    for (const name of ['products', 'users', 'transactions', 'vaultentries', 'inventorymovements', 'inventoryunits', 'inventoryunitevents', 'inventoryunitoperations']) {
      const docs = await raw(name).find({}).toArray(); if (docs.length) await target.collection(name).insertMany(docs);
    }
    await migrateInventoryUnitIndexes(target.db!, true);
    const restored = new InventoryUnitsService(target, target.model('InventoryUnit', InventoryUnitSchema), target.model('InventoryUnitEvent', InventoryUnitEventSchema), target.model('InventoryUnitOperation', InventoryUnitOperationSchema), (service as any).transactions, new UnitManualCodesService(target));
    expect(String((await restored.register(dto, actor)).unit._id)).toBe(String(original.unit._id));
    expect(await target.collection('inventoryunits').countDocuments()).toBe(1);
    expect(await target.collection('transactions').find({}).sort({ _id: 1 }).toArray()).toEqual(await raw('transactions').find({}).sort({ _id: 1 }).toArray());
    expect(await target.collection('vaultentries').find({}).toArray()).toEqual(await raw('vaultentries').find({}).toArray());
    expect(await target.collection('inventoryunitevents').countDocuments()).toBe(1);
  });
  it('enforces authentication, explicit read/print permissions and DTO validation over HTTP', async () => {
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { headers: { 'x-test-role': 'staff' } })).status).toBe(403);
    expect((await fetch(base, { headers: { 'x-test-role': 'reader' } })).status).toBe(200);
    for (const [role, route, body, expected] of [
      ['reader', '/labels/requests', { ...req(), unitIds: [productId], sizeId: '60x40' }, 403],
      ['admin', '', { ...registration(), observedPhysicalCount: -1 }, 400],
      ['staff', '/' + productId + '/actions', { ...req(), action: 'lost', expectedVersion: 0 }, 403],
    ] as const) expect((await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body) })).status).toBe(expected);
  });
  it('searches shared SKU/product attributes separately from unique unit barcode', async () => {
    const { unit } = await register();
    expect((await service.search({ q: 'XL' })).units).toHaveLength(1);
    const result = await service.search({ q: unit.barcode }); expect(result.units).toHaveLength(1); expect(result.products).toHaveLength(0);
    expect(result.units[0].product.code).toBe('SKU-1');
  });
  it('lists recent supplier invoices with per-line barcode coverage on the HTTP route', async () => {
    await raw('transactions').updateOne({ _id: new Types.ObjectId(purchaseId) }, { $set: { items: [{ code: 'SKU-1', name: 'Product One', qty: 3, lineId: 'purchase-line-1' }] } });
    await Unit.create({ productId, status: 'inspection-required', warehouseCode: null, origin: { kind: 'purchase', purchaseTransactionId: purchaseId }, registeredByUserId: actorId, registeredBy: 'Verified Operator' });
    const response = await fetch(base + '/purchases/receipts', { headers: { 'x-test-role': 'admin' } });
    expect(response.status).toBe(200);
    const invoices = await response.json();
    expect(invoices[0]).toMatchObject({ transactionId: purchaseId, ref: 'P1', lines: [{ lineId: 'purchase-line-1', sku: 'SKU-1', quantity: 3, createdUnits: 1 }] });
  });
  it('paginates and searches source invoices without silently hiding older purchases', async () => {
    const extra = Array.from({ length: 24 }, (_, i) => ({ _id: new Types.ObjectId(), type: 'مشتريات', ref: `OLDER-${i}`, client: i === 0 ? 'Needle+Supplier' : 'Another supplier', items: [{ code: 'SKU-1', qty: 1 }], createdAt: new Date(2026, 0, i + 1) }));
    await raw('transactions').insertMany(extra);
    const page = await (await fetch(base + '/purchases/receipts?page=2&limit=10', { headers: { 'x-test-role': 'admin' } })).json();
    expect(page).toMatchObject({ page: 2, limit: 10, total: 25 }); expect(page.receipts).toHaveLength(10);
    const found = await (await fetch(base + '/purchases/receipts?page=1&q=Needle%2BSupplier', { headers: { 'x-test-role': 'admin' } })).json();
    expect(found.total).toBe(1); expect(found.receipts[0].ref).toBe('OLDER-0');
    const direct = await (await fetch(base + `/purchases/receipts?page=1&transactionId=${purchaseId}`, { headers: { 'x-test-role': 'admin' } })).json();
    expect(direct.receipts[0].transactionId).toBe(purchaseId);
    expect((await fetch(base + '/purchases/receipts?page=-1', { headers: { 'x-test-role': 'admin' } })).status).toBe(400);
  });
  it('selects exact source-line pieces even when another SKU contains the requested SKU', async () => {
    const otherId = key();
    await raw('products').insertOne({ _id: new Types.ObjectId(otherId), code: 'SKU-10', name: 'Different product' });
    await raw('transactions').updateOne({ _id: new Types.ObjectId(purchaseId) }, { $set: { items: [{ code: 'SKU-1', qty: 3 }, { code: 'SKU-10', qty: 2 }] } });
    await service.identifyPurchaseLine(purchaseId, 0, { ...req(), sku: 'SKU-1', expectedQuantity: 3, physicalQuantity: 2, warehouseCode: 'MAIN', physicalPossessionConfirmed: true }, actor);
    await service.identifyPurchaseLine(purchaseId, 1, { ...req(), sku: 'SKU-10', expectedQuantity: 2, physicalQuantity: 1, warehouseCode: 'MAIN', physicalPossessionConfirmed: true }, actor);
    const exact = await (await fetch(base + `/purchases/${purchaseId}/lines/0/units?page=1&limit=1`, { headers: { 'x-test-role': 'admin' } })).json();
    expect(exact.total).toBe(2); expect(exact.units).toHaveLength(1); expect(exact.units[0].product.code).toBe('SKU-1');
    const second = await service.purchaseLineUnits(purchaseId, 0, { page: '2', limit: '1' });
    expect(second.units[0]._id.toString()).not.toBe(exact.units[0]._id); expect(second.units[0].product?.code).toBe('SKU-1');
    expect((await fetch(base + `/purchases/${purchaseId}/lines/0/units`, { headers: { 'x-test-role': 'reader' } })).status).toBe(403);
  });
  it('does not attribute legacy generic pieces to ambiguous repeated SKU lines', async () => {
    await Unit.create({ productId, status: 'inspection-required', origin: { kind: 'purchase', purchaseTransactionId: purchaseId }, registeredByUserId: actorId, registeredBy: 'Operator' });
    await raw('transactions').updateOne({ _id: new Types.ObjectId(purchaseId) }, { $set: { items: [{ code: 'SKU-1', qty: 1 }, { code: 'SKU-1', qty: 2 }] } });
    expect((await service.purchaseLineUnits(purchaseId, 0)).total).toBe(0);
    expect((await service.purchaseLineUnits(purchaseId, 1)).total).toBe(0);
  });
  it('registers only invoice-linked units confirmed physically on hand without posting stock twice', async () => {
    const body = { ...req(), sku: 'SKU-1', expectedQuantity: 3, physicalQuantity: 2, warehouseCode: 'MAIN', physicalPossessionConfirmed: true };
    const send = () => fetch(`${base}/purchases/${purchaseId}/lines/0/identify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': 'admin' }, body: JSON.stringify(body) });
    const first = await send(); expect(first.status).toBe(201);
    const result = await first.json(); expect(result).toMatchObject({ transactionId: purchaseId, expectedQuantity: 3, previouslyIdentified: 0, createdUnits: 2, stockChanged: false, status: 'inspection-required' });
    const retry = await send(); expect(await retry.json()).toEqual(result);
    await expect(service.identifyPurchaseLine(purchaseId, 0, { ...body, operationKey: key() }, actor)).rejects.toThrow('already have identities');
    const purchase = await raw('transactions').findOne({ _id: new Types.ObjectId(purchaseId) });
    expect(purchase.items[0].qty).toBe(3); expect(await Unit.countDocuments({ 'origin.purchaseTransactionId': purchaseId })).toBe(2);
    const summary = await service.purchaseReceipts(); expect(summary[0].lines[0]).toMatchObject({ createdUnits: 2, onHandUnits: 2, lineId: result.lineId });
  });
  it('serves the actual create, lookup, configuration, preview and print HTTP contracts with authenticated attribution', async () => {
    const http = async (route: string, body?: any) => {
      const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'x-test-role': 'admin' }, body: body ? JSON.stringify(body) : undefined });
      expect(response.ok).toBe(true); return response.json();
    };
    const created = await http('', { ...registration(), registeredBy: 'Forged Operator' });
    expect(created.unit.registeredBy).toBe('Verified Operator');
    const config = await http('/config'); expect(config.enforcementEnabled).toBe(false);
    expect((await http('/' + created.unit.barcode)).unit._id).toBe(created.unit._id);
    const body = { ...req(), unitIds: [created.unit._id], sizeId: config.labelSizes[0].id };
    expect((await http('/labels/preview', body)).labels[0].barcode).toBe(created.unit.barcode);
    const printed = await http('/labels/requests', body);
    expect(printed).toMatchObject({ physicalPrintingVerified: false, stockChanged: false });
    expect((await Event.findOne({ action: 'label-print-requested' }))!.byUserId).toBe(actorId);
  });
});

describe('Standalone MongoDB safety', () => {
  it('rejects all writes rather than falling back to non-atomic operations', async () => {
    const mongo = await trackingMongo(false);
    try {
      await migrateInventoryUnitIndexes(mongo.connection.db!, true);
      const service = new InventoryUnitsService(mongo.connection, mongo.connection.model('InventoryUnit', InventoryUnitSchema), mongo.connection.model('InventoryUnitEvent', InventoryUnitEventSchema), mongo.connection.model('InventoryUnitOperation', InventoryUnitOperationSchema), {} as any, new UnitManualCodesService(mongo.connection));
      expect((await service.readiness()).writesReady).toBe(false);
      await expect(service.register({ operationKey: 'standalone-test', reason: 'Test' } as any, { userId: new Types.ObjectId().toHexString(), role: 'admin' })).rejects.toThrow('replica set');
    } finally { await mongo.close(); }
  }, 30000);
});
