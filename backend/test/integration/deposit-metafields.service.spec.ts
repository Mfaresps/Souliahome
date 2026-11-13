/**
 * Shopify deposit metafields — real MongoDB scratch database, the REAL DepositReceiptsService
 * (create → approve → refund) and the real queue; only Shopify is a fake that keeps the four
 * metafields in memory and can be told to fail.
 *
 * Run with: TEST_MONGODB_URI=mongodb://127.0.0.1:27018/soulia_test_deposit_metafields?replicaSet=souliaDev npm test -- deposit-metafields
 */
import mongoose, { Connection, Model } from 'mongoose';
import { ShopifyOrderSchema } from '../../src/shopify/schemas/shopify-order.schema';
import { TransactionSchema } from '../../src/transactions/schemas/transaction.schema';
import { ManualDepositReceiptSchema } from '../../src/shopify/schemas/manual-deposit-receipt.schema';
import { SyncApiError } from '../../src/shopify/sync/sync-api.service';
import {
  depositStateFromOrder, depositStateFromTransaction, desiredDepositMetafields, checkDefinitions, depositMetafieldChanges,
} from '../../src/shopify/sync/deposit-metafields.util';
/* eslint-disable @typescript-eslint/no-var-requires */
const { DepositReceiptsService } = require('../../src/shopify/deposit-receipts.service');
const { ShopifyDepositMetafieldsService } = require('../../src/shopify/sync/deposit-metafields.service');
/* eslint-enable @typescript-eslint/no-var-requires */

export {};

const URI = process.env.TEST_MONGODB_URI || `mongodb://localhost:27017/soulia_test_deposit_metafields_${process.pid}_${Date.now()}`;
const scratchDb = URI.match(/\/([^/?]+)(?:\?|$)/)?.[1] || '';
if (!/^soulia_test_deposit_metafields(?:_[a-zA-Z0-9_-]+)?$/.test(scratchDb)) {
  throw new Error('Refusing to drop any database outside the soulia_test_deposit_metafields prefix');
}

const ADMIN = { id: 'u-admin', username: 'admin', name: 'محمد أشرف', isAdmin: true };
const DEFS = [
  { key: 'deposit_amount', type: { name: 'money' } }, { key: 'remaining_amount', type: { name: 'money' } },
  { key: 'deposit_method', type: { name: 'single_line_text_field' } }, { key: 'deposit_date', type: { name: 'date_time' } },
];

let conn: Connection;
let orderModel: Model<any>;
let txModel: Model<any>;
let manualModel: Model<any>;

/** In-memory Shopify: order totals + the four metafields, with switchable failures. */
function fakeShopify() {
  const orders = new Map<string, { total: string; currency: string; mf: Record<string, string> }>();
  const state = { defs: DEFS as any[], failNext: 0, failUncertain: false, scopes: ['write_orders'], calls: [] as string[], onSet: null as null | (() => Promise<void>), onRead: null as null | (() => Promise<void>), sets: [] as any[] };
  const digest = (v?: string) => (v === undefined ? null : 'd:' + v);
  const api = {
    connection: jest.fn(async () => ({ scopes: state.scopes })),
    query: jest.fn(async (q: string, v: any = {}, mutation = false) => {
      state.calls.push(q.includes('metafieldsSet') ? 'set' : q.includes('metafieldsDelete') ? 'delete' : q.includes('metafieldDefinitions') ? 'defs' : 'read');
      if (state.failNext > 0) { state.failNext--; throw new SyncApiError('انقطع الاتصال بـ Shopify', true, mutation); }
      if (q.includes('metafieldDefinitions')) return { metafieldDefinitions: { nodes: state.defs } };
      if (q.includes('metafieldsSet')) {
        if (state.onSet) { const f = state.onSet; state.onSet = null; await f(); }
        // compare-and-set, atomic for the whole call (Shopify metafieldsSet, 2024-07+)
        const stale = v.m.filter((m: any) => 'compareDigest' in m && m.compareDigest !== digest(orders.get(m.ownerId.split('/').pop())!.mf[m.key]));
        if (stale.length) return { metafieldsSet: { metafields: null, userErrors: stale.map((m: any) => ({ field: ['metafields', m.key], code: 'STALE_OBJECT', message: 'The resource has been updated since it was loaded.' })) } };
        state.sets.push(v.m);
        for (const m of v.m) orders.get(m.ownerId.split('/').pop())!.mf[m.key] = m.value;
        if (state.failUncertain) { state.failUncertain = false; throw new SyncApiError('رد Shopify غير مكتمل', true, true); }
        return { metafieldsSet: { metafields: v.m.map((m: any) => ({ key: m.key })), userErrors: [] } };
      }
      if (q.includes('metafieldsDelete')) {
        for (const m of v.m) delete orders.get(m.ownerId.split('/').pop())!.mf[m.key];
        return { metafieldsDelete: { deletedMetafields: v.m.map((m: any) => ({ key: m.key })), userErrors: [] } };
      }
      const id = String(v.id).split('/').pop()!;
      const o = orders.get(id);
      if (state.onRead) { const f = state.onRead; state.onRead = null; await f(); }
      if (!o) return { order: null };
      const mf = (k: string) => (o.mf[k] !== undefined ? { value: o.mf[k], compareDigest: digest(o.mf[k]) } : null);
      return { order: { id: v.id, currentTotalPriceSet: { shopMoney: { amount: o.total, currencyCode: o.currency } },
        deposit_amount: mf('deposit_amount'), remaining_amount: mf('remaining_amount'), deposit_method: mf('deposit_method'), deposit_date: mf('deposit_date') } };
    }),
  };
  return { orders, state, api };
}

