import mongoose, { Connection, Types } from 'mongoose';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { AnnouncementsService, cleanAnnouncementMessage } from '../../src/announcements/announcements.service';

export {};
const dbName = `soulia_test_ann_${process.pid}_${Date.now()}`;
let connection: Connection;
let notifications: NotificationsService;
let service: AnnouncementsService;
const emitted: { userId: string; event: string; payload: any }[] = [];
const presence: any = { emitToUser: (userId: string, event: string, payload: any) => { emitted.push({ userId, event, payload }); return true; } };

const id = () => new Types.ObjectId().toString();
const admin = { userId: id(), name: 'المدير', username: 'admin', role: 'admin' };
const admin2 = { userId: id(), name: 'Nour', username: 'nour', role: 'admin' };
const staffA = { userId: id(), name: 'منى', username: 'mona', role: 'staff' };
const staffB = { userId: id(), name: 'Omar', username: 'omar', role: 'staff' };
const viewer = { userId: id(), name: 'سارة', username: 'sara', role: 'viewer' };
const inactive = { userId: id(), name: 'معطل', username: 'off', role: 'staff' };
const sub = (n: number) => ({ endpoint: 'https://web.push.apple.com/ann-' + n, keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } });

beforeAll(async () => {
  connection = await mongoose.createConnection(`mongodb://localhost:27017/${dbName}`, { serverSelectionTimeoutMS: 3000 }).asPromise();
  notifications = new NotificationsService(connection); await notifications.onModuleInit();
  (notifications as any).push = { sendNotification: jest.fn(async () => ({})) };
  service = new AnnouncementsService(connection, notifications, presence); await service.onModuleInit();
  for (const u of [admin, admin2, staffA, staffB, viewer, inactive]) {
    await connection.collection('users').insertOne({ _id: new Types.ObjectId(u.userId), name: u.name, username: u.username, role: u.role, isActive: u !== inactive });
  }
  // Staff push language is the admin-managed employee language (Arabic by default);
  // an admin chooses their own. admin2: English. viewer: never enabled push.
  await notifications.preferences({ ...staffA, isActive: true }, { enabled: true }); await notifications.subscribe({ ...staffA, isActive: true }, sub(1));
  await notifications.preferences({ ...staffB, isActive: true }, { enabled: true }); await notifications.subscribe({ ...staffB, isActive: true }, sub(2));
  await notifications.preferences({ ...admin2, isActive: true }, { enabled: true, language: 'en' }); await notifications.subscribe({ ...admin2, isActive: true }, sub(3));
}, 15000);
afterAll(async () => {
  if (connection) {
    if (!/^soulia_test_ann_\d+_\d+$/.test(connection.name)) throw new Error('Unsafe scratch database');
    await connection.dropDatabase(); await connection.close();
  }
});
beforeEach(async () => {
  emitted.length = 0;
  await connection.collection('announcements').deleteMany({});
  await connection.collection('announcementconfig').deleteMany({});
  await connection.collection('notificationjobs').deleteMany({});
});

