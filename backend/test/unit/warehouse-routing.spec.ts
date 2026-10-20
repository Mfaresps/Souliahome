import mongoose, { Types } from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../src/employee-performance/employee-scoring.service', () => ({ EmployeeScoringService: class {} }));
jest.mock('../../src/notifications/admin-events', () => ({ ...jest.requireActual('../../src/notifications/admin-events'), notifyApproval: jest.fn().mockResolvedValue(undefined) }));

import { TransactionsService } from '../../src/transactions/transactions.service';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';
import { InventoryMovementsService } from '../../src/inventory-movements/inventory-movements.service';
import { ShopifyService } from '../../src/shopify/shopify.service';

const productId = new Types.ObjectId().toHexString();
const txId = new Types.ObjectId().toHexString();
const item = (qty = 1) => ({ code: 'SKU-1', name: 'Basket', productId, qty, price: 100, total: 100 * qty });
function stock(main = 5, other = 20) {
  const service: any = Object.create(TransactionsService.prototype);
  service.transactionModel = { db: { collection: () => ({ findOne: jest.fn(async ({ code }) => ({ code })) }) } };
  service.getInventory = jest.fn().mockResolvedValue([{ _id: productId, code: 'SKU-1', name: 'Basket', current: main + other, warehouseBalances: { MAIN: main, 'WH-B': other } }]);
  return service;
}
function shopify(main = 5) {
  const source = { _id: new Types.ObjectId(), status: 'pending', ref: '1234', items: [item(2)], total: 200, itemsTotal: 200, depositReceipts: [], client: 'Customer', shipCost: 0 };
  const order: any = { ...source, toObject: () => ({ ...source }) };
  const service: any = Object.create(ShopifyService.prototype);
  service.shopifyOrderModel = { findById: jest.fn().mockResolvedValue(order), findOneAndUpdate: jest.fn(() => ({ exec: async () => order })) };
  service.txModel = { create: jest.fn(async (payload: any) => ({ ...payload, _id: txId })) };
  service.transactionsService = stock(main);
  service.transactionsService.assertWarehouseSale = jest.fn(service.transactionsService.assertWarehouseSale.bind(service.transactionsService));
  service.settingsService = { getSettings: jest.fn().mockResolvedValue({}) };
  service.applyDerivedDeposit = jest.fn();
  service.recordInventoryMovementForSale = jest.fn().mockResolvedValue(undefined);
  service.emit = jest.fn(); service.depositReceipts = { discardDrafts: jest.fn().mockResolvedValue(undefined) };
  service.logger = { log: jest.fn(), error: jest.fn() };
  return service;
}

