import mongoose, { Connection, Model } from 'mongoose';
import * as crypto from 'crypto';
import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as path from 'path';

declare let currentUser: any;
declare let currentLang: string;
declare let currentPage: string;
declare let _shopifyOrders: any[];
declare let _spServerEnabled: boolean;
declare function _spReceiptAction(orderId: string, receiptId: string, action: string): void;

const { ShopifyOrderSchema } = require('../../src/shopify/schemas/shopify-order.schema');
const { TransactionSchema } = require('../../src/transactions/schemas/transaction.schema');
const { ManualDepositReceiptSchema } = require('../../src/shopify/schemas/manual-deposit-receipt.schema');
const { SettingsSchema } = require('../../src/settings/schemas/settings.schema');
const { VaultEntrySchema } = require('../../src/vault/schemas/vault-entry.schema');
const { FollowUpSchema } = require('../../src/followups/schemas/followup.schema');
const { DepositReceiptsService } = require('../../src/shopify/deposit-receipts.service');
const { SettingsService } = require('../../src/settings/settings.service');
const { VaultService } = require('../../src/vault/vault.service');
const { FollowUpsService } = require('../../src/followups/followups.service');
const { NotificationsService } = require('../../src/notifications/notifications.service');

const uri = process.env.TEST_MONGODB_URI || '';
const dbName = uri.match(/\/([^/?]+)(?:\?|$)/)?.[1] || '';
if (!/^soulia_test_deposit_receipts_phase5_[a-zA-Z0-9_-]+$/.test(dbName)) {
  throw new Error('Phase 5 benchmark requires a fresh isolated scratch database');
}

const admin = { id: 'admin-phase5', username: 'admin', name: 'Test Admin', isAdmin: true };
let conn: Connection;
let orderModel: Model<any>;
let vaultModel: Model<any>;
let settingsModel: Model<any>;
let followupModel: Model<any>;
let receipts: any;
let settings: any;
let vault: any;
let followups: any;
let notifications: any;
let seq = 0;

function instrument(target: any, method: string, samples: Record<string, number[]>, name = method) {
  const original = target[method].bind(target);
  target[method] = async (...args: any[]) => {
    const start = performance.now();
    try { return await original(...args); }
    finally { (samples[name] ||= []).push(performance.now() - start); }
  };
  return () => { target[method] = original; };
}

function instrumentSync(target: any, method: string, samples: Record<string, number[]>, name = method) {
  const original = target[method].bind(target);
  target[method] = (...args: any[]) => {
    const start = performance.now();
    try { return original(...args); }
    finally { (samples[name] ||= []).push(performance.now() - start); }
  };
  return () => { target[method] = original; };
}

async function pendingOrder(rawBytes = 12000) {
  const id = crypto.randomUUID();
  const imageSha = crypto.createHash('sha256').update(id).digest('hex');
  const rawSha = crypto.createHash('sha256').update('raw:' + id).digest('hex');
  const reference = 'P5-' + (seq + 1);
  const order = await orderModel.create({
    shopifyId: `phase5-${++seq}`, ref: String(90000 + seq), client: 'Realistic Test Customer',
    status: 'pending', total: 1500, itemsTotal: 1450, shipCost: 50,
    items: [{ productId: 'p1', code: 'SKU-1', name: 'Product', qty: 1, price: 1450, total: 1450 }],
    rawData: { checkout: 'x'.repeat(rawBytes) },
    depositReceipts: [{
      id, status: 'معلق', imageKey: `test/${id}`, imageSha256: imageSha,
      rawSha256: rawSha, imageBytes: 12000,
      imageDeleted: false, amount: 500, method: 'Instapay',
      ocr: { amount: 500, method: 'Instapay', pattern: 'instapay', reference,
        dateText: '', confident: true, ran: true, ms: 5 },
      needsReview: false, warnings: [], uploadedAt: new Date().toISOString(),
      submittedBy: 'Test Staff', submittedById: String((global as any).__phase5StaffId),
      submittedAt: new Date().toISOString(),
    }],
  });
  const now = new Date().toISOString();
  await conn.collection('depositreceiptidentities').insertMany([
    `image:${imageSha}`, `raw:${rawSha}`,
    `transfer:${crypto.createHash('sha256').update(reference.toLowerCase()).digest('hex')}`,
  ].map(_id => ({ _id, receiptId: id, createdAt: now, claimedAt: now, phase: 'committed' })) as any);
  await conn.collection('followups').insertOne({ shopifyOrderId: String(order._id), orderRef: order.ref,
    reason: 'عملية تأكيد الطلب', status: 'في انتظار المتابعة', orderOutcome: '', cancelled: false });
  return { orderId: String(order._id), receiptId: id };
}

