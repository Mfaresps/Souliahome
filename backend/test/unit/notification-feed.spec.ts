import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import { MentionsService } from '../../src/mentions/mentions.service';
import { NotificationsService } from '../../src/notifications/notifications.service';

const script = readFileSync(resolve(__dirname, '../../../frontend/public/notification-feed.js'), 'utf8');
function fixture(storage = new Map()) {
  const c: any = { currentUser: { _id: 'user-a' }, currentLang: 'en', _notifReadIds: [], notifDismissed: [], _mentionsCache: [], users: [],
    localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
    _notifStorageKey: (key: string) => key + ':' + c.currentUser._id,
    api: jest.fn(async (url: string) => url === '/notifications/read-state' ? { ids: [] } : {}),
    getMentionNotifs: () => c._mentionsCache, buildMentionNotifsList: () => c._mentionsCache,
    souliaHistoryNotifs: () => c.history || [], souliaHistoryUnread: () => c.unread || 0,
    souliaMarkHistoryRead: jest.fn(async () => {}), ICON: () => '<svg></svg>', t: (s: string) => s,
    sanitizeUrl: (s: string) => s, escHtml: (s: string) => String(s).replace(/"/g, '&quot;'),
    qs: () => null, setTimeout: jest.fn(), clearTimeout: jest.fn(), setInterval: jest.fn(), addEventListener: jest.fn(),
    document: { hidden: false }, toast: jest.fn(), buildNotifications: jest.fn(),
  };
  c.window = c; runInNewContext(script, c);
  return c;
}
it('merges mentions and comment/history copies into one newest-first event with one unread count', () => {
  const c = fixture(); c.souliaSyncNotificationAccount();
  c._mentionsCache = [{ id: 'm1', fromUserId: 'author', fromName: 'Mona', txId: 'tx1', commentId: 42, ts: '2026-10-20T20:00:00Z', commentText: 'New text', read: false }];
  c.history = [
    { id: 'h-mention', history: true, recordId: 'mention:m1', historyRead: false, ts: '2026-10-20T20:00:00Z' },
    { id: 'h-comment', history: true, recordId: 'tx:tx1', event: '42', eventType: 'comment', historyRead: false, ts: '2026-10-20T20:00:00Z' },
  ]; c.unread = 2;
  const items = c.souliaMergeNotifications([{ id: 'old-warning', type: 'urgent', ts: '2026-07-01' }, ...c.history]);
  expect(items.map((n: any) => n.id)).toEqual(['mention-m1', 'old-warning']);
  expect(c.souliaNotificationUnread(items, [])).toBe(2);
});
it('merges a follow-up comment with its participant notification and reads both together', async () => {
  const c = fixture(); c.souliaSyncNotificationAccount();
  c._mentionsCache = [{ id: 'm-followup', fromName: 'Sallonaz', txId: 'fu1', commentId: 0, fuCommentId: 'comment1', read: false,
    commentText: 'تعليق جديد على متابعة #2907: Dont forget ya ganna', ts: '2026-10-24T00:47:00Z' }];
  c.history = [
    { id: 'h1', history: true, recordId: 'followup:fu1', eventType: 'comment', event: 'comment1', historyRead: false },
    { id: 'other-comment', history: true, recordId: 'followup:fu1', eventType: 'comment', event: 'comment2', historyRead: false },
    { id: 'other-thread', history: true, recordId: 'followup:fu2', eventType: 'comment', event: 'comment1', historyRead: false },
    { id: 'other-record', history: true, recordId: 'tx:fu1', eventType: 'comment', event: 'comment1', historyRead: false },
  ]; c.unread = 4;
  const items = c.souliaMergeNotifications(c.history);
  expect(items.map((n: any) => n.id)).toEqual(['mention-m-followup', 'other-comment', 'other-record', 'other-thread']);
  expect(c.souliaNotificationUnread(items, [])).toBe(4);
  expect(items[0].historyIds).toEqual(['h1']);
  expect(items[0].mention.fuCommentId).toBe('comment1');
  await c.souliaReadNotification('mention-m-followup');
  expect(c.api).toHaveBeenCalledWith('/mentions/m-followup/read', { method: 'POST' });
  expect(c.souliaMarkHistoryRead).toHaveBeenCalledWith('h1');
  expect(c.souliaIsNotificationUnread(items[0])).toBe(false);
});
it('does not merge unrelated follow-up notices with an empty comment identifier', () => {
  const c = fixture();
  c._mentionsCache = [{ id: 'm1', txId: 'fu1', commentId: 0, fuCommentId: '' }];
  const items = c.souliaMergeNotifications([{ id: 'h1', history: true, recordId: 'followup:fu1', eventType: 'comment', event: '0' }]);
  expect(items).toHaveLength(2);
});
it('formats live relative notification times with Arabic singular, dual and plural units', () => {
  const c = fixture(); c.currentLang = 'ar';
  const now = Date.parse('2026-10-21T12:00:00Z');
  for (const [seconds, expected] of [[5, 'منذ 5 ثوانٍ'], [60, 'منذ دقيقة'], [120, 'منذ دقيقتين'], [300, 'منذ 5 دقائق'], [3600, 'منذ ساعة'], [7200, 'منذ ساعتين'], [10800, 'منذ 3 ساعات'], [86400, 'منذ يوم'], [172800, 'منذ يومين']] as const) {
    expect(c.souliaNotificationRelativeTime(new Date(now - seconds * 1000).toISOString(), now)).toBe(expected);
  }
  expect(c.souliaNotificationRelativeTime('bad timestamp')).toBe('');
  c.currentLang = 'en';
  expect(c.souliaNotificationRelativeTime(new Date(now - 5000).toISOString(), now)).toBe('5 seconds ago');
});
it('keeps newly opened items highlighted while the badge is cleared, and removes the highlight on the next opening', async () => {
  const c = fixture();
  c.qs = (selector: string) => selector === '#notif-panel' ? { classList: { contains: () => true } } : null;
  c.souliaSyncNotificationAccount();
  const [item] = c.souliaMergeNotifications([{ id: 'new-item' }]);
  await c.souliaMarkNotificationsOpened();
  expect(c.souliaNotificationUnread([item], [])).toBe(0);
  expect(c.souliaIsNotificationHighlighted(item)).toBe(true);
  await c.souliaMarkNotificationsOpened();
  expect(c.souliaIsNotificationHighlighted(item)).toBe(false);
});
it('uses vector delivery icons, removes delivery emoji prefixes, and escapes delivery descriptions', () => {
  const c = fixture();
  c.escHtml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const item = { eventType: 'delivered', title: '📦 Order Delivered', desc: 'Successfully Delivered <unsafe>' };
  expect(c.souliaNotificationTitle(item)).toBe('Order Delivered');
  expect(c.souliaNotificationTone(item)).toBe('notification-delivered');
  expect(c.souliaNotificationDescription(item)).toContain('notification-check');
  expect(c.souliaNotificationDescription(item)).toContain('&lt;unsafe&gt;');
  expect(c.souliaNotificationTone({ eventType: 'deliveryProblem' })).toBe('notification-delivery-issue');
  expect(c.souliaNotificationAvatar(item)).toContain('<svg');
});
it('keeps a fallback icon present during photo loading and avoids retrying failed photos on every repaint', () => {
  const c = fixture();
  const item = { actorAvatar: '/broken-photo.png', eventType: 'security' };
  const markup = c.souliaNotificationAvatar(item);
  expect(markup.indexOf('notification-avatar-fallback')).toBeLessThan(markup.indexOf('<img'));
  expect(markup).not.toContain(' hidden');
  const remove = jest.fn();
  c.souliaNotificationAvatarFailed({ getAttribute: () => '/broken-photo.png', parentNode: { classList: { remove: jest.fn() } }, remove });
  expect(remove).toHaveBeenCalled();
  expect(c.souliaNotificationAvatar(item)).not.toContain('<img');
  expect(c.souliaNotificationAvatar(item)).toContain('<svg');
  expect(c.souliaNotificationAvatar({ actorAvatar: '/new-photo.png' })).toContain('<img');
});
it('saves existing internal notifications when opened, survives refresh, and counts only new arrivals', async () => {
  const storage = new Map();
  const c = fixture(storage);
  c.souliaSyncNotificationAccount();
  const openedAt = Date.parse('2026-10-21T10:00:00Z');
  const items = c.souliaMergeNotifications([{ id: 'internal-old' }, { id: 'new-after-open', ts: '2026-10-21T10:00:01Z' }]);
  c.api.mockImplementation(async (url: string) => url === '/notifications/read-all' ? { before: new Date(openedAt).toISOString(), unread: 0 } : { ids: [] });
  await c.souliaMarkNotificationsOpened(openedAt);
  expect(c.souliaNotificationUnread(items, [])).toBe(1);
  const body = JSON.parse(c.api.mock.calls.find((args: any[]) => args[0] === '/notifications/read-all')[1].body);
  expect(body.ids).toEqual(['internal-old']);
  const reloaded = fixture(storage); reloaded.souliaSyncNotificationAccount();
  expect(reloaded.souliaIsNotificationUnread({ id: 'internal-old' })).toBe(false);
  expect(reloaded.souliaIsNotificationUnread({ id: 'new-after-open' })).toBe(true);
});
it('does not clear unread badges when saving the opened state fails or after changing accounts', async () => {
  const c = fixture(); c.souliaSyncNotificationAccount();
  c.souliaMergeNotifications([{ id: 'internal-old' }]);
  c.api.mockRejectedValueOnce(new Error('offline'));
  await c.souliaMarkNotificationsOpened();
  expect(c.souliaIsNotificationUnread({ id: 'internal-old' })).toBe(true);
  let finish!: (value: any) => void;
  c.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = c.souliaMarkNotificationsOpened();
  c.currentUser = { _id: 'user-b' }; c.souliaSyncNotificationAccount();
  finish({ before: new Date().toISOString(), unread: 0 }); await pending;
  expect(c._notifReadIds).not.toContain('internal-old');
});
it('marks server history and mentions only for the authenticated account and through the opening cutoff', async () => {
  const inbox = { updateMany: jest.fn(async (_query: any, _update: any) => ({})), countDocuments: jest.fn(async () => 1) };
  const mentions = { updateMany: jest.fn(async (_query: any, _update: any) => ({})) };
  const receipts = { bulkWrite: jest.fn(async (_operations: any[]) => ({})) };
  const service = new NotificationsService({ collection: (name: string) => name === 'notificationinbox' ? inbox : name === 'mentions' ? mentions : receipts } as any);
  const before = '2026-10-20T10:00:00Z';
  const result = await service.markAllRead({ userId: 'user-a', username: 'MONA', role: 'staff' }, { before, ids: ['internal-old'] });
  expect(result.unread).toBe(1);
  expect(inbox.updateMany.mock.calls[0][0]).toEqual(expect.objectContaining({ userId: 'user-a', readAt: null, createdAt: { $lte: new Date(before) } }));
  expect(mentions.updateMany.mock.calls[0][0]).toEqual({ $or: [{ targetUserId: 'user-a' }, { targetUsername: 'mona' }], read: false, createdAt: { $lte: new Date(before) } });
  expect(receipts.bulkWrite.mock.calls[0][0][0].updateOne.filter).toEqual({ userId: 'user-a', notificationId: 'internal-old' });
  await expect(service.markAllRead({ userId: 'user-a', role: 'staff' }, { before: 'invalid', ids: [] })).rejects.toThrow('Invalid notification read state');
});
it('does not let an older in-flight history refresh resurrect a cleared unread count', async () => {
  const c = fixture();
  let finish!: (value: any) => void;
  c.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  runInNewContext(readFileSync(resolve(__dirname, '../../../frontend/public/notification-history.js'), 'utf8'), c);
  c.souliaApplyHistoryReadAll('2026-10-21T10:00:00Z', 0);
  finish({ items: [{ _id: 'old', readAt: null, createdAt: '2026-10-20' }], unread: 1 });
  await Promise.resolve(); await Promise.resolve();
  expect(c.souliaHistoryUnread()).toBe(0);
  expect(c.souliaHistoryNotifs()).toHaveLength(0);
});
it('saves all related read receipts once, updates the count only on success, and keeps failures unread', async () => {
  const c = fixture(); c.souliaSyncNotificationAccount();
  c._mentionsCache = [{ id: 'm1', fromName: 'Mona', txId: 'tx1', read: false }];
  const items = c.souliaMergeNotifications([{ id: 'h1', history: true, recordId: 'mention:m1', historyRead: false }]);
  await Promise.all([c.souliaReadNotification('mention-m1'), c.souliaReadNotification('mention-m1')]);
  expect(c.api.mock.calls.filter((args: any) => args[0] === '/mentions/m1/read')).toHaveLength(1);
  expect(c.souliaMarkHistoryRead).toHaveBeenCalledWith('h1');
  expect(c.souliaIsNotificationUnread(items[0])).toBe(false);
  c.souliaMergeNotifications([{ id: 'legacy', ts: '2026-10-20' }]);
  c.api.mockRejectedValueOnce(new Error('offline'));
  await c.souliaReadNotification('legacy');
  expect(c._notifReadIds).not.toContain('legacy'); expect(c.toast).toHaveBeenCalled();
});
it('isolates account caches and always supplies an event icon, including failed avatar fallback', () => {
  const c = fixture(); c.souliaSyncNotificationAccount(); c._notifReadIds = ['private'];
  c.currentUser = { _id: 'user-b' }; c.souliaSyncNotificationAccount();
  expect(c._notifReadIds).toEqual([]);
  expect(c.souliaNotificationAvatar({ eventType: 'comment' })).toContain('<svg');
  const avatar = c.souliaNotificationAvatar({ eventType: 'mention', actorAvatar: '/avatar.png', actorName: 'Mona' });
  expect(avatar).toContain('<img'); expect(avatar).toContain('onerror='); expect(avatar).toContain('<svg');
});
it('scopes a mention read to the authenticated recipient', async () => {
  const update = jest.fn(() => ({ exec: async () => ({}) }));
  const service = new MentionsService({ updateOne: update } as any);
  await service.markRead('mention1', 'user-a', 'MONA');
  expect(update).toHaveBeenCalledWith({ _id: 'mention1', $or: [{ targetUserId: 'user-a' }, { targetUsername: 'mona' }] }, { $set: { read: true } });
});
it('validates durable legacy read IDs and keeps them scoped to the account', async () => {
  const bulkWrite = jest.fn(async (_operations: any[]) => ({}));
  const service = new NotificationsService({ collection: () => ({ bulkWrite }) } as any);
  const user = { userId: 'user-a', role: 'staff', isActive: true };
  await service.saveReadState(user, { ids: ['cmp-pending-123'] });
  expect(bulkWrite.mock.calls[0][0][0].updateOne.filter).toEqual({ userId: 'user-a', notificationId: 'cmp-pending-123' });
  await expect(service.saveReadState(user, { ids: [{}] })).rejects.toThrow('Invalid notification IDs');
});
