import * as fs from 'fs';
import * as path from 'path';

/**
 * التفقيط — the written-out amount printed on every invoice.
 *
 * ⚠ The function under test lives in `frontend/public/index.html`, not in the
 * backend. It is extracted from the shipped file and evaluated here rather than
 * being copied into this spec: a copy would keep passing after the real one was
 * broken, which is the exact failure mode the pre-existing
 * `test/unit/returns.spec.ts` suffers from (it asserts on local helper
 * re-implementations and passes whether or not the service works).
 *
 * Why this needs locking down: Arabic counted nouns inflect, and the rules are
 * easy to "simplify" into something that reads fine for the common case and is
 * wrong at the boundaries. Every case below failed at some point while the
 * function was being written.
 */

const INDEX_HTML = path.resolve(
  __dirname,
  '../../../frontend/public/index.html',
);

function loadAmountToArabicWords(): (v: number) => string {
  const src = fs.readFileSync(INDEX_HTML, 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('const _AR_ONES');
  const end = src.indexOf('   PRINTED INVOICE', start);
  if (start < 0 || end < 0) {
    throw new Error(
      'Could not locate the تفقيط block in index.html — if it was renamed or ' +
        'moved, update the markers here rather than deleting this suite.',
    );
  }
  // The slice stops inside the banner comment that opens the next block, so
  // close that comment to keep the extracted source parseable.
  const code = src.slice(start, end) + '*/';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  return new Function(`${code}; return amountToArabicWords;`)() as (
    v: number,
  ) => string;
}

const say = loadAmountToArabicWords();

/** Strips the fixed «فقط … لا غير» wrapper so cases assert on the amount itself. */
const core = (v: number) =>
  say(v).replace(/^فقط\s+/, '').replace(/\s+لا غير$/, '');

describe('amountToArabicWords — التفقيط', () => {
  it('is wrapped in the conventional فقط … لا غير', () => {
    const s = say(100);
    expect(s.startsWith('فقط ')).toBe(true);
    expect(s.endsWith(' لا غير')).toBe(true);
  });

  /**
   * 1 and 2 are expressed BY the noun form itself (جنيه واحد / جنيهان), so the
   * spelled numeral must not also be printed. Getting this wrong produces
   * «واحد جنيه واحد».
   */
  describe('1 and 2 carry the numeral inside the noun', () => {
    it('1 → جنيه واحد', () => expect(core(1)).toBe('جنيه واحد مصري'));
    it('2 → جنيهان (dual, no numeral)', () =>
      expect(core(2)).toBe('جنيهان مصريان'));
    it('never prints واحد twice', () => expect(say(1)).not.toMatch(/واحد.*واحد/));
  });

  /**
   * ⚠ Agreement is governed by the LAST number spoken (n % 100), never by the
   * whole amount. These four cases pin the four distinct forms.
   */
  describe('the counted noun agrees with n % 100', () => {
    it('3–10 take the plural جمع قلة', () => {
      expect(core(3)).toBe('ثلاثة جنيهات مصرية');
      expect(core(10)).toBe('عشرة جنيهات مصرية');
    });

    it('11–99 take the accusative singular تمييز منصوب', () => {
      expect(core(11)).toContain('جنيهاً مصرياً');
      expect(core(99)).toContain('جنيهاً مصرياً');
      expect(core(543)).toContain('جنيهاً مصرياً');
    });

    // A round hundred/thousand takes the GENITIVE singular, not the accusative.
    // «مائة جنيهاً» is the error this guards.
    it('a round 100 / 1000 takes the genitive singular', () => {
      expect(core(100)).toBe('مائة جنيه مصري');
      expect(core(1000)).toBe('ألف جنيه مصري');
      expect(core(2500)).toBe('ألفان وخمسمائة جنيه مصري');
      expect(core(100)).not.toContain('جنيهاً');
    });

    // 101 ends in 1, but the numeral is already spoken by the hundreds part, so
    // the noun must be the bare form. Returning the `one` form here printed
    // «مائة وواحد جنيه واحد».
    it('101 spells the numeral once and uses the bare noun', () => {
      expect(core(101)).toBe('مائة وواحد جنيه مصري');
      expect(core(1001)).toBe('ألف وواحد جنيه مصري');
    });
  });

  /** A scale word is itself a counted noun and obeys the same rule. */
  describe('scale words inflect too', () => {
    it('3–10 thousands take آلاف', () =>
      expect(core(3000)).toBe('ثلاثة آلاف جنيه مصري'));
    it('11–99 thousands take ألفاً', () =>
      expect(core(12000)).toBe('اثنا عشر ألفاً جنيه مصري'));
    // «مائة ألفاً» is the error this guards.
    it('a round hundred thousand takes ألف', () => {
      expect(core(100000)).toBe('مائة ألف جنيه مصري');
      expect(core(500000)).toBe('خمسمائة ألف جنيه مصري');
    });
    it('1 and 2 are carried by the scale word, never counted in front of it', () => {
      expect(core(1000)).not.toMatch(/واحد ألف/);
      expect(core(2000)).toBe('ألفان جنيه مصري');
      expect(core(1000000)).toBe('مليون جنيه مصري');
      expect(core(2000000)).toBe('مليونان جنيه مصري');
    });
  });

  /** Arabic states the unit before the ten: "three and twenty". */
  it('the unit leads the ten', () => {
    expect(core(21)).toBe('واحد وعشرون جنيهاً مصرياً');
    expect(core(33)).toBe('ثلاثة وثلاثون جنيهاً مصرياً');
  });

  describe('piastres', () => {
    it('are appended with their own agreement', () => {
      expect(core(1250.5)).toBe(
        'ألف ومائتان وخمسون جنيهاً مصرياً وخمسون قرشاً',
      );
      expect(core(1.01)).toBe('جنيه واحد مصري وقرش واحد');
      expect(core(7940.25)).toContain('وخمسة وعشرون قرشاً');
    });

    it('are omitted entirely when zero', () => {
      expect(say(38440)).not.toContain('قرش');
      expect(say(1000)).not.toContain('قرش');
    });

    /**
     * ⚠ Rounds to 2dp BEFORE splitting. Reading the fraction off an unrounded
     * float prints 49 piastres where the invoice total says 50.
     */
    it('rounds to 2dp before splitting, so it agrees with the printed figure', () => {
      expect(core(0.1 + 0.2)).toContain('ثلاثون قرشاً'); // 0.30000000000000004
      expect(say(2.675)).toContain('قرش');
      expect(say(99.999)).toContain('مائة'); // rounds up to 100.00
      expect(say(99.999)).not.toContain('قرش');
    });
  });

  describe('edge values', () => {
    it('0 → صفر', () => expect(core(0)).toBe('صفر جنيه مصري'));
    it('spells piastres even when there are no pounds', () =>
      expect(core(0.75)).toBe('صفر جنيه مصري وخمسة وسبعون قرشاً'));
    it('marks a negative amount', () => expect(say(-1500)).toMatch(/^سالب /));
    it('treats null/undefined/NaN as zero rather than throwing', () => {
      expect(core(null as unknown as number)).toBe('صفر جنيه مصري');
      expect(core(undefined as unknown as number)).toBe('صفر جنيه مصري');
      expect(core(NaN)).toBe('صفر جنيه مصري');
    });
  });

  /** The real amounts this system prints, taken from the documented incidents. */
  describe('real invoice totals', () => {
    it('7,940 — the #900001 purchase', () =>
      expect(core(7940)).toBe('سبعة آلاف وتسعمائة وأربعون جنيهاً مصرياً'));
    it('38,440 — the June invoice ref 010', () =>
      expect(core(38440)).toBe(
        'ثمانية وثلاثون ألفاً وأربعمائة وأربعون جنيهاً مصرياً',
      ));
    it('142,743 — the المصاريف KPI figure', () =>
      expect(core(142743)).toBe(
        'مائة واثنان وأربعون ألفاً وسبعمائة وثلاثة وأربعون جنيهاً مصرياً',
      ));
  });

  /**
   * The document-level guarantee: the written amount is an anti-tampering
   * control, so it must never come back empty or carry a raw digit — either
   * would defeat the reason it is on the page.
   */
  it('never returns an empty string or a Latin digit, across a wide sweep', () => {
    for (let v = 0; v <= 2200; v++) {
      const s = say(v);
      expect(s.length).toBeGreaterThan(8);
      expect(s).not.toMatch(/[0-9]/);
      expect(s).not.toContain('undefined');
      expect(s).not.toContain('NaN');
    }
    for (const v of [12186.5, 999999.99, 1234567.89, 9999999]) {
      const s = say(v);
      expect(s).not.toMatch(/[0-9]/);
      expect(s).not.toContain('undefined');
    }
  });
});