async function resetMoney() {
  await Promise.all([settingsModel.deleteMany({}), vaultModel.deleteMany({})]);
  await settingsModel.create({ vaultCash: 0, vaultInstapay: 0, vaultVodafone: 0, vaultBank: 0 });
}

beforeAll(async () => {
  conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000, monitorCommands: true }).asPromise();
  if (conn.name !== dbName) throw new Error('Refusing unexpected database');
  await conn.dropDatabase();
  orderModel = conn.model('ShopifyOrder', ShopifyOrderSchema);
  const txModel = conn.model('Transaction', TransactionSchema);
  const manualModel = conn.model('ManualDepositReceipt', ManualDepositReceiptSchema);
  settingsModel = conn.model('Settings', SettingsSchema);
  vaultModel = conn.model('VaultEntry', VaultEntrySchema);
  followupModel = conn.model('FollowUp', FollowUpSchema);
  await Promise.all([orderModel.init(), vaultModel.init(), settingsModel.init(), followupModel.init()]);
  await settingsModel.create({ vaultCash: 0, vaultInstapay: 0, vaultVodafone: 0, vaultBank: 0 });
  const staffId = new mongoose.Types.ObjectId();
  (global as any).__phase5StaffId = staffId;
  await conn.collection('users').insertOne({ _id: staffId, role: 'staff', isActive: true, name: 'Test Staff' });
  settings = Object.create(SettingsService.prototype);
  settings.settingsModel = settingsModel;
  settings.getSettings = () => settingsModel.findOne().exec();
  vault = Object.create(VaultService.prototype);
  vault.settingsService = settings;
  vault.vaultModel = vaultModel;
  vault.presence = { emitEvent() {} };
  followups = Object.create(FollowUpsService.prototype);
  followups.model = followupModel;
  followups.presence = { emitEvent() {} };
  notifications = new NotificationsService(conn);
  receipts = new DepositReceiptsService(orderModel, txModel, vault, settings,
    {}, { scoreDepositDetection: async () => undefined }, { emitEvent() {} }, manualModel);
  receipts.followUpsService = followups;
  receipts.notifications = notifications;
});

afterAll(async () => {
  if (conn) { await conn.dropDatabase(); await conn.close(); }
});

