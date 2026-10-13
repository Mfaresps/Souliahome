import { NotificationsService, DEFAULTS, TYPES, MANDATORY_TYPES, STAFF_TYPES, eligible, validatePreferences, validateSubscription, notificationBody } from '../../src/notifications/notifications.service';
import { MentionsService } from '../../src/mentions/mentions.service';
import { NotificationsController } from '../../src/notifications/notifications.controller';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { ShopifyService } from '../../src/shopify/shopify.service';
import { createHmac } from 'crypto';

const admin = { userId: '507f1f77bcf86cd799439011', role: 'admin', isActive: true };
const subscription = { endpoint: 'https://web.push.apple.com/test', keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } };
function setup() {
  let account: any = { userId: admin.userId, preferences: { ...DEFAULTS, enabled: true }, subscriptions: [subscription] };
  const users = { find: jest.fn(() => ({ toArray: async () => [{ ...admin, _id: admin.userId }] })), findOne: jest.fn(async () => ({ ...admin })) };
  const accounts = { findOne: jest.fn(async () => account), updateMany: jest.fn(), updateOne: jest.fn(async (_filter, update) => {
    for (const [key, value] of Object.entries(update.$set || {})) if (key.startsWith('preferences.')) account.preferences[key.split('.')[1]] = value;
    if (update.$set?.language) account.language = update.$set.language;
    if (update.$pull) account.subscriptions = [];
  }) };
  const stored = new Map();
  const jobs = { updateOne: jest.fn(async (filter, update) => { if (update.$setOnInsert && !stored.has(filter.eventId)) stored.set(filter.eventId, update.$setOnInsert); }), findOneAndUpdate: jest.fn(async () => null) };
  const connection: any = { collection: (name: string) => ({ users, notificationaccounts: accounts, notificationjobs: jobs } as any)[name] };
  const service = new NotificationsService(connection);
  const push = { sendNotification: jest.fn(async () => ({})) };
  (service as any).push = push;
  return { service, push, account, accounts, jobs, users, stored };
}
describe('Web Push settings, security and delivery', () => {
  it('guards every endpoint with JWT', () => expect(Reflect.getMetadata(GUARDS_METADATA, NotificationsController)).toContain(JwtAuthGuard));
  it.each(['staff', 'viewer'])('allows %s operational notifications while keeping deposits administrator-only', async role => {
    const { service } = setup(); const user = { ...admin, role };
    expect((await service.settings(user)).allowedTypes).toEqual(STAFF_TYPES);
    await expect(service.preferences(user, { enabled: true, mention: false, comment: true, followup: true, order: true, deliveryProblem: true, delivered: true })).resolves.toBeDefined();
    await expect(service.preferences(user, { deposit: true })).rejects.toThrow();
    expect(eligible(user, { ...DEFAULTS, enabled: true }, 'mention')).toBe(true);
    expect(eligible(user, { ...DEFAULTS, enabled: true }, 'deposit')).toBe(false);
  });
  it('rejects inactive administrators', () => expect(() => setup().service.authorize({ ...admin, isActive: false })).toThrow());
  it('cannot switch off management announcements except through the master switch', async () => {
    expect(() => validatePreferences({ announcement: false })).toThrow();
    const { service, account, stored } = setup();
    await expect(service.preferences({ ...admin, role: 'staff' }, { announcement: false })).rejects.toThrow();
    account.preferences.announcement = false; // a value stored before the rule existed
    await service.enqueue('announcement', 'stored-off', '', 'announcement:' + admin.userId, [admin.userId]); expect(stored.size).toBe(1);
    account.preferences.enabled = false;
    await service.enqueue('announcement', 'master-off', '', 'announcement:' + admin.userId, [admin.userId]); expect(stored.size).toBe(1);
  });
  it.each(TYPES.filter(type => !(MANDATORY_TYPES as readonly string[]).includes(type)))('respects independent %s preferences and master', async type => {
    const { service, account, stored } = setup();
    account.preferences[type] = false;
    await service.enqueue(type, 'off', '100'); expect(stored.size).toBe(0);
    account.preferences[type] = true; account.preferences.enabled = false;
    await service.enqueue(type, 'master-off', '100'); expect(stored.size).toBe(0);
    account.preferences.enabled = true;
    await service.enqueue(type, 'on', '100', type === 'otp' ? 'otp:' + admin.userId : '', ['mention', 'performance'].includes(type) ? admin.userId : undefined, undefined, { pointDelta: 2, expiresAt: new Date(Date.now() + 60000).toISOString() }); expect(stored.size).toBe(1);
  });
  it('preserves individual preferences across master off/on and new login', async () => {
    const { service } = setup();
    await service.preferences(admin, { deposit: false, comment: false });
    await service.preferences(admin, { enabled: false }); await service.preferences(admin, { enabled: true });
    expect((await service.settings({ ...admin })).preferences).toEqual({ ...DEFAULTS, enabled: true, deposit: false, comment: false });
  });
  it.each([null, { enabled: 'true' }, { userId: 'other' }, { toString: true }, { unknown: false }] as any[])('rejects malformed preferences %p', value => expect(() => validatePreferences(value)).toThrow());
  it.each(['http://web.push.apple.com/test', 'https://127.0.0.1/test', 'https://evil.test/test', 'https://web.push.apple.com.evil.test/test', 'https://user:pass@web.push.apple.com/test'])('blocks unsafe endpoint %s', endpoint => expect(() => validateSubscription({ ...subscription, endpoint })).toThrow());
  it('accepts valid provider keys, rejects malformed keys', () => {
    expect(validateSubscription(subscription)).toEqual(subscription);
    expect(() => validateSubscription({ ...subscription, keys: { p256dh: 'bad', auth: 'bad' } })).toThrow();
  });
  it.each(TYPES)('deduplicates durable %s events and excludes private payload data', async type => {
    const { service, stored } = setup();
    const recipient = ['mention', 'performance'].includes(type) ? admin.userId : undefined;
    await service.enqueue(type, 'stable', '100', (type === 'otp' ? 'otp:' : 'tx:') + admin.userId, recipient, undefined, { pointDelta: 2, expiresAt: new Date(Date.now() + 60000).toISOString() }); await service.enqueue(type, 'stable', '100', type === 'otp' ? 'otp:' + admin.userId : '', recipient, undefined, { pointDelta: 2, expiresAt: new Date(Date.now() + 60000).toISOString() });
    expect(stored.size).toBe(1); const payload = JSON.parse(stored.get('stable').payload);
    expect(payload.body).toContain(type === 'mention' ? '100' : '#100'); expect(payload.url).toContain('pushRecord=');
    expect(Object.keys(payload).sort()).toEqual(['body', 'dir', 'lang', 'tag', 'timestamp', 'title', 'url']);
  });
  it('allows active staff orders and isolates a user test', async () => {
    expect(eligible({ role: 'staff', isActive: true }, { ...DEFAULTS, enabled: true }, 'order')).toBe(true);
    const { service, stored } = setup(); await service.enqueue('order', 'test', '100', '', 'another-user'); expect(stored.size).toBe(0);
  });
  it('never throws when queuing fails after a business commit', async () => {
    const { service, users } = setup(); users.find.mockImplementation(() => { throw new Error('Database unavailable'); });
    await expect(service.enqueue('deposit', 'event', '100')).resolves.toBeUndefined();
  });
  it.each(STAFF_TYPES.filter(type => !['mention', 'performance'].includes(type)))('queues %s to all opted-in staff and uses one timestamp across devices', async type => {
    const { service, users, accounts, stored } = setup();
    const staff1 = '507f1f77bcf86cd799439012', staff2 = '507f1f77bcf86cd799439013';
    users.find.mockReturnValue({ toArray: async () => [{ _id: staff1, role: 'staff' }, { _id: staff2, role: 'staff' }] } as any);
    (accounts.findOne as jest.Mock).mockImplementation(async ({ userId }: any) => ({ userId, preferences: { ...DEFAULTS, enabled: true }, subscriptions: [subscription] }));
    // Store each recipient independently, matching the queue's compound identity.
    const jobs = (service as any).jobs;
    jobs.updateOne.mockImplementation(async (_filter: any, update: any) => { const job = update.$setOnInsert; if (job) stored.set(job.userId, job); });
    await service.enqueue(type, 'shared-event', '2771', 'tx:' + admin.userId);
    expect(stored.size).toBe(2);
    expect(new Set([...stored.values()].map(job => JSON.parse(job.payload).timestamp)).size).toBe(1);
    expect(users.find).toHaveBeenCalledWith({ role: { $in: ['admin', 'staff', 'viewer'] }, isActive: { $ne: false } });
  });
  it('starts sending to a second device while the first provider request is still pending', async () => {
    const { service, jobs, push } = setup();
    jobs.findOneAndUpdate.mockResolvedValueOnce({ _id: 'first', userId: admin.userId, endpoint: subscription.endpoint, type: 'comment', payload: 'first', attempts: 1 } as never)
      .mockResolvedValueOnce({ _id: 'second', userId: admin.userId, endpoint: subscription.endpoint, type: 'comment', payload: 'second', attempts: 1 } as never);
    let finishFirst!: () => void;
    const firstPending = new Promise<void>(resolve => finishFirst = resolve);
    push.sendNotification.mockImplementationOnce(async () => { await firstPending; return {}; });
    const work = service.dispatch();
    for (let i = 0; i < 100 && push.sendNotification.mock.calls.length < 2; i++) await Promise.resolve();
    expect(push.sendNotification).toHaveBeenCalledTimes(2);
    finishFirst(); await work;
    expect(jobs.updateOne).toHaveBeenCalledWith({ _id: 'second' }, { $set: { done: true } });
  });
  it.each([404, 410])('removes expired subscriptions on %s', async statusCode => {
    const { service, push, accounts, jobs } = setup();
    jobs.findOneAndUpdate.mockResolvedValueOnce({ _id: 'job', userId: admin.userId, endpoint: subscription.endpoint, type: 'order', payload: '{}', attempts: 1 } as never);
    push.sendNotification.mockRejectedValueOnce({ statusCode } as never);
    await service.dispatch(); expect(accounts.updateOne).toHaveBeenCalledWith({ userId: admin.userId }, expect.objectContaining({ $pull: expect.anything() }));
    expect(jobs.updateOne).toHaveBeenCalledWith({ _id: 'job' }, expect.objectContaining({ $set: expect.objectContaining({ done: true }) }));
  });
  it('bounds provider failures and supplies timeout without exposing secrets', async () => {
    const { service, push, jobs, accounts } = setup();
    jobs.findOneAndUpdate.mockResolvedValueOnce({ _id: 'job', userId: admin.userId, endpoint: subscription.endpoint, type: 'order', payload: '{}', attempts: 3 } as never);
    push.sendNotification.mockRejectedValueOnce(new Error('network') as never);
    await service.dispatch(); expect(push.sendNotification).toHaveBeenCalledWith(subscription, '{}', { TTL: 3600, timeout: 10000 });
    expect(jobs.updateOne).toHaveBeenCalledWith({ _id: 'job' }, expect.objectContaining({ $set: expect.objectContaining({ done: true }) }));
    expect(accounts.updateOne).not.toHaveBeenCalled();
  });
  it('rechecks current authorization and preferences before dispatch', async () => {
    const { service, push, jobs, account } = setup(); account.preferences.enabled = false;
    jobs.findOneAndUpdate.mockResolvedValueOnce({ _id: 'job', userId: admin.userId, endpoint: subscription.endpoint, type: 'order' } as never);
    await service.dispatch(); expect(push.sendNotification).not.toHaveBeenCalled();
  });
  it('rejects missing/invalid Shopify webhook signatures and accepts the correct HMAC', () => {
    const verify = ShopifyService.prototype.verifyWebhook; const old = process.env.SHOPIFY_WEBHOOK_SECRET;
    try {
      delete process.env.SHOPIFY_WEBHOOK_SECRET; expect(verify.call({}, Buffer.from('{}'), 'bad')).toBe(false);
      process.env.SHOPIFY_WEBHOOK_SECRET = 'test-only'; const raw = Buffer.from('{}');
      expect(verify.call({}, raw, 'bad')).toBe(false);
      expect(verify.call({}, raw, createHmac('sha256', 'test-only').update(raw).digest('base64'))).toBe(true);
    } finally { if (old === undefined) delete process.env.SHOPIFY_WEBHOOK_SECRET; else process.env.SHOPIFY_WEBHOOK_SECRET = old; }
  });
});

