# Phase 9 — read-only performance investigation

## Conditions and limits

Fourteen runs formed **seven cold/warm pairs** on the same populated local database (1,053 non-archived transactions, 1,027 non-cancelled active transactions, 538 Follow-ups; 1,057 total transaction documents). Each pair used a new Chrome context for a cold Dashboard load, then reloaded the same context for a warm load. The browser was 1440 × 900, authenticated as an active admin, and navigated Dashboard → Orders → Dashboard → Movements → Dashboard → Follow-ups → Dashboard → Orders → Movements → Follow-ups. All write methods were blocked, except the existing read-only `POST /transactions/movements-page`. The shipping sync GET was blocked because it can update records. No application code was changed and the audit sent no data-changing test requests. Test code and measurement artifacts were added only under `backend/test/perf` and `artifacts`.

**Timing definitions:** “Browser wait” is Chrome's request-send-to-response-headers interval (TTFB); “browser headers” is request creation to response headers and includes browser queuing. “Backend loopback” is the median of seven direct authenticated calls to port 4000; it includes local HTTP and JSON serialization, so it is an upper bound on backend processing, not a pure handler timer. MongoDB `explain` measures database execution separately. The app emits no `Server-Timing` header, so exact handler CPU and connection-pool wait cannot be isolated without instrumenting backend code in a later approved phase.

## Seven paired scenarios

| Pair | Cold Dashboard data ready | Warm Dashboard data ready | Cold app interactive | Warm app interactive |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1,161 ms | 780 ms | 1,158 ms | 794 ms |
| 2 | 1,140 ms | 785 ms | 1,137 ms | 882 ms |
| 3 | 1,048 ms | 879 ms | 968 ms | 753 ms |
| 4 | 983 ms | 784 ms | 981 ms | 780 ms |
| 5 | 1,075 ms | 841 ms | 1,074 ms | 836 ms |
| 6 | 871 ms | 901 ms | 986 ms | 897 ms |
| 7 | 1,023 ms | 777 ms | 1,021 ms | 882 ms |
| **Median** | **1,048 ms** | **785 ms** | **1,021 ms** | **836 ms** |

Six of seven warm pairs were faster to data readiness; one was 30 ms slower. The median cold-to-warm data-ready difference is **263 ms**. Both modes fetched the same **1,541,379 B** of regular startup API bodies in the representative runs, so that difference cannot be attributed to API payload caching. Cold resources transferred about 2.28 MB of JS/CSS and decoded to 8.55 MB; a warm reload transferred about 44 KB of mostly revalidation headers. `app-core.js` alone was 4,887,238 B decoded / 1,297,724 B transferred on a cold load; `app-core.css` was 1,404,087 B decoded / 322,969 B transferred. The generated HTML is 496,445 B; the 7.66 MB source `index.html` is split into runtime assets.

Median navigation ready times across seven cold runs (the warm runs were similar):

| Route | First visit | Return visit | Request behavior |
| --- | ---: | ---: | --- |
| Orders | 630 ms | 659 ms | One summary-page GET on each visit, 14/14 runs. |
| Movements | 400 ms | 382 ms | One read-only movements-page POST on each visit, 14/14 runs. |
| Follow-ups | 433 ms | 333 ms | One full Follow-ups GET and one complaints GET on each visit, 14/14 runs. |
| Dashboard after Orders / Movements / Follow-ups | 230 / 241 / 268 ms | — | Duty-board GET on return; route DOM remains mounted. |

## Startup API waterfall

Twenty-four regular endpoints appeared in every paired run. Two optional background endpoints appeared intermittently. The app also **attempted eight sequential `GET /shipping/sync/:id` calls** during startup; the read-only harness intercepted them before the backend. They are excluded from response sizes and backend timings below. In normal operation, they may add real latency and database writes; this phase cannot measure that safely on the live database.

Medians below are from seven cold runs. `Start` is relative to the first API request, not navigation start. `Headers` includes browser queuing; `Wait` is Chrome TTFB. `Backend` is direct loopback RTT. `Block` describes the initial Dashboard shell, not whether a later widget uses the data. `Defer` is a candidate, subject to preserving the named feature.

