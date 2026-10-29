import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const start = html.indexOf('function _fuCommentDisplayText(');
const source = html.slice(start, html.indexOf('function renderMyFollowUpComment(', start));
const prefix = 'موعد المتابعة: ';
const due = '2026-10-27T17:01:00.000Z';
function fixture(language = 'ar', document: any = {}) {
  const context: any = { currentLang: language, Date, document,
    esc: (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    escHtml: (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  };
  runInNewContext(source, context);
  return context;
}

describe('dynamic follow-up reminder display', () => {
  const carrierText = ['أُعيد فتح المتابعة — تحديث جديد على نفس الطلب: تحديث بوسطة: في الطريق',
    'آخر سبب مسجل لدى بوسطة: العميل طلب تأجيل الاستلام',
    'نص شركة الشحن: Postponed - the customer requested postponement for another day.',
    'كود السبب: 3', 'موعد إعادة المحاولة حسب بوسطة: 2026-10-29T03:00:00.000Z',
    'عدد محاولات بوسطة: 1', 'وقت التحديث: 2026-10-28T16:58:17.000Z', 'البوليصة: internal-shipment-id'].join('\n');
  it('reduces existing carrier audit notes to a clear status, reason and Cairo delivery time', () => {
    const context = fixture();
    const copy = context._fuCommentDisplayText(carrierText);
    expect(copy.split('\n')).toHaveLength(3);
    expect(copy).toContain('أُعيد فتح المتابعة · في الطريق');
    expect(copy).toContain('العميل طلب تأجيل الاستلام');
    expect(copy).toContain('29 أكتوبر');
    expect(copy).toContain('6:00 ص');
    expect(copy).not.toMatch(/Postponed|كود السبب|البوليصة|وقت التحديث|2026-10-29T/);
    const markup = context._fuCommentDisplayHtml(carrierText);
    expect(markup).toContain('fu-carrier-update');
    expect(markup).toContain('datetime="2026-10-29T03:00:00.000Z"');
    expect(markup).not.toContain('internal-shipment-id');
  });
  it('translates the compact update and removes old postponements after delivery', () => {
    const context = fixture('en');
    expect(context._fuCommentDisplayText(carrierText)).toContain('Follow-up reopened · In transit');
    expect(context._fuCommentDisplayText(carrierText)).toContain('Customer requested a later delivery');
    const delivered = context._fuCommentDisplayText(carrierText.replace('في الطريق', 'تم التسليم'));
    expect(delivered).toContain('Delivered');
    expect(delivered).not.toMatch(/later delivery|Next delivery/);
    expect(context._fuCommentDisplayText('تحديث بوسطة: موعدي مع العميل بكرة')).toBe('تحديث بوسطة: موعدي مع العميل بكرة');
  });
  it('uses Bosta identity for legacy carrier notes and keeps the system identity for internal actions', () => {
    const context = fixture();
    const bosta = context._fuCommentAuthor({ authorId: 'system', authorName: 'النظام', text: carrierText });
    expect(bosta).toMatchObject({ _id: 'system', name: 'بوسطة', carrier: 'bosta' });
    expect(context._fuCommentAuthor({ authorId: 'system', authorName: 'النظام', text: 'تم إسناد المتابعة' }).carrier).toBeUndefined();
    const avatarStart = html.indexOf('function userAvatarHtml(');
    runInNewContext(html.slice(avatarStart, html.indexOf('\n}', avatarStart) + 2), context);
    const avatar = context.userAvatarHtml(bosta, 36);
    expect(avatar).toContain('/bosta-logo-original.png');
    expect(avatar).not.toContain('/favicon.png');
    expect(context.userAvatarHtml({ _id: 'system', name: 'النظام' })).toContain('/favicon.png');
  });
  it('shows the remaining duration and exact Cairo appointment', () => {
    const text = fixture()._fuCommentDisplayText(prefix + due, Date.parse('2026-10-27T15:01:00Z'));
    expect(text).toContain('خلال ساعتين');
    expect(text).toContain('27 أكتوبر 2026');
    expect(text).toContain('8:01 م');
    expect(text).not.toContain('بتوقيت القاهرة');
    expect(text).toContain('\u2068');
    expect(text).not.toContain(due);
  });

  it('uses Cairo calendar days for tomorrow even on a browser in another timezone', () => {
    const text = fixture()._fuCommentDisplayText(prefix + '2026-10-27T21:30:00Z', Date.parse('2026-10-27T19:00:00Z'));
    expect(text).toContain('بكرة');
    expect(text).toContain('28 أكتوبر');
    expect(text).toContain('12:30 ص');
  });

  it('distinguishes upcoming, due and past appointments', () => {
    const format = fixture('en')._fuCommentDisplayText;
    expect(format(prefix + due, Date.parse(due) - 5 * 60000)).toContain('in 5 minutes');
    expect(format(prefix + due, Date.parse(due))).toContain('Due now');
    expect(format(prefix + due, Date.parse(due) + 5 * 60000)).toContain('Time passed: 5 minutes ago');
  });

  it('respects winter time and preserves invalid dates and ordinary comments', () => {
    const format = fixture('en')._fuCommentDisplayText;
    expect(format(prefix + '2026-12-27T17:01:00Z', Date.parse('2026-12-27T15:01:00Z'))).toContain('7:01 pm');
    expect(format(prefix + '2026-99-27T17:01:00Z')).toBe(prefix + '2026-99-27T17:01:00Z');
    expect(format('Customer note ' + due)).toBe('Customer note ' + due);
  });

  it('updates the existing comment in place as time passes', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(Date.parse(due) - 5 * 60000);
      const copy = { textContent: '' };
      const badge = { title: '', className: '', getAttribute: () => due, setAttribute: jest.fn(), querySelector: () => copy };
      const element = { querySelectorAll: () => [badge] };
      const document = { hidden: false, querySelectorAll: (selector: string) => selector === '[data-fu-timed-comment]' ? [element] : [] };
      const context = fixture('en', document);
      context._fuRefreshCommentTimes();
      expect(badge.title).toContain('in 5 minutes');
      expect(copy.textContent).toBe('Today · 8:01 pm');
      expect(badge.className).toContain('is-upcoming');
      jest.setSystemTime(Date.parse(due) + 5 * 60000);
      context._fuRefreshCommentTimes();
      expect(badge.title).toContain('Time passed: 5 minutes ago');
      expect(copy.textContent).toBe('Overdue · Today · 8:01 pm');
      expect(badge.className).toContain('is-overdue');
      document.hidden = true;
      jest.setSystemTime(Date.parse(due) + 10 * 60000);
      context._fuRefreshCommentTimes();
      expect(badge.title).toContain('5 minutes ago');
    } finally { jest.useRealTimers(); }
  });

  it('escapes stored comment attributes and preserves mention rendering on refresh', () => {
    const context = fixture('en');
    context.renderMentionText = jest.fn((text: string) => 'rendered: ' + text);
    const markup = context._fuCommentDisplayHtml(prefix + due + ' @Malak', true);
    expect(context.renderMentionText).toHaveBeenCalledWith(expect.stringContaining('@Malak'));
    expect(markup).toContain('rendered:');
    expect(markup).toContain('data-fu-appointment');
    expect(context._fuCommentDisplayHtml('<img src=x onerror=alert(1)> ' + prefix + due)).not.toContain('<img');
    expect(context._fuCommentTimeAttrs(prefix + due + ' "<note>')).toContain('&quot;&lt;note&gt;');
    expect(context._fuCommentTimeAttrs('ordinary comment')).toBe('');
  });
});
