import { Types } from 'mongoose';
import { trackingMongo } from '../helpers/tracking-mongo';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';

describe('Inventory calculation with real MongoDB', () => {
  let mongo: Awaited<ReturnType<typeof trackingMongo>>;
  let service: any;
  const productId = new Types.ObjectId();
  const line = (qty: number, condition = '', code = 'SKU') => ({ code, qty, condition });
  const transaction = (type: string, items: any[], extra = {}) => ({
    type, items, ref: '', date: '2026-10-01', warehouseCode: 'MAIN', ...extra,
  });

  beforeAll(async () => {
    mongo = await trackingMongo();
    service = Object.create(TransactionsService.prototype);
    service.transactionModel = mongo.connection.model('Transaction', TransactionSchema);
    service.productsService = { findAll: async () => [
      { _id: productId, code: ' SKU ', name: 'Basket', openingBalance: 10, minStock: 1 },
      { _id: new Types.ObjectId(), code: 'EMPTY', name: 'Empty', openingBalance: 0 },
    ] };
    service.inventoryMovementsService = {
      getManualAdjustmentQtyByProductCode: async () => new Map([['SKU', -1]]),
      getManualAdjustmentWarehouseRows: async () => [{ productCode: 'SKU', warehouseCode: 'WH-B', qtyDelta: -1 }],
    };
  }, 40000);
  afterAll(async () => { await mongo?.close(); });
  beforeEach(async () => {
    for (const name of ['transactions', 'warehousetransfers', 'inventoryunits', 'inventoryunitevents']) {
      await mongo.connection.collection(name).deleteMany({});
    }
  });

  it('preserves purchases, repeated sales, returns, transfers and per-warehouse corrections', async () => {
    await mongo.connection.collection('transactions').insertMany([
      transaction('مشتريات', [line(5)]),
      transaction('مبيعات', [line(2), line(1, '', ' SKU ')]),
      transaction('مبيعات', [line(1)], { warehouseCode: 'WH-B' }),
      transaction('مرتجع', [line(2), line(5, 'تالف')], { ref: 'R-2', date: '2026-10-02T12:00:00Z' }),
      transaction('مرتجع مشتريات', [line(1)]),
      transaction('مشتريات', [line(1)], { ref: '123-RET', warehouseCode: 'WH-B' }),
      transaction('مشتريات', [line(1)], { notes: 'استبدال — مرتجع: قديم', ref: 'R-1' }),
      transaction('مبيعات', [line(100)], { cancelled: true }),
      transaction('مشتريات', [line(100)], { archived: true }),
    ]);
    await mongo.connection.collection('warehousetransfers').insertOne({ from: 'MAIN', to: 'WH-B', lines: [{ productId: String(productId), quantity: 3 }] });
    const [row, empty] = await service.getInventory();
    expect(row).toMatchObject({ purchases: 5, sales: 5, returnsToStock: 4, adjustments: -1, current: 13,
      warehouseBalances: { MAIN: 11, 'WH-B': 2 }, returnRefs: '123-RET، R-1، R-2', returnDates: '2026-10-01، 2026-10-02' });
    expect(empty).toMatchObject({ current: 0, status: 'zero', warehouseBalances: { MAIN: 0 } });
  });

  it('reads fresh stock after a sale and rejects an excessive MAIN sale', async () => {
    expect((await service.getInventory())[0].warehouseBalances.MAIN).toBe(10);
    await mongo.connection.collection('transactions').insertOne(transaction('مبيعات', [line(7)]));
    const snapshot = await service.getInventory();
    expect(snapshot[0].warehouseBalances.MAIN).toBe(3);
    await expect(service.assertWarehouseSale([line(2), line(2)], 'MAIN', snapshot)).rejects.toThrow('رصيد المخزن');
  });

  it('retains the original receipt warehouse for legacy purchases without warehouse metadata', async () => {
    const invoiceId = new Types.ObjectId(), unitId = new Types.ObjectId();
    await mongo.connection.collection('transactions').insertOne(transaction('مشتريات', [{ ...line(1), lineId: 'line-1' }], { _id: invoiceId, warehouseCode: null }));
    await mongo.connection.collection('inventoryunits').insertOne({ _id: unitId, origin: { purchaseTransactionId: String(invoiceId), purchaseLineId: 'line-1' } });
    await mongo.connection.collection('inventoryunitevents').insertOne({ unitId: String(unitId), action: 'registered', details: { physicalPossessionConfirmed: true, warehouseCode: 'WH-B' } });
    expect((await service.getInventory())[0]).toMatchObject({ purchases: 1, current: 10, warehouseBalances: { MAIN: 10, 'WH-B': 0 } });
  });

  it('includes uncommitted stock changes only in the supplied database session', async () => {
    const session = await mongo.connection.startSession();
    try {
      session.startTransaction();
      await mongo.connection.collection('transactions').insertOne(transaction('مبيعات', [line(4)]), { session });
      expect((await service.getInventory(session))[0].warehouseBalances.MAIN).toBe(6);
      expect((await service.getInventory())[0].warehouseBalances.MAIN).toBe(10);
      await session.abortTransaction();
    } finally { await session.endSession(); }
  });
});
