import { Logger, INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Model, Types } from 'mongoose';
import { trackingMongo } from '../helpers/tracking-mongo';
import { PurchaseReceivingService } from '../../src/purchase-orders/purchase-receiving.service';
import { PurchaseOrdersService } from '../../src/purchase-orders/purchase-orders.service';
import { PurchaseOrdersController } from '../../src/purchase-orders/purchase-orders.controller';
import { PurchaseOrderSchema } from '../../src/purchase-orders/schemas/purchase-order.schema';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';
import { ProductsService } from '../../src/products/products.service';
import { ProductSchema } from '../../src/products/schemas/product.schema';
import { SettingsService } from '../../src/settings/settings.service';
import { SettingsSchema } from '../../src/settings/schemas/settings.schema';
import { VaultService } from '../../src/vault/vault.service';
import { VaultEntrySchema } from '../../src/vault/schemas/vault-entry.schema';
import { SupplierLedgerService } from '../../src/supplier-ledger/supplier-ledger.service';
import { SupplierLedgerEntrySchema } from '../../src/supplier-ledger/schemas/supplier-ledger-entry.schema';
import { InventoryMovementsService } from '../../src/inventory-movements/inventory-movements.service';
import { InventoryMovementSchema } from '../../src/inventory-movements/schemas/inventory-movement.schema';
import { InventoryUnitsService } from '../../src/inventory-units/inventory-units.service';
import { UnitManualCodesService } from '../../src/inventory-units/unit-manual-codes.service';
import { InventoryUnitSchema } from '../../src/inventory-units/schemas/inventory-unit.schema';
import { InventoryUnitEventSchema } from '../../src/inventory-units/schemas/inventory-unit-event.schema';
import { InventoryUnitOperationSchema } from '../../src/inventory-units/schemas/inventory-unit-operation.schema';
import { migrateInventoryUnitIndexes } from '../../src/inventory-units/inventory-unit-index.migration';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { ManualPurchaseReceivingService } from '../../src/inventory-units/manual-purchase-receiving.service';
import { InventoryUnitsController } from '../../src/inventory-units/inventory-units.controller';
import { InventoryScanningService } from '../../src/inventory-units/inventory-scanning.service';
import { ScannedSaleService } from '../../src/inventory-units/scanned-sale.service';
import { HttpExceptionFilter } from '../../src/core/filters/http-exception.filter';
import { InventoryPacksService } from '../../src/inventory-units/inventory-packs.service';
import { DepositReceiptsService } from '../../src/shopify/deposit-receipts.service';
import { ManualDepositReceiptSchema } from '../../src/shopify/schemas/manual-deposit-receipt.schema';