function setup() {
  const shopify = fakeShopify();
  const vault = { addSystemEntry: jest.fn(async () => ({ _id: new mongoose.Types.ObjectId(), txNo: 'SAL-1' })) };
  const settings = { getR2Config: jest.fn(async () => null), getSettings: jest.fn(async () => ({ r2ReceiptsMax: 2000 })) };
  const queue = new ShopifyDepositMetafieldsService(txModel, orderModel, shopify.api);
  queue.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const receipts = new DepositReceiptsService(orderModel, txModel, vault, settings, {}, { scoreDepositDetection: jest.fn(async () => undefined) }, { emitEvent: jest.fn() }, manualModel);
  receipts.depositMetafields = queue;
  receipts.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { ...shopify, queue, receipts, vault };
}

let seq = 0;
async function newOrder(total = 1500) {
  seq += 1;
  const shopifyId = String(9000000 + seq);
  const order = await orderModel.create({ shopifyId, ref: String(5000 + seq), client: 'عميل', total, itemsTotal: total, shipCost: 0, status: 'pending',
    items: [{ productId: 'p1', code: 'C1', name: 'سجادة', qty: 1, price: total, total }] });
  return { order, id: String(order._id), shopifyId };
}
async function deposit(ctx: any, orderId: string, amount: number, method: string) {
  const { receipt } = await ctx.receipts.createWithoutImage(orderId, { amount, method, reason: '' }, ADMIN, { role: 'admin', perms: [] });
  await ctx.receipts.approve(orderId, receipt.id, ADMIN);
  return receipt.id as string;
}
const job = (shopifyId: string) => conn.collection('shopifydepositmetafieldjobs').findOne({ _id: shopifyId as any });
const money = (v?: string) => (v ? JSON.parse(v) : null);
const enable = (ctx: any) => ctx.queue.configure(true, 'test');

beforeAll(async () => {
  conn = await mongoose.createConnection(URI).asPromise();
  orderModel = conn.model('ShopifyOrder', ShopifyOrderSchema);
  txModel = conn.model('Transaction', TransactionSchema);
  manualModel = conn.model('ManualDepositReceipt', ManualDepositReceiptSchema);
});
afterAll(async () => {
  await conn?.dropDatabase();
  await conn?.close();
});
beforeEach(async () => {
  await conn.collection('shopifydepositmetafieldjobs').deleteMany({});
  await conn.collection('shopifysyncconfigs').deleteMany({});
});

