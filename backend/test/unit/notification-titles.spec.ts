import { notificationTitle } from '../../src/notifications/notification-titles';
import { NotificationDetails, NotificationType } from '../../src/notifications/notifications.service';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const events: [NotificationType, NotificationDetails, string][] = [
  ['deposit', {}, '💰 New Deposit · SOULIA'],
  ['comment', {}, '💬 New Comment · SOULIA'],
  ['followup', {}, '📌 New Follow-up · SOULIA'],
  ['comment', { followupComment: true }, '📌 New Follow-up · SOULIA'],
  ['order', {}, '🛍️ New Order · SOULIA'],
  ['order', { assignedToYou: true }, '🛍️ New Order Assigned · SOULIA'],
  ['deliveryProblem', {}, '🚨 Delivery Issue · SOULIA'],
  ['delivered', {}, '📦 Order Delivered · SOULIA'],
  ['otp', {}, '🔐 OTP Verification Required · SOULIA'],
  ['approval', { status: 'pending', actionKey: 'product' }, '✏️ Modification Request · SOULIA'],
  ['approval', { status: 'pending', actionKey: 'edit-tx' }, '✏️ Modification Request · SOULIA'],
  ['approval', { status: 'pending', actionKey: 'deposit' }, '⏳ Approval Required · SOULIA'],
  ['shopifyChange', {}, '🛒 Shopify Order Updated · SOULIA'],
  ['approval', { status: 'modified', actionKey: 'edit-tx' }, '🔄 Transaction Modified · SOULIA'],
  ['security', { actionKey: 'otp_violation' }, '🛡️ Security Alert · SOULIA'],
  ['security', { actionKey: 'failed_login' }, '❌ Failed Login Attempt · SOULIA'],
  ['approval', { status: 'approved', actionKey: 'edit-tx' }, '✅ Request Approved · SOULIA'],
  ['approval', { status: 'rejected', actionKey: 'product' }, '🚫 Request Rejected · SOULIA'],
  ['mention', {}, '💬 You Were Mentioned · SOULIA'],
  ['approval', { status: 'modified', actionKey: 'vault' }, '✏️ Record Modified · SOULIA'],
];
describe('Event emojis in notification titles', () => {
  it.each(events)('preserves the full Unicode title through JSON and the native worker: %s %j', async (type, details, expected) => {
    expect(notificationTitle(type, details, 'en')).toBe(expected);
    const arabic = notificationTitle(type, details, 'ar');
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
    expect(notificationTitle('order', {}, 'en', true)).toBe('🔔 SOULIA test notification');
  });
});