describe('Announcements — all employees', () => {
  it('addresses every active employee except the author, in-app and by push where enabled', async () => {
    const row = await service.create(admin, { category: 'holiday', audience: 'all', message: 'عيد سعيد للجميع 🎉\nإجازة يوم الخميس' });
    expect(row.recipientCount).toBe(4);
    expect(row.recipients.map((r: any) => r.userId).sort()).toEqual([admin2.userId, staffA.userId, staffB.userId, viewer.userId].sort());
    // Live ping carries the id only — never the message.
    expect(emitted.map(e => e.userId).sort()).toEqual([admin2.userId, staffA.userId, staffB.userId, viewer.userId].sort());
    expect(emitted.every(e => e.event === 'announcement:new' && Object.keys(e.payload).join() === 'id')).toBe(true);

    // Push: only those who enabled it (viewer still sees it in-app).
    const jobs = await connection.collection('notificationjobs').find({}).toArray();
    expect(jobs.map(j => j.userId).sort()).toEqual([admin2.userId, staffA.userId, staffB.userId].sort());
    const ar = JSON.parse(jobs.find(j => j.userId === staffA.userId)!.payload);
    const en = JSON.parse(jobs.find(j => j.userId === admin2.userId)!.payload);
    expect(en.title).toBe('📢 SOULIA Announcement');
    expect(ar.title).toBe('📢 إعلان من SOULIA');
    expect(en.body).toBe('🎉 Holiday Greeting · عيد سعيد للجميع 🎉 إجازة يوم الخميس');
    expect(ar.body).toBe('🎉 تهنئة بمناسبة · عيد سعيد للجميع 🎉 إجازة يوم الخميس');
    const destination = new URL(en.url, 'https://soulia.test');
    expect(destination.pathname).toBe('/');
    expect(destination.searchParams.get('pushRecord')).toBe(`announcement:${row.id}`);
    expect(destination.searchParams.get('pushType')).toBe('announcement');
    const historyRow = await connection.collection('notificationinbox').findOne({ userId: admin2.userId, recordId: `announcement:${row.id}` });
    expect(historyRow).not.toBeNull();
    expect(destination.searchParams.get('pushNotification')).toBe(historyRow!._id);

    const send = (notifications as any).push.sendNotification; send.mockClear();
    await notifications.dispatch();
    expect(send).toHaveBeenCalledTimes(3);

    for (const u of [admin2, staffA, staffB, viewer]) {
      const mine = await service.mine(u);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toEqual(expect.objectContaining({ id: row.id, category: 'holiday', ackAt: null, createdByName: 'المدير' }));
      expect(mine[0].message).toBe('عيد سعيد للجميع 🎉\nإجازة يوم الخميس'); // line breaks kept in-app
      expect(Object.keys(mine[0])).not.toContain('recipients');
    }
    expect(await service.mine(admin)).toHaveLength(0);
    expect(await service.mine(inactive)).toHaveLength(0);
  });
});

describe('Announcements — a specific employee', () => {
  it('reaches only the chosen employee and is invisible to everyone else', async () => {
    const row = await service.create(admin, { category: 'appreciation', audience: 'selected', recipientIds: [staffB.userId], message: 'Thank you for the great week' });
    expect(row.recipientCount).toBe(1);
    expect(emitted.map(e => e.userId)).toEqual([staffB.userId]);
    const jobs = await connection.collection('notificationjobs').find({}).toArray();
    expect(jobs.map(j => j.userId)).toEqual([staffB.userId]);
    expect(await service.mine(staffB)).toHaveLength(1);
    expect(await service.mine(staffA)).toHaveLength(0);
    expect(await service.mine(viewer)).toHaveLength(0);
    await expect(service.acknowledge(staffA, row.id)).rejects.toThrow();
  });
  it('supports several chosen recipients and de-duplicates repeated ids', async () => {
    const row = await service.create(admin, { category: 'reminder', audience: 'selected', recipientIds: [staffA.userId, viewer.userId, staffA.userId], message: 'اجتماع الساعة 4' });
    expect(row.recipientCount).toBe(2);
  });
  it('refuses a selection containing an inactive or unknown employee rather than dropping them silently', async () => {
    await expect(service.create(admin, { category: 'reminder', audience: 'selected', recipientIds: [staffA.userId, inactive.userId], message: 'x' })).rejects.toThrow(/معطلة/);
    await expect(service.create(admin, { category: 'reminder', audience: 'selected', recipientIds: [id()], message: 'x' })).rejects.toThrow();
    await expect(service.create(admin, { category: 'reminder', audience: 'selected', recipientIds: ['not-an-id'], message: 'x' })).rejects.toThrow();
    await expect(service.create(admin, { category: 'reminder', audience: 'selected', recipientIds: [], message: 'x' })).rejects.toThrow();
    expect(await connection.collection('announcements').countDocuments()).toBe(0);
  });
});