it('profiles the complete isolated approval path with real Mongo writes', async () => {
  const timings: Record<string, number[]> = {};
  const queryMs: Record<string, number[]> = {};
  const commands: Record<string, number> = {};
  let activeSample: { started: number; vaultCommittedMs?: number; orderLinkedMs?: number } | null = null;
  const restore: Array<() => void> = [];
  const oldExec = mongoose.Query.prototype.exec;
  (mongoose.Query.prototype as any).exec = async function(...args: any[]) {
    const name = `${this.model?.modelName || 'unknown'}.${this.op}`;
    const started = performance.now();
    try { return await oldExec.apply(this, args as any); }
    finally {
      (queryMs[name] ||= []).push(performance.now() - started);
      if (activeSample && name === 'ShopifyOrder.updateOne' && activeSample.orderLinkedMs === undefined)
        activeSample.orderLinkedMs = performance.now() - activeSample.started;
    }
  };
  const onCommand = (event: any) => {
    const collection = event.command?.[event.commandName] || event.command?.aggregate || 'other';
    const key = `${String(collection)}.${event.commandName}`;
    commands[key] = (commands[key] || 0) + 1;
  };
  conn.getClient().on('commandStarted', onCommand);
  for (const [target, method, name] of [
    [receipts, 'findDuplicates', 'duplicate lookup'],
    [receipts, 'reserveIdentity', 'identity reservation'],
    [receipts, 'commitIdentity', 'identity commit'],
    [receipts, 'reserveTransfer', 'transfer checks total'],
    [vault, 'generateTxNo', 'ledger number'],
    [vault, 'addSystemEntry', 'vault and ledger total'],
    [settings, 'adjustReceiptVaultBalance', 'balance atomic write'],
    [receipts, 'refreshDerived', 'order summary refresh'],
    [followups, 'closeConfirmationForDeposit', 'follow-up closure'],
    [notifications, 'enqueue', 'notification enqueue'],
  ] as Array<[any, string, string]>) restore.push(instrument(target, method, timings, name));
  for (const [method, name] of [['findReceipt', 'receipt lookup'], ['validateEntry', 'receipt amount and method validation'],
    ['emit', 'socket event']] as Array<[string, string]>) restore.push(instrumentSync(receipts, method, timings, name));
  const originalAdd = vault.addSystemEntry.bind(vault);
  vault.addSystemEntry = async (...args: any[]) => {
    const result = await originalAdd(...args);
    if (activeSample) activeSample.vaultCommittedMs = performance.now() - activeSample.started;
    return result;
  };
  restore.push(() => { vault.addSystemEntry = originalAdd; });

  const samples: any[] = [];
  try {
    for (let i = 0; i < 6; i++) {
      const { orderId, receiptId } = await pendingOrder();
      const commandBefore = { ...commands };
      const t0 = performance.now();
      activeSample = { started: t0 };
      const result = await receipts.approve(orderId, receiptId, admin);
      const total = performance.now() - t0;
      const sample = { totalMs: +total.toFixed(1), vaultCommittedMs: +((activeSample as any).vaultCommittedMs || 0).toFixed(1),
        orderLinkedMs: +((activeSample as any).orderLinkedMs || 0).toFixed(1),
        commands: Object.entries(commands).reduce((sum, [key, count]) => sum + count - (commandBefore[key] || 0), 0) };
      activeSample = null;
      const order: any = await orderModel.findById(orderId).lean().exec();
      const balance = await settings.getSettings();
      const entry: any = await vaultModel.findById(result.vaultEntryId).lean().exec();
      expect(order.depositReceipts[0].status).toBe('معتمد');
      expect(order.depositReceipts[0].vaultEntryId).toBe(result.vaultEntryId);
      expect(entry.status).toBe('completed');
      expect(balance.vaultInstapay).toBe((i + 1) * 500);
      expect(await followupModel.findOne({ shopifyOrderId: orderId }).lean().exec()).toMatchObject({ orderOutcome: 'confirmed' });
      samples.push(sample);
    }
    const summary = (data: Record<string, number[]>) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, {
      medianMs: +[...v].sort((a, b) => a - b)[Math.floor(v.length / 2)].toFixed(1),
      count: v.length,
    }]));
    console.log('PHASE5_BENCH ' + JSON.stringify({ samples, stages: summary(timings), queries: summary(queryMs), commands }));
  } finally {
    conn.getClient().off('commandStarted', onCommand);
    (mongoose.Query.prototype as any).exec = oldExec;
    restore.reverse().forEach(fn => fn());
  }
}, 120000);