| Endpoint | B | Start ms | Headers ms | Wait ms | Backend ms | Block / dependency | Defer or combine? |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `/api/branding` | 65 | 0 | 42 | 6 | 1.3 | Visual branding; starts first | Could retain cached branding while refreshing. |
| `/api/auth/me` | 533 | 245 | 25 | 6 | 1.8 | **Yes: identity and permissions** | No. |
| `/api/warehouses` | 118 | 266 | 14 | 5 | 2.5 | No; warehouse selectors | Defer until inventory/transaction form. |
| `/api/transactions/dashboard-overview` | 695,816 | 295 | 135 | 44 | 33.3 | **Yes: Dashboard transaction state** | Retain freshness; optimize rendering/consumer scope only after contract test. |
| `/api/settings` | 6,109 | 295 | 51 | 9 | 4.3 | **Yes: language/theme and rules** | No. |
| `/api/drafts` | 6,523 | 289 | 66 | 6 | 2.5 | Draft badge; not initial shell | Defer badge fill if allowed. |
| `/api/products` | 153,379 | 447 | 216 | 35 | 16.5 | Stock/product widgets; background | Defer beyond initial shell; keep stock display accurate. |
| `/api/expenses` | 16,714 | 448 | 215 | 19 | 4.5 | Financial widgets; background | Only after verifying KPI dependencies. |
| `/api/users` | 10,986 | 448 | 216 | 37 | 3.7 | Assignee labels and staff widgets | Full user list may be deferred; preserve permission checks. |
| `/api/tags` | 2,869 | 448 | 223 | 39 | 2.7 | No initial Dashboard dependency found | Defer to tagged features. |
| `/api/returns` | 60,880 | 448 | 234 | 46 | 7.1 | Dashboard alerts/notifications | Defer only after badge parity check. |
| `/api/complaints` | 21,009 | 448 | 247 | 56 | 4.5 | Dashboard status/notifications | Defer only after notification parity check. |
| `/api/purchase-orders` | 36,856 | 449 | 250 | 38 | 3.4 | Dashboard status/notifications | Candidate for compact counts. |
| `/api/supplier-returns` | 15,027 | 449 | 271 | 32 | 3.0 | Dashboard status/notifications | Candidate for compact counts. |
| `/api/transactions/inventory` | 47,047 | 449 | 354 | 101 | 31.7 | Stock/attention widget | Preserve live stock; do not cache financial/inventory values blindly. |
| `/api/notifications/read-state` | 52,116 | 471 | 271 | 52 | 9.7 | Notification badge accuracy | Badge state should stay fresh; panel DOM can wait. |
| `/api/notifications/history` | 32,843 | 533 | 217 | 51 | 5.1 | Notification history/badge | Consider count-only boot plus history on open. |
| `/api/mentions` | 96,457 | 534 | 233 | 53 | 11.4 | Mention badge/notifications | Count-only boot is a candidate. |
| `/api/auth/users-status` | 1,399 | 564 | 174 | 26 | 2.1 | Presence, not authentication | Defer until shell is painted. |
| `/api/transactions/sales-overview?...` | 2,145 | 588 | 182 | 57 | 21.7 | Sales chart | Widget can load after initial shell. |
| `/api/employee-performance/duty-board` | 403 | 589 | 176 | 26 | 3.6 | Staff duty widget | Already async; retain accuracy. |
| `/api/followups/dashboard-summary` | 239,221 | 589 | 193 | 34 | 10.6 | Follow-up badges/reminders | Already async; do not omit reminder fields. |
| `/api/security-audit/locked-users` | 1,736 | 1,109 | 51 | 11 | 4.1 | **No; Users security panel** | Defer to Users page. |
| `/api/security-audit/logs` | 41,128 | 1,110 | 51 | 10 | 3.3 | **No; Users security panel** | Defer to Users page. |
| `/api/announcements/mine` | 2 | ~1,769 | 13 | 7 | — | Optional announcement check | Already after shell. |
| `/api/notifications` | 694 | ~2,262 | 99 | 6 | 1.9 | Optional notification settings | Defer to settings feature. |

There were **no duplicate regular startup endpoints** in the seven pairs. `/api/users` is coalesced in `loadAllData`. The waterfall has a real prerequisite chain: `checkAuth` awaits `/auth/me`; `showApp` awaits settings and transaction overview; `loadAllData` then launches the other collections in parallel. Much of the 245–589 ms request-start offset occurred while scripts and the shell were loading; it is not evidence that the backend spent those milliseconds on earlier requests. The 216–354 ms browser request-to-header times for background calls exceed their 3–32 ms direct backend RTTs and 19–101 ms Chrome TTFB, indicating browser queuing/main-thread competition and concurrent request processing. Security audit requests are triggered by `renderUsers()` from the socket `users:status` handler even when Dashboard is active.

