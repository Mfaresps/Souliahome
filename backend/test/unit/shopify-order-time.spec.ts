import * as fs from 'fs';
import * as path from 'path';

export {};

const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('function _spOrderTimeLabel(');
if (start < 0) throw new Error('Missing Shopify time formatter');
const fn = source.slice(start, source.indexOf('\n}', start) + 2);
const format = new Function('value', 'now', 'language', `const currentLang = language; ${fn}; return _spOrderTimeLabel(value, now);`) as (value: string, now: number, language: string) => string;

// Local dates reproduce the browser's midnight boundary in any test-host timezone.
const now = new Date(2026, 9, 11, 0, 8).getTime();
const yesterday = (hour: number, minute: number) => new Date(2026, 9, 10, hour, minute).toISOString();

describe('Shopify order time across midnight', () => {
  it('shows 12 minutes ago for yesterday at 11:56 pm (#2780)', () => {
    expect(format(yesterday(23, 56), now, 'en')).toBe('12 minutes ago');
  });
  it('shows 53 minutes ago for yesterday at 11:15 pm (#2779)', () => {
    expect(format(yesterday(23, 15), now, 'en')).toBe('53 minutes ago');
  });
  it('keeps yesterday at 4:08 pm for an older order (#2778)', () => {
    expect(format(yesterday(16, 8), now, 'en')).toBe('Yesterday at 4:08 pm');
  });
  it('uses a calendar label at exactly one hour across midnight', () => {
    expect(format(yesterday(23, 8), now, 'en')).toBe('Yesterday at 11:08 pm');
  });
  it('keeps Friday for orders earlier in the week', () => {
    expect(format(new Date(2026, 9, 9, 23, 28).toISOString(), now, 'en')).toBe('Friday at 11:28 pm');
  });
  it('uses Arabic relative wording and Latin digits across midnight', () => {
    const text = format(yesterday(23, 56), now, 'ar');
    expect(text).toContain('12');
    expect(text).toContain('منذ');
    expect(text).not.toContain('أمس');
  });
});