describe('SOULIA notification message formats', () => {
  it.each([
    ['deposit', 'New Deposit · SOULIA', 'Fares added EGP 1,600 · InstaPay · #2771 · Review Required', { actorName: 'Fares', amount: 1600, vaultName: 'Instapay', pendingApproval: true }, 'tx:', undefined],
    ['comment', 'New Comment · SOULIA', 'Ahmed commented on Order #2771: "Customer requested a delivery update…"', { actorName: 'Ahmed', commentText: 'Customer requested a delivery update…', commentId: 123 }, 'tx:', undefined],
    ['comment', 'New Follow-up · SOULIA', 'Ahmed · Order #2771: "Call the customer tomorrow…"', { actorName: 'Ahmed', commentText: 'Call the customer tomorrow…', commentId: admin.userId }, 'followup:', undefined],
    ['order', 'New Order · SOULIA', 'Order #2771 · EGP 2,450 · New Order Received', { orderTotal: 2450 }, 'tx:', undefined],
    ['deliveryProblem', 'Delivery Issue · SOULIA', 'Order #2771 · Delivery Failed · Action Required', {}, 'tx:', 'FAILED_ATTEMPT'],
    ['delivered', 'Order Delivered · SOULIA', 'Order #2771 · Successfully Delivered', {}, 'tx:', undefined],
  ] as const)('formats %s as specified: %s', async (type, title, body, details, kind, status) => {
    const { service, stored, account } = setup(); account.language = 'en';
    await service.enqueue(type, 'format', '2771', kind + admin.userId, undefined, status, details);
    const payload = JSON.parse(stored.get('format').payload);
    const emoji = kind === 'followup:' ? '📌' : { deposit: '💰', comment: '💬', order: '🛍️', deliveryProblem: '🚨', delivered: '📦' }[type];
    expect(payload.title).toBe(`${emoji} ${title}`); expect(payload.body).toBe(body);
    const url = new URL(payload.url, 'https://soulia.test');
    expect(url.searchParams.get('pushRecord')).toBe(kind + admin.userId);
    expect(url.searchParams.get('pushType')).toBe(type);
  });
  it('uses Review Required only for explicitly pending deposits', () => {
    expect(notificationBody('deposit', '2771', { actorName: 'Fares', amount: 1600, vaultName: 'Instapay' }, 'en')).toBe('Fares added EGP 1,600 · InstaPay · #2771');
    expect(notificationBody('deposit', '2771', { amount: 1600, pendingApproval: false }, 'en')).not.toContain('Review Required');
  });
  it('truncates comment excerpts to 80 characters with an ellipsis and closing quote', () => {
    const text = 'Customer requested a delivery update. '.repeat(5);
    const body = notificationBody('comment', '2771', { actorName: 'Ahmed', commentText: text }, 'en');
    expect(body).toBe('Ahmed commented on Order #2771: "' + text.slice(0, 79).trimEnd() + '…"');
    expect(body.length).toBeLessThanOrEqual(160);
    const long = notificationBody('comment', '9'.repeat(24), { actorName: 'A'.repeat(36), commentText: '📦'.repeat(100) }, 'en');
    expect(long.length).toBeLessThanOrEqual(160); expect(long).toMatch(/…"$/);
    expect(long).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
  it('does not invent an order total and distinguishes actual returned deliveries', () => {
    expect(notificationBody('order', '2771', {}, 'en')).toBe('Order #2771 · New Order Received');
    expect(notificationBody('deliveryProblem', '2771', { deliveryStatus: 'RETURNED' }, 'en')).toBe('Order #2771 · Returned Before Delivery · Action Required');
  });
  it('persists notification language separately without changing categories', async () => {
    const { service } = setup(); await service.preferences(admin, { language: 'en' });
    const state = await service.settings(admin); expect(state.language).toBe('en'); expect(state.preferences).toEqual({ ...DEFAULTS, enabled: true });
    expect(() => validatePreferences({ language: 'fr' })).toThrow();
  });
  it.each(TYPES)('sends English %s titles and bodies for English recipients', async type => {
    const { service, account, stored } = setup(); account.language = 'en';
    await service.enqueue(type, 'english', '2638', type === 'otp' ? 'otp:' + admin.userId : '', ['mention', 'performance'].includes(type) ? admin.userId : undefined, 'FAILED_ATTEMPT', { pointDelta: 2, actorName: 'Ahmed Ali', amount: 500, expiresAt: new Date(Date.now() + 60000).toISOString() });
    const payload = JSON.parse(stored.get('english').payload);
    expect(payload.lang).toBe('en'); expect(payload.dir).toBe('ltr'); expect(payload.title).not.toMatch(/[\u0600-\u06ff]/); expect(payload.body).not.toMatch(/[\u0600-\u06ff]/);
    if (type === 'deposit') expect(payload.body).toBe('Ahmed Ali added EGP 500 · Unspecified vault · #2638');
    if (type === 'mention') expect(payload.body).toBe('Ahmed Ali mentioned you in a comment on order #2638.');
  });
  it('translates pending receipt and test notifications', async () => {
    const { service, account, stored } = setup(); account.language = 'en';
    await service.enqueue('deposit', 'pending', '2638', '', undefined, undefined, { actorName: 'Ahmed', amount: 500, pendingApproval: true });
    expect(JSON.parse(stored.get('pending').payload).body).toBe('Ahmed added EGP 500 · Unspecified vault · #2638 · Review Required');
    await service.test(admin); const test = [...stored.values()].find(j => j.eventId.startsWith('test:')); expect(JSON.parse(test.payload).title).toBe('🔔 SOULIA test notification');
  });
  it('includes the depositing employee, amount and order with correct formal grammar', () => {
    expect(notificationBody('deposit', '#2638', { actorName: 'أحمد علي', amount: 500, vaultName: 'Instapay' })).toBe('أحمد علي أضاف 500 ج.م. · Instapay · #2638');
    expect(notificationBody('deposit', '2638', { actorName: 'منى', amount: 1250.5 })).toContain('1,250.5 ج.م.');
  });
  it('accurately labels submitted receipts as pending approval', async () => {
    const { service, stored } = setup();
    await service.enqueue('deposit', 'receipt', '2638', '', undefined, undefined, { actorName: 'أحمد علي', amount: 500, pendingApproval: true });
    const payload = JSON.parse(stored.get('receipt').payload);
    expect(payload.title).toBe('💰 عربون جديد · SOULIA'); expect(payload.body).toBe('أحمد علي أضاف 500 ج.م. · خزنة غير محددة · #2638 · مطلوب مراجعة');
    expect(payload.body.length).toBeLessThan(160); expect(payload.timestamp).toEqual(expect.any(Number));
  });
  it('does not invent a financial amount or expose unsafe control characters', () => {
    expect(notificationBody('deposit', '2638', { actorName: 'Test', amount: NaN })).toBe('');
    expect(notificationBody('mention', '2638', { actorName: 'أحمد\n\u202e علي' })).toBe('إشارة من أحمد علي إليك في تعليق على الطلب رقم 2638.');
  });
  it('includes the comment author and routes to the saved comment, without a date in the body', async () => {
    const { service, stored, account } = setup(); account.language = 'en';
    await service.enqueue('comment', 'comment-detail', '2776', 'tx:' + admin.userId, undefined, undefined, { actorName: 'Fares', commentId: 123, commentText: 'Called customer' });
    const payload = JSON.parse(stored.get('comment-detail').payload);
    expect(payload.body).toBe('Fares commented on Order #2776: "Called customer"');
    const url = new URL(payload.url, 'https://soulia.test');
    expect(url.searchParams.get('pushType')).toBe('comment'); expect(url.searchParams.get('pushEvent')).toBe('123');
  });
  it('keeps pending deposit messages short and includes their actual vault and receipt link', async () => {
    const { service, stored, account } = setup(); account.language = 'en';
    await service.enqueue('deposit', 'deposit-detail', '2771', 'shopify:' + admin.userId, undefined, undefined, { actorName: 'Fares', amount: 1600, vaultName: 'Instapay', pendingApproval: true, receiptId: 'receipt-123' });
    const payload = JSON.parse(stored.get('deposit-detail').payload);
    expect(payload.body).toBe('Fares added EGP 1,600 · InstaPay · #2771 · Review Required'); expect(payload.body.length).toBeLessThan(80);
    const url = new URL(payload.url, 'https://soulia.test');
    expect(url.searchParams.get('pushType')).toBe('deposit'); expect(url.searchParams.get('pushEvent')).toBe('receipt-123');
  });
  it('never broadcasts mentions and targets only the mentioned account', async () => {
    const { service, stored } = setup();
    await service.enqueue('mention', 'broadcast', '2638'); expect(stored.size).toBe(0);
    await service.enqueue('mention', 'target', '2638', 'mention:' + admin.userId, admin.userId, undefined, { actorName: 'منى' });
    expect(JSON.parse(stored.get('target').payload).body).toBe('إشارة من منى إليك في تعليق على الطلب رقم 2638.');
  });
  it('queues genuine saved mentions using stable comment/recipient identifiers without comment text', async () => {
    const row: any = { _id: admin.userId, targetUserId: 'target', fromUserId: 'author', fromName: 'أحمد', txId: 'record', txRef: '2638', commentId: 15, commentText: 'private customer fixture' };
    const model: any = { insertMany: jest.fn(async () => [row]) };
    const service: any = new MentionsService(model); service.notifications = { enqueue: jest.fn(async () => {}) };
    await service.createMany([row], true); const first = service.notifications.enqueue.mock.calls[0];
    expect(first).toEqual(['mention', expect.stringMatching(/^mention:/), '2638', 'mention:' + admin.userId, 'target', undefined, { actorName: 'أحمد' }]);
    await service.createMany([row], true); expect(service.notifications.enqueue.mock.calls[1][1]).toBe(first[1]);
    expect(JSON.stringify(first)).not.toContain(row.commentText);
    service.notifications.enqueue.mockClear(); await service.createMany([row]); expect(service.notifications.enqueue).not.toHaveBeenCalled();
    row.fromUserId = 'system'; await service.createMany([row], true); expect(service.notifications.enqueue).not.toHaveBeenCalled();
  });
  it('does not queue mentions after failed persistence', async () => {
    const service: any = new MentionsService({ insertMany: jest.fn(async () => { throw new Error('failed'); }) } as any);
    service.notifications = { enqueue: jest.fn() }; await expect(service.createMany([{}], true)).rejects.toThrow(); expect(service.notifications.enqueue).not.toHaveBeenCalled();
  });
});
