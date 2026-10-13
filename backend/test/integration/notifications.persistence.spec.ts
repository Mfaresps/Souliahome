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
beforeEach(async () => { await connection.collection('notificationaccounts').deleteMany({}); await connection.collection('notificationjobs').deleteMany({}); });
it('persists account preferences across service restart without mixing devices', async () => {
  await service.preferences(user, { enabled: true, delivered: false, language: 'en' }); await service.subscribe(user, sub);
  const restarted = new NotificationsService(connection); const state = await restarted.settings(user);
  expect(state.preferences.enabled).toBe(true); expect(state.preferences.delivered).toBe(false); expect(state.devices).toBe(1);
  expect(state.language).toBe('en');
});
it('atomically deduplicates concurrent webhook notifications in MongoDB', async () => {
  await service.preferences(user, { enabled: true }); await service.subscribe(user, sub);
  await Promise.all(Array.from({ length: 5 }, () => service.enqueue('delivered', 'delivery:fixture', '100')));
  expect(await connection.collection('notificationjobs').countDocuments({})).toBe(1);
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
