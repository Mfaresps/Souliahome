import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
function fixture() {
  const env: any = { currentLang: 'ar', esc: String, escHtml: String };
  for (const name of ['myPriorityCommentText', 'renderMyPrioritySchedule']) {
    const start = html.indexOf('function ' + name + '(');
    runInNewContext(html.slice(start, html.indexOf('\n}', start) + 2), env);
  }
  return env;
}
const scheduled = '2026-10-26T17:41:42.067Z';
describe('employee priority card content', () => {
  it('separates the current appointment from the human comment without losing the note', () => {
    const f = { deferredUntil: scheduled, latestComment: { text: `إعادة التواصل لتأكيد الطلب — موعد المتابعة: ${scheduled} — اتصال: لا يوجد رد\nالمحاولة غدًا` } };
    expect(fixture().myPriorityCommentText(f)).toBe('اتصال: لا يوجد رد\nالمحاولة غدًا');
    expect(f.latestComment.text).toContain(scheduled);
  });
  it('keeps a historical appointment and ordinary comments intact', () => {
    const text = `إعادة التواصل لتأكيد الطلب — موعد المتابعة: ${scheduled} — اتصال: لا يوجد رد`;
    expect(fixture().myPriorityCommentText({ deferredUntil: '2026-10-27T17:01:00Z', latestComment: { text } })).toBe(text);
    expect(fixture().myPriorityCommentText({ latestComment: { text: 'Please call @Fares' } })).toBe('Please call @Fares');
  });
  it('retains the scheduling reason when no note was recorded', () => {
    expect(fixture().myPriorityCommentText({ deferredUntil: scheduled, latestComment: { text: `إعادة التواصل لتأكيد الطلب — موعد المتابعة: ${scheduled}` } })).toBe('إعادة التواصل لتأكيد الطلب');
  });
  it('shows a separate due label, Cairo appointment and relative time', () => {
    const markup = fixture().renderMyPrioritySchedule({ deferredUntil: '2026-10-27T17:01:00Z' }, Date.parse('2026-10-27T18:01:00Z'));
    expect(markup).toContain('متأخر عن موعد المتابعة');
    expect(markup).toContain('8:01 م');
    expect(markup).not.toContain('بتوقيت القاهرة');
    expect(markup).toContain('قبل ساعة');
    expect(markup.replace(/<[^>]+>/g, '')).not.toContain('T17:01');
  });
  it('handles future, missing and invalid appointments without claiming they are due', () => {
    const env = fixture(); env.currentLang = 'en';
    const markup = env.renderMyPrioritySchedule({ deferredUntil: '2026-12-27T17:01:00Z' }, Date.parse('2026-12-27T16:01:00Z'));
    expect(markup).toContain('in 1 hour');
    expect(markup).toContain('7:01 pm');
    expect(markup).not.toContain('is-due');
    expect(env.renderMyPrioritySchedule({})).toBe('');
    expect(env.renderMyPrioritySchedule({ deferredUntil: 'invalid' })).toBe('');
  });
});
