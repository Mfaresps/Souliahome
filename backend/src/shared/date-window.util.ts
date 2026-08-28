/**
 * Date-window comparison for report periods.
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * `date` on a transaction is *supposed* to be a plain `YYYY-MM-DD` string, and much of the
 * system assumes it. But it is written from whatever the client sends (see VaultService.addEntry:
 * `dto.date || new Date().toISOString().split('T')[0]` — the fallback is truncated, the caller's
 * value is stored verbatim), so a large share of real rows carry a full ISO timestamp instead:
 *
 *   measured on the 2026-08-28 backup — transactions 326/521 (63%), vault entries 10/766,
 *   supplier-ledger entries 5/19.
 *
 * Both JS `<=` and Mongo `$lte` compare strings bytewise, so for those rows:
 *
 *   '2026-06-30T00:39:12.745Z' <= '2026-06-30'   →   FALSE
 *
 * because the timestamped string is longer and therefore sorts *after* the bare date. The result
 * is that **the last day of any period silently drops** every timestamped row on it. A June report
 * showed purchases of 22,860 when the true figure was 61,300 — one invoice (ref 010, 38,440)
 * dated 30 June was invisible.
 *
 * It reads as missing data, not as a date bug, which is why it survived: the totals are
 * self-consistent and nothing looks broken.
 *
 * ⚠ THE FRONTEND ALREADY DOES THE RIGHT THING. `index.html` filters with
 *   `tx.date.slice(0, 10) < from` (and the same for expenses), so before this fix the two layers
 *   disagreed: صفحة الحركات and صفحة التقارير could list different transactions for the same
 *   month. The backend was the outlier, which is what makes this a correction rather than a
 *   behaviour change.
 *
 * ⚠ MEASURED AS PURELY ADDITIVE. Across all 12 months of 2026 the fix ADDS 1 row and REMOVES 0.
 *   It can only restore rows that were being dropped; it can never exclude one that used to count.
 *
 * TWO FORMS, BECAUSE HALF THE CALLERS ARE MONGO
 * ---------------------------------------------
 * `inDateWindow` is for filtering in JS (it truncates the value). Mongo queries cannot truncate a
 * stored field in a plain `find`, so `dateWindowQuery` widens the *bound* instead: `$lte` becomes
 * `to + '￿'`, which sorts after every possible time suffix on that date but before the next
 * day. Verified equivalent to truncation on both sides of both boundaries.
 *
 * NOT A MIGRATION. Existing rows keep whatever format they have; both helpers accept either. The
 * companion fix is `normalizeDateOnly`, applied where dates are WRITTEN so new rows are clean.
 */

/** The day a date value falls on, whether it is `YYYY-MM-DD` or a full ISO timestamp. */
export function dateOnly(value: unknown): string {
  return String(value ?? '').slice(0, 10);
}

/**
 * Is `value` inside the inclusive `[from, to]` day window?
 * Compares on the DAY, so a timestamped value on the boundary day is included.
 * An empty/absent value is never in a bounded window.
 */
export function inDateWindow(
  value: unknown,
  from?: string,
  to?: string,
): boolean {
  const d = dateOnly(value);
  if (!d) return !from && !to;
  if (from && d < dateOnly(from)) return false;
  if (to && d > dateOnly(to)) return false;
  return true;
}

/**
 * Mongo range operators for an inclusive day window over a string date field.
 * Returns `null` when unbounded, so callers can skip adding the key entirely.
 *
 * ⚠ The upper bound is `to + '￿'`, NOT `to`. '￿' is the highest code unit, so it sorts
 *   after '2026-06-30T23:59:59.999Z' but before '2026-07-01' — which is exactly "any time on
 *   that day, and nothing after it". Do not "simplify" this back to a bare `$lte: to`; that is
 *   the bug.
 */
export function dateWindowQuery(
  from?: string,
  to?: string,
): { $gte?: string; $lte?: string } | null {
  if (!from && !to) return null;
  const q: { $gte?: string; $lte?: string } = {};
  if (from) q.$gte = dateOnly(from);
  if (to) q.$lte = dateOnly(to) + '￿';
  return q;
}

/**
 * Normalises a date to `YYYY-MM-DD` for STORAGE, so new rows stop entering the mixed state above.
 * Returns '' for an empty value and leaves an unparseable non-empty value as its first 10 chars
 * rather than throwing — a report filter must never be the thing that rejects a save.
 */
export function normalizeDateOnly(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return raw.slice(0, 10);
}
