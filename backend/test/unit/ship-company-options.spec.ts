import * as fs from 'fs';
import * as path from 'path';

/**
 * `getShipCompanyOptions` — the <option> list behind the edit-transaction
 * shipping-company picker.
 *
 * ⚠ The function under test lives in `frontend/public/index.html`. It is
 * EXTRACTED from the shipped file and evaluated here rather than copied into
 * this spec: a copy keeps passing after the real one breaks, which is exactly
 * what `test/unit/returns.spec.ts` does wrong. Same technique as
 * `amount-to-words.spec.ts` and `staff-dashboard.spec.ts`.
 *
 * THE INCIDENT (8 Sep 2026). Opening the edit modal on sale #1973 and changing
 * something unrelated (adding an item) reported a change nobody made:
 *
 *     شركة الشحن: bosta + ← بدون شحن
 *
 * Cause: the options were built ONLY from `settings.shipCos`. Real data holds
 * two spellings of the same carrier — `'bosta +'` (221 sales) and `'Bosta'`
 * (144) — so at least one of them matches no row in Settings. Assigning a value
 * that has no matching <option> to a <select> is a silent no-op: the element
 * stays on «بدون شحن», the change detector reads `''`, and the employee's
 * request carries a shipping change they never requested — which a manager then
 * approves.
 *
 * The stored value must therefore always be representable in the list, even
 * when Settings has never heard of it.
 */

const INDEX_HTML = path.resolve(__dirname, '../../../frontend/public/index.html');

function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in index.html — was it renamed?`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces while extracting ${name}`);
}

/** Build the shipped function with `settings` and `esc` supplied. */
function load(shipCos: any): (name?: string) => string {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');
  const body = extractFn(src, 'getShipCompanyOptions');
  const esc = (v: any) =>
    String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('settings', 'esc', `${body}; return getShipCompanyOptions;`)(
    { shipCos }, esc,
  );
}

/** What the browser would end up with: the last `selected` option's value. */
function selectedValue(html: string): string {
  const opts = [...html.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
  const sel = opts.filter(o => / selected/.test(o[2]));
  return sel.length ? sel[sel.length - 1][1] : '';
}

describe('getShipCompanyOptions — the stored carrier must always be selectable', () => {
  const CONFIGURED = [{ name: 'Bosta' }, { name: 'Mylerz' }];

  it('selects a value that IS configured', () => {
    const html = load(CONFIGURED)('Bosta');
    expect(selectedValue(html)).toBe('Bosta');
    expect(html.match(/<option/g)).toHaveLength(2); // no phantom option added
  });

  it('THE REGRESSION: keeps a stored value that Settings does not list', () => {
    // #1973 — 221 sales carry this exact string, and Settings lists only 'Bosta'.
    const html = load(CONFIGURED)('bosta +');
    expect(selectedValue(html)).toBe('bosta +');
  });

  it('does not silently fall back to "no shipping" for an unknown carrier', () => {
    // Before the fix this returned a list with nothing selected, so the <select>
    // landed on the empty «بدون شحن» option and the diff read `'' !== 'bosta +'`.
    expect(selectedValue(load(CONFIGURED)('bosta +'))).not.toBe('');
  });

  it('still works when Settings has no shipping companies at all', () => {
    expect(selectedValue(load([])('bosta +')).trim()).toBe('bosta +');
    expect(selectedValue(load(undefined)('bosta +')).trim()).toBe('bosta +');
  });

  it('adds nothing when there is no stored value', () => {
    expect(load(CONFIGURED)('')).not.toMatch(/selected/);
    expect(load(CONFIGURED)()).not.toMatch(/selected/);
  });

  it('escapes an unknown carrier name rather than injecting markup', () => {
    const html = load(CONFIGURED)('"><img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;');
  });
});

export {};