describe('Atomic purchase receiving with actual financial writers on disposable replica set', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>, models: Record<string, Model<any>>;
  let transactions: TransactionsService, units: InventoryUnitsService, receiving: PurchaseReceivingService, orders: PurchaseOrdersService;
  let vault: VaultService, ledger: SupplierLedgerService, movements: InventoryMovementsService;
  let manual: ManualPurchaseReceivingService;
  let scannedSales: ScannedSaleService;
  let productId: string, supplierId: string, actorId: string, actor: any, presence: any, app: INestApplication, base: string;
  const id = () => new Types.ObjectId().toHexString();
  const raw = (name: string) => mongo.connection.collection(name);
  async function po(status = 'مستلم', qty = 3) {
    return (await raw('purchaseorders').insertOne({ supplierId, supplierName: 'Supplier One', poNumber: 'PO-' + id(), status,
      createdDate: '2026-10-17', createdBy: 'Operator', linkedTransactionId: '', statusHistory: [],
      items: [{ productCode: 'SKU-1', productName: 'Basket', productImage: '', qty, unitPrice: 20, total: qty * 20 }] })).insertedId.toHexString();
  }
  function payload(extra: any = {}) {
    return { ref: '100', date: '2026-10-17', deposit: 20, discount: 5, depMethod: 'كاش', createdBy: 'Forged Name',
      items: [{ productId, code: 'SKU-1', name: 'Basket', qty: 3, price: 20, purchaseOrderLineIndex: 0 }],
      tracking: { physicalPossessionConfirmed: true, warehouseCode: 'ACTUAL-SHELF-A', reason: 'Counted signed delivery note' }, ...extra };
  }
  async function baseline() {
    return { stock: (await transactions.getInventory())[0].current, cash: (await models.Settings.findOne())!.vaultCash,
      debt: await ledger.getCurrentBalance(supplierId), transactions: await models.Transaction.countDocuments(),
      movements: await models.InventoryMovement.countDocuments(), vault: await models.VaultEntry.countDocuments(), units: await models.InventoryUnit.countDocuments() };
  }
  beforeAll(async () => {
    mongo = await trackingMongo(); models = {};
    for (const [name, schema] of Object.entries({ Product: ProductSchema, Transaction: TransactionSchema, PurchaseOrder: PurchaseOrderSchema,
      Settings: SettingsSchema, VaultEntry: VaultEntrySchema, SupplierLedgerEntry: SupplierLedgerEntrySchema, InventoryMovement: InventoryMovementSchema,
      InventoryUnit: InventoryUnitSchema, InventoryUnitEvent: InventoryUnitEventSchema, InventoryUnitOperation: InventoryUnitOperationSchema, ManualDepositReceipt: ManualDepositReceiptSchema })) {
      models[name] = mongo.connection.model(name, schema);
      await models[name].createCollection();
      if (!name.startsWith('InventoryUnit')) await models[name].createIndexes();
    }
    await migrateInventoryUnitIndexes(mongo.connection.db!, true);
    const settings: any = Object.create(SettingsService.prototype); settings.settingsModel = models.Settings;
    presence = { emitEvent: jest.fn() };
    vault = new VaultService(models.VaultEntry, settings, presence);
    ledger = new SupplierLedgerService(models.SupplierLedgerEntry, vault);
    const products: any = Object.create(ProductsService.prototype); products.productModel = models.Product;
    transactions = Object.create(TransactionsService.prototype);
    movements = new InventoryMovementsService(models.InventoryMovement, products, transactions);
    Object.assign(transactions, { transactionModel: models.Transaction, productsService: products, vaultService: vault, settingsService: settings,
      presence, inventoryMovementsService: movements, supplierLedgerService: ledger, suppliersService: { findAll: () => raw('suppliers').find({}).toArray() },
      discountOtpService: { assertPurchaseOtp: jest.fn(), attachToTransaction: jest.fn().mockResolvedValue(undefined) },
      logger: new Logger('IsolatedReceiptTest'), _recentSubmissions: new Map(), _SUBMIT_DEDUP_MS: 15000 });
    const manualCodes = new UnitManualCodesService(mongo.connection); await manualCodes.onModuleInit();
    units = new InventoryUnitsService(mongo.connection, models.InventoryUnit, models.InventoryUnitEvent, models.InventoryUnitOperation, transactions, manualCodes);
    await units.onModuleInit();
    receiving = new PurchaseReceivingService(mongo.connection, units, transactions);
    manual = new ManualPurchaseReceivingService(mongo.connection, units, transactions);
    scannedSales = new ScannedSaleService(mongo.connection, units, transactions);
    const receiptService: any = Object.create(DepositReceiptsService.prototype); receiptService.manualReceiptModel = models.ManualDepositReceipt;
    (transactions as any).depositReceiptsService = receiptService;
    orders = new PurchaseOrdersService(models.PurchaseOrder, transactions, receiving);
    const module = await Test.createTestingModule({ controllers: [PurchaseOrdersController, InventoryUnitsController], providers: [
      { provide: PurchaseOrdersService, useValue: orders }, { provide: PurchaseReceivingService, useValue: receiving },
      { provide: InventoryUnitsService, useValue: units }, { provide: ManualPurchaseReceivingService, useValue: manual },
      { provide: ScannedSaleService, useValue: scannedSales },
      { provide: InventoryScanningService, useValue: new InventoryScanningService(mongo.connection, models.InventoryUnit, models.InventoryUnitEvent, models.InventoryUnitOperation, units) },
    ] }).overrideGuard(JwtAuthGuard).useValue({ canActivate(context: any) {
      const request = context.switchToHttp().getRequest(), role = request.headers['x-test-role'];
      if (!role) throw new UnauthorizedException();
      request.user = { ...actor, role: role === 'admin' ? 'admin' : 'staff', perms: role === 'buyer' ? ['purchase-create'] : role === 'viewer' ? ['purchase-view'] : role === 'receiver' ? ['purchase-create', 'purchase-view', 'inventory-units-receive'] : [] }; return true;
    } }).compile();
    app = module.createNestApplication(); app.useLogger(false); app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  }, 40000);
  beforeEach(async () => {
    await raw('warehouses').updateOne({ code: 'ACTUAL-SHELF-A' }, { $setOnInsert: { code: 'ACTUAL-SHELF-A', active: true } }, { upsert: true });
    for (const name of ['products', 'transactions', 'purchaseorders', 'settings', 'vaultentries', 'supplierledgerentries', 'inventorymovements', 'inventoryunits', 'inventoryunitevents', 'inventoryunitoperations', 'inventoryunitprelabels', 'inventoryunitprelabelbatches', 'manualdepositreceipts', 'users', 'suppliers', 'inventorypacks', 'inventoryunitprelabelpacks']) await raw(name).deleteMany({});
    productId = id(); supplierId = id(); actorId = id(); actor = { userId: actorId, role: 'admin', name: 'Forged Request Name' };
    await raw('users').insertOne({ _id: new Types.ObjectId(actorId), name: 'Authenticated Receiver', role: 'admin', isActive: true });
    await raw('suppliers').insertOne({ _id: new Types.ObjectId(supplierId), name: 'Supplier One' });
    await raw('products').insertOne({ _id: new Types.ObjectId(productId), code: 'SKU-1', name: 'Basket', openingBalance: 7, buyPrice: 18, sellPrice: 30 });
    await raw('settings').insertOne({ vaultCash: 1000, vaultVodafone: 0, vaultInstapay: 0, vaultBank: 0, vaultBalance: 1000, otpEnabled: false, purchaseOtpEnabled: false });
    await raw('supplierledgerentries').insertOne({ supplierId, amount: 100, runningBalance: 100, entryType: 'manual-adjustment', createdAt: new Date('2026-10-01T00:00:00Z') });
    presence.emitEvent.mockClear();
  });
  afterAll(async () => { await app?.close(); await mongo?.close(); });

  async function scannedPayload(count = 1) {
    const pieces: string[] = [];
    for (let i = 0; i < count; i++) {
      const pieceId = id(); pieces.push(pieceId);
      await raw('inventoryunits').insertOne({ _id: new Types.ObjectId(pieceId), barcode: 'SU-' + pieceId.toUpperCase(), productId,
        warehouseCode: 'MAIN', status: 'available', assignment: null, __v: 0, registeredBy: 'Authenticated Receiver', registeredByUserId: actorId, origin: { kind: 'legacy-unknown', reconciliationRef: 'TEST-COUNT' } });
    }
    return { operationKey: id(), invoice: { type: 'مبيعات', date: '2026-10-20', ref: '200', warehouseCode: 'MAIN', client: 'Customer', employee: 'Forged employee', carrierCode: 'bosta', shipCo: 'Bosta',
      items: [{ productId, code: 'SKU-1', name: 'Basket', qty: count, price: 30, total: count * 30 }], itemsTotal: count * 30,
      total: count * 30, deposit: 10, remaining: count * 30 - 10, depMethod: 'كاش' }, bindings: [{ productId, unitIds: pieces }] };
  }
  it('saves a scanned sale, money, stock movement and exact physical reservations once', async () => {
    const request = await scannedPayload(2);
    const [first, concurrent] = await Promise.all([scannedSales.create(request as any, actor), scannedSales.create(request as any, actor)]);
    expect(String(concurrent.transaction._id)).toBe(String(first.transaction._id));
    const replay = await new ScannedSaleService(mongo.connection, units, transactions).create(request as any, actor);
    expect(String(first.transaction._id)).toBe(String(replay.transaction._id));
    expect(await models.Transaction.countDocuments()).toBe(1);
    expect((await transactions.getInventory())[0].current).toBe(5);
    expect((await models.Settings.findOne())!.vaultCash).toBe(1010);
    expect(await models.VaultEntry.countDocuments()).toBe(1);
    const pieces = await models.InventoryUnit.find().lean();
    expect(pieces.every(piece => piece.status === 'reserved' && piece.assignment.transactionId === String(first.transaction._id) && piece.assignment.lineId === first.transaction.items[0].lineId)).toBe(true);
    expect(await models.InventoryUnitEvent.countDocuments({ action: 'reserved' })).toBe(2);
    expect(await models.InventoryMovement.countDocuments()).toBe(1);
    await expect(scannedSales.create({ ...request, invoice: { ...request.invoice, ref: '999' } } as any, actor)).rejects.toThrow('different payload');
  });
  it('rolls back sale and money when a later physical reservation fails', async () => {
    const request = await scannedPayload(2), before = await baseline();
    const real = units.actionInSession.bind(units); let calls = 0;
    const spy = jest.spyOn(units, 'actionInSession').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('Injected second piece failure');
      return real(...args);
    });
    try { await expect(scannedSales.create(request as any, actor)).rejects.toThrow('second piece'); }
    finally { spy.mockRestore(); }
    expect(await baseline()).toEqual(before);
    expect(await models.InventoryUnit.countDocuments({ status: 'reserved' })).toBe(0);
    expect(await models.InventoryUnitEvent.countDocuments()).toBe(0);
    expect(presence.emitEvent.mock.calls.some((row: any[]) => row[0] === 'tx:created')).toBe(false);
  });
  it('does not sell the same physical piece to two concurrent scanned orders', async () => {
    const request = await scannedPayload();
    const results = await Promise.allSettled([scannedSales.create(request as any, actor), scannedSales.create({ ...request, operationKey: id(), invoice: { ...request.invoice, ref: '201' } } as any, actor)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await models.Transaction.countDocuments()).toBe(1);
    expect((await models.Settings.findOne())!.vaultCash).toBe(1010);
  });
  it('rejects a mismatched warehouse and quantity before creating any financial entry', async () => {
    const request = await scannedPayload(2);
    await raw('inventoryunits').updateOne({ _id: new Types.ObjectId(request.bindings[0].unitIds[0]) }, { $set: { warehouseCode: 'ACTUAL-SHELF-A' } });
    await expect(scannedSales.create(request as any, actor)).rejects.toThrow('warehouse');
    expect(await models.Transaction.countDocuments()).toBe(0);
    const smaller = { ...request, invoice: { ...request.invoice, items: [{ ...request.invoice.items[0], qty: 1, total: 30 }], itemsTotal: 30, total: 30, remaining: 20 } };
    await expect(scannedSales.create(smaller as any, actor)).rejects.toThrow('quantity');
  });
  it('keeps deposit receipt claiming and consumption in the same transaction as scanned reservations', async () => {
    const request: any = await scannedPayload(); request.invoice.manualDepositReceiptId = 'receipt-scanned-sale';
    await models.ManualDepositReceipt.create({ receiptId: request.invoice.manualDepositReceiptId, ownerId: actorId, state: 'submitted', expiresAt: new Date(Date.now() + 60000).toISOString(),
      receipt: { amount: 10, method: 'كاش', imageKey: 'receipts/manual/draft/image.jpg', submittedBy: 'Uploader', submittedAt: new Date().toISOString(), needsReview: false, ocr: { amount: 10, method: 'كاش' } } });
    const spy = jest.spyOn(units, 'actionInSession').mockRejectedValueOnce(new Error('Reject piece'));
    await expect(scannedSales.create(request, actor)).rejects.toThrow('Reject piece'); spy.mockRestore();
    expect((await models.ManualDepositReceipt.findOne())!.state).toBe('submitted');
    expect(await models.Transaction.countDocuments()).toBe(0);
    await scannedSales.create(request, actor);
    expect((await models.ManualDepositReceipt.findOne())!.state).toBe('consumed');
    expect((await models.Settings.findOne())!.vaultCash).toBe(1010);
    expect(await vault.receiptOperationApplied(request.invoice.manualDepositReceiptId, 'approve')).toBe(true);
    await vault.addSystemEntry(-10, 'كاش', 'Receipt refund', '2026-10-20', 'Refund', '200', undefined, 'Operator', { receiptId: request.invoice.manualDepositReceiptId });
    await vault.addSystemEntry(-10, 'كاش', 'Receipt refund', '2026-10-20', 'Refund', '200', undefined, 'Operator', { receiptId: request.invoice.manualDepositReceiptId });
    expect((await models.Settings.findOne())!.vaultCash).toBe(1000);
  });
  it('reserves a sealed pack together and accepts its later preparation scan for that order', async () => {
    const request: any = await scannedPayload(2), packId = id();
    await raw('inventorypacks').insertOne({ _id: new Types.ObjectId(packId), barcode: 'PK-' + packId.toUpperCase(), productId, warehouseCode: 'MAIN', state: 'sealed', quantity: 2, unitIds: request.bindings[0].unitIds, revision: 0 });
    await raw('inventoryunits').updateMany({}, { $set: { packId } });
    request.bindings = [{ productId, packIds: [packId] }];
    const result = await scannedSales.create(request, actor);
    await models.Transaction.updateOne({ _id: result.transaction._id }, { $set: { pickupStatus: 'Preparing' } });
    const packs = new InventoryPacksService(mongo.connection, models.InventoryUnit, units);
    const scanned = await packs.scan(String(result.transaction._id), { operationKey: id(), reason: 'Physical pack verified', identifier: 'PK-' + packId.toUpperCase(), lineId: result.transaction.items[0].lineId, physicalPossessionConfirmed: true }, actor);
    expect(scanned.quantity).toBe(2);
    expect(await models.InventoryUnit.countDocuments({ status: 'picking' })).toBe(2);
  });
  it.each([false, true])('scans and approves existing receipt pieces after a quantity increase, while rejecting later overcoverage (reduce=%s)', async reduce => {
    const receipt = await manual.receive(manualPayload(), actor);
    const unitId = receipt.receipt.unitIds[0];
    const initial: any = await models.InventoryUnit.findById(unitId).lean();
    await units.action(unitId, { operationKey: id(), reason: 'Physical inspection', action: 'inspect', expectedVersion: initial.__v,
      physicalPossessionConfirmed: true, inspectionPassed: true }, actor);
    await models.Transaction.updateOne({ _id: receipt.transaction._id }, { $set: { 'items.0.qty': 5 } });
    const saleId = id();
    await raw('transactions').insertOne({ _id: new Types.ObjectId(saleId), type: 'مبيعات', ref: 'SALE-PREP', warehouseCode: initial.warehouseCode, pickupStatus: 'Preparing',
      items: [{ lineId: 'sale-line', code: 'SKU-1', productId, qty: 1, price: 30 }] });
    const before = await baseline();
    const post = (path: string, data: any) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': 'admin' }, body: JSON.stringify(data) });
    const scanned = await post(`/inventory-units/orders/${saleId}/picking/scans`, { operationKey: id(), reason: 'Physical piece scanned', identifier: initial.barcode,
      lineId: 'sale-line', physicalPossessionConfirmed: true });
    expect(scanned.status).toBe(201);
    const picked: any = await models.InventoryUnit.findById(unitId).lean();
    if (reduce) await models.Transaction.updateOne({ _id: receipt.transaction._id }, { $set: { 'items.0.qty': 2 } });
    const approved = await post(`/inventory-units/${unitId}/actions`, { operationKey: id(), reason: 'Approve physical piece', action: 'prepare',
      expectedVersion: picked.__v, transactionId: saleId, lineId: 'sale-line', physicalPossessionConfirmed: true });
    expect(approved.status).toBe(reduce ? 409 : 201);
    const response: any = await approved.json();
    if (reduce) expect(response).toMatchObject({ code: 'PURCHASE_RECEIPT_RECONCILIATION_REQUIRED', purchaseTransactionId: String(receipt.transaction._id), invoiceQuantity: 2, registeredQuantity: 3 });
    else {
      expect(response.unit.status).toBe('prepared');
      expect(await baseline()).toEqual(before);
    }
    expect((await models.InventoryUnit.findById(unitId).lean() as any).status).toBe(reduce ? 'picking' : 'prepared');
  });

  it('protects the scanned-sale HTTP route with authentication, allocation permission and nested DTO validation', async () => {
    const request = await scannedPayload();
    const http = (role?: string, body: any = request) => fetch(base + '/inventory-units/sales', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(role ? { 'x-test-role': role } : {}) }, body: JSON.stringify(body) });
    expect((await http()).status).toBe(401);
    expect((await http('viewer')).status).toBe(403);
    expect((await http('admin', { ...request, bindings: [{ productId, unitIds: ['invalid'] }] })).status).toBe(400);
    const response = await http('admin'); const result = await response.json();
    expect({ status: response.status, result }).toMatchObject({ status: 201, result: { reservedPieces: 1 } });
  });

  function manualPayload(extra: any = {}) {
    return { operationKey: id(), tracking: payload().tracking, invoice: { type: 'مشتريات', date: '2026-10-17', transactionDate: '2026-10-17', ref: '100',
      client: 'Supplier One', supplierId, employee: 'Forged Name', items: [{ productId, code: 'SKU-1', name: 'Basket', qty: 3, price: 20, total: 60 }],
      itemsTotal: 60, discount: 5, total: 55, deposit: 20, remaining: 35, creditApplied: 0, depMethod: 'كاش', payment: 'كاش', payStatus: 'معلق', ...extra } };
  }
  it('persists purchase quantities against their receiving warehouse independently', async () => {
    const secondary = await transactions.create({ ...manualPayload().invoice, ref: '883001', warehouseCode: 'ACTUAL-SHELF-A' } as any,
      'admin', undefined, 'Authenticated Receiver');
    const main = await transactions.create({ ...manualPayload().invoice, ref: '883002', warehouseCode: 'MAIN',
      items: [{ productId, code: 'SKU-1', name: 'Basket', qty: 2, price: 20, total: 40 }],
      itemsTotal: 40, discount: 0, total: 40, deposit: 0, remaining: 40 } as any,
      'admin', undefined, 'Authenticated Receiver');
    expect((await models.Transaction.findById(secondary._id).lean() as any).warehouseCode).toBe('ACTUAL-SHELF-A');
    expect((await models.Transaction.findById(main._id).lean() as any).warehouseCode).toBe('MAIN');
    const inventory = (await transactions.getInventory()).find(row => row.code === 'SKU-1');
    expect(inventory?.warehouseBalances).toMatchObject({ MAIN: 9, 'ACTUAL-SHELF-A': 3 });
    expect(inventory?.current).toBe(12);
    const movements = await models.InventoryMovement.find().lean() as any[];
    expect(movements).toEqual(expect.arrayContaining([
      expect.objectContaining({ warehouseCode: 'ACTUAL-SHELF-A', qtyDelta: 3 }),
      expect.objectContaining({ warehouseCode: 'MAIN', qtyDelta: 2 }),
    ]));
  });
  it('rejects tracked receiving into a warehouse different from its purchase invoice', async () => {
    const request = manualPayload();
    request.invoice.warehouseCode = 'MAIN';
    await expect(manual.receive(request, actor)).rejects.toThrow('مخزن القطع يجب أن يطابق مخزن فاتورة الشراء');
    expect(await models.Transaction.countDocuments()).toBe(0);
    expect(await models.InventoryUnit.countDocuments()).toBe(0);
    expect((await transactions.getInventory()).find(row => row.code === 'SKU-1')?.warehouseBalances).toMatchObject({ MAIN: 7 });
  });
  it('receives a manual purchase as exactly one invoice with traceable units and no invented PO', async () => {
    const result = await manual.receive(manualPayload(), actor);
    expect(await baseline()).toEqual({ stock: 10, cash: 980, debt: 135, transactions: 1, movements: 1, vault: 1, units: 3 });
    expect(result.transaction.employee).toBe('Authenticated Receiver'); expect(await raw('purchaseorders').countDocuments()).toBe(0);
    for (const unit of await models.InventoryUnit.find().lean() as any[]) {
      expect(unit.origin.purchaseOrderId).toBeUndefined();
      expect(unit.origin.purchaseTransactionId).toBe(String(result.transaction._id));
      expect(unit.origin.purchaseLineId).toBe(result.transaction.items[0].lineId);
      expect(unit.status).toBe('inspection-required');
    }
    expect((await manual.summary(String(result.transaction._id))).createdUnits).toBe(3);
    const labels = await units.preview({ operationKey: 'receipt-label-preview', reason: 'Label date verification', unitIds: result.receipt.unitIds, sizeId: '50x30' });
    const event: any = await raw('inventoryunitevents').findOne({ unitId: result.receipt.unitIds[0], action: 'registered' });
    const expectedDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(event.createdAt);
    expect(labels.labels.every(label => label.receivedDate === expectedDate)).toBe(true);
    expect(await baseline()).toEqual({ stock: 10, cash: 980, debt: 135, transactions: 1, movements: 1, vault: 1, units: 3 });
  });
  it('saves a normal purchase invoice, then receives preprinted identities by scan and stored range without duplicate stock', async () => {
    const issued = await units.issuePrelabels({ operationKey: id(), reason: 'Supplier labels', productId, quantity: 3 }, actor);
    const printed = await units.printPrelabels(issued.batchId, { operationKey: id(), reason: 'Print supplier labels', start: 1,
      quantity: 3, sizeId: '50x30' }, actor);
    expect(await baseline()).toEqual({ stock: 7, cash: 1000, debt: 100, transactions: 0, movements: 0, vault: 0, units: 0 });
    const invoice = await transactions.create({ ...manualPayload().invoice, warehouseCode: 'ACTUAL-SHELF-A' } as any,
      'admin', undefined, 'Authenticated Receiver');
    const invoiceId = String(invoice._id);
    expect(await baseline()).toEqual({ stock: 10, cash: 980, debt: 135, transactions: 1, movements: 1, vault: 1, units: 0 });
    const optionsResponse = await fetch(`${base}/inventory-units/purchases/${invoiceId}/prelabels/options`,
      { headers: { 'x-test-role': 'receiver' } });
    expect(optionsResponse.status).toBe(200);
    expect(await optionsResponse.json()).toMatchObject({ receipt: { transactionId: invoiceId,
      lines: [{ quantity: 3, createdUnits: 0 }] }, batches: [{ batchId: issued.batchId, unused: 3 }] });
    const scanned = await units.prelabelLookup(printed.labels[0].barcode);
    expect(scanned).toMatchObject({ batchId: issued.batchId, ordinal: 1, state: 'unused', printCount: 1 });
    const scanResponse = await fetch(`${base}/inventory-units/purchases/${invoiceId}/prelabels/link`, { method: 'POST',
      headers: { 'x-test-role': 'receiver', 'Content-Type': 'application/json' }, body: JSON.stringify({ operationKey: id(), reason: 'Physical QR scan', batchId: scanned.batchId,
      lineIndex: 0, start: scanned.ordinal, quantity: 1, physicalPossessionConfirmed: true,
      physicalLabelsConfirmed: true, inspectionPassed: true }) });
    expect(scanResponse.status).toBe(201);
    const byScan = await scanResponse.json();
    const byRange = await units.linkPrelabels(invoiceId, { operationKey: id(), reason: 'Counted stored range', batchId: issued.batchId,
      lineIndex: 0, start: 2, quantity: 2, physicalPossessionConfirmed: true,
      physicalLabelsConfirmed: true, inspectionPassed: true }, actor);
    expect(byScan.linked).toBe(1); expect(byRange.linked).toBe(2);
    expect((await units.purchaseReceipts({ transactionId: invoiceId }) as any)[0].lines[0].createdUnits).toBe(3);
    expect((await units.purchaseReceipts({ transactionId: invoiceId, page: '1' }) as any).receipts[0].lines[0].createdUnits).toBe(3);
    expect((await units.lookup(printed.labels[0].barcode)).unit.status).toBe('available');
    expect((await units.prelabelLookup(printed.labels[0].barcode)).state).toBe('linked');
    expect(await baseline()).toEqual({ stock: 10, cash: 980, debt: 135, transactions: 1, movements: 1, vault: 1, units: 3 });
  });
  it('persists same-key manual retries through concurrency and service restart', async () => {
    const request = manualPayload(); const results = await Promise.all(Array.from({ length: 4 }, () => manual.receive(request, actor)));
    expect(new Set(results.map(row => String(row.transaction._id))).size).toBe(1);
    const restarted = new ManualPurchaseReceivingService(mongo.connection, units, transactions);
    expect((await restarted.receive(request, actor)).receipt.unitIds).toEqual(results[0].receipt.unitIds);
    await expect(manual.receive({ ...request, tracking: { ...request.tracking, reason: 'Changed evidence' } }, actor)).rejects.toThrow('different payload');
    expect(await baseline()).toEqual({ stock: 10, cash: 980, debt: 135, transactions: 1, movements: 1, vault: 1, units: 3 });
  });
  it('serializes mixed manual/PO receipts and different manual keys using the same reference', async () => {
    const orderId = await po(); await Promise.all([manual.receive(manualPayload(), actor), receiving.convert(orderId, payload({ ref: '101' }), actor)]);
    expect(await baseline()).toEqual({ stock: 13, cash: 960, debt: 170, transactions: 2, movements: 2, vault: 2, units: 6 });
    const results = await Promise.allSettled([manual.receive(manualPayload({ ref: '102' }), actor), manual.receive(manualPayload({ ref: '102' }), actor)]);
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  });
  it.each(['units', 'credit'])('rolls back manual receipt finance and identity on %s failure', async failure => {
    const request = manualPayload();
    if (failure === 'credit') { await raw('supplierledgerentries').updateMany({}, { $set: { runningBalance: -50 } }); request.invoice.creditApplied = 10; request.invoice.remaining = 25; }
    const before = await baseline();
    const spy = failure === 'units' ? jest.spyOn(models.InventoryUnit.collection, 'insertMany') : jest.spyOn(ledger, 'postCreditUsed');
    spy.mockRejectedValueOnce(new Error('Manual receipt interruption'));
    await expect(manual.receive(request, actor)).rejects.toThrow('interruption'); spy.mockRestore();
    expect(await baseline()).toEqual(before); expect(await models.InventoryUnitOperation.countDocuments()).toBe(0);
    expect((await manual.receive(request, actor)).receipt.createdUnits).toBe(3);
  });
  it('keeps the existing supplier credit/debt arithmetic inside the manual receipt transaction', async () => {
    await raw('supplierledgerentries').updateMany({}, { $set: { runningBalance: -50 } });
    const result = await manual.receive(manualPayload({ creditApplied: 15, remaining: 20 }), actor);
    expect(await baseline()).toEqual({ stock: 10, cash: 980, debt: -15, transactions: 1, movements: 1, vault: 1, units: 3 });
    expect(result.transaction).toMatchObject({ creditApplied: 15, remaining: 20, deposit: 20, total: 55 });
    expect(await models.SupplierLedgerEntry.countDocuments({ entryType: 'credit-used' })).toBe(1);
    await expect(manual.receive(manualPayload({ ref: '101', creditApplied: 20, remaining: 15 }), actor)).rejects.toThrow('الرصيد');
  });
  it('does not overspend standing credit under concurrent manual receipts', async () => {
    await raw('supplierledgerentries').updateMany({}, { $set: { runningBalance: -50 } });
    const results = await Promise.allSettled([manual.receive(manualPayload({ creditApplied: 30, remaining: 5 }), actor), manual.receive(manualPayload({ ref: '101', creditApplied: 30, remaining: 5 }), actor)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await baseline()).toEqual({ stock: 10, cash: 980, debt: -15, transactions: 1, movements: 1, vault: 1, units: 3 });
  });
  it('does not withdraw cash when an existing supplier credit fully pays a manual invoice', async () => {
    await raw('supplierledgerentries').updateMany({}, { $set: { runningBalance: -60 } });
    await manual.receive(manualPayload({ creditApplied: 55, deposit: 0, remaining: 0, payStatus: 'مكتمل' }), actor);
    expect(await baseline()).toEqual({ stock: 10, cash: 1000, debt: -5, transactions: 1, movements: 1, vault: 0, units: 3 });
  });
  it('rejects unconfirmed, fractional, wrong supplier/product and mismatched manual invoice amounts without posting', async () => {
    const before = await baseline();
    const bad = manualPayload(); bad.tracking.physicalPossessionConfirmed = false;
    await expect(manual.receive(bad, actor)).rejects.toThrow('confirmed');
    await expect(manual.receive(manualPayload({ total: 1 }), actor)).rejects.toThrow('totals');
    await expect(manual.receive(manualPayload({ supplierId: id() }), actor)).rejects.toThrow('Supplier');
    await expect(manual.receive(manualPayload({ items: [{ ...manualPayload().invoice.items[0], productId: id() }] }), actor)).rejects.toThrow('identity');
    await expect(manual.receive(manualPayload({ items: [{ ...manualPayload().invoice.items[0], qty: 0.5 }] }), actor)).rejects.toThrow('whole-piece');
    expect(await baseline()).toEqual(before);
  });
  it('preserves manual receipt IDs and blocks inspection/availability after existing purchase cancellation', async () => {
    const result = await manual.receive(manualPayload(), actor);
    await transactions.cancel(String(result.transaction._id), { cancelReasonCode: 'other', cancelReasonNote: 'Manual receipt reversal', cancelledBy: 'Authenticated Receiver' } as any);
    expect(await baseline()).toEqual({ stock: 7, cash: 1000, debt: 100, transactions: 1, movements: 2, vault: 2, units: 3 });
    expect((await manual.summary(String(result.transaction._id))).unresolvedErrors.length).toBeGreaterThan(0);
    const unit: any = await models.InventoryUnit.findOne().lean();
    await expect(units.action(String(unit._id), { operationKey: id(), reason: 'Inspection', action: 'inspect', expectedVersion: unit.__v,
      physicalPossessionConfirmed: true, inspectionPassed: true, evidenceReference: 'Received' }, actor)).rejects.toThrow('Receipt reversed');
    expect(await models.InventoryUnit.countDocuments()).toBe(3);
  });
  it('enforces manual receipt HTTP permissions and nested DTOs', async () => {
    const post = (body: any, role = 'receiver') => fetch(base + '/inventory-units/purchases/receive', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body) });
    expect((await post(manualPayload(), 'buyer')).status).toBe(403);
    expect((await post({ ...manualPayload(), tracking: undefined })).status).toBe(400);
    const response = await post(manualPayload()); expect(response.status).toBe(201);
    expect((await response.json() as any).receipt.createdUnits).toBe(3);
  });

  // ── Receive by scanning pre-printed QR labels ─────────────────────────────────────────────
  async function scanFixture() {
    const product2 = id();
    await raw('products').insertOne({ _id: new Types.ObjectId(product2), code: 'SKU-2', name: 'Tray', openingBalance: 0, buyPrice: 10, sellPrice: 25 });
    const pieces = await units.issuePrelabels({ operationKey: id(), reason: 'Supplier labels', productId, quantity: 4 }, actor);
    const printedPieces = await units.printPrelabels(pieces.batchId, { operationKey: id(), reason: 'Print', start: 1, quantity: 3, sizeId: '50x30' }, actor);
    const packs = await units.issuePrelabels({ operationKey: id(), reason: 'Supplier pack labels', productId: product2, quantity: 4, piecesPerPack: 2 }, actor);
    const printedPacks = await units.printPrelabels(packs.batchId, { operationKey: id(), reason: 'Print', start: 1, quantity: 4, sizeId: '50x30' }, actor);
    const unprinted: any = await raw('inventoryunitprelabels').findOne({ batchId: pieces.batchId, ordinal: 4 });
    const packMember: any = await raw('inventoryunitprelabels').findOne({ batchId: packs.batchId, ordinal: 1 });
    const packMember2: any = await raw('inventoryunitprelabels').findOne({ batchId: packs.batchId, ordinal: 2 });
    return { product2, pieceIds: printedPieces.labels.map((l: any) => l.unitId), packIds: printedPacks.labels.map((l: any) => l.unitId),
      unprintedId: String(unprinted._id), packMemberId: String(packMember._id), packMember2Id: String(packMember2._id) };
  }
  /** Line 0: 5 × SKU-1 = 3 scanned pieces + 2 without a label (one line) · line 1: one scanned pack (2 × SKU-2). */
  function scanPayload(f: any, extra: any = {}, scans?: any[]) {
    return { operationKey: id(), tracking: { ...payload().tracking, inspectionPassed: true },
      invoice: { type: 'مشتريات', date: '2026-10-17', transactionDate: '2026-10-17', ref: '300', client: 'Supplier One', supplierId, employee: 'Forged Name',
        items: [{ productId, code: 'SKU-1', name: 'Basket', qty: 5, price: 20, total: 100 }, { productId: f.product2, code: 'SKU-2', name: 'Tray', qty: 2, price: 10, total: 20 }],
        itemsTotal: 120, discount: 0, total: 120, deposit: 20, remaining: 100, creditApplied: 0, depMethod: 'كاش', payment: 'كاش', payStatus: 'معلق', ...extra },
      scans: scans || [{ lineIndex: 0, unitIds: f.pieceIds, packIds: [] }, { lineIndex: 1, unitIds: [], packIds: [f.packIds[0]] }] };
  }
  async function scanState() {
    const stock = Object.fromEntries((await transactions.getInventory()).map((row: any) => [row.code, row.current]));
    return { stock, cash: (await models.Settings.findOne())!.vaultCash, debt: await ledger.getCurrentBalance(supplierId),
      transactions: await models.Transaction.countDocuments(), movements: await models.InventoryMovement.countDocuments(),
      vault: await models.VaultEntry.countDocuments(), units: await models.InventoryUnit.countDocuments(), events: await raw('inventoryunitevents').countDocuments(),
      linkedLabels: await raw('inventoryunitprelabels').countDocuments({ state: 'linked' }), sealedPacks: await raw('inventorypacks').countDocuments(),
      linkedPacks: await raw('inventoryunitprelabelpacks').countDocuments({ state: 'linked' }) };
  }
  it('receives scanned pieces, a scanned pack and an unlabelled line as one invoice in one transaction, and replays a retry', async () => {
    const f = await scanFixture();
    const request = scanPayload(f);
    const result = await manual.receiveScanned(request, actor);
    const txId = String(result.transaction._id);
    expect(await scanState()).toEqual({ stock: { 'SKU-1': 12, 'SKU-2': 2 }, cash: 980, debt: 200, transactions: 1, movements: 2, vault: 1,
      units: 7, events: 7, linkedLabels: 5, sealedPacks: 1, linkedPacks: 1 });
    expect(result.receipt).toMatchObject({ createdUnits: 2, linkedUnits: 5 });
    expect(result.receipt.lines.map((l: any) => [l.labelled, l.linkedUnits, l.createdUnits])).toEqual([[true, 3, 2], [true, 2, 0]]);
    const lineIds = result.transaction.items.map((l: any) => l.lineId);
    // The scanned identities ARE the printed labels; the unlabelled line got new ones.
    for (const pieceId of f.pieceIds) expect(await models.InventoryUnit.findById(pieceId).lean()).toMatchObject({ productId, status: 'available',
      origin: { purchaseTransactionId: txId, purchaseLineId: lineIds[0] } });
    const fresh = (await models.InventoryUnit.find({ 'origin.purchaseLineId': lineIds[0] }).lean()).filter((u: any) => !f.pieceIds.includes(String(u._id)));
    expect(fresh).toHaveLength(2); expect(fresh.every((u: any) => u.status === 'available' && !f.pieceIds.includes(String(u._id)))).toBe(true);
    expect(await raw('inventoryunitprelabels').countDocuments({ linkedPurchaseId: txId, linkedLineId: lineIds[1] })).toBe(2);
    expect(await raw('inventorypacks').findOne({ _id: new Types.ObjectId(f.packIds[0]) })).toMatchObject({ state: 'sealed', quantity: 2 });
    // Same key, same scans → the committed result; same key, other scans → refused; nothing posted twice.
    expect(String((await manual.receiveScanned(request, actor)).transaction._id)).toBe(txId);
    await expect(manual.receiveScanned({ ...request, scans: [request.scans[0]] }, actor)).rejects.toThrow('different payload');
    expect((await scanState()).transactions).toBe(1); expect((await scanState()).vault).toBe(1);
  });
  it('rolls back the invoice, vault, stock and new barcodes when any scanned code is refused', async () => {
    const f = await scanFixture();
    const before = await scanState();
    const refused: [any, RegExp][] = [
      [scanPayload(f, {}, [{ lineIndex: 0, unitIds: [f.pieceIds[0], f.pieceIds[1], f.unprintedId], packIds: [] }]), /لم تُطلب طباعته/],
      [scanPayload(f, {}, [{ lineIndex: 0, unitIds: [f.pieceIds[0], f.pieceIds[1], id()], packIds: [] }]), /غير مسجل/],
      [scanPayload(f, { items: [{ productId, code: 'SKU-1', name: 'Basket', qty: 2, price: 20, total: 40 }], itemsTotal: 40, total: 40, remaining: 20 }, [{ lineIndex: 0, unitIds: f.pieceIds, packIds: [] }]), /أكبر من|أقل من/],
      [scanPayload(f, {}, [{ lineIndex: 1, unitIds: [f.packMemberId, f.packMember2Id], packIds: [] }]), /داخل باك/],
      [scanPayload(f, {}, [{ lineIndex: 0, unitIds: [f.pieceIds[0], f.pieceIds[1]], packIds: [] }, { lineIndex: 1, unitIds: [f.packMemberId], packIds: [f.packIds[0]] }]), /داخل باك ممسوح/],
      [scanPayload(f, {}, [{ lineIndex: 1, unitIds: f.pieceIds.slice(0, 2), packIds: [] }]), /لا يطابق منتج/],
      [scanPayload(f, {}, [{ lineIndex: 0, unitIds: [f.pieceIds[0], f.pieceIds[0], f.pieceIds[1]], packIds: [] }]), /أكثر من مرة/],
    ];
    for (const [request, message] of refused) await expect(manual.receiveScanned(request, actor)).rejects.toThrow(message);
    expect(await scanState()).toEqual(before);
    // A code received on an earlier invoice cannot be received again; the second receipt leaves nothing behind.
    await manual.receiveScanned(scanPayload(f), actor);
    const after = await scanState();
    await expect(manual.receiveScanned(scanPayload(f, { ref: '301' }), actor)).rejects.toThrow(/مستلم/);
    expect(await scanState()).toEqual(after);
  });
  it('gives new barcodes to a line with no scan at all, next to a mixed line', async () => {
    const f = await scanFixture();
    const request = scanPayload(f, { items: [{ productId, code: 'SKU-1', name: 'Basket', qty: 4, price: 20, total: 80 }, { productId: f.product2, code: 'SKU-2', name: 'Tray', qty: 2, price: 10, total: 20 }],
      itemsTotal: 100, total: 100, remaining: 80 }, [{ lineIndex: 0, unitIds: [f.pieceIds[0]], packIds: [] }]);
    const result = await manual.receiveScanned(request, actor);
    expect(result.receipt.lines.map((l: any) => [l.labelled, l.linkedUnits, l.createdUnits])).toEqual([[true, 1, 3], [false, 0, 2]]);
    expect(await scanState()).toMatchObject({ units: 6, linkedLabels: 1, transactions: 1, vault: 1 });
  });
  it('lets only one of two simultaneous receipts claim the same scanned codes', async () => {
    const f = await scanFixture();
    const results = await Promise.allSettled([manual.receiveScanned(scanPayload(f), actor), manual.receiveScanned(scanPayload(f, { ref: '301' }), actor)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(await scanState()).toMatchObject({ transactions: 1, vault: 1, units: 7, linkedLabels: 5, cash: 980 });
  });
  it('reports the current state of saved scans so an outdated scan session cannot be resumed', async () => {
    const f = await scanFixture();
    const check = () => units.prelabelScanCheck([...f.pieceIds, f.unprintedId, f.packMemberId], [f.packIds[0], f.packIds[1]]);
    const first = await check();
    expect(first.pieces.map((p: any) => p.state)).toEqual(['ok', 'ok', 'ok', 'unprinted', 'in-pack']);
    expect(first.packs.map((p: any) => [p.state, p.quantity, p.productId])).toEqual([['ok', 2, f.product2], ['ok', 2, f.product2]]);
    await manual.receiveScanned(scanPayload(f), actor);
    const second = await check();
    expect(second.pieces.slice(0, 3).every((p: any) => p.state === 'linked')).toBe(true);
    expect(second.packs.map((p: any) => p.state)).toEqual(['linked', 'ok']);
    expect((await scanState()).transactions).toBe(1);
  });
  it('protects the scanned-receipt and scan-check HTTP routes with permissions and nested DTO validation', async () => {
    const f = await scanFixture();
    const post = (path: string, body: any, role = 'receiver') => fetch(base + '/inventory-units/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-role': role }, body: JSON.stringify(body) });
    expect((await post('purchases/receive-scanned', scanPayload(f), 'buyer')).status).toBe(403);
    expect((await post('purchases/receive-scanned', { ...scanPayload(f), scans: [{ lineIndex: 0, unitIds: ['not-an-id'], packIds: [] }] })).status).toBe(400);
    expect((await post('purchases/receive-scanned', { ...scanPayload(f), scans: [] })).status).toBe(400);
    expect((await post('purchases/receive-scanned', { ...scanPayload(f), tracking: { ...payload().tracking, inspectionPassed: false } })).status).toBe(400);
    expect((await scanState()).transactions).toBe(0);
    const response = await post('purchases/receive-scanned', scanPayload(f)); expect(response.status).toBe(201);
    expect((await response.json() as any).receipt).toMatchObject({ linkedUnits: 5, createdUnits: 2 });
    expect((await post('prelabels/scan-check', { unitIds: f.pieceIds, packIds: [] }, 'buyer')).status).toBe(403);
    const check = await post('prelabels/scan-check', { unitIds: f.pieceIds, packIds: [] });
    expect(((await check.json()) as any).pieces.every((p: any) => p.state === 'linked')).toBe(true);
  });

  it('does not create units, stock or finance for a draft or the status-only received step', async () => {
    const draft = await orders.create({ supplierId, supplierName: 'Supplier One', createdBy: 'Operator', items: [{ productCode: 'SKU-1', productName: 'Basket', qty: 3, unitPrice: 20 }] });
    const before = await baseline();
    await expect(receiving.convert(String(draft._id), payload(), actor)).rejects.toThrow('غير مستلم');
    await orders.updateStatus(String(draft._id), { status: 'مستلم', changedBy: 'Operator' });
    expect(await baseline()).toEqual(before);
  });
  it('commits one financial purchase, one normal stock movement and exactly the physically received pieces', async () => {
    const orderId = await po(); const result = await receiving.convert(orderId, payload(), actor);
    expect(await baseline()).toEqual({ stock: 10, cash: 980, debt: 135, transactions: 1, movements: 1, vault: 1, units: 3 });
    expect(result.transaction).toMatchObject({ total: 55, deposit: 20, remaining: 35, discount: 5, employee: 'Authenticated Receiver', supplierId });
    const pieces = await models.InventoryUnit.find().lean();
    expect(new Set(pieces.map((piece: any) => piece.barcode)).size).toBe(3);
    for (const piece of pieces as any[]) expect(piece).toMatchObject({ status: 'inspection-required', warehouseCode: 'ACTUAL-SHELF-A', origin: { purchaseOrderId: orderId, purchaseTransactionId: String(result.transaction._id), purchaseLineId: result.transaction.items[0].lineId } });
    expect((await raw('products').findOne({ _id: new Types.ObjectId(productId) }))!.buyPrice).toBe(18);
    expect((await models.InventoryMovement.findOne())!.qtyDelta).toBe(3);
    expect(presence.emitEvent).toHaveBeenCalledWith('tx:created', expect.anything());
  });
  it('preserves invoice-only behavior when unit tracking is not explicitly requested', async () => {
    await receiving.convert(await po(), payload({ tracking: undefined }), actor);
    expect(await baseline()).toEqual({ stock: 10, cash: 980, debt: 135, transactions: 1, movements: 1, vault: 1, units: 0 });
  });
  it('serializes repeated and concurrent receipt retries, including after service restart', async () => {
    const orderId = await po(), dto = payload();
    const results = await Promise.all(Array.from({ length: 5 }, () => receiving.convert(orderId, dto, actor)));
    expect(new Set(results.map(result => String(result.transaction._id))).size).toBe(1);
    const restarted = new PurchaseReceivingService(mongo.connection, units, transactions);
    expect((await restarted.convert(orderId, dto, actor)).receipt.unitIds).toEqual(results[0].receipt.unitIds);
    expect(await baseline()).toEqual({ stock: 10, cash: 980, debt: 135, transactions: 1, movements: 1, vault: 1, units: 3 });
    await expect(receiving.convert(orderId, payload({ deposit: 21 }), actor)).rejects.toThrow('different payload');
  });
  it('does not allow different idempotency keys or actors to create another invoice for the same receipt', async () => {
    const orderId = await po(); await receiving.convert(orderId, payload(), actor);
    const dto = payload(); dto.tracking.operationKey = 'different-receipt-key';
    await expect(receiving.convert(orderId, dto, actor)).rejects.toThrow('محوّل بالفعل');
    expect(await models.Transaction.countDocuments()).toBe(1);
  });
  it('serializes distinct receipts, preserving cash and the supplier running balance', async () => {
    const first = await po(), second = await po();
    await Promise.all([receiving.convert(first, payload(), actor), receiving.convert(second, payload({ ref: '101' }), actor)]);
    expect(await baseline()).toEqual({ stock: 13, cash: 960, debt: 170, transactions: 2, movements: 2, vault: 2, units: 6 });
  });
  it('allows only one concurrent receipt to use an existing invoice reference', async () => {
    const orderIds = [await po(), await po()];
    const results = await Promise.allSettled(orderIds.map(orderId => receiving.convert(orderId, payload(), actor)));
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1);
    expect(await baseline()).toEqual({ stock: 10, cash: 980, debt: 135, transactions: 1, movements: 1, vault: 1, units: 3 });
  });
  it.each(['unit', 'event', 'ledger', 'movement'])('rolls back ALL financial/quantity writes after injected %s failure, then recovers with the same request', async failure => {
    const before = await baseline(), orderId = await po(), dto = payload();
    const spy = failure === 'unit' ? jest.spyOn(models.InventoryUnit.collection, 'insertMany') : failure === 'event' ? jest.spyOn(models.InventoryUnitEvent.collection, 'insertMany') : failure === 'ledger' ? jest.spyOn(models.SupplierLedgerEntry, 'create') : jest.spyOn(movements, 'record');
    spy.mockRejectedValueOnce(new Error('Injected receipt failure'));
    await expect(receiving.convert(orderId, dto, actor)).rejects.toThrow('Injected receipt failure'); spy.mockRestore();
    expect(await baseline()).toEqual(before); expect(await models.InventoryUnitOperation.countDocuments()).toBe(0);
    expect((await raw('purchaseorders').findOne({ _id: new Types.ObjectId(orderId) }))!.linkedTransactionId).toBe('');
    expect(presence.emitEvent).not.toHaveBeenCalled();
    expect((await receiving.convert(orderId, dto, actor)).receipt.createdUnits).toBe(3);
  });
  it('supports a short one-time receipt without inventing a second receipt/backorder', async () => {
    const orderId = await po(), dto = payload(); dto.items[0].qty = 1;
    await expect(receiving.convert(orderId, dto, actor)).rejects.toThrow('اختلاف كمية');
    dto.tracking.acceptQuantityDifference = true;
    const result = await receiving.convert(orderId, dto, actor);
    expect(result.quantityDifference).toBe(true);
    expect(await baseline()).toEqual({ stock: 8, cash: 985, debt: 100, transactions: 1, movements: 1, vault: 1, units: 1 });
    expect(result.po.items[0].qty).toBe(3);
    const next = payload(); next.tracking.operationKey = 'another-short-delivery';
    await expect(receiving.convert(orderId, next, actor)).rejects.toThrow('محوّل بالفعل');
  });
  it('preserves explicitly approved over-receipts and does not silently cap them to ordered quantity', async () => {
    const dto = payload(); dto.items[0].qty = 4; dto.tracking.acceptQuantityDifference = true;
    await receiving.convert(await po(), dto, actor);
    expect(await baseline()).toEqual({ stock: 11, cash: 980, debt: 155, transactions: 1, movements: 1, vault: 1, units: 4 });
  });
  it('blocks unconfirmed physical receipts, fractions and wrong product/supplier relationships without posting', async () => {
    const orderId = await po(), before = await baseline();
    const bad = [payload(), payload(), payload()];
    bad[0].tracking.physicalPossessionConfirmed = false; bad[1].items[0].qty = 1.5; bad[2].items[0].productId = id();
    for (const dto of bad) await expect(receiving.convert(orderId, dto, actor)).rejects.toThrow();
    await expect(receiving.convert(orderId, payload({ notes: 'استبدال — مرتجع: invalid receipt alias' }), actor)).rejects.toThrow('مرتجع عميل');
    await raw('suppliers').insertOne({ name: 'Supplier One' });
    await expect(receiving.convert(orderId, payload(), actor)).rejects.toThrow('علاقة المورد');
    expect(await baseline()).toEqual(before);
  });
  it('rejects insufficient cash without committing an invoice or any unit', async () => {
    await raw('settings').updateOne({}, { $set: { vaultCash: 10, vaultBalance: 10 } }); const before = await baseline();
    await expect(receiving.convert(await po(), payload(), actor)).rejects.toThrow('غير كاف');
    expect(await baseline()).toEqual(before);
  });
  it('blocks ambiguous historical supplier balances instead of choosing a different financial source by ID', async () => {
    await raw('supplierledgerentries').insertOne({ supplierId, runningBalance: 999, amount: 899, entryType: 'manual-adjustment', createdAt: new Date('2026-10-01T00:00:00Z') });
    await expect(receiving.convert(await po(), payload(), actor)).rejects.toThrow('ملتبس');
    await raw('supplierledgerentries').updateMany({}, { $set: { createdAt: '2026-10-01T00:00:00Z' } });
    await expect(receiving.convert(await po(), payload(), actor)).rejects.toThrow('توقيت');
    expect(await models.Transaction.countDocuments()).toBe(0); expect(await models.InventoryUnit.countDocuments()).toBe(0);
    expect((await models.Settings.findOne())!.vaultCash).toBe(1000);
  });
  it('verifies the existing financial indexes without creating or replacing them automatically', async () => {
    const before = await baseline(), orderId = await po();
    const index = (await models.InventoryMovement.collection.indexes()).find(row => row.unique && row.key.movementId === 1)!;
    await models.InventoryMovement.collection.dropIndex(index.name!);
    try { await expect(receiving.convert(orderId, payload(), actor)).rejects.toThrow('فهرس التفرد'); expect(await baseline()).toEqual(before); }
    finally { await models.InventoryMovement.createIndexes(); }
  });
  it('prints immediately or later against the same received identities without posting another payment or movement', async () => {
    const orderId = await po(), result = await receiving.convert(orderId, payload(), actor), before = await baseline();
    const labels = await units.labels({ operationKey: 'receipt-label-request', reason: 'Received label request', unitIds: result.receipt.unitIds.slice(0, 2), sizeId: '60x40' }, actor);
    expect(labels.labels).toHaveLength(2); expect(await baseline()).toEqual(before);
    const summary = await receiving.summary(orderId); expect(summary).toMatchObject({ createdUnits: 3, labelRequests: 2, labelsWithoutRequests: 1, physicalPrintingVerified: false });
    expect((await units.search({ purchaseTransactionId: String(result.transaction._id) })).total).toBe(3);
  });
  it('uses existing purchase cancellation reversals, retains unit IDs, and exposes custody review instead of deleting identities', async () => {
    const orderId = await po(), result = await receiving.convert(orderId, payload(), actor);
    await transactions.cancel(String(result.transaction._id), { cancelReasonCode: 'other', cancelReasonNote: 'Receipt reversal test', cancelledBy: 'Authenticated Receiver' } as any);
    expect(await baseline()).toEqual({ stock: 7, cash: 1000, debt: 100, transactions: 1, movements: 2, vault: 2, units: 3 });
    expect((await receiving.summary(orderId)).reversedOrArchived).toBe(true);
    expect((await receiving.summary(orderId)).unresolvedErrors.length).toBeGreaterThan(0);
    await expect(units.action(result.receipt.unitIds[0], { operationKey: 'reversed-receipt-inspection', reason: 'Attempt after reversal', action: 'inspect', expectedVersion: 0,
      physicalPossessionConfirmed: true, inspectionPassed: true, evidenceReference: 'Physical count' }, actor)).rejects.toThrow('reversed');
    expect((await receiving.convert(orderId, payload(), actor)).receipt.unitIds).toEqual(result.receipt.unitIds);
    expect(await models.VaultEntry.countDocuments()).toBe(2);
  });
  it('recovers a complete receipt copy in a separate scratch database without regenerating identities or reposting finance', async () => {
    const orderId = await po(), dto = payload(), saved = await receiving.convert(orderId, dto, actor);
    const target = mongo.connection.useDb('receipt_recovery_' + id());
    for (const name of ['products', 'transactions', 'purchaseorders', 'settings', 'vaultentries', 'supplierledgerentries', 'inventorymovements', 'inventoryunits', 'inventoryunitevents', 'inventoryunitoperations', 'users', 'suppliers']) {
      const rows = await raw(name).find({}).toArray(); if (rows.length) await target.collection(name).insertMany(rows);
    }
    await migrateInventoryUnitIndexes(target.db!, true);
    await target.collection('purchaseorders').createIndex({ poNumber: 1 }, { unique: true });
    await target.collection('inventorymovements').createIndex({ movementId: 1 }, { unique: true });
    const targetUnits = new InventoryUnitsService(target, target.model('InventoryUnit', InventoryUnitSchema), target.model('InventoryUnitEvent', InventoryUnitEventSchema), target.model('InventoryUnitOperation', InventoryUnitOperationSchema), {} as any, new UnitManualCodesService(target));
    const restored = new PurchaseReceivingService(target, targetUnits, {} as any);
    expect((await restored.convert(orderId, dto, actor)).receipt.unitIds).toEqual(saved.receipt.unitIds);
    expect((await restored.summary(orderId)).createdUnits).toBe(3);
    expect(await target.collection('transactions').countDocuments()).toBe(1); expect(await target.collection('vaultentries').countDocuments()).toBe(1);
    expect((await target.collection('settings').findOne({}))!.vaultCash).toBe(980);
    expect(await target.collection('supplierledgerentries').find({}).sort({ createdAt: -1, _id: -1 }).toArray()).toEqual(await raw('supplierledgerentries').find({}).sort({ createdAt: -1, _id: -1 }).toArray());
  });
  it('enforces authenticated purchase/unit permissions and DTO validation through the real controller', async () => {
    const orderId = await po();
    const http = (role?: string, body: any = payload()) => fetch(base + '/purchase-orders/' + orderId + '/convert', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(role ? { 'x-test-role': role } : {}) }, body: JSON.stringify(body) });
    expect((await http()).status).toBe(401); expect((await http('viewer')).status).toBe(403); expect((await http('buyer')).status).toBe(403);
    const invalid = payload(); invalid.tracking.physicalPossessionConfirmed = 'true'; expect((await http('receiver', invalid)).status).toBe(400);
    const response = await http('receiver'); expect(response.status).toBe(201); const result = await response.json();
    expect(result.receipt.createdUnits).toBe(3); expect(result.transaction.employee).toBe('Authenticated Receiver');
    expect((await fetch(base + '/purchase-orders/' + orderId + '/receipt', { headers: { 'x-test-role': 'viewer' } })).status).toBe(200);
  });
});
