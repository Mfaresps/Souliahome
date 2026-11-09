# Phase 7 performance audit and implementation

## Conditions and scope

- Same local frontend (port 8081), backend (port 4000), Chromium viewport (1440 × 900), cache disabled, five cold runs, and the same deterministic populated browser fixture before and after: 1,053 transactions, 891 Shopify orders, 120 products, 90 follow-ups. Before data is `phase6-populated-after.json`; after data is `phase7-populated-after.json`.
- The live API audit used the same configured populated database, an admin read-only JWT, GET requests only, and no writes. It contains 1,053 transactions and 538 follow-ups. The live browser verifier blocked every non-GET API request; none was attempted during its run.
- Browser timing is noisy. The numbers below are medians, not a guaranteed per-device improvement. The sequential GET duration is an endpoint-profile sum, not browser wall time.

## Dependency and API audit before changes

The generated `app-core.js` was 5,056,218 decoded bytes with 4,021 top-level statements. Its largest declaration is the globally needed `TRANSLATIONS` table (509,161 bytes). The largest route-specific declarations were `renderInvoiceViewPage` (74,048), `buildOrderTimelineSection` (40,970), `showInvoiceDetail` (29,575), and `renderFollowUps` (28,065). `EXPORT_REGISTRY` (35,207), `_buildMentionCardHtml` (30,499), and `renderMovementsLegacy` (27,206) remain in core because their current cross-route callers or fallback behavior need more isolation before extraction. Two top-level `stripHtml` definitions exist; the later one wins under classic-script semantics, so neither was removed without a behavior audit.

The 23 observed startup GET endpoints below were measured individually on the live backend. “Initial use” describes the relevant Dashboard or global UI dependency; “decision” records this phase's result. All times are local read-only request durations, including network overhead.

| GET endpoint | Bytes | ms | Initial use | Decision |
| --- | ---: | ---: | --- | --- |
| `/api/branding` | 65 | 26 | Brand shell | Keep |
| `/api/auth/me` | 533 | 4 | Identity and permissions | Keep |
| `/api/warehouses` | 118 | 4 | Shared warehouse selector | Keep; negligible |
| `/api/transactions/startup-overview` | 998,127 | 44 | Dashboard shipment/status data; Follow-ups order lookup | Keep and reuse |
| `/api/settings` | 6,109 | 4 | Language, theme, security settings | Keep |
| `/api/drafts` | 6,523 | 4 | Global draft state | Keep; small |
| `/api/products` | 153,379 | 17 | Dashboard stock data | Keep |
| `/api/expenses` | 16,714 | 5 | Global approval/notification state | Keep |
| `/api/users` | 10,986 | 4 | Staff and assignment state | Keep |
| `/api/tags` | 2,869 | 4 | Shared transaction tags and migration | Keep; small |
| `/api/returns` | 60,880 | 5 | Dashboard and notification state | Keep |
| `/api/complaints` | 21,009 | 5 | Global issue indicators | Keep |
| `/api/purchase-orders` | 36,856 | 6 | Pending approval indicators | Keep |
| `/api/supplier-returns` | 15,027 | 4 | Pending approval indicators | Keep |
| `/api/transactions/inventory` | 47,047 | 35 | Dashboard stock attention | Keep |
| `/api/vault` | 1,307,543 | 118 | Admin briefing and Vault page, not default Dashboard | Defer on default Dashboard; retain eager load when briefing opted in |
| `/api/notifications/read-state` | 51,929 | 14 | Notification read state | Keep |
| `/api/notifications/history` | 32,843 | 7 | Notification history | Keep |
| `/api/mentions` | 96,457 | 16 | Mention indicators | Keep |
| `/api/auth/users-status` | 1,399 | 4 | Presence | Keep |
| `/api/transactions/sales-overview?year=2026&month=11` | 2,145 | 22 | Dashboard sales overview | Keep |
| `/api/employee-performance/duty-board` | 525 | 4 | Dashboard duty board | Keep |
| `/api/followups` | 1,149,876 | 35 | Dashboard issue badges and timed reminders | Keep one shared read; remove duplicate reminder read |

The three largest responses were 3,455,546 bytes, or 86% of the audited 4,018,959-byte total. The extra `/followups` call observed in a real browser came from the reminder module's independent startup/socket refresh. The initial Dashboard read and the reminder refresh now share the same in-flight result; a recent result is reused only for initial/socket connection within one second for the same user. Later refreshes and follow-up change events still request current data.

