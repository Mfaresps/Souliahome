# Phase 11: navigation performance and safe reuse

## Test conditions and interpretation

Seven fresh Chromium contexts were run before and seven after against the same populated MongoDB (1,053 transactions, 538 Follow-ups, 891 Shopify orders), at 1440 × 900. Each run followed Dashboard → Orders → Dashboard → Movements → Dashboard → Follow-ups → Dashboard → Orders → Movements → Follow-ups, with an order detail opened and closed. API writes were blocked in the browser; the read-only Movements page POST was allowed. The `visible` timer includes two animation frames after content appears. `fresh` waits for the route's latest data to be applied; Dashboard's old value was a cached paint and was **not server-fresh**. Figures are medians in milliseconds. Chrome Resource Timing supplies request and byte counts. Two source changes outside this phase landed during the measurement window, including the Shipping Command Center, so initial-route changes are indicative; return-path measurements and the isolated renderer benchmark are the stronger evidence.

## Audit findings and implementation

| Priority | Source and root cause | Change | Safety decision |
|---|---|---|---|
| 1 | `loadFollowUps` and `switchMainTab` fetched the full 538-row list, reset the page, and rebuilt 40 visible rows on every return. | Preserve page/search/date state; reuse a full admin read for 5 seconds; compare the full response before repainting. A write, token change, or `followup:changed` event invalidates reuse. Staff always revalidate employee-scoped records. | A cold first visit and explicit refresh still read the server. |
| 2 | `_spLoadServerPage(true)` fetched a fresh summary as required, then rebuilt Orders even when the response was identical. | Keep the required fresh summary read, compare it with the prior response, and retain the existing list DOM when identical. Inventory identity, transaction count, language, user, and query changes force a repaint. | Order/deposit status, totals, and actions are masked during revalidation and after failure. Full order detail cache is cleared on route entry. |
| 3 | Movements already deduplicated identical in-flight requests and skipped identical paints, but old financial values remained visible while a fresh POST ran. | Keep the fresh POST. Show only cached reference/date/customer identity during the wait; mask status, money, KPIs, counts, actions, grid/mobile cards and pagination. On a failed read, show the error and keep old KPIs masked. | No cached financial value is treated as authoritative. The page, search, sort, and date state remain intact. |
| 4 | Dashboard Sales Overview reused month totals for up to 30 seconds on return and rebuilt its metrics during refresh. | Revalidate on each Dashboard entry. Mask old numbers/chart until confirmed. If the response matches, retain the existing DOM. In-flight reads are bound to the write revision. | Failed reads keep old totals hidden. |
| 5 | `showInvoiceDetail` reused a previously hydrated transaction on another open. | Fetch full transaction detail on every open from Movements; coalesce double opens through the existing detail task map. | The modal opens only after the fresh detail arrives. No financial calculation changed. |

All changes are in the frontend. API response formats, permissions, business rules, financial calculations, and database schema were not changed.

## Seven-run navigation comparison

| Flow | Visible before → after | Latest data before → after | API requests before → after | Decoded API bytes before → after | Direct list children removed before → after |
|---|---:|---:|---:|---:|---:|
| Dashboard → Orders, first visit | 496 → 634 | 522 → 679 | 1 → 2 | 109 KB → 109 KB | 0 → 0 |
| Orders → detail | 41 → 59 | 41 → 59 | 1 → 1 | detail body not isolated | 0 → 0 |
| Orders → Dashboard | 85 → 99 | cached 111 → verified 183 | 3 → 3 | 1.15 MB → 1.15 MB | 49 → 26 |
| Dashboard → Movements | identity 37 → 52 | 332 → 400 | 3 → 2 | 171 KB → 170 KB | 1 → 1 |
| Movements → Dashboard | 79 → 92 | cached 113 → verified 168 | 0 → 1 | 0 → 2 KB | 49 → 62 |
| Dashboard → Follow-ups* | 346 → 321 | 366 → 335 | 2 → 1 | 1.17 MB → 21 KB | 0 → 0 |
| Follow-ups → Dashboard | 109 → 88 | cached 128 → verified 157 | 1 → 2 | <1 KB → 3 KB | 49 → 26 |
| Dashboard → Orders, return | stale rows 138 → verified rows 498 | 651 → 516 | 1 → 1 | 109 KB → 109 KB | 2 → 0 |
| Orders → Movements, return | identity 122 → 125 | 302 → 396 | 1 → 1 | 120 KB → 120 KB | 0 → 0 |
| Movements → Follow-ups, return | 114 → 139 | 309 → 160 | 2 → 1 | 1.17 MB → 21 KB | 40 → 0 |