describe('Announcements — read status', () => {
  it('records acknowledgement once, per recipient, and reports it to the author', async () => {
    const row = await service.create(admin, { category: 'important', audience: 'all', message: 'تحديث سياسة الإجازات' });
    emitted.length = 0;
    const first = await service.acknowledge(staffA, row.id);
    expect(first.ackAt).toBeInstanceOf(Date);
    const again = await service.acknowledge(staffA, row.id);
    expect(new Date(again.ackAt).getTime()).toBe(first.ackAt.getTime()); // not re-stamped
    expect(emitted).toEqual([{ userId: admin.userId, event: 'announcement:read', payload: { id: row.id } }]);
    expect((await service.mine(staffA))[0].ackAt).not.toBeNull();
    expect((await service.mine(staffB))[0].ackAt).toBeNull(); // other recipients unaffected
    const [hist] = await service.history();
    expect(hist.ackCount).toBe(1); expect(hist.recipientCount).toBe(4);
    await expect(service.acknowledge(admin, row.id)).rejects.toThrow(); // the author is not a recipient
    await expect(service.acknowledge(staffA, 'bad')).rejects.toThrow();
  });
});

describe('Announcements — duplicate prevention', () => {
  it('turns a double submit into one announcement and one push per device', async () => {
    const body = { category: 'announcement', audience: 'all', message: 'رسالة واحدة فقط', requestKey: 'k-0123456789' };
    const results = await Promise.all(Array.from({ length: 5 }, () => service.create(admin, body).catch(e => e)));
    expect(results.every(r => !(r instanceof Error))).toBe(true);
    expect(new Set(results.map((r: any) => r.id)).size).toBe(1);
    expect(await connection.collection('announcements').countDocuments()).toBe(1);
    expect(await connection.collection('notificationjobs').countDocuments()).toBe(3);
    expect(results.filter((r: any) => r.duplicate).length).toBeGreaterThanOrEqual(1);
  });
  it('treats a new request key as a new announcement', async () => {
    await service.create(admin, { category: 'announcement', audience: 'all', message: 'a', requestKey: 'k-aaaaaaaaaa' });
    await service.create(admin, { category: 'announcement', audience: 'all', message: 'a', requestKey: 'k-bbbbbbbbbb' });
    expect(await connection.collection('announcements').countDocuments()).toBe(2);
  });
});

describe('Announcements — validation and limits', () => {
  it('enforces the configured maximum length on the server', async () => {
    expect((await service.getConfig()).maxLength).toBe(500);
    await expect(service.create(admin, { category: 'custom', audience: 'all', message: 'x'.repeat(501) })).rejects.toThrow(/500/);
    await service.setConfig({ maxLength: 60 });
    await expect(service.create(admin, { category: 'custom', audience: 'all', message: 'x'.repeat(61) })).rejects.toThrow(/60/);
    await expect(service.create(admin, { category: 'custom', audience: 'all', message: 'x'.repeat(60) })).resolves.toBeDefined();
    await expect(service.setConfig({ maxLength: 10 })).rejects.toThrow();
    await expect(service.setConfig({ maxLength: 5000 })).rejects.toThrow();
    await expect(service.setConfig({ maxLength: 100.5 })).rejects.toThrow();
  });
  it('requires a message, a known category and a recipient mode, and an admin author', async () => {
    await expect(service.create(admin, { category: 'custom', audience: 'all', message: '   \n  ' })).rejects.toThrow(/مطلوب/);
    await expect(service.create(admin, { category: 'party', audience: 'all', message: 'hi' })).rejects.toThrow();
    await expect(service.create(admin, { category: 'custom', audience: 'everyone', message: 'hi' })).rejects.toThrow();
    await expect(service.create(staffA, { category: 'custom', audience: 'all', message: 'hi' })).rejects.toThrow();
    await expect(service.create(admin, { category: 'custom', audience: 'all', message: 'hi', requestKey: '<script>' })).rejects.toThrow();
    expect(await connection.collection('announcements').countDocuments()).toBe(0);
  });
  it('keeps line breaks but strips control and bidi-override characters', () => {
    expect(cleanAnnouncementMessage('  مرحبا\r\n\r\n\r\n\r\nبالفريق‮  \u0007 ')).toBe('مرحبا\n\nبالفريق');
    expect(cleanAnnouncementMessage('a\t\tb')).toBe('a b');
  });
  it('keeps a long push preview within the notification limit', async () => {
    await service.setConfig({ maxLength: 2000 });
    await service.create(admin, { category: 'work-update', audience: 'selected', recipientIds: [admin2.userId], message: 'word '.repeat(300) });
    const [job] = await connection.collection('notificationjobs').find({}).toArray();
    const payload = JSON.parse(job.payload);
    expect(payload.body.length).toBeLessThanOrEqual(160);
    expect(payload.body.startsWith('📋 Work Update · word')).toBe(true);
    expect(payload.body.endsWith('…')).toBe(true);
  });
});

