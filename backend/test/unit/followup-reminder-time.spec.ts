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