## Browser main thread, DOM, and memory

| Metric | Cold median | Warm median | Interpretation |
| --- | ---: | ---: | --- |
| DOMContentLoaded | 341 ms | 283 ms | Earlier than data readiness. |
| First Contentful Paint | 224 ms | 204 ms | Shell paints early. |
| Largest Contentful Paint | 728 ms | 816 ms | Warm LCP varied; no reliable LCP gain. |
| Script execution (`ScriptDuration`) | 161 ms | 74 ms | Cold script parse/compile/execute matters. |
| Style recalculation | 177 ms | 179 ms | Still substantial when assets are cached. |
| Layout | 235 ms | 39 ms | Largest cold/warm median difference. |
| Total Blocking Time | 182 ms | 95 ms | Multiple long tasks around startup. |
| JS heap at data ready | 13.8 MB | 19.7 MB | Warm run reused a context after navigating several routes. |
| Active-document DOM nodes | 11,701 | 11,537 | Large even with only Dashboard active. |

One cold Chrome trace measured **174 ms HTML parsing, 190 ms style tree updates, 253 ms layout, and 35 ms paint** on the renderer main thread. These events can nest; their totals must not be added as a wall-clock total. The same trace recorded 12 ms of `EventDispatch` and 63 ms of timer callbacks. Its largest app `FunctionCall` was notification-feed `repaint` at 54 ms. A CPU profile sampled about 201 ms in `souliaRenderNotificationContent` during startup, dominated by building a template and recursively reconciling notification nodes. A direct populated-data rerender measured `buildNotifications` 35.6 ms, `_renderStaffDashboard` 8.8 ms, `buildSidebar` 5.3 ms, and `renderUsers` 5.5 ms. These direct calls are diagnostic single invocations, not additive startup durations.

The active document contained about **11,444 nodes** in the component snapshot: `#header` had 4,081 descendants, of which the **hidden** `#notif-panel` had 3,987. The visible Dashboard page had 706. The inactive Users page already had 1,485 nodes. On the route sequence, DOM nodes grew from about 11.7k on Dashboard to 16.2k after Orders, 20.5k after Movements, and 26.0k after Follow-ups, then remained mounted on returns. Chrome's `Memory.getDOMCounters` counted additional nodes across old documents and browser internals; those numbers alone do not establish a leak.

## Backend and MongoDB

| Path / query | Direct API median | MongoDB explain | Source and finding |
| --- | ---: | --- | --- |
| Transactions Dashboard overview | 33.3 ms | 5 ms; 1,057 documents examined; 1,007 returned | `TransactionsService.findDashboardOverview`: row query plus active-count query; collection scan at this dataset size. |
| Inventory | 31.7 ms | Main transaction read 2 ms / 1,057 examined; product read 0 ms / 115 | `TransactionsService.getInventory`: multiple **batched but sequential** reads, then in-memory stock calculation. No per-product query loop was found. |
| Sales overview | 21.7 ms | Four aggregations launched concurrently | `TransactionsService.getSalesOverview`: Shopify, orphan sales, revenue, returns pipelines. The `$lookup`s merit isolated profiling only if this endpoint becomes critical. |
| Products | 16.5 ms | Product read 0 ms / 115 | `ProductsService.findAll`: payload and document hydration/serialization account for more than raw query time. |
| Mentions | 11.4 ms | 7 ms; 6,116 examined; 200 returned | `MentionsService.findForUser`: collection scan plus sort/limit. An index is a later candidate, but current absolute cost is small. |
| Follow-ups summary | 10.6 ms | 1 ms; 538 examined / returned | `FollowUpsService.findDashboardSummary`: payload/serialization dominates Mongo time. |
| Manual inventory adjustments | Within inventory | 1 ms; 1,522 examined; 27 returned | Two separate scans of the same adjustment collection occur in `getInventory`; neither is a current major cost. |

The inventory helper `legacyReceiptLocations` uses up to three batched queries, not one query per transaction. `getInventory` then reads transfers and two adjustment views sequentially. This explains a portion of its ~32 ms API time, but it is not the startup critical path in the measured fast Dashboard boot. MongoDB reported 23 current connections, four active, zero rejected, and zero queued for establishment at the sample instant. The backend config sets no custom pool limit. This provides **no evidence of connection-pool saturation**; per-request pool wait remains unmeasured.