describe('Warehouse routing and visibility', () => {
  it('defaults new sales and purchases to MAIN in the persisted schema', () => {
    const model = mongoose.models.WarehouseRoutingTransaction || mongoose.model('WarehouseRoutingTransaction', TransactionSchema);
    expect(new model({ type: 'مبيعات' }).warehouseCode).toBe('MAIN');
    expect(new model({ type: 'مشتريات' }).warehouseCode).toBe('MAIN');
  });
  it('refuses a default sale when only another warehouse has stock', async () => {
    await expect(stock(0, 20).assertWarehouseSale([item(1)])).rejects.toThrow('رصيد المخزن');
  });
  it('allows default sales covered by MAIN', async () => {
    await expect(stock(5).assertWarehouseSale([item(5)])).resolves.toBeUndefined();
  });
  it('sums repeated product lines before checking MAIN stock', async () => {
    await expect(stock(5).assertWarehouseSale([item(3), item(3)])).rejects.toThrow('رصيد المخزن');
  });
  it('honors a different warehouse when it is explicitly selected for a manual sale', async () => {
    await expect(stock(0, 20).assertWarehouseSale([item(3)], 'WH-B')).resolves.toBeUndefined();
  });
  it('persists Shopify approval in MAIN and checks MAIN first', async () => {
    const service = shopify();
    await expect(service.approveOrder('order-1', 'Admin')).resolves.toMatchObject({ success: true });
    expect(service.transactionsService.assertWarehouseSale).toHaveBeenCalledWith([item(2)], 'MAIN', expect.any(Array));
    expect(service.transactionsService.getInventory).toHaveBeenCalledTimes(1);
    expect(service.txModel.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'مبيعات', source: 'shopify', warehouseCode: 'MAIN' }));
  });
  it('leaves a Shopify order pending when MAIN is short, even with other stock', async () => {
    const service = shopify(0);
    await expect(service.approveOrder('order-1', 'Admin')).rejects.toThrow('رصيد المخزن');
    expect(service.txModel.create).not.toHaveBeenCalled();
    expect(service.shopifyOrderModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('validates the request-local stock snapshot without recalculating inventory', async () => {
    const service = stock(20);
    const snapshot = [{ _id: productId, code: 'SKU-1', name: 'Basket', current: 2, warehouseBalances: { MAIN: 2 } }];
    await expect(service.assertWarehouseSale([item(3)], 'MAIN', snapshot)).rejects.toThrow('رصيد المخزن');
    expect(service.getInventory).not.toHaveBeenCalled();
  });
  it('records the linked invoice warehouse in movement entries', async () => {
    const service: any = Object.create(InventoryMovementsService.prototype);
    service.model = { db: { collection: () => ({ find: () => ({ toArray: async () => [{ _id: new Types.ObjectId(txId), warehouseCode: 'WH-B' }] }) }) }, insertMany: jest.fn().mockResolvedValue([]) };
    service.generateMovementId = jest.fn().mockResolvedValue('123456');
    await service.record([{ productId, productCode: 'SKU-1', productName: 'Basket', type: 'مبيعات', sourceType: 'transaction-create', sourceTransactionId: txId, qtyDelta: -1, qtyBefore: 3, qtyAfter: 2, by: 'Admin' }]);
    expect(service.model.insertMany.mock.calls[0][0][0].warehouseCode).toBe('WH-B');
  });
  it('routes manual stock corrections to the selected warehouse balance', async () => {
    const service: any = Object.create(InventoryMovementsService.prototype);
    service.model = { db: { collection: () => ({ findOne: async () => ({ code: 'WH-B' }) }) }, create: jest.fn(async value => value) };
    service.productsService = { findById: async () => ({ _id: productId, code: 'SKU-1', name: 'Basket' }) };
    service.transactionsService = stock(5, 20);
    service.generateMovementId = async () => '123456'; service.generateAdjustmentRef = async () => 'ADJ-1';
    await expect(service.adjustStock({ productId, warehouseCode: 'WH-B', qtyDelta: -2, reason: 'Count', by: 'Admin' })).resolves.toMatchObject({ warehouseCode: 'WH-B', qtyBefore: 20, qtyAfter: 18 });
  });
  it('does not allocate corrections in a secondary warehouse to MAIN', async () => {
    const service: any = Object.create(TransactionsService.prototype);
    service.productsService = { findAll: async () => [{ _id: productId, code: 'SKU-1', name: 'Basket', openingBalance: 10, minStock: 1 }] };
    service.transactionModel = { find: () => ({ exec: async () => [] }), db: { collection: () => ({ find: () => ({ toArray: async () => [] }) }) } };
    service.inventoryMovementsService = { getManualAdjustmentQtyByProductCode: async () => new Map([['SKU-1', 2]]), getManualAdjustmentWarehouseRows: async () => [{ productCode: 'SKU-1', qtyDelta: 2, warehouseCode: 'WH-B' }] };
    const [row] = await service.getInventory();
    expect(row.current).toBe(12); expect(row.warehouseBalances).toEqual({ MAIN: 10, 'WH-B': 2 });
  });
  it('uses MAIN for Shopify stock badges even when another warehouse has more', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf('function _spWarehouseQty('), end = source.indexOf('\n}', start) + 2;
    const quantity = new Function('inv', `${source.slice(start, end)}; return _spWarehouseQty(inv);`);
    expect(quantity({ current: 20, warehouseBalances: { MAIN: 0, 'WH-B': 20 } })).toBe(0);
    expect(quantity({ current: 20, warehouseBalances: { MAIN: 4, 'WH-B': 16 } })).toBe(4);
  });
});