describe('Announcements — scheduled for later', () => {
  const inMinutes = (m: number) => new Date(Date.now() + m * 60000).toISOString();
  const makeDue = (annId: string) => connection.collection('announcements').updateOne({ _id: new Types.ObjectId(annId) }, { $set: { sendAt: new Date(Date.now() - 1000) } });

  it('holds a scheduled announcement back entirely until its time, then delivers it', async () => {
    const row = await service.create(admin, { category: 'reminder', audience: 'all', message: 'اجتماع الغد الساعة 10', sendAt: inMinutes(30) });
    expect(row.status).toBe('scheduled');
    expect(row.recipientCount).toBe(4); // the plan, shown to the author
    expect(emitted).toHaveLength(0);
    expect(await connection.collection('notificationjobs').countDocuments()).toBe(0);
    for (const u of [admin2, staffA, staffB, viewer]) expect(await service.mine(u)).toHaveLength(0);
    await expect(service.acknowledge(staffA, row.id)).rejects.toThrow(); // not addressed to anyone yet

    await service.deliverDue();
    expect((await service.history())[0].status).toBe('scheduled'); // not due: untouched

    await makeDue(row.id);
    await service.deliverDue();
    const [sent] = await service.history();
    expect(sent.status).toBe('sent'); expect(sent.recipientCount).toBe(4); expect(sent.sentAt).toBeInstanceOf(Date);
    expect(emitted.filter(e => e.event === 'announcement:new').map(e => e.userId).sort()).toEqual([admin2.userId, staffA.userId, staffB.userId, viewer.userId].sort());
    expect(emitted).toContainEqual({ userId: admin.userId, event: 'announcement:read', payload: { id: row.id } }); // author's list refreshes
    expect(await connection.collection('notificationjobs').countDocuments()).toBe(3);
    const mine = await service.mine(staffA);
    expect(mine).toHaveLength(1);
    expect(new Date(mine[0].createdAt).getTime()).toBe(sent.sentAt.getTime()); // recipients see the delivery time
  });

  it('delivers exactly once when several workers run at the same moment', async () => {
    const row = await service.create(admin, { category: 'announcement', audience: 'all', message: 'مرة واحدة', sendAt: inMinutes(10) });
    await makeDue(row.id);
    const workers = [service, new AnnouncementsService(connection, notifications, presence), new AnnouncementsService(connection, notifications, presence)];
    await Promise.all(workers.map(w => w.deliverDue()));
    expect(emitted.filter(e => e.event === 'announcement:new')).toHaveLength(4);
    expect(await connection.collection('notificationjobs').countDocuments()).toBe(3);
  });

  it('resolves recipients at delivery: new hires get «all», deactivated ones are skipped', async () => {
    const later = await service.create(admin, { category: 'announcement', audience: 'all', message: 'للجميع', sendAt: inMinutes(10) });
    const picked = await service.create(admin, { category: 'announcement', audience: 'selected', recipientIds: [staffA.userId, viewer.userId], message: 'لكما', sendAt: inMinutes(10) });
    const hire = new Types.ObjectId();
    await connection.collection('users').insertOne({ _id: hire, name: 'جديد', username: 'new', role: 'staff', isActive: true });
    await connection.collection('users').updateOne({ _id: new Types.ObjectId(viewer.userId) }, { $set: { isActive: false } });
    try {
      await makeDue(later.id); await makeDue(picked.id);
      await service.deliverDue();
      const rows = await service.history();
      const all = rows.find(r => r.id === later.id)!, sel = rows.find(r => r.id === picked.id)!;
      expect(all.recipients.map((r: any) => r.userId)).toContain(String(hire));
      expect(all.recipients.map((r: any) => r.userId)).not.toContain(viewer.userId);
      expect(sel.status).toBe('sent');
      expect(sel.recipients.map((r: any) => r.userId)).toEqual([staffA.userId]);
      expect(sel.skippedCount).toBe(1);
    } finally {
      await connection.collection('users').deleteOne({ _id: hire });
      await connection.collection('users').updateOne({ _id: new Types.ObjectId(viewer.userId) }, { $set: { isActive: true } });
    }
  });

  it('records a failure instead of retrying forever when nobody is left to receive it', async () => {
    const row = await service.create(admin, { category: 'announcement', audience: 'selected', recipientIds: [viewer.userId], message: 'x', sendAt: inMinutes(10) });
    await connection.collection('users').updateOne({ _id: new Types.ObjectId(viewer.userId) }, { $set: { isActive: false } });
    try {
      await makeDue(row.id);
      await service.deliverDue(); await service.deliverDue();
      const [h] = await service.history();
      expect(h.status).toBe('failed'); expect(h.failReason).toBeTruthy();
      expect(await connection.collection('notificationjobs').countDocuments()).toBe(0);
    } finally {
      await connection.collection('users').updateOne({ _id: new Types.ObjectId(viewer.userId) }, { $set: { isActive: true } });
    }
  });

  it('retries a delivery whose worker died mid-send, without duplicating push', async () => {
    const row = await service.create(admin, { category: 'announcement', audience: 'all', message: 'retry', sendAt: inMinutes(10) });
    await connection.collection('announcements').updateOne({ _id: new Types.ObjectId(row.id) }, { $set: { status: 'sending', claimedAt: new Date(Date.now() - 11 * 60000) } });
    await service.deliverDue();
    expect((await service.history())[0].status).toBe('sent');
    expect(await connection.collection('notificationjobs').countDocuments()).toBe(3);
  });

  it('can be cancelled before its time, and then is never delivered', async () => {
    const row = await service.create(admin, { category: 'announcement', audience: 'all', message: 'ملغي', sendAt: inMinutes(10) });
    const cancelled = await service.cancel(row.id);
    expect(cancelled.status).toBe('cancelled');
    await makeDue(row.id);
    await service.deliverDue();
    expect((await service.history())[0].status).toBe('cancelled');
    expect(emitted).toHaveLength(0);
    for (const u of [staffA, viewer]) expect(await service.mine(u)).toHaveLength(0);
    await expect(service.cancel(row.id)).rejects.toThrow(/بالفعل/);
    const sent = await service.create(admin, { category: 'announcement', audience: 'all', message: 'now' });
    await expect(service.cancel(sent.id)).rejects.toThrow(/تم إرساله/);
    await expect(service.cancel('nope')).rejects.toThrow();
  });

  it('rejects a time in the past, too soon, too far, or unreadable', async () => {
    for (const sendAt of [inMinutes(-5), inMinutes(1), inMinutes(61 * 24 * 60), 'tomorrow-ish']) {
      await expect(service.create(admin, { category: 'announcement', audience: 'all', message: 'x', sendAt })).rejects.toThrow();
    }
    expect(await connection.collection('announcements').countDocuments()).toBe(0);
    // A bad selection fails at scheduling time, while the author is still on screen.
    await expect(service.create(admin, { category: 'announcement', audience: 'selected', recipientIds: [inactive.userId], message: 'x', sendAt: inMinutes(30) })).rejects.toThrow(/معطلة/);
  });
});