describe('deposit metafields — pure rules', () => {
  it('counts only approved receipts that reached the vault', () => {
    const s = depositStateFromOrder({ depositReceipts: [
      { status: 'معتمد', vaultEntryId: 'v1', amount: 300, method: 'Instapay', reviewedAt: '2026-11-10T10:00:00.000Z' },
      { status: 'معتمد', vaultEntryId: '', amount: 999, method: 'كاش', reviewedAt: '2026-11-11T10:00:00.000Z' },
      { status: 'معلق', amount: 50, method: 'كاش' }, { status: 'مُسترد', vaultEntryId: 'v2', amount: 70, method: 'كاش' },
    ] });
    expect(s).toMatchObject({ depositCents: 30000, methods: ['InstaPay'], lastAt: '2026-11-10T10:00:00Z' });
  });
  it('a transaction: ignores COD collection in `deposit`, honours refunds and cancellation', () => {
    const tx = { deposit: 1500, deposits: [
      { amount: 300, method: 'فودافون كاش', date: '2026-11-01T09:00:00Z' }, { amount: 200, method: 'كاش', date: '2026-11-02T09:00:00Z' },
      { amount: 100, method: 'كاش', date: '2026-11-03T09:00:00Z', reversed: true }] };
    expect(depositStateFromTransaction(tx)).toMatchObject({ depositCents: 50000, methods: ['Vodafone Cash', 'Cash'], lastAt: '2026-11-02T09:00:00Z' });
    expect(depositStateFromTransaction({ ...tx, cancellationDepositRefunds: [{ amount: 300 }] }).depositCents).toBe(20000);
    expect(depositStateFromTransaction({ ...tx, deposit: 250 }).depositCents).toBe(25000);
    expect(depositStateFromTransaction({ ...tx, cancelled: true })).toMatchObject({ depositCents: 0, methods: [], lastAt: null });
  });
  it('remaining never goes negative on an overpayment; a non-EGP order is refused', () => {
    const d = desiredDepositMetafields({ depositCents: 160000, methods: ['Cash'], lastAt: '2026-11-01T09:00:00Z', source: 'order' },
      { currentTotalPriceSet: { shopMoney: { amount: '1500.00', currencyCode: 'EGP' } } });
    expect(money(d.set.find(m => m.key === 'remaining_amount')!.value)).toEqual({ amount: '0.00', currency_code: 'EGP' });
    expect(() => desiredDepositMetafields({ depositCents: 1, methods: [], lastAt: null, source: 'order' },
      { currentTotalPriceSet: { shopMoney: { amount: '10', currencyCode: 'USD' } } })).toThrow('USD');
  });
  it('definitions are checked by key AND type; equal values are not rewritten', () => {
    expect(checkDefinitions(DEFS)).toEqual([]);
    expect(checkDefinitions([...DEFS.slice(0, 3), { key: 'deposit_date', type: { name: 'date' } }])[0]).toContain('date_time');
    expect(checkDefinitions(DEFS.slice(1))[0]).toContain('deposit_amount');
    const d = desiredDepositMetafields({ depositCents: 30000, methods: ['Cash'], lastAt: '2026-11-01T09:00:00Z', source: 'order' },
      { currentTotalPriceSet: { shopMoney: { amount: '1500.0', currencyCode: 'EGP' } } });
    const changes = depositMetafieldChanges(d, {
      deposit_amount: { value: '{"amount":"300.0","currency_code":"EGP"}' }, remaining_amount: { value: '{"amount":"1200.00","currency_code":"EGP"}' },
      deposit_method: { value: 'Cash' }, deposit_date: { value: '2026-11-01T09:00:00+00:00' } });
    expect(changes).toEqual({ set: [], remove: [] });
  });
});

