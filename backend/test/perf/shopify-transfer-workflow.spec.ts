/** Seven isolated MongoDB approvals. No test writes to the application database. */
import mongoose, { Connection, Model } from 'mongoose';
import { performance } from 'node:perf_hooks';

const { ShopifyOrderSchema } = require('../../src/shopify/schemas/shopify-order.schema');
const { TransactionSchema } = require('../../src/transactions/schemas/transaction.schema');
const { ShopifyService } = require('../../src/shopify/shopify.service');

const scratchName = `soulia_test_transfer_perf_${process.pid}_${Date.now()}`;
const baseUri = process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017';
const url = new URL(baseUri);
url.pathname = '/' + scratchName;
if (!/^soulia_test_transfer_perf_\d+_\d+$/.test(url.pathname.slice(1))) throw new Error('Unsafe scratch database name');

let conn: Connection;
let orders: Model<any>;
let transactions: Model<any>;

beforeAll(async () => {
  conn = await mongoose.createConnection(url.toString()).asPromise();
  orders = conn.model('TransferPerfShopifyOrder', ShopifyOrderSchema);
  transactions = conn.model('TransferPerfTransaction', TransactionSchema);
});
afterAll(async () => {
  if (conn) { await conn.dropDatabase(); await conn.close(); }
});

test('seven successful approvals retain the reference and reject duplicates', async () => {
  const timings: number[] = [];
  const queries: number[] = [];
  for (let i = 0; i < 7; i++) {
    const source = await orders.create({
      shopifyId: `transfer-perf-${i}`, ref: String(920000 + i), client: 'Performance Fixture',
      phone: '01000000000', status: 'pending', total: 1800, itemsTotal: 1750, shipCost: 50,
      shopifyCreatedAt: new Date().toISOString(),
      items: [{ productId: 'fixture-product-1', code: 'P1', name: 'Fixture item', qty: 1, price: 1750, total: 1750 }],
      depositReceipts: [], shipWithoutDeposit: true,
    });
    const shop = Object.create(ShopifyService.prototype);
    shop.shopifyOrderModel = orders;
    shop.txModel = transactions;
    shop.settingsService = { getSettings: async () => ({ defaultCarrierCode: 'bosta' }) };
    shop.transactionsService = { getInventory: async () => [], assertWarehouseSale: async () => undefined };
    shop.recordInventoryMovementForSale = async () => undefined;
    shop.depositReceipts = { discardDrafts: async () => undefined };
    shop.followUpsService = { closeForOrder: async () => undefined };
    shop.notifications = { enqueue: async () => undefined };
    shop.presence = { emitEvent: () => undefined };
    shop.logger = { log: () => undefined, warn: () => undefined, error: () => undefined };
    let count = 0;
    conn.set('debug', () => { count++; });
    const start = performance.now();
    const result = await shop.approveOrder(String(source._id), 'Fixture admin', 'bosta', 'fixture-admin');
    timings.push(Math.round((performance.now() - start) * 10) / 10);
    conn.set('debug', false);
    queries.push(count);
    expect(result.success).toBe(true);
    expect(await transactions.countDocuments({ shopifyOrderId: source.shopifyId, ref: source.ref })).toBe(1);
    expect((await shop.approveOrder(String(source._id), 'Fixture admin', 'bosta')).success).toBe(false);
  }
  console.log('TRANSFER_PERF ' + JSON.stringify({ timings, queries }));
});
