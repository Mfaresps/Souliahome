import { notificationBody, DEFAULTS, eligible, NotificationsService } from '../../src/notifications/notifications.service';
import { notificationTitle } from '../../src/notifications/notification-titles';
import { carrierTrackingUpdate, postponementNotificationKey } from '../../src/bosta/bosta-tracking.util';
import { readFileSync } from 'fs';
import { resolve } from 'path';
const orderStatus = require('../../../frontend/public/order-status.js');

describe('postponement notification and timeline station', () => {
  const at = '2026-10-28T08:46:38.320Z', scheduledAt = '2026-10-29T03:00:00.000Z';
  const detail = { code: 3, at, scheduledAt, reason: 'Customer requested postponement' };
  const tx = { bostaOrderId: 'b1', bostaStatus: 'IN_TRANSIT', bostaDeliveryException: detail };

  it('has a distinct bilingual title and body including the new date', () => {
    expect(notificationTitle('deliveryPostponed')).toContain('تأجيل الاستلام بطلب العميل');
    expect(notificationTitle('deliveryPostponed', {}, 'en')).toContain('Delivery Postponed by Customer');
    const body = notificationBody('deliveryPostponed', '2883', { postponedUntil: scheduledAt });
    expect(body).toContain('الموعد الجديد');
    expect(body).not.toMatch(/فشل|مشكلة/);
    expect(notificationBody('deliveryPostponed', '2883')).toContain('بانتظار تحديد الموعد');
  });

  it('has a preference independent of delivery problems', () => {
    expect(eligible({ role: 'staff' }, { ...DEFAULTS, enabled: true, deliveryProblem: false }, 'deliveryPostponed')).toBe(true);
    expect(eligible({ role: 'staff' }, { ...DEFAULTS, enabled: true, deliveryPostponed: false }, 'deliveryPostponed')).toBe(false);
  });

  it('deduplicates notification delivery across movement and retries, but accepts a changed date', () => {
    const first = carrierTrackingUpdate({ state: 47 }, 'CUSTOMER_POSTPONED', '', 'b1', detail, 'webhook', at);
    const movement = carrierTrackingUpdate({ state: 24 }, 'IN_TRANSIT', '', 'b1', detail, 'sync', at, first);
    expect(postponementNotificationKey(first)).toBe(postponementNotificationKey(movement));
    expect(postponementNotificationKey({ ...movement, scheduledAt: '2026-10-30T03:00:00Z' })).not.toBe(postponementNotificationKey(first));
  });

  it('combines REST history, current details and event history into one dated station', () => {
    const events = orderStatus.postponements({ ...tx, bostaTrackingEvents: [
      { status: 'CUSTOMER_POSTPONED', shipmentId: 'b1', exceptionAt: at, scheduledAt },
      { status: 'IN_TRANSIT', reasonCode: 3, shipmentId: 'b1', exceptionAt: at, scheduledAt, at: '2026-10-28T17:00:00Z' },
    ], bostaRawResponse: { data: { state: { exception: [{ ...detail, time: at }] }, attempts: [{ exception: { ...detail, time: at } }] } } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ at, scheduledAt, shipmentId: 'b1' });
    expect(orderStatus.postponements({ bostaOrderId: 'b1', bostaStatus: 'CUSTOMER_POSTPONED' })[0].at).toBe('');
  });

  it('renders a real standalone station, active while postponed and historical after delivery', () => {
    const source = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
    const start = source.indexOf('  const postponements = SouliaOrderStatus.postponements(tx);');
    const end = source.indexOf('  if (rawTimeline.some', start);
    const render = new Function('tx', 'SouliaOrderStatus', 'currentLang', '_fmtTs', 'esc', '_stepHtml', source.slice(start, end) + '\nreturn stepPostponements;');
    const step = (icon, title, desc, status, time, extra, last, badge) => ({ title, status, time, extra, badge });
    const renderTx = data => render(data, orderStatus, 'ar', value => value, value => String(value).replace(/</g, '&lt;'), step);
    const [active] = renderTx(tx);
    expect(active).toMatchObject({ title: 'تأجيل الاستلام بطلب العميل', status: 'active', time: at, badge: 'بانتظار إعادة المحاولة' });
    expect(active.extra).toContain(scheduledAt);
    expect(renderTx({ ...tx, bostaStatus: 'DELIVERED', deliveredAt: '2026-10-29T12:00:00Z' })[0].status).toBe('completed');
    expect(source).toContain('...stepPostponements, step4');
  });

  it('corrects a proved legacy notification and pending push without touching another shipment', async () => {
    const row = { _id: 'n1', userId: 'u1', type: 'deliveryProblem', eventId: 'problem:t1:b1:initial:0', title: '🚨 مشكلة في التسليم', body: 'فشل التسليم' };
    const inbox = { find: jest.fn((_query: any) => ({ toArray: async () => [row] })), updateOne: jest.fn(async (_query: any, _update: any) => ({})) };
    const jobs = { find: jest.fn((_query: any) => ({ toArray: async () => [{ _id: 'j1', payload: JSON.stringify({ title: row.title, body: row.body, tag: 'keep-tag' }) }] })), updateOne: jest.fn(async (_query: any, _update: any) => ({})) };
    const mentions = { updateMany: jest.fn(async (_query: any, _update: any) => ({})) };
    const collections = { notificationinbox: inbox, notificationjobs: jobs, mentions,
      followups: { find: () => ({ toArray: async () => [{ _id: 'f1' }] }) } };
    const service = new NotificationsService({ collection: name => collections[name] } as any);
    await service.correctPostponementNotifications('t1', 'b1', '2883', scheduledAt, '2026-10-27T00:00:00Z');
    const filter = inbox.find.mock.calls[0][0];
    const pattern = new RegExp(filter.eventId.$regex);
    expect(pattern.test('problem:t1:b1:initial:0')).toBe(true);
    expect(pattern.test('problem:t1:other:initial:0')).toBe(false);
    expect(inbox.updateOne.mock.calls[0][1].$set).toMatchObject({ type: 'deliveryPostponed', correction: { previousType: 'deliveryProblem' } });
    expect(jobs.find.mock.calls[0][0]).toMatchObject({ done: false });
    expect(JSON.parse(jobs.updateOne.mock.calls[0][1].$set.payload)).toMatchObject({ tag: 'keep-tag', title: '🗓️ تأجيل الاستلام بطلب العميل' });
    expect(mentions.updateMany.mock.calls[0][0]).toMatchObject({ fromUserId: 'system', txId: { $in: ['f1'] } });
    expect(mentions.updateMany.mock.calls[0][1][0].$set.commentText).toContain('تأجيل استلام الطلب #2883');
  });
});
