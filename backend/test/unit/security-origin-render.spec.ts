import * as fs from 'fs';
import * as path from 'path';

/**
 * Renders the origin column through the FUNCTIONS SHIPPED IN index.html.
 *
 * ⚠ The functions are EXTRACTED from the real file, never copied into this
 * spec. A copy keeps passing after the real one breaks — which is exactly what
 * the pre-existing `returns.spec.ts` does wrong (see CLAUDE.md).
 */

const INDEX = path.join(__dirname, '../../../frontend/public/index.html');

/** Pull one top-level `function name(...) {...}` out of the file, brace-balanced. */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in index.html`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

/** Pull a top-level `const NAME = {...};` literal out of the file. */
function extractConst(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = `);
  if (start === -1) throw new Error(`const ${name} not found`);
  let i = src.indexOf('{', start);
  if (i === -1 || i > src.indexOf('\n', start) + 200) {
    // single-line backtick constant
    const eol = src.indexOf('\n', start);
    return src.slice(start, eol + 1);
  }
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1) + ';';
    }
  }
  throw new Error(`unbalanced braces reading ${name}`);
}

describe('security log — «مصدر المحاولة» column (shipped renderers)', () => {
  let src: string;
  let ctx: Record<string, any>;

  beforeAll(() => {
    src = fs.readFileSync(INDEX, 'utf8');

    // ⚠ The shipped `esc()` escapes by round-tripping through a real DOM node
    // (`createElement` + `createTextNode` + `.innerHTML`), and jsdom is not a
    // dependency of this project. The shim below is that behaviour expressed
    // without a DOM — it is the ONLY substituted function, and only because it
    // cannot run here at all. Every function actually under test is the real
    // one, extracted from the shipped file.
    const escShim = `function esc(str){ if (str == null) return '';
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }`;

    const bundle = [
      escShim,
      extractFn(src, 'fmtN'),
      extractConst(src, '_SEC_DEVICE_ICON'),
      extractConst(src, '_SEC_PIN_ICON'),
      extractConst(src, '_SEC_NET_ICON'),
      extractFn(src, '_secOriginTitle'),
      extractFn(src, '_secOriginCellHtml'),
      extractFn(src, '_secLockedAttemptsHtml'),
      'return { _secOriginCellHtml, _secOriginTitle, _secLockedAttemptsHtml };',
    ].join('\n');

    ctx = new Function(bundle)();
  });

  const chromeWin = {
    browser: 'Chrome',
    os: 'Windows',
    device: 'كمبيوتر',
    ipAddress: '197.55.1.9',
    location: 'القاهرة، مصر',
    isp: 'Vodafone Egypt',
    userAgent: 'Mozilla/5.0 ... Chrome/131',
  };

  it('renders browser, OS, IP and location', () => {
    const html = ctx._secOriginCellHtml(chromeWin);
    expect(html).toContain('Chrome');
    expect(html).toContain('Windows');
    expect(html).toContain('197.55.1.9');
    expect(html).toContain('القاهرة، مصر');
    expect(html).toContain('Vodafone Egypt');
  });

  it('isolates the IP in a <bdi> — a Latin run inside an RTL table', () => {
    // Without isolation the dots in an address reorder. Same rule as the vault
    // journal. Never "fix" a mis-rendered address by reordering the string.
    const html = ctx._secOriginCellHtml(chromeWin);
    expect(html).toMatch(/<bdi>197\.55\.1\.9<\/bdi>/);
  });

  it('says «غير معروف» when nothing was captured, rather than rendering blank', () => {
    // An absent origin is itself a fact. A blank cell reads as a rendering bug,
    // and every row predating this feature has exactly these empty fields.
    const html = ctx._secOriginCellHtml({ username: 'admin', violationType: 'failed_login' });
    expect(html).toContain('غير معروف');
    expect(html).toContain('sec-origin-none');
  });

  it('renders a partial origin rather than the nothing-captured state', () => {
    // An IP with no UA still tells the admin where the attempt came from, so it
    // must NOT collapse into the «لم تُسجَّل بيانات» state. The device heading
    // reads «جهاز غير معروف» — that names the unknown half while showing the
    // known half, which is the distinction being locked in here.
    const html = ctx._secOriginCellHtml({ ipAddress: '197.55.1.9' });
    expect(html).not.toContain('sec-origin-none');
    expect(html).toContain('197.55.1.9');
    expect(html).toContain('جهاز غير معروف');
  });

  it('escapes hostile values — the UA is attacker-controlled input', () => {
    // The User-Agent on a FAILED login is attacker-supplied by definition, and
    // it lands in an admin-only page. Escaping is the whole defence.
    const html = ctx._secOriginCellHtml({
      browser: '<img src=x onerror=alert(1)>',
      os: 'Windows',
      ipAddress: '"><script>alert(2)</script>',
      location: 'x',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
  });

  it('escapes the title attribute too', () => {
    const html = ctx._secOriginCellHtml({
      browser: 'Chrome',
      os: 'Windows',
      ipAddress: '1.1.1.1',
      userAgent: 'evil" onmouseover="alert(1)',
    });
    // The injected quote must not be able to close the title attribute.
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain('&quot;');
  });

  describe('lockout attempt list', () => {
    const attempt = (over: Record<string, unknown> = {}) => ({
      violationType: 'failed_login',
      createdAt: '2026-09-08T04:42:00.000Z',
      browser: 'Chrome',
      os: 'Windows',
      device: 'كمبيوتر',
      ipAddress: '197.55.1.9',
      location: 'القاهرة، مصر',
      ...over,
    });

    it('renders nothing for a pre-existing row with no attempts — no backfill needed', () => {
      expect(ctx._secLockedAttemptsHtml(undefined)).toBe('');
      expect(ctx._secLockedAttemptsHtml([])).toBe('');
    });

    it('lists every attempt, not a collapsed count', () => {
      // ⚠ A count would hide the one case that matters: attempts from two
      // different devices. Each attempt keeps its own origin.
      const html = ctx._secLockedAttemptsHtml([attempt(), attempt(), attempt()]);
      expect((html.match(/sec-att-when/g) || []).length).toBe(3);
      expect(html).toContain('(3)');
    });

    it('flags a lockout whose attempts came from more than one device', () => {
      const html = ctx._secLockedAttemptsHtml([
        attempt(),
        attempt({ browser: 'Safari', os: 'iOS', ipAddress: '41.2.3.4' }),
      ]);
      expect(html).toContain('من أكثر من جهاز');
    });

    it('does NOT flag a single device — the ordinary forgetful-employee case', () => {
      const html = ctx._secLockedAttemptsHtml([attempt(), attempt(), attempt(), attempt()]);
      expect(html).not.toContain('من أكثر من جهاز');
    });

    it('marks the lock event itself distinctly from the failed attempts', () => {
      const html = ctx._secLockedAttemptsHtml([
        attempt({ violationType: 'account_locked' }),
        attempt(),
      ]);
      expect(html).toContain('is-lock');
    });
  });

  describe('the table contract', () => {
    it('header column count matches the row column count', () => {
      // ⚠ The header and the row template are separate string literals with
      // nothing tying them together — adding a column to one alone shifts every
      // cell under the wrong header. Same trap as the cancellations table.
      const tbodyAt = src.indexOf('id="security-audit-tbody"');
      const theadAt = src.lastIndexOf('<thead>', tbodyAt);
      const header = src.slice(theadAt, src.indexOf('</thead>', theadAt));
      const headerCols = (header.match(/<th /g) || []).length;
      expect(headerCols).toBe(5);

      const rowFn = extractFn(src, '_renderSecurityLogPage');
      const rowTemplate = rowFn.slice(rowFn.indexOf('<tr class="sec-row'));
      const bodyCols = (rowTemplate.match(/<td /g) || []).length;
      expect(bodyCols).toBe(headerCols);
    });

    it('the empty-state colspan matches the column count', () => {
      const rowFn = extractFn(src, '_renderSecurityLogPage');
      expect(rowFn).toContain('colspan="5"');
    });

    it('dates use the Latin-digit locale, not bare ar-EG', () => {
      // ⚠ Plain 'ar-EG' emits Arabic-Indic digits (٠-٩) — the recurring trap in
      // this codebase. The rest of this panel uses Latin digits.
      const rowFn = extractFn(src, '_renderSecurityLogPage');
      expect(rowFn).toContain('ar-EG-u-nu-latn');
      expect(rowFn).not.toMatch(/toLocaleString\('ar-EG'\)/);
    });

    it('row tints are classes, not inline hex — the panel has a dark theme', () => {
      const rowFn = extractFn(src, '_renderSecurityLogPage');
      expect(rowFn).not.toContain('#fef2f2');
      expect(rowFn).not.toContain('#f0fdf4');
      expect(rowFn).toContain('sec-row-danger');
      expect(rowFn).toContain('sec-row-ok');
    });

    it('every class the renderers emit has a CSS rule', () => {
      for (const cls of [
        'sec-origin', 'sec-origin-head', 'sec-origin-sub', 'sec-origin-bit',
        'sec-origin-isp', 'sec-origin-none', 'sec-row-danger', 'sec-row-ok',
        'sec-locked-card', 'sec-att-wrap', 'sec-att-summary', 'sec-att-warn',
        'sec-att-list', 'sec-att-when', 'sec-att-origin', 'sec-unlock-btn',
      ]) {
        expect(src).toContain(`.${cls}{`);
      }
    });
  });
});