describe('deposit metafields — queue over the real deposit workflow', () => {
  it('first deposit, then a second with another method: cumulative amount, remaining, both methods, latest date', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });

    await deposit(ctx, id, 300, 'Instapay');
    await ctx.queue.tick();
    let mf = ctx.orders.get(shopifyId)!.mf;
    expect(money(mf.deposit_amount)).toEqual({ amount: '300.00', currency_code: 'EGP' });
    expect(money(mf.remaining_amount)).toEqual({ amount: '1200.00', currency_code: 'EGP' });
    expect(mf.deposit_method).toBe('InstaPay');
    const first = (await orderModel.findById(id).lean() as any).depositReceipts[0].reviewedAt;
    expect(Date.parse(mf.deposit_date)).toBe(Math.floor(Date.parse(first) / 1000) * 1000);

    await new Promise(r => setTimeout(r, 1100));
    await deposit(ctx, id, 200, 'فودافون كاش');
    await ctx.queue.tick();
    mf = ctx.orders.get(shopifyId)!.mf;
    expect(money(mf.deposit_amount)!.amount).toBe('500.00');
    expect(money(mf.remaining_amount)!.amount).toBe('1000.00');
    expect(mf.deposit_method).toBe('InstaPay + Vodafone Cash');
    const second = (await orderModel.findById(id).lean() as any).depositReceipts[1].reviewedAt;
    expect(Date.parse(mf.deposit_date)).toBe(Math.floor(Date.parse(second) / 1000) * 1000);
    expect((await job(shopifyId))).toMatchObject({ status: 'synced', lastSent: { deposit: 500, remaining: 1000, total: 1500 } });
  });

  it('a duplicate approval is refused by the ERP and sends nothing extra', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1000);
    ctx.orders.set(shopifyId, { total: '1000.00', currency: 'EGP', mf: {} });
    const { receipt } = await ctx.receipts.createWithoutImage(id, { amount: 400, method: 'كاش', reason: '' }, ADMIN, { role: 'admin', perms: [] });
    const results = await Promise.allSettled([ctx.receipts.approve(id, receipt.id, ADMIN), ctx.receipts.approve(id, receipt.id, ADMIN)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(ctx.vault.addSystemEntry).toHaveBeenCalledTimes(1);
    await ctx.queue.tick();
    expect(money(ctx.orders.get(shopifyId)!.mf.deposit_amount)!.amount).toBe('400.00');
    expect(ctx.state.calls.filter(c => c === 'set')).toHaveLength(1);
    await ctx.queue.requestSync(shopifyId, 'again');
    await ctx.queue.tick();
    expect(ctx.state.calls.filter(c => c === 'set')).toHaveLength(1); // already equal → no mutation
  });

  it('Shopify unavailable: the deposit still succeeds, the job retries later with the latest figure', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    ctx.state.failNext = 99;
    await deposit(ctx, id, 300, 'كاش');                       // never blocked by Shopify
    await ctx.queue.tick();
    let j: any = await job(shopifyId);
    expect(j.status).toBe('error');
    expect(j.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    ctx.state.failNext = 0;
    await deposit(ctx, id, 200, 'كاش');                       // a later deposit re-queues immediately
    await ctx.queue.tick();
    j = await job(shopifyId);
    expect(j.status).toBe('synced');
    expect(money(ctx.orders.get(shopifyId)!.mf.deposit_amount)!.amount).toBe('500.00');
  });

  it('an uncertain mutation result is retried safely (absolute values, no double count)', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    ctx.state.failUncertain = true;
    await deposit(ctx, id, 300, 'كاش');
    await ctx.queue.tick();
    expect((await job(shopifyId) as any).status).toBe('error');
    await conn.collection('shopifydepositmetafieldjobs').updateOne({ _id: shopifyId as any }, { $set: { nextAttemptAt: new Date(0) } });
    await ctx.queue.tick();
    expect((await job(shopifyId) as any).status).toBe('synced');
    expect(money(ctx.orders.get(shopifyId)!.mf.deposit_amount)!.amount).toBe('300.00');
  });

  it('a deposit approved WHILE a send is in flight is sent right after; the older value never lands last', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    await deposit(ctx, id, 300, 'كاش');
    ctx.state.onSet = async () => { await deposit(ctx, id, 200, 'Instapay'); };
    await ctx.queue.tick();
    expect(money(ctx.orders.get(shopifyId)!.mf.deposit_amount)!.amount).toBe('500.00');
    expect((await job(shopifyId) as any).status).toBe('synced');
  });

  it('two workers never process the same order at once', async () => {
    const ctx = setup(); await enable(ctx);
    const other = new ShopifyDepositMetafieldsService(txModel, orderModel, ctx.api);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    await deposit(ctx, id, 300, 'كاش');
    await Promise.all([ctx.queue.tick(), other.tick()]);
    expect(ctx.state.calls.filter(c => c === 'set')).toHaveLength(1);
  });

  it('refund on order cancellation: deposit 0, remaining = total, method and date removed', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    await deposit(ctx, id, 300, 'كاش');
    await ctx.queue.tick();
    await ctx.receipts.settleOnCancel(id, 'admin', 'إلغاء');
    await ctx.queue.tick();
    const mf = ctx.orders.get(shopifyId)!.mf;
    expect(money(mf.deposit_amount)!.amount).toBe('0.00');
    expect(money(mf.remaining_amount)!.amount).toBe('1500.00');
    expect(mf.deposit_method).toBeUndefined();
    expect(mf.deposit_date).toBeUndefined();
  });

  it('after confirmation the transaction is the source: an edit-added deposit and a cancellation', async () => {
    const ctx = setup(); await enable(ctx);
    const { shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    const tx = await txModel.create({ type: 'مبيعات', employee: 'test', date: '2026-11-01', ref: 'T' + shopifyId, shopifyOrderId: shopifyId, total: 1500, deposit: 1500,
      deposits: [{ id: 'd1', amount: 300, method: 'كاش', date: '2026-11-01T09:00:00Z' }, { id: 'd2', amount: 100, method: 'Instapay', date: '2026-11-05T09:00:00Z' }] });
    await ctx.queue.requestSync(shopifyId, 'tx-edit');
    await ctx.queue.tick();
    let mf = ctx.orders.get(shopifyId)!.mf;
    expect(money(mf.deposit_amount)!.amount).toBe('400.00');        // COD inside `deposit` is not a deposit
    expect(mf.deposit_method).toBe('Cash + InstaPay');
    expect(Date.parse(mf.deposit_date)).toBe(Date.parse('2026-11-05T09:00:00Z'));
    await txModel.updateOne({ _id: tx._id }, { $set: { cancelled: true } });
    await ctx.queue.requestSync(shopifyId, 'tx-cancelled');
    await ctx.queue.tick();
    mf = ctx.orders.get(shopifyId)!.mf;
    expect(money(mf.deposit_amount)!.amount).toBe('0.00');
    expect(money(mf.remaining_amount)!.amount).toBe('1500.00');
  });

  it('a Shopify total edit re-sends remaining only for a tracked order whose total moved', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    await deposit(ctx, id, 300, 'كاش');
    await ctx.queue.tick();
    await ctx.queue.requestSyncIfTotalChanged(shopifyId, '1500.00');
    expect((await job(shopifyId) as any).status).toBe('synced');
    ctx.orders.get(shopifyId)!.total = '1800.00';
    await ctx.queue.requestSyncIfTotalChanged(shopifyId, '1800.00');
    await ctx.queue.tick();
    expect(money(ctx.orders.get(shopifyId)!.mf.remaining_amount)!.amount).toBe('1500.00');
    await ctx.queue.requestSyncIfTotalChanged('9999999999', '10');
    expect(await job('9999999999')).toBeNull();
  });

  it('off by default: events queue but nothing is sent until enabled', async () => {
    const ctx = setup();
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    await deposit(ctx, id, 300, 'كاش');
    await ctx.queue.tick();
    expect(ctx.api.query).not.toHaveBeenCalled();
    expect((await job(shopifyId) as any).status).toBe('pending');
    await enable(ctx);
    await ctx.queue.tick();
    expect(money(ctx.orders.get(shopifyId)!.mf.deposit_amount)!.amount).toBe('300.00');
  });

  it('refuses to enable, and holds jobs for review, when a definition is missing or of another type', async () => {
    const ctx = setup();
    ctx.state.defs = DEFS.slice(0, 3);
    await expect(enable(ctx)).rejects.toThrow('deposit_date');
    ctx.state.scopes = [];
    ctx.state.defs = DEFS;
    await expect(enable(ctx)).rejects.toThrow('write_orders');
    ctx.state.scopes = ['write_orders'];
    await enable(ctx);
    ctx.state.defs = [...DEFS.slice(0, 3), { key: 'deposit_date', type: { name: 'date' } }];
    (ctx.queue as any).definitions = null;
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    await deposit(ctx, id, 300, 'كاش');
    await ctx.queue.tick();
    expect((await job(shopifyId) as any)).toMatchObject({ status: 'review' });
    expect(ctx.state.calls).not.toContain('set');
  });

  it('a non-EGP Shopify order is held for review, never converted', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'USD', mf: {} });
    await deposit(ctx, id, 300, 'كاش');
    await ctx.queue.tick();
    expect((await job(shopifyId) as any).status).toBe('review');
    expect(ctx.orders.get(shopifyId)!.mf).toEqual({});
  });
});

