import { notificationTitle, unbrandedNotificationTitle, unbrandedNotificationBody } from '../../src/notifications/notification-titles';
import { NotificationDetails, NotificationType } from '../../src/notifications/notifications.service';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const events: [NotificationType, NotificationDetails, string][] = [
  ['approval', { afterSalesAction: 'requested' }, '📦 New return / exchange request'],
  ['approval', { afterSalesAction: 'settlement:refund' }, '📦 Customer refund recorded'],
  ['order', { afterSalesAction: 'received-and-inspected' }, '📦 Return received and inspected'],
  ['deposit', {}, '💰 New Deposit'],
  ['comment', {}, '💬 New Comment'],
  ['comment', { reaction: 'applause' }, '👏 New reaction to your comment'],
  ['comment', { reaction: 'angry' }, '😠 New reaction to your comment'],
  ['comment', { reaction: 'strong', followupComment: true }, '💪 New reaction to your comment'],
  ['followup', {}, '📌 New Follow-up'],
  ['comment', { followupComment: true }, '📌 New Follow-up'],
  ['order', {}, '🛍️ New Order'],
  ['order', { assignedToYou: true }, '🛍️ New Order Assigned'],
  ['deliveryProblem', {}, '🚨 Delivery Issue'],
  ['delivered', {}, '📦 Order Delivered'],
  ['otp', {}, '🔐 OTP Verification Required'],
  ['approval', { status: 'pending', actionKey: 'product' }, '✏️ Modification Request'],
  ['approval', { status: 'pending', actionKey: 'edit-tx' }, '✏️ Modification Request'],
  ['approval', { status: 'pending', actionKey: 'deposit' }, '⏳ Approval Required'],
  ['shopifyChange', {}, '🛒 Shopify Order Updated'],
  ['approval', { status: 'modified', actionKey: 'edit-tx' }, '🔄 Transaction Modified'],
  ['security', { actionKey: 'otp_violation' }, '🛡️ Security Alert'],
  ['security', { actionKey: 'failed_login' }, '❌ Failed Login Attempt'],
  ['approval', { status: 'approved', actionKey: 'edit-tx' }, '✅ Request Approved'],
  ['approval', { status: 'rejected', actionKey: 'product' }, '🚫 Request Rejected'],
  ['mention', {}, '💬 You Were Mentioned'],
  ['approval', { status: 'modified', actionKey: 'vault' }, '✏️ Record Modified'],
];
describe('Event emojis in notification titles', () => {
  it.each(events)('preserves the full Unicode title through JSON and the native worker: %s %j', async (type, details, expected) => {
    expect(notificationTitle(type, details, 'en')).toBe(expected);
    const arabic = notificationTitle(type, details, 'ar');
    expect(arabic).not.toMatch(/SOULIA/i);
    expect(arabic.split(' ')[0]).toBe(expected.split(' ')[0]);
    expect(arabic).toMatch(/[\u0600-\u06ff]/);
    for (const [title, language] of [[expected, 'en'], [arabic, 'ar']]) {
      const handlers: Record<string, any> = {};
      const showNotification = jest.fn(async () => {});
      const self = { addEventListener: (name: string, handler: any) => handlers[name] = handler,
        location: { origin: 'https://soulia.test' }, registration: { showNotification } };
      runInNewContext(readFileSync(resolve(__dirname, '../../../frontend/public/push-sw.js'), 'utf8'), { self, URL });
      const serialized = JSON.stringify({ title, lang: language, body: 'Existing concise message', url: '/' });
      let work: any;
      handlers.push({ data: { json: () => JSON.parse(serialized) }, waitUntil: (promise: any) => work = promise });
      await work;
      expect(showNotification).toHaveBeenCalledWith(title, expect.objectContaining({ body: 'Existing concise message', lang: language, dir: language === 'en' ? 'ltr' : 'rtl' }));
      expect(title.length).toBeLessThan(80);
    }
  });
  it('keeps a test notification recognizable without suggesting a business event', () => {
    expect(notificationTitle('order', {}, 'en', true)).toBe('🔔 Test notification');
    expect(notificationTitle('order', {}, 'ar', true)).toBe('🔔 إشعار تجريبي');
  });
  it.each([
    ['🛍️ طلب جديد · SOULIA', '🛍️ طلب جديد'],
    ['📢 إعلان من SOULIA', '📢 إعلان'],
    ['📢 SOULIA Announcement', '📢 Announcement'],
    ['🔔 إشعار SOULIA تجريبي', '🔔 إشعار تجريبي'],
    ['🔔 SOULIA test notification', '🔔 Test notification'],
    ['🛍️ New Order · SOULIA · #2906', '🛍️ New Order · #2906'],
  ])('removes branding from stored titles: %s', (stored, expected) => {
    expect(unbrandedNotificationTitle(stored)).toBe(expected);
  });
  it('removes branding from legacy test bodies while preserving authored messages', () => {
    expect(unbrandedNotificationBody('SOULIA notifications are working.')).toBe('Notifications are working.');
    expect(unbrandedNotificationBody('تم تفعيل إشعارات SOULIA بنجاح.')).toBe('تم تفعيل الإشعارات بنجاح.');
    expect(unbrandedNotificationBody('Customer comment')).toBe('Customer comment');
  });
  it.each(['ar', 'en'] as const)('uses a generic announcement title in %s', language => {
    expect(notificationTitle('announcement', {}, language)).toBe(language === 'en' ? '📢 Announcement' : '📢 إعلان');
  });
});