it('measures a real browser click through isolated Mongo ledger completion', async () => {
  await resetMoney();
  const { orderId, receiptId } = await pendingOrder();
  const order: any = await orderModel.findById(orderId).lean().exec();
  const publicDir = path.resolve(__dirname, '../../../frontend/public');
  const html = fs.readFileSync(path.join(publicDir, 'index.html'));
  const browser = await require('puppeteer').launch({ headless: true });
  const page = await browser.newPage();
  const errors: string[] = [];
  let vaultCommittedEpoch = 0;
  let approvalRequests = 0;
  const originalAdd = vault.addSystemEntry.bind(vault);
  vault.addSystemEntry = async (...args: any[]) => {
    const result = await originalAdd(...args);
    vaultCommittedEpoch = performance.timeOrigin + performance.now();
    return result;
  };
  try {
    await page.setRequestInterception(true);
    page.on('pageerror', (error: Error) => errors.push(error.message));
    page.on('request', async (request: any) => {
      const url = new URL(request.url());
      const reply = (data: unknown, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) });
      try {
        if (url.origin === 'http://soulia.test' && url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: html });
        if (url.pathname === '/config.js') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.__ENV__={API_BASE_URL:""};' });
        if (url.pathname === `/api/shopify/orders/${orderId}/deposit-receipts/${receiptId}/approve`) {
          approvalRequests++;
          try { return reply(await receipts.approve(orderId, receiptId, admin)); }
          catch (error: any) { return reply({ message: error.message }, 400); }
        }
        if (url.pathname === '/api/shopify/orders') return reply([order]);
        if (url.pathname.startsWith('/api/')) return reply([]);
        if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
          const asset = path.resolve(publicDir, '.' + url.pathname);
          if (asset.startsWith(publicDir + path.sep) && fs.existsSync(asset))
            return request.respond({ status: 200, contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(asset) });
        }
        if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
        if (request.resourceType() === 'image') return request.respond({ status: 200, contentType: 'image/png', body: Buffer.alloc(0) });
        return request.respond({ status: 200, contentType: 'text/plain', body: '' });
      } catch (error: any) { errors.push(error.message); if (!request.isInterceptResolutionHandled()) await reply({ message: 'interception failed' }, 500); }
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((data: any) => {
      localStorage.setItem('token', 'scratch-test-token');
      currentUser = { _id: 'admin-phase5', name: 'Test Admin', username: 'admin', role: 'admin', perms: ['shopify-orders'] };
      currentLang = 'en';
      currentPage = 'shopify-orders';
      _shopifyOrders = [data];
      _spServerEnabled = false;
      document.querySelector<HTMLElement>('#login-page')!.style.display = 'none';
      document.querySelector<HTMLElement>('#app')!.style.display = '';
      document.querySelector('#splash-screen')?.remove();
      (window as any).__phase5 = {};
      const original = (window as any).api;
      (window as any).api = function(path: string, options: any) {
        if (path.includes('/deposit-receipts/') && path.endsWith('/approve')) (window as any).__phase5.requestEpoch = window.performance.timeOrigin + window.performance.now();
        return original(path, options).then((result: any) => {
          if (path.includes('/deposit-receipts/') && path.endsWith('/approve')) (window as any).__phase5.responseEpoch = window.performance.timeOrigin + window.performance.now();
          return result;
        });
      };
      _spReceiptAction(data._id, data.depositReceipts[0].id, 'approve');
      (window as any).__phase5.clickEpoch = window.performance.timeOrigin + window.performance.now();
      const button = document.querySelector<HTMLButtonElement>('#spdep-decide')!;
      button.click(); button.click();
    }, JSON.parse(JSON.stringify(order)));
    await page.waitForFunction((id: string) => (window as any).__phase5.responseEpoch &&
      _shopifyOrders[0].depositReceipts.find((r: any) => r.id === id)?.status === 'معتمد',
    { timeout: 30000 }, receiptId);
    const marks: any = await page.evaluate(() => (window as any).__phase5);
    expect(approvalRequests).toBe(1);
    expect(vaultCommittedEpoch).toBeGreaterThan(marks.clickEpoch);
    expect((await settings.getSettings()).vaultInstapay).toBe(500);
    expect(errors).toEqual([]);
    console.log('PHASE5_BROWSER ' + JSON.stringify({
      clickToRequestMs: +(marks.requestEpoch - marks.clickEpoch).toFixed(1),
      clickToLedgerCommitMs: +(vaultCommittedEpoch - marks.clickEpoch).toFixed(1),
      clickToResponseMs: +(marks.responseEpoch - marks.clickEpoch).toFixed(1),
      approvalRequests, browser: 'Chromium', database: 'isolated scratch',
    }));
  } finally { vault.addSystemEntry = originalAdd; await browser.close(); }
}, 120000);

it('keeps one financial booking for a duplicate approval and rapid double click', async () => {
  await resetMoney();
  const { orderId, receiptId } = await pendingOrder();
  const outcomes = await Promise.allSettled([
    receipts.approve(orderId, receiptId, admin), receipts.approve(orderId, receiptId, admin),
  ]);
  expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  await expect(receipts.approve(orderId, receiptId, admin)).rejects.toThrow();
  expect(await vaultModel.countDocuments({ idempotencyKey: `receipt:${receiptId}:approve`, status: 'completed' })).toBe(1);
  expect((await settings.getSettings()).vaultInstapay).toBe(500);
  expect(await conn.collection('notificationinbox').countDocuments({ event: receiptId })).toBe(1);
});