*The benchmark visits an order detail first, which primes a full Follow-ups read. A direct cold Follow-ups visit still needs the full response. The remaining request on quick Follow-ups returns is `/api/complaints`, used for its adjacent tab and pending badge.

The ten-flow sequence changed from a median 15 to 16 API requests. Median decoded API bytes fell from **4.00 MB to 1.71 MB** (57%). Median wire bytes stayed approximately **1.55 MB** because the old repeat Follow-ups response was already HTTP-revalidated to about 300 bytes; the saved cost is browser decode/JSON/render work. Dashboard's additional financial revalidation accounts for one extra request. Orders and Movements continue to make one authoritative page read on return.

The Orders return is **21% faster to verified data** (651 → 516 ms) without a list rebuild. The Follow-ups return is **48% faster** (309 → 160 ms), with no row remount. First Orders and fresh Movements did not improve in this run; showing only verified financial values makes their complete-data milestone later. The new Shipping Command Center and varying backend load also affect these cross-run figures. The safe cached identity columns on Movements appear at about 52 ms.

### Isolated renderer cost

On populated page 2, seven direct synchronous measurements of the same renderers gave a median **279–309 ms** for a forced Orders repaint versus **0.2 ms** to serialize/compare its summary. A forced Follow-ups repaint cost **33–40 ms** versus **1.7–5.5 ms** for the full-list comparison. These are browser JavaScript/DOM construction times, excluding network and subsequent paint. They explain why retaining an unchanged tree helps even when HTTP transfer was already small. No route shell nodes were remounted.

## Detail round trips, state, and safety

- Shopify detail still makes one full-detail GET on first open; closing the peek leaves the Orders DOM intact and starts no list request. The seven-run first-open median was 41 → 59 ms. Route return invalidates the full-detail cache and revalidates the summary.
- Transaction detail now makes one full GET on each open, including a repeat open. A single populated-data check measured 73–126 ms for the first open and 41–279 ms for a repeat under variable load; the old cached equivalent rendered in 4–5 ms but could show an outdated status. Closing the modal causes no list request; returning to Movements makes one fresh page POST.
- Search, page 2, and Follow-ups date inputs survived route changes. Movements page 2 and its 2020-01-01 to 2030-12-31 range survived; the backend query and date semantics were unchanged. Order search survived. The live checks confirmed 538 Follow-ups and zero uncaught browser errors.
- Simulated write revision and real-time events each forced a new Follow-ups read. During Orders/Movements revalidation, old financial/status cells were hidden. Injected HTTP 500 responses left old Orders deposits and Movements KPIs hidden and displayed the existing error/retry state.
- `navigation-permissions.cjs` and `startup-route-fast-path.cjs` passed. `movements-refresh-dedupe.cjs` passed on rerun after one timing-sensitive failure. The older `sales-overview.cjs` fixture currently references removed shipping DOM IDs and does not reflect the current Shipping Command Center; live populated-data checks covered the Dashboard financial revalidation.

## Remaining bottlenecks

1. **Cold Orders and first navigation remain slow.** Route module startup, other foreground work, and the required summary read put verified Orders at 679 ms median in the final run. The concurrent Shipping Command Center change prevents attributing the full difference to this phase.
2. **Movements still waits for a live page POST.** Verified content was 400 ms on first entry and 396 ms on return. Skipping that request would risk stale balances or statuses; a backend query/network profile is needed before changing it.
3. **Cold Follow-ups still needs the 1.15 MB full response.** The five-second admin reuse window only helps quick revisits. Staff-specific lists always revalidate.
4. **Dashboard returns now include a small extra financial read.** This is deliberate freshness work; its shell stays available while values are masked.

Raw runs: `phase11-navigation-before.json` and `phase11-navigation-after-final.json`. The reproducible browser and failure-path checks are `backend/test/perf/phase11-navigation.cjs` and `phase11-navigation-safety.cjs`.