describe('deposit metafields — production-readiness guards', () => {
  it('every write is a compare-and-set against what was read', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    await deposit(ctx, id, 300, 'كاش');
    await ctx.queue.tick();
    expect(ctx.state.sets[0].every((m: any) => 'compareDigest' in m && m.compareDigest === null)).toBe(true);
    await deposit(ctx, id, 200, 'كاش');
    await ctx.queue.tick();
    expect(ctx.state.sets[1].find((m: any) => m.key === 'deposit_amount').compareDigest).toBe('d:' + JSON.stringify({ amount: '300.00', currency_code: 'EGP' }));
  });

  it('a field changed between our read and our write: Shopify refuses, we re-read and send the ERP value', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    await deposit(ctx, id, 300, 'كاش');
    ctx.state.onSet = async () => { ctx.orders.get(shopifyId)!.mf.deposit_amount = JSON.stringify({ amount: '999.00', currency_code: 'EGP' }); };
    await ctx.queue.tick();
    expect(money(ctx.orders.get(shopifyId)!.mf.deposit_amount)!.amount).toBe('300.00');
    expect((await job(shopifyId) as any).status).toBe('synced');
  });

  it('a worker whose lease was taken over does not write and does not overwrite the job', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    await deposit(ctx, id, 300, 'كاش');
    ctx.state.onRead = async () => {
      await conn.collection('shopifydepositmetafieldjobs').updateOne({ _id: shopifyId as any }, { $set: { lease: 'other-worker', status: 'running' } });
    };
    await ctx.queue.tick();
    expect(ctx.state.calls).not.toContain('set');
    expect((await job(shopifyId) as any)).toMatchObject({ lease: 'other-worker', status: 'running' });
  });

  it('webhooks do not reset the backoff of a failing job; only a new total queues, once', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    await deposit(ctx, id, 300, 'كاش');
    await ctx.queue.tick();
    ctx.state.failNext = 99;
    await deposit(ctx, id, 100, 'كاش');
    await ctx.queue.tick();
    const failed: any = await job(shopifyId);
    expect(failed.status).toBe('error');
    for (let i = 0; i < 4; i++) await ctx.queue.requestSyncIfTotalChanged(shopifyId, '1500.00');
    expect((await job(shopifyId) as any)).toMatchObject({ status: 'error', nextAttemptAt: failed.nextAttemptAt, seq: failed.seq });
    for (let i = 0; i < 4; i++) await ctx.queue.requestSyncIfTotalChanged(shopifyId, '1700.00');
    const after: any = await job(shopifyId);
    expect(after.status).toBe('pending');
    expect(after.seq).toBe(failed.seq + 1);
  });

  it('nothing is sent while a vault booking or refund is unfinished; the finished state is sent after', async () => {
    const ctx = setup(); await enable(ctx);
    const { id, shopifyId } = await newOrder(1500);
    ctx.orders.set(shopifyId, { total: '1500.00', currency: 'EGP', mf: {} });
    const rid = await deposit(ctx, id, 300, 'كاش');
    await ctx.queue.tick();
    // A refund whose vault entry is not written yet (crashed mid-refund).
    await orderModel.updateOne({ _id: id, 'depositReceipts.id': rid }, { $set: { 'depositReceipts.$.status': 'مُسترد' } });
    await ctx.queue.requestSync(shopifyId, 'test');
    await ctx.queue.tick();
    expect((await job(shopifyId) as any).status).toBe('error');
    expect(money(ctx.orders.get(shopifyId)!.mf.deposit_amount)!.amount).toBe('300.00');   // unchanged, not guessed
    await orderModel.updateOne({ _id: id, 'depositReceipts.id': rid }, { $set: { 'depositReceipts.$.refundVaultEntryId': 'v-refund' } });
    await ctx.queue.requestSync(shopifyId, 'refund-done');
    await ctx.queue.tick();
    expect(money(ctx.orders.get(shopifyId)!.mf.deposit_amount)!.amount).toBe('0.00');
  });
});
