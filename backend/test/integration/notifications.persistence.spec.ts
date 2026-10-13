import mongoose, { Connection, Types } from 'mongoose';
import { NotificationsService } from '../../src/notifications/notifications.service';
const dbName = `soulia_test_push_${process.pid}_${Date.now()}`;
let connection: Connection;
let service: NotificationsService;
const user = { userId: new Types.ObjectId().toString(), role: 'admin', isActive: true };
const sub = { endpoint: 'https://web.push.apple.com/fixture', keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } };
beforeAll(async () => {
  connection = await mongoose.createConnection(`mongodb://localhost:27017/${dbName}`, { serverSelectionTimeoutMS: 3000 }).asPromise();
  service = new NotificationsService(connection); await service.onModuleInit();
  (service as any).push = { sendNotification: jest.fn(async () => ({})) };
  await connection.collection('users').insertOne({ _id: new Types.ObjectId(user.userId), role: 'admin', isActive: true });
}, 10000);
afterAll(async () => {
  if (connection) { if (!/^soulia_test_push_\d+_\d+$/.test(connection.name)) throw new Error('Unsafe scratch database'); await connection.dropDatabase(); await connection.close(); }
});
beforeEach(async () => { await connection.collection('notificationaccounts').deleteMany({}); await connection.collection('notificationjobs').deleteMany({}); await connection.collection('notificationpointchanges').deleteMany({}); await connection.collection('employeeperformancelogs').deleteMany({}); });
it('persists account preferences across service restart without mixing devices', async () => {
  await service.preferences(user, { enabled: true, delivered: false, language: 'en' }); await service.subscribe(user, sub);
  const restarted = new NotificationsService(connection); const state = await restarted.settings(user);
  expect(state.preferences.enabled).toBe(true); expect(state.preferences.delivered).toBe(false); expect(state.devices).toBe(1);
  expect(state.language).toBe('en');
});
it('only admins control the language applied to every employee, overriding old staff choices', async () => {
  const staff = { ...user, userId: new Types.ObjectId().toString(), role: 'staff' };
  await service.preferences(user, { employeeLanguage: 'en' });
  await connection.collection('notificationaccounts').insertOne({ userId: staff.userId, language: 'ar', preferences: { enabled: true } });
  expect((await service.settings(staff)).language).toBe('en');
  await expect(service.preferences(staff, { language: 'ar' })).rejects.toThrow();
  await expect(service.preferences(staff, { employeeLanguage: 'ar' })).rejects.toThrow();
  await service.preferences(user, { employeeLanguage: 'ar' });
  expect((await service.settings(staff)).language).toBe('ar');
});
it('tracks gross changes and weekly totals without changing the current points balance or double counting replaced rows', async () => {
  const staff = { ...user, role: 'staff', userId: new Types.ObjectId().toString() };
  await connection.collection('users').insertOne({ _id: new Types.ObjectId(staff.userId), role: 'staff', isActive: true });
  await service.preferences(staff, { enabled: true }); await service.subscribe(staff, sub);
  const oldId = new Types.ObjectId(), newId = new Types.ObjectId();
  const previous = { _id: oldId, employeeId: staff.userId, points: 15, createdAt: new Date() };
  await connection.collection('employeeperformancelogs').insertOne({ _id: newId, employeeId: staff.userId, points: 10, createdAt: new Date() });
  await service.recordPointChange(String(newId), staff.userId, -5, 'تعديل التقييم', '2771', previous);
  await service.recordPointChange(String(newId), staff.userId, -5, 'تعديل التقييم', '2771', previous);
  const pointJobs = await connection.collection('notificationjobs').find({ type: 'performance' }).toArray();
  expect(pointJobs).toHaveLength(1); expect(JSON.parse(pointJobs[0].payload).body).toContain('-5');
  const nextWeek = new Date(Date.now() + 7 * 86400000);
  await service.weeklyPerformanceSummary(nextWeek); await service.weeklyPerformanceSummary(nextWeek);
  const summaries = await connection.collection('notificationjobs').find({ eventId: /^performance:week:/ }).toArray();
  expect(summaries).toHaveLength(1);
  const payload = JSON.parse(summaries[0].payload);
  expect(payload.body).toBe('رصيد نقاطك الحالي: 10 نقطة. نقاط مكتسبة هذا الأسبوع: +15. نقاط مخصومة: -5.');
  expect(payload.title).toBe('📊 ملخص الأداء الأسبوعي · SOULIA');
  expect(await connection.collection('employeeperformancelogs').countDocuments({})).toBe(1);
});
it('atomically deduplicates concurrent webhook notifications in MongoDB', async () => {
  await service.preferences(user, { enabled: true }); await service.subscribe(user, sub);
  await Promise.all(Array.from({ length: 5 }, () => service.enqueue('delivered', 'delivery:fixture', '100')));
  expect(await connection.collection('notificationjobs').countDocuments({})).toBe(1);
});
it.each(['en', 'ar'])('personalizes a new order only for its assigned employee in %s, retaining admin and other staff delivery', async language => {
  const assignee = { ...user, role: 'staff', userId: new Types.ObjectId().toString() };
  const other = { ...assignee, userId: new Types.ObjectId().toString() };
  const inactive = { ...assignee, userId: new Types.ObjectId().toString(), isActive: false };
  for (const recipient of [assignee, other, inactive]) await connection.collection('users').insertOne({ _id: new Types.ObjectId(recipient.userId), role: recipient.role, isActive: recipient.isActive });
  await service.preferences(user, { employeeLanguage: language });
  for (const [index, recipient] of [user, assignee, other].entries()) {
    await service.preferences(recipient, recipient.role === 'admin' ? { enabled: true, language } : { enabled: true });
    await service.subscribe(recipient, { ...sub, endpoint: sub.endpoint + '/assignment-' + index });
  }
  await service.enqueue('order', 'assigned:new-order', '2771', 'shopify:' + new Types.ObjectId('507f1f77bcf86cd799439011'), undefined, undefined, { orderTotal: 2450, assignedUserId: assignee.userId });
  await Promise.all(Array.from({ length: 5 }, () => service.enqueue('order', 'assigned:new-order', '2771', 'shopify:' + new Types.ObjectId('507f1f77bcf86cd799439011'), undefined, undefined, { orderTotal: 2450, assignedUserId: assignee.userId })));
  const jobs = await connection.collection('notificationjobs').find({}).toArray();
  expect(jobs).toHaveLength(3);
  const assigned = JSON.parse(jobs.find(job => job.userId === assignee.userId)!.payload);
  expect(assigned.title).toBe(language === 'en' ? '🛍️ New Order Assigned · SOULIA' : '🛍️ طلب جديد مُسند إليك · SOULIA');
  expect(assigned.body).toBe(language === 'en' ? 'Order #2771 · EGP 2,450 · Assigned to You' : 'الطلب #2771 · 2,450 ج.م. · مُسند إليك');
  for (const recipient of [user, other]) {
    const payload = JSON.parse(jobs.find(job => job.userId === recipient.userId)!.payload);
    expect(payload.title).toBe(language === 'en' ? '🛍️ New Order · SOULIA' : '🛍️ طلب جديد · SOULIA');
    expect(payload.body).toBe(language === 'en' ? 'Order #2771 · EGP 2,450 · New Order Received' : 'الطلب #2771 · 2,450 ج.م. · تم استلام طلب جديد');
    expect(payload.timestamp).toBe(assigned.timestamp);
  }
  const send = (service as any).push.sendNotification; send.mockClear();
  await service.dispatch(); await service.dispatch(); expect(send).toHaveBeenCalledTimes(3);
  // Turning off this category for the assignee does not suppress other recipients.
  await service.preferences(assignee, { order: false });
  await service.enqueue('order', 'assigned:disabled', '2772', 'shopify:' + new Types.ObjectId(), undefined, undefined, { orderTotal: 100, assignedUserId: assignee.userId });
  const disabled = await connection.collection('notificationjobs').find({ eventId: 'assigned:disabled' }).toArray();
  expect(disabled.map(job => job.userId).sort()).toEqual([user.userId, other.userId].sort());
});
it('retains normal notifications for unassigned orders and never personalizes an admin notification', async () => {
  await service.preferences(user, { enabled: true, language: 'en' }); await service.subscribe(user, sub);
  await service.enqueue('order', 'unassigned', '2771', '', undefined, undefined, { orderTotal: 2450 });
  await service.enqueue('order', 'admin-assigned', '2772', '', undefined, undefined, { orderTotal: 2450, assignedUserId: user.userId, assignedToYou: true });
  const jobs = await connection.collection('notificationjobs').find({}).toArray();
  expect(jobs).toHaveLength(2);
  for (const job of jobs) {
    expect(JSON.parse(job.payload).title).toBe('🛍️ New Order · SOULIA');
    expect(JSON.parse(job.payload).body).toContain('New Order Received');
  }
});
it.each(['otp', 'approval', 'shopifyChange', 'security'] as const)('deduplicates concurrent admin %s events and dispatches them only once', async type => {
  await service.preferences(user, { enabled: true, language: 'en' }); await service.subscribe(user, sub);
  const id = new Types.ObjectId();
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  if (type === 'otp') await connection.collection('discountotps').insertOne({ _id: id, otp: '493821', status: 'unused', expiresAt });
  await Promise.all(Array.from({ length: 5 }, () => service.enqueue(type, 'admin:' + type + ':' + id, '2771', (type === 'otp' ? 'otp:' : 'tx:') + id, undefined, undefined, { actorName: 'Ahmed', actionKey: 'edit-tx', expiresAt, status: 'pending', changedFields: ['address', 'price'] })));
  const jobs = await connection.collection('notificationjobs').find({}).toArray();
  expect(jobs).toHaveLength(1); expect(JSON.stringify(jobs)).not.toContain('493821');
  const send = (service as any).push.sendNotification; send.mockClear();
  await service.dispatch(); await service.dispatch(); expect(send).toHaveBeenCalledTimes(1);
  if (type === 'otp') expect(JSON.parse(send.mock.calls[0][1]).body).toContain('493821');
});
it('supports multiple devices and unique ownership when a browser changes accounts', async () => {
  await service.subscribe(user, sub); await service.subscribe(user, { ...sub, endpoint: sub.endpoint + '2' });
  expect((await service.settings(user)).devices).toBe(2);
  const other = { ...user, userId: new Types.ObjectId().toString() }; await service.subscribe(other, sub);
  expect((await service.settings(user)).devices).toBe(1); expect((await service.settings(other)).devices).toBe(1);
});
it('dispatches a persisted job once across worker ticks', async () => {
  await service.preferences(user, { enabled: true }); await service.subscribe(user, sub);
  await service.enqueue('deposit', 'deposit:fixture', '100');
  const send = (service as any).push.sendNotification; send.mockClear(); await service.dispatch(); await service.dispatch();
  expect(send).toHaveBeenCalledTimes(1);
  expect(await connection.collection('notificationjobs').countDocuments({ done: true })).toBe(1);
});
it('routes mentions only to the referenced staff member while keeping finance administrator-only', async () => {
  const staff = { userId: new Types.ObjectId().toString(), role: 'staff', isActive: true };
  await connection.collection('users').insertOne({ _id: new Types.ObjectId(staff.userId), role: 'staff', isActive: true });
  await service.preferences(staff, { enabled: true, mention: true }); await service.subscribe(staff, sub);
  await service.enqueue('deposit', 'finance', '2638', '', undefined, undefined, { actorName: 'Fixture', amount: 500 });
  expect(await connection.collection('notificationjobs').countDocuments({})).toBe(0);
  await service.enqueue('mention', 'mention:fixture', '2638', 'mention:' + new Types.ObjectId(), staff.userId, undefined, { actorName: 'Fixture' });
  const jobs = await connection.collection('notificationjobs').find({}).toArray();
  expect(jobs).toHaveLength(1); expect(jobs[0].userId).toBe(staff.userId);
  const send = (service as any).push.sendNotification; send.mockClear(); await service.dispatch(); expect(send).toHaveBeenCalledTimes(1);
});
