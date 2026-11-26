/**
 * Shopify page reports (Nov 26, 2026 — owner's decision): the period KPI strip and the «تقرير»
 * image / text / share are permissions, not open to everyone who may see the orders.
 *
 *  - Viewing the strip needs ONE of the range keys below; the key decides how far back the
 *    employee may look (today only … any period). The widest key held wins.
 *  - `shopify-reports-share` = download / copy / share the report (it leaves the system).
 *  - The deposit money totals (Instapay / Vodafone Cash) are sent to admins only — no screen
 *    shows them any more (the bar they fed was removed), so nobody else needs them.
 *
 * ⚠ Mirrored by `_spRep*` in index.html (SHOPIFY_REPORT_RANGES) — keep the keys and days in step.
 * ⚠ The server is the authority: summary-page drops what the caller may not see.
 */
export const SHOPIFY_REPORT_RANGES: ReadonlyArray<readonly [string, number]> = [
  ['shopify-reports-today', 1],
  ['shopify-reports-3d', 3],
  ['shopify-reports-7d', 7],
  ['shopify-reports-30d', 30],
  ['shopify-reports-all', Infinity],
];
export const SHOPIFY_REPORT_RANGE_KEYS = SHOPIFY_REPORT_RANGES.map(([key]) => key);
export const SHOPIFY_REPORT_SHARE = 'shopify-reports-share';

export type ReportUser = { role?: string; perms?: string[] } | undefined | null;

/** How many calendar days back (today included) the user may view. 0 = none, Infinity = any. */
export function shopifyReportDays(user: ReportUser): number {
  if (user?.role === 'admin') return Infinity;
  const perms = user?.perms || [];
  let days = 0;
  for (const [key, n] of SHOPIFY_REPORT_RANGES) if (perms.includes(key)) days = Math.max(days, n);
  return days;
}
export function canShareShopifyReport(user: ReportUser): boolean {
  return user?.role === 'admin' || (shopifyReportDays(user) > 0 && !!user?.perms?.includes(SHOPIFY_REPORT_SHARE));
}
export function canSeeShopifyDepositTotals(user: ReportUser): boolean {
  return user?.role === 'admin';
}

const CAIRO = 'Africa/Cairo';
function cairoOffsetMs(at: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: CAIRO, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(at)).reduce((o: Record<string, number>, x) => (x.type !== 'literal' && (o[x.type] = Number(x.value)), o), {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}
/** Start (ms) of the earliest Cairo day the user may view, or -Infinity for any / null for none. */
export function shopifyReportMinMs(user: ReportUser, now = Date.now()): number | null {
  const days = shopifyReportDays(user);
  if (!days) return null;
  if (!Number.isFinite(days)) return -Infinity;
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: CAIRO, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(now)).split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d - (days - 1));
  return guess - cairoOffsetMs(guess);
}
/** A browser in another zone may send its own local midnight; one hour of slack absorbs it. */
export const SHOPIFY_REPORT_SLACK_MS = 60 * 60 * 1000;
export function shopifyReportAllows(user: ReportUser, fromMs: number, now = Date.now()): boolean {
  const min = shopifyReportMinMs(user, now);
  if (min === null || !Number.isFinite(fromMs)) return false;
  return fromMs >= min - SHOPIFY_REPORT_SLACK_MS;
}
