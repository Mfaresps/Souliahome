/** Real Mongo queue/lease tests in an isolated LOCAL database; Shopify is always mocked. */
import mongoose, { Connection, Schema } from 'mongoose';
import { randomUUID } from 'crypto';
import { ShopifySyncService } from '../../src/shopify/sync/sync.service';
import { SyncApiError } from '../../src/shopify/sync/sync-api.service';
import { applyFixtureAction, syncFixture } from '../fixtures/shopify-sync';

const uri = process.env.SHOPIFY_SYNC_TEST_MONGO || '';
const enabled = /^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\//.test(uri);
(enabled ? describe : describe.skip)('persistent Shopify outbound queue (local isolated Mongo)', () => {
  let db: Connection, tx: any, orders: any, service: ShopifySyncService, api: any, remote: any, calls: string[];
  const database = 'soulia_shopify_sync_test_' + randomUUID().replace(/-/g, '');
  const connection = { store: 'test-store', appKey: 'test-app', shopId: 'gid://shopify/Shop/1', domain: 'test-store.myshopify.com', missing: [], scopes: [] };
  beforeAll(async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network forbidden in queue tests'));
    db = await mongoose.createConnection(uri, { dbName: database, serverSelectionTimeoutMS: 5000 }).asPromise();
    tx = db.model('TestTransaction', new Schema({}, { strict: false, timestamps: true }), 'transactions');
    orders = db.model('TestShopifyOrder', new Schema({}, { strict: false }), 'shopifyorders');
  });
  afterAll(async () => {
    if (db && /^soulia_shopify_sync_test_[a-f0-9]{32}$/.test(db.name)) { await db.dropDatabase(); await db.close(); }
    jest.restoreAllMocks();
  });
  beforeEach(async () => {
    for (const name of ['transactions', 'shopifyorders', 'shopifysyncjobs', 'shopifysyncconfigs', 'shopifysyncpreviews', 'shopifysyncreconciliations']) await db.collection(name).deleteMany({});
    const fixture = syncFixture(); remote = fixture.remote; calls = [];
    await tx.create(fixture.tx); await orders.create(fixture.order);
    api = { identity: jest.fn(async () => ({ store: connection.store, appKey: connection.appKey })),
      connection: jest.fn(async () => connection), read: jest.fn(async () => structuredClone(remote)),
      apply: jest.fn(async (action: any) => { calls.push(action.kind); applyFixtureAction(remote, action); }) };
    service = new ShopifySyncService(tx, orders, api); await service.onModuleInit();
  });
  const id = '507f1f77bcf86cd799439011';
  const job = () => db.collection('shopifysyncjobs').findOne({ transactionId: id });
  async function queue() {
    const p = await service.preview([id], false, 'admin');
    expect(p.results[0].issues).toEqual([]);
    const result = await service.execute([p.results[0].token], 'admin');
    expect(result.results[0].status).toBe('pending'); return p;
  }
  it('defaults off and does not enqueue historical orders', async () => {
    expect((await service.status()).enabled).toBe(false);
    await service.tick(); expect(await job()).toBeNull(); expect(api.read).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  });
  it('uses only the current app and order reconciliation for pack quantities', async () => {
    await tx.updateOne({ _id:id }, { $set:{ 'items.0.qty':6, 'items.0.price':145 } });
    await orders.updateOne({ shopifyId:syncFixture().tx.shopifyOrderId }, { $set:{ 'rawData.line_items.0.price':'870.00' } });
    const row = { store:connection.store,appKey:'other-app',transactionId:id,orderId:syncFixture().tx.shopifyOrderId,
      unitMappings:[{lineId:'123',sku:'B-1',localQty:6,remoteQty:1,localUnitPrice:14500,remoteUnitPrice:87000}] };
    await db.collection('shopifysyncreconciliations').insertOne(row);
    expect((await service.preview([id],false,'admin')).results[0].issues.length).toBeGreaterThan(0);
    await db.collection('shopifysyncreconciliations').updateOne({transactionId:id},{$set:{appKey:connection.appKey}});
    await queue(); await service.tick(); expect((await job())?.status).toBe('synced');
    expect(remote.fulfillments[0].fulfillmentLineItems.nodes[0].quantity).toBe(1);
  });
  it('verifies manual fulfillment and delivery without tracking and does not repeat them after restart', async () => {
    await tx.updateOne({ _id: id }, { $set: { type: 'مبيعات', deliverySource: 'MANUAL', bostaTrackingNumber: '', bostaRawResponse: null,
      deliveryAuditLog: [{ action: 'MANUAL_DELIVERY_CONFIRMATION', newStatus: 'DELIVERED', by: 'admin', at: syncFixture().tx.deliveredAt }] } });
    await queue(); await service.tick();
    expect((await job())?.status).toBe('synced'); expect(calls).toEqual(['fulfill', 'event', 'metadata']);
    expect(remote.fulfillments[0].trackingInfo).toEqual([]); expect(remote.fulfillments[0].events.nodes[0].status).toBe('DELIVERED');
    expect(remote.displayFinancialStatus).toBe('PENDING');
    await new ShopifySyncService(tx, orders, api).tick(); expect(calls).toHaveLength(3);
  });
  it('corrects legacy metadata-only successes to require shipping review', async () => {
    await db.collection('shopifysyncjobs').insertOne({ transactionId: id, target: 'legacy', status: 'synced', source: { state: 'DELIVERED', shipmentType: 'UNKNOWN' } });
    await service.onModuleInit(); expect((await job())?.status).toBe('review');
  });
  it('preview is read-only; execution survives restart and duplicate submission', async () => {
    const p = await queue(); expect(calls).toEqual([]);
    await service.execute([p.results[0].token], 'admin');
    const restarted = new ShopifySyncService(tx, orders, api); await restarted.tick(); await restarted.tick();
    expect(calls).toEqual(['fulfill', 'event', 'metadata']);
    expect((await job())?.status).toBe('synced'); expect((await restarted.status()).lastSuccessAt).toBeTruthy();
    const again = await restarted.preview([id], false, 'admin'); expect(again.results[0].matched).toBe(true);
  });
  it('rejects another actor and expired previews', async () => {
    const p = await service.preview([id], false, 'admin'); const token = p.results[0].token;
    expect((await service.execute([token], 'other')).results[0].error).toBeTruthy();
    await db.collection('shopifysyncpreviews').updateOne({ _id: token as any }, { $set: { expiresAt: new Date(0) } });
    expect((await service.execute([token], 'admin')).results[0].error).toBeTruthy(); expect(calls).toEqual([]);
  });
  it.each(['local', 'remote', 'identity'])('rejects a changed %s after preview', async kind => {
    const p = await service.preview([id], false, 'admin');
    if (kind === 'local') await tx.updateOne({ _id: id }, { $set: { bostaTrackingNumber: 'new' } });
    if (kind === 'remote') remote.currentTotalPriceSet.shopMoney.amount = '999';
    if (kind === 'identity') api.identity.mockResolvedValue({ store: 'other', appKey: 'other' });
    expect((await service.execute([p.results[0].token], 'admin')).results[0].error).toBeTruthy();
    expect(await job()).toBeNull(); expect(calls).toEqual([]);
  });
  it('checks remote again before the queued manual send begins', async () => {
    await queue(); remote.name = '#different'; await service.tick();
    expect((await job())?.status).toBe('review'); expect(calls).toEqual([]);
  });
  it('two workers claim only one lease', async () => {
    await queue(); const second = new ShopifySyncService(tx, orders, api);
    await Promise.all([service.tick(), second.tick()]);
    expect(calls).toEqual(['fulfill', 'event', 'metadata']); expect((await job())?.status).toBe('synced');
  });
  it('recovers an applied mutation whose response was lost without sending it twice', async () => {
    await queue(); api.apply.mockImplementationOnce(async (action: any) => {
      calls.push(action.kind); applyFixtureAction(remote, action); throw new SyncApiError('timeout', true, true);
    });
    await service.tick(); expect((await job())?.status).toBe('error'); expect((await job())?.intent.kind).toBe('fulfill');
    await db.collection('shopifysyncjobs').updateOne({ transactionId: id }, { $set: { nextAttemptAt: new Date(0) } });
    await new ShopifySyncService(tx, orders, api).tick();
    expect(calls).toEqual(['fulfill', 'event', 'metadata']); expect((await job())?.status).toBe('synced');
  });
  it('never blindly repeats an uncertain mutation that cannot be confirmed', async () => {
    await queue(); api.apply.mockImplementationOnce(async (a: any) => { calls.push(a.kind); throw new SyncApiError('timeout', true, true); });
    await service.tick(); await db.collection('shopifysyncjobs').updateOne({ transactionId: id }, { $set: { nextAttemptAt: new Date(0) } });
    await service.tick(); expect(calls).toEqual(['fulfill']); expect((await job())?.status).toBe('review');
    await service.retry(String((await job())?._id), 'admin'); await service.tick(); expect(calls).toEqual(['fulfill']);
  });
  it('retries a known throttle safely and exposes the eventual status', async () => {
    await queue(); api.apply.mockRejectedValueOnce(new SyncApiError('rate limit', true, false));
    await service.tick(); expect((await job())?.intent).toBeNull();
    await service.retry(String((await job())?._id), 'admin'); await service.tick();
    expect(calls).toEqual(['fulfill', 'event', 'metadata']); expect((await job())?.status).toBe('synced');
  });
  it('only syncs changes after first enable, persists settings, and avoids echo loops', async () => {
    await tx.updateOne({ _id: id }, { $set: { updatedAt: new Date('2026-01-01') } }, { timestamps: false });
    await service.configure(true, false, 'admin'); await service.tick(); expect(calls).toEqual([]);
    await tx.updateOne({ _id: id }, { $set: { deposit: 401, remaining: 469 } });
    await service.tick(); expect((await job())?.status).toBe('synced');
    const count = calls.length;
    await tx.updateOne({ _id: id }, { $set: { unrelatedField: 'webhook echo' } });
    const restarted = new ShopifySyncService(tx, orders, api); await restarted.tick();
    expect((await restarted.status()).enabled).toBe(true); expect(calls).toHaveLength(count);
  });
  it('stops automatic pending sends when disabled, but an explicit retry works', async () => {
    await service.configure(true, false, 'admin');
    await tx.updateOne({ _id: id }, { $set: { deposit: 401, remaining: 469 } });
    api.apply.mockRejectedValueOnce(new SyncApiError('rate limit', true, false));
    await service.tick(); expect((await job())?.status).toBe('error');
    await service.configure(false, false, 'admin');
    await db.collection('shopifysyncjobs').updateOne({ transactionId: id }, { $set: { nextAttemptAt: new Date(0) } });
    await service.tick(); expect(calls).toEqual([]);
    await service.retry(String((await job())?._id), 'admin'); await service.tick();
    expect((await job())?.status).toBe('synced');
  });
  it('persists invalid sources as review rows rather than silently skipping them', async () => {
    await service.configure(true, false, 'admin');
    await tx.create({ ref: 'duplicate', shopifyOrderId: syncFixture().tx.shopifyOrderId });
    await tx.updateOne({ _id: id }, { $set: { deposit: 401 } });
    await service.tick(); expect((await job())?.status).toBe('review'); expect(calls).toEqual([]);
  });
  it('honors switching automatic payments off for an already queued attempt', async () => {
    await service.configure(true, true, 'admin');
    await tx.updateOne({ _id: id }, { $set: { deposit: 870, remaining: 0 } });
    api.apply.mockRejectedValueOnce(new SyncApiError('rate limit', true, false));
    await service.tick(); expect((await job())?.includePayments).toBe(true);
    await service.configure(true, false, 'admin');
    await service.retry(String((await job())?._id), 'admin'); await service.tick();
    expect((await job())?.status).toBe('synced'); expect(calls).not.toContain('payment');
    expect(remote.displayFinancialStatus).toBe('PENDING');
  });
  it('a delayed retry does not block another order, and the latest source is reconsidered', async () => {
    await service.configure(true, false, 'admin');
    await tx.updateOne({ _id: id }, { $set: { deposit: 401, remaining: 469 } });
    api.apply.mockRejectedValueOnce(new SyncApiError('rate limit', true, false));
    await service.tick(); expect((await job())?.status).toBe('error');
    await tx.updateOne({ _id: id }, { $set: { deposit: 402, remaining: 468 } });
    const second = syncFixture(); const otherId = '507f1f77bcf86cd799439012';
    second.tx._id = otherId; second.tx.ref = '2883'; second.tx.shopifyOrderId = '7219642466606';
    second.order.shopifyId = second.tx.shopifyOrderId;
    second.remote.id = 'gid://shopify/Order/' + second.tx.shopifyOrderId; second.remote.name = '#2883';
    await tx.create(second.tx); await orders.create(second.order);
    let activeRemote = remote;
    api.read.mockImplementation(async (orderId: string) => { activeRemote = orderId === second.tx.shopifyOrderId ? second.remote : remote; return structuredClone(activeRemote); });
    api.apply.mockImplementation(async (a: any) => { calls.push(a.kind); applyFixtureAction(activeRemote, a); });
    await service.tick();
    expect((await db.collection('shopifysyncjobs').findOne({ transactionId: otherId }))?.status).toBe('synced');
    expect((await job())?.rescan).toBe(true);
    await db.collection('shopifysyncjobs').updateOne({ transactionId: id }, { $set: { nextAttemptAt: new Date(0) } });
    await service.tick(); expect((await job())?.status).toBe('review');
    await service.tick(); expect((await job())?.status).toBe('synced');
    expect((await job())?.source.deposit).toBe(40200);
  });
});