The six Follow-ups transaction requests came from `navigateTo`: its transaction-dependent route gate called `loadTransactionSummaries({ forceFull: true })` before displaying the page. Each visit fetched six `/transactions/summary-page` responses (3,315,737 live JSON bytes). Follow-ups only uses transaction ID, type, reference, client, phone, cancellation state, and dates for the linked sale search and labels; opening an invoice already hydrates its full detail through `/transactions/:id`. A live parity comparison found all 1,007 sales and all 367 resolvable Follow-ups transaction links in `/transactions/startup-overview`, with zero mismatches in the fields above. The existing overview is therefore sufficient for this route; the full summary endpoint remains unchanged for other consumers.

## Changes

- Removed Follow-ups from the `navigateTo` gate that forces a complete transaction summary history. Complaints and other consumers retain their existing gate.
- Extracted complete invoice page, invoice modal, order timeline, and Follow-ups table renderers into two generated route assets. Classic-script global function bridges preserve existing inline handlers, socket callbacks, and direct source fixtures. Invoice details still hydrate from the existing full transaction endpoint.
- Deferred the 1.31 MB Vault startup read on the default Dashboard when admin briefing is disabled. Vault still fetches on its page; an opted-in admin briefing still loads it at startup. The reopen action starts the deferred read before showing briefing data.
- Shared the Follow-ups read with the reminder module and kept socket-change refresh behavior.
- Registered the new generated assets in the development server. Production Docker copies the generated runtime directory, and nginx serves JavaScript files from it.

## Before and after

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Decoded `app-core.js` | 5,056,218 B | 4,884,286 B | −171,932 B (−3.4%) |
| Initial decoded scripts, fixture | 6,320,420 B | 6,150,462 B | −169,958 B (−2.7%) |
| Initial JavaScript execution, median | 131 ms | 109 ms | −22 ms |
| DOMContentLoaded, median | 683 ms | 504 ms | −179 ms |
| First Contentful Paint, median | 204 ms | 176 ms | −28 ms |
| Largest Contentful Paint, median | 1,084 ms | 820 ms | −264 ms |
| Dashboard interactive, median | 1,052 ms | 952 ms | −100 ms |
| Total Blocking Time, median | 114 ms | 89 ms | −25 ms |
| Startup API count, controlled fixture | 23 | 22 | −1 |
| Same live 23-endpoint audit set | 4,018,959 B / 391 ms sequential | 2,711,416 B / 250 ms sequential | −1,307,543 B / −141 ms sequential |
| Follow-ups requests on navigation, controlled fixture | 8 | 2 | −6 |
| Follow-ups data ready, median fixture | 112 ms | 94 ms | −18 ms |
| Follow-ups transaction summary transfer | 3,315,737 B | 0 B | −3,315,737 B |

The populated live browser's default Dashboard read 2,789,056 API bytes across 25 GETs in a 900 ms observation window after the change. This wider window includes optional security audit, announcements, and shipping reads that are outside the 23-request audit window. Its Follow-ups view displayed 538 records (40 rows on the current page) in 308 ms; opening a linked invoice loaded the generated invoice asset and hydrated the complete transaction record in 572 ms. A separate opted-in briefing run fetched `/vault` exactly once and populated its ledger. Enabling briefing after Dashboard startup also fetched `/vault` exactly once before opening it.

## Verification and remaining work

Generated core and route scripts passed `node --check`; the development server returned each generated asset with JavaScript content type and HTTP 200. Five populated browser runs had no console or asset errors. Live read-only verification displayed Follow-ups and opened a linked full invoice. Navigation/permission, direct route, invoice timeline, Follow-ups reminder, and notification settings browser checks passed. No financial writes were made or required for this phase.

Remaining core weight is mainly shared translations plus intertwined legacy UI functions. `/api/followups` (1.15 MB) and `/api/transactions/startup-overview` (998 KB) remain the largest startup reads because Dashboard currently uses their status and reminder data. A future pass could design dedicated Dashboard projections, but that requires a field-level audit of every badge, reminder, and update path to avoid stale operational status. The modest 18 ms Follow-ups timing gain in the zero-latency fixture should be interpreted alongside the measured 3.32 MB real-data transfer eliminated; it does not predict a specific network-speed improvement.
