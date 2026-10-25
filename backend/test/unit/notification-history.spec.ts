import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const source = readFileSync(resolve(__dirname, '../../../frontend/public/notification-history.js'), 'utf8');
const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
it('loads durable notifications, retains older pages, marks reads and opens the exact stored destination', async () => {
  const row = { _id: 'a'.repeat(64), recordId: 'followup:507f1f77bcf86cd799439011', type: 'comment', title: 'New comment', actorName: 'Mona', commentText: 'Full comment\nSecond line', ref: '100', createdAt: '2026-10-13T10:00:00Z', url: '/?pushRecord=followup:507f1f77bcf86cd799439011&pushType=comment&pushEvent=507f1f77bcf86cd799439012' };
  Object.assign(row, { eventId: 'comment:followup:fu1:c1' });
  const context: any = { URL, location: { href: 'https://soulia.test/' }, currentUser: null, currentLang: 'en', ICON: (name: string) => name, setInterval: jest.fn(), qs: () => null, document: {}, buildNotifications: jest.fn(), closeNotifCenter: jest.fn(), souliaNavigateNotification: jest.fn(async () => true), toast: jest.fn(),
    api: jest.fn(async (url: string) => url.includes('/read') ? {} : url.includes('before=') ? { items: [{ ...row, _id: 'b'.repeat(64), createdAt: '2026-10-12T10:00:00Z' }], next: '' } : { items: [row], next: row._id }), };
  context.window = context; runInNewContext(source, context);
  context.currentUser = { _id: 'account-1' };
  await context.souliaRefreshNotificationHistory();
  const item = context.souliaHistoryNotifs()[0];
  expect(item.eventId).toBe('comment:followup:fu1:c1');
  expect(item.desc).toBe('Mona · Full comment\nSecond line'); expect(item.ts).toBe(row.createdAt); expect(item.title).toContain('#100');
  await context.souliaRefreshNotificationHistory(true); expect(context.souliaHistoryNotifs()).toHaveLength(2);
  await context.souliaOpenHistory(row._id);
  const destination = new URL(context.souliaNavigateNotification.mock.calls[0][0]);
  const expected = new URL(row.url, context.location.href);
  expect(destination.origin).toBe(expected.origin);
  expect([...destination.searchParams]).toEqual([...expected.searchParams]);
  expect(context.api).toHaveBeenCalledWith('/notifications/history/' + row._id + '/read', { method: 'POST' });
  expect(context.souliaHistoryNotifs()[0].historyRead).toBe(true);
  context.currentUser = { _id: 'account-2' }; expect(context.souliaHistoryNotifs()).toHaveLength(0);
});
it('waits for follow-up data before opening and highlighting the exact comment', async () => {
  const start = html.indexOf('async function goToFuAndHighlight(');
  const end = html.indexOf('/* ── Shopify order #', start);
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const context: any = { _requirePageAccess: () => true, followUps: [], navigateTo: jest.fn(), switchMainTab: jest.fn(),
    loadFollowUps: jest.fn(async () => { await gate; context.followUps = [{ _id: 'f1', createdAt: '2026-10-13' }]; }),
    qs: () => null, _fuIsSettled: () => false, _fuPerPage: 25, _fuPage: 1, renderFollowUps: jest.fn(), openFuCommentPopup: jest.fn(), toast: jest.fn(), t: (s: string) => s };
  runInNewContext(html.slice(start, end) + '\nthis.open = goToFuAndHighlight;', context);
  const work = context.open('f1', true, 'comment-123');
  expect(context.openFuCommentPopup).not.toHaveBeenCalled();
  release(); await work;
  expect(context.switchMainTab).toHaveBeenCalledWith('fu', false, true);
  expect(context.openFuCommentPopup).toHaveBeenCalledWith('f1', 'comment-123');
});
it('refreshes a cached Shopify order before locating the comment', async () => {
  const start = html.indexOf('async function openShopifyOrderComments(');
  const end = html.indexOf('/**', start);
  const el = { scrollIntoView: jest.fn(), classList: { add: jest.fn(), remove: jest.fn() }, offsetWidth: 1 };
  const context: any = { _requirePageAccess: () => true, _shopifyOrders: [{ _id: 'o1' }], navigateTo: jest.fn(), loadShopifyOrders: jest.fn(async () => {}), _spOrderById: () => ({ _id: 'o1' }), openShopifyCommentsModal: jest.fn(), requestAnimationFrame: (fn: any) => fn(), qs: jest.fn(() => el), setTimeout: jest.fn(), toast: jest.fn() };
  runInNewContext(html.slice(start, end) + '\nthis.open = openShopifyOrderComments;', context);
  await context.open('o1', 123);
  expect(context.loadShopifyOrders).toHaveBeenCalledTimes(1);
  expect(context.qs).toHaveBeenCalledWith('#sp-cmt-123');
  expect(el.scrollIntoView).toHaveBeenCalled(); expect(el.classList.add).toHaveBeenCalledWith('comment-mention-highlight');
});