## Ranked bottlenecks and next-phase recommendations

1. **Initial DOM/style/layout and hidden notification panel.** Sources: `frontend/public/index.html` (`#notif-panel`, `buildNotifications`, `showApp`) and `frontend/public/notification-feed.js` (`souliaRenderNotificationContent`, `reconcile`). Measured: ~3,987 hidden notification nodes, ~177 ms style and ~235 ms layout cold medians, 35.6 ms for one notification rebuild, up to ~201 ms sampled in notification reconciliation during one cold trace. Root cause: full notification DOM is built and reconciled during startup despite the panel being closed; large CSS/DOM adds layout cost. Recommendation: profile a count-only badge plus on-open panel rendering and preserve unread state, focus, and live updates. **Target to verify:** at least one avoided 35 ms rebuild and a 50–150 ms reduction in cold style/layout; values are hypotheses, not guaranteed gains. Risk: unread counts, notification ordering, keyboard focus, and live updates.
2. **Cold runtime asset processing.** Sources: generated `frontend/runtime/app-core.js` (from `frontend/public/index.html`) and `app-core.css`. Measured: 4.89 MB decoded JS, 1.40 MB decoded CSS; cold script 161 ms versus warm 74 ms, and cold data readiness 263 ms slower at the median with unchanged API bytes. Root cause: asset transfer plus parse/compile and initial DOM construction. Recommendation: dependency-audit more route-specific code and CSS before extracting; consider immutable asset caching. **Target to verify:** 80–180 ms cold startup improvement. Risk: global functions, inline handlers, shared CSS, cache invalidation.
3. **Return navigation refetch and accumulated page DOM.** Sources: `loadShopifyOrders`, `renderMovementsServer`, `loadFollowUps`, and `onPageEnter` in `frontend/public/index.html`. Measured: Orders 630/659 ms first/return, Movements 400/382 ms, Follow-ups 433/333 ms; each endpoint was refetched on both visits in all 14 runs; nodes reached ~26k after the route sequence. Recommendation: measure route render versus response time, then use conditional GET/revision-aware reuse for safe data, with forced revalidation after payment/order changes. **Target to verify:** 100–250 ms on repeat Orders and 50–150 ms on repeat Follow-ups, subject to A/B. Risk: stale payment, deposit, stock, and Follow-up status; this must have explicit invalidation.
4. **Off-route work during startup.** Sources: `renderUsers`/`loadSecurityPanel` and socket `users:status` handler in `frontend/public/index.html`; `loadAllData` background factories. Measured: two security endpoints total ~43 KB and ~51 ms browser request-to-header each, plus a 1,485-node inactive Users page; other off-route requests include warehouses and tags. Recommendation: gate Users security rendering and reads on active route, then verify Dashboard badge parity before deferring any shared collections. **Target to verify:** two fewer requests and ~43 KB less startup API payload; likely little direct change to first interactive time because these requests start around 1.1 s. Risk: Users security panel showing stale data on first entry.
5. **Backend query cost.** Sources: `TransactionsService.findDashboardOverview`, `getInventory`, `getSalesOverview`, `MentionsService.findForUser`. Measured: top direct endpoint medians 22–33 ms, Mongo query execution 0–7 ms for examined reads. Recommendation: defer index and query redesign until a measured endpoint becomes a critical path. **Expected startup gain now:** likely below 10–30 ms from individual query changes. Risk: stock and financial correctness if calculations or query predicates change.

**Final recommendation:** the next optimization should focus first on **DOM rendering and browser main-thread work**, especially the hidden notification tree, followed by cold asset processing. For navigation, focus on route rendering and safe revalidation. Reducing raw API count or tuning MongoDB alone is unlikely to materially improve Dashboard interactive time under the measured conditions. Separately, measure the eight sequential Bosta sync attempts in an isolated environment before deciding whether they affect real startup; they were intentionally excluded here because the GET can write transaction state.

Raw evidence: `phase9-browser-runs.json`, `phase9-assets-runs.json`, `phase9-cold-trace.json`, `phase9-cold-cpu.json`, `phase9-direct-api.json`, `phase9-mongo-explain.json`, and `phase9-dom-components.json` in this directory. The read-only harness is `backend/test/perf/phase9-deep-readonly.cjs`.