it('allows only one winner among concurrent approval attempts', async () => {
  await resetMoney();
  const { orderId, receiptId } = await pendingOrder();
  const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => receipts.approve(orderId, receiptId, admin)));
  expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
  expect(await vaultModel.countDocuments({ idempotencyKey: `receipt:${receiptId}:approve`, status: 'completed' })).toBe(1);
  expect((await settings.getSettings()).vaultInstapay).toBe(500);
});

it('keeps money unchanged if the balance write fails, then safely recovers', async () => {
  await resetMoney();
  const { orderId, receiptId } = await pendingOrder();
  const fail = jest.spyOn(settingsModel, 'findOneAndUpdate').mockImplementationOnce(() => ({
    exec: async () => { throw new Error('simulated balance write failure'); },
  }) as any);
  await expect(receipts.approve(orderId, receiptId, admin)).rejects.toThrow('simulated balance write failure');
  fail.mockRestore();
  expect((await settings.getSettings()).vaultInstapay).toBe(0);
  expect(await vaultModel.countDocuments({ idempotencyKey: `receipt:${receiptId}:approve`, status: 'completed' })).toBe(0);
  await orderModel.updateOne({ _id: orderId, 'depositReceipts.id': receiptId },
    { $set: { 'depositReceipts.$.reviewedAt': '2020-01-01T00:00:00.000Z' } });
  await receipts.approve(orderId, receiptId, admin);
  expect((await settings.getSettings()).vaultInstapay).toBe(500);
  expect(await vaultModel.countDocuments({ idempotencyKey: `receipt:${receiptId}:approve`, status: 'completed' })).toBe(1);
});

it('recovers when ledger completion fails after the balance was committed', async () => {
  await resetMoney();
  const { orderId, receiptId } = await pendingOrder();
  const fail = jest.spyOn(vaultModel, 'findOneAndUpdate').mockImplementationOnce(() => ({
    exec: async () => { throw new Error('simulated ledger completion failure'); },
  }) as any);
  await expect(receipts.approve(orderId, receiptId, admin)).rejects.toThrow('simulated ledger completion failure');
  fail.mockRestore();
  expect((await settings.getSettings()).vaultInstapay).toBe(500);
  await orderModel.updateOne({ _id: orderId, 'depositReceipts.id': receiptId },
    { $set: { 'depositReceipts.$.reviewedAt': '2020-01-01T00:00:00.000Z' } });
  await receipts.approve(orderId, receiptId, admin);
  expect((await settings.getSettings()).vaultInstapay).toBe(500);
  expect(await vaultModel.countDocuments({ idempotencyKey: `receipt:${receiptId}:approve`, status: 'completed' })).toBe(1);
});

it('does not let a notification failure undo an approved deposit', async () => {
  await resetMoney();
  const { orderId, receiptId } = await pendingOrder();
  const original = notifications.enqueue.bind(notifications);
  notifications.enqueue = async () => { throw new Error('simulated notification failure'); };
  try { await receipts.approve(orderId, receiptId, admin); }
  finally { notifications.enqueue = original; }
  expect((await settings.getSettings()).vaultInstapay).toBe(500);
  expect(await vaultModel.countDocuments({ idempotencyKey: `receipt:${receiptId}:approve`, status: 'completed' })).toBe(1);
});

it('rejects cancelled orders and unauthorized actors without booking money', async () => {
  await resetMoney();
  const cancelled = await pendingOrder();
  await orderModel.updateOne({ _id: cancelled.orderId }, { $set: { cancelled: true } });
  await expect(receipts.approve(cancelled.orderId, cancelled.receiptId, admin)).rejects.toThrow();
  const restricted = await pendingOrder();
  await expect(receipts.approve(restricted.orderId, restricted.receiptId,
    { ...admin, isAdmin: false })).rejects.toThrow();
  expect(await vaultModel.countDocuments()).toBe(0);
  expect((await settings.getSettings()).vaultInstapay).toBe(0);
});

it('preserves the legacy reservation path when identity keys are missing', async () => {
  await resetMoney();
  const { orderId, receiptId } = await pendingOrder();
  await conn.collection('depositreceiptidentities').deleteMany({ receiptId });
  await receipts.approve(orderId, receiptId, admin);
  expect(await conn.collection('depositreceiptidentities').countDocuments({ receiptId, phase: 'committed' })).toBe(3);
  expect((await settings.getSettings()).vaultInstapay).toBe(500);
});
