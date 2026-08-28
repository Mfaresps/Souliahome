import {
  dateOnly,
  inDateWindow,
  dateWindowQuery,
  normalizeDateOnly,
} from '../../src/shared/date-window.util';

/**
 * Locks in the fix for the date-window bug (Aug 28, 2026).
 *
 * `date` is written from whatever the client sends, so a large share of real rows carry a full
 * ISO timestamp rather than a bare `YYYY-MM-DD`. Both JS `<=` and Mongo `$lte` compare strings
 * bytewise, so `'2026-06-30T00:39:12.745Z' <= '2026-06-30'` was FALSE — the last day of every
 * report period silently dropped those rows. June 2026 reported purchases of 22,860 against a
 * true 61,300, the gap being one 38,440 invoice dated 30 June.
 *
 * The first test below is that exact regression. If it ever fails again, the reports are
 * under-counting real money.
 */
describe('date-window util', () => {
  describe('the regression itself', () => {
    it('includes a timestamped row on the LAST day of the window (the 38,440 June invoice)', () => {
      // The raw-string compare that caused the bug, kept here to show what changed.
      expect('2026-06-30T00:39:12.745Z' <= '2026-06-30').toBe(false);
      // What the helper does instead:
      expect(
        inDateWindow('2026-06-30T00:39:12.745Z', '2026-06-01', '2026-06-30'),
      ).toBe(true);
    });

    it('includes a timestamped row at the very end of the last day', () => {
      expect(
        inDateWindow('2026-06-30T23:59:59.999Z', '2026-06-01', '2026-06-30'),
      ).toBe(true);
    });

    it('still excludes the next day, timestamp or not', () => {
      expect(inDateWindow('2026-07-01', '2026-06-01', '2026-06-30')).toBe(false);
      expect(
        inDateWindow('2026-07-01T00:00:00.000Z', '2026-06-01', '2026-06-30'),
      ).toBe(false);
    });

    it('still excludes the day before the window', () => {
      expect(
        inDateWindow('2026-05-31T23:59:59.999Z', '2026-06-01', '2026-06-30'),
      ).toBe(false);
    });
  });

  describe('dateOnly', () => {
    it('truncates an ISO timestamp to its day', () => {
      expect(dateOnly('2026-06-30T00:39:12.745Z')).toBe('2026-06-30');
    });
    it('leaves a plain date untouched', () => {
      expect(dateOnly('2026-06-30')).toBe('2026-06-30');
    });
    it('maps null/undefined to empty rather than "null"', () => {
      expect(dateOnly(null)).toBe('');
      expect(dateOnly(undefined)).toBe('');
    });
  });

  describe('inDateWindow boundaries', () => {
    it('is inclusive on both ends', () => {
      expect(inDateWindow('2026-06-01', '2026-06-01', '2026-06-30')).toBe(true);
      expect(inDateWindow('2026-06-30', '2026-06-01', '2026-06-30')).toBe(true);
    });
    it('supports an open-ended start and end', () => {
      expect(inDateWindow('2030-01-01', '2026-06-01', undefined)).toBe(true);
      expect(inDateWindow('2020-01-01', undefined, '2026-06-30')).toBe(true);
    });
    it('accepts anything when unbounded', () => {
      expect(inDateWindow('2026-06-15')).toBe(true);
      expect(inDateWindow('')).toBe(true);
    });
    it('rejects an empty value inside a bounded window', () => {
      // A row with no date cannot be shown to belong to a period.
      expect(inDateWindow('', '2026-06-01', '2026-06-30')).toBe(false);
    });
  });

  describe('dateWindowQuery (Mongo)', () => {
    it('returns null when unbounded so callers can omit the key', () => {
      expect(dateWindowQuery()).toBeNull();
      expect(dateWindowQuery(undefined, undefined)).toBeNull();
    });

    it('widens $lte past any time suffix', () => {
      const q = dateWindowQuery('2026-06-01', '2026-06-30');
      expect(q).not.toBeNull();
      expect(q!.$gte).toBe('2026-06-01');
      // ⚠ NOT a bare '2026-06-30' — that is the bug.
      expect(q!.$lte).toBe('2026-06-30￿');
    });

    it('omits the bound that was not supplied', () => {
      expect(dateWindowQuery('2026-06-01', undefined)!.$lte).toBeUndefined();
      expect(dateWindowQuery(undefined, '2026-06-30')!.$gte).toBeUndefined();
    });

    /**
     * The property the whole Mongo approach rests on: comparing against the widened bounds must
     * give the same answer as truncating the value. If these ever diverge, the JS-filtered
     * reports and the Mongo-filtered ones scope different periods.
     */
    it('is bytewise-equivalent to truncation on every boundary case', () => {
      const from = '2026-06-01';
      const to = '2026-06-30';
      const q = dateWindowQuery(from, to)!;
      const probes = [
        '2026-05-31',
        '2026-05-31T23:59:59.999Z',
        '2026-06-01',
        '2026-06-01T00:00:00.000Z',
        '2026-06-15',
        '2026-06-30',
        '2026-06-30T00:39:12.745Z',
        '2026-06-30T23:59:59.999Z',
        '2026-07-01',
        '2026-07-01T00:00:00.000Z',
      ];
      for (const p of probes) {
        const viaMongoBounds =
          (!q.$gte || p >= q.$gte) && (!q.$lte || p <= q.$lte);
        expect([p, viaMongoBounds]).toEqual([p, inDateWindow(p, from, to)]);
      }
    });
  });

  describe('normalizeDateOnly (write side)', () => {
    it('stores an ISO timestamp as its day', () => {
      expect(normalizeDateOnly('2026-06-30T00:39:12.745Z')).toBe('2026-06-30');
    });
    it('leaves an already-clean date alone', () => {
      expect(normalizeDateOnly('2026-06-30')).toBe('2026-06-30');
    });
    it('returns empty for a missing value so the caller\'s `||` fallback fires', () => {
      // VaultService.addEntry relies on this: `normalizeDateOnly(dto.date) || today`.
      expect(normalizeDateOnly(undefined)).toBe('');
      expect(normalizeDateOnly(null)).toBe('');
      expect(normalizeDateOnly('   ')).toBe('');
    });
    it('trims surrounding whitespace', () => {
      expect(normalizeDateOnly('  2026-06-30  ')).toBe('2026-06-30');
    });
  });

  /**
   * The fix must only ever RESTORE rows, never exclude one that used to count. Measured against
   * the real backup this held exactly (1 row recovered, 0 removed); this asserts the property in
   * the abstract so it keeps holding for data we have not seen.
   */
  describe('purely additive', () => {
    it('never excludes a value the old raw-string compare included', () => {
      const from = '2026-06-01';
      const to = '2026-06-30';
      const values = [
        '2026-05-31',
        '2026-06-01',
        '2026-06-01T09:00:00.000Z',
        '2026-06-15',
        '2026-06-15T12:34:56.000Z',
        '2026-06-30',
        '2026-06-30T00:39:12.745Z',
        '2026-07-01',
      ];
      for (const v of values) {
        const oldWay = v >= from && v <= to;
        if (oldWay) {
          expect([v, inDateWindow(v, from, to)]).toEqual([v, true]);
        }
      }
    });
  });
});
