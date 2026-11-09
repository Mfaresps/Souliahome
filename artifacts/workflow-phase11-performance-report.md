# Phase 11: high-frequency workflow performance report

Date: 2026-11-09. Tested against the populated local database and Chromium at 1440×900. The benchmark blocked API writes, including carrier sync, so no live financial transaction or order was created. Transfer commit tests used an isolated MongoDB database. Each before/after browser comparison contains seven fresh-context runs; figures below are medians, not best runs. Raw runs: [before](workflow-all-before.json), [invoice change](workflow-priority1-after.json), [transfer refresh change](workflow-priority2-after.json), [final runtime before list batching](workflow-phase11-final-runtime.json), and [Orders render before](workflow-orders-render-profile.json) / [after](workflow-orders-render-after.json). Browser results include background requests that happened inside a measurement window; endpoint lists in the raw files separate them.

## Audit and priority ranking

| Rank | Measured bottleneck | Source and cause | Decision |
| --- | --- | --- | --- |
| 1 | Opening a Shopify invoice fetched ~1.15 MB of all Follow-ups and delayed the drawer until detail hydration. First visible content: 99.8 ms. | `frontend/public/index.html`: `_spPeekLoadFu`, `openSpOrderPeek`; `backend/src/followups/followups.service.ts`: `findAll`. | Open a safe identity/loading drawer immediately; fetch only this order's Follow-ups; keep full detail on demand. |
| 1 | Orders list re-render spent ~252 ms on 30 visible rows. About 161 ms in one trace came from per-note layout reads interleaved with style writes. | `frontend/public/index.html`: `_syncSpNoteClamps` called by `applyShopifyColsVisibility` inside `renderShopifyOrders`. | Read all note dimensions first, then write button visibility, preserving the clipping test. |
| 2 | After a successful Shopify transfer, the frontend fetched six transaction summary pages and re-rendered Movements even while Orders was open. Refresh: 773.7 ms, seven API reads, 3.43 MB. | `frontend/public/index.html`: `_confirmApproveShopify`, `loadTransactionSummaries`, `renderMovements`. The financial commit path was not the dominant measured cost. | Read the committed transaction by ID and revalidate the Orders page. Keep the backend approval transaction unchanged. |
| 3 | Pickup navigation fetched all 981 sales with 4.84 MB of history, plus six transaction summary pages because `pickup-orders` was in `_transactionDependentPages`. Under the comparable intermediate build, opening took 754.1 ms and eight API requests. | `frontend/public/index.html`: `navigateTo`, `loadPickupOrders`; `backend/src/transactions/transactions.service.ts`: `findPickupOrders`. | Use a projected board feed and remove the unneeded full-history navigation dependency. |

## Priority 1: Shopify Orders and invoice window

| Measure | Before | After |
| --- | ---: | ---: |
| First invoice content visible | 99.8 ms | 22.7 ms |
| Full invoice drawer ready | 181.6 ms | 146.5 ms |
| First invoice API payload during measurement | 1,162,100 B | 15,363 B |
| First invoice required API reads | 2 | 2 |
| Switching to another invoice, ready | 144.8 ms | 107.5 ms |
| Reopening the first invoice, ready | 130.3 ms | 121.8 ms |
| Initial Orders list ready, paired render profile | 541.0 ms | 490.8 ms |
| Orders list re-render, same populated page | 252.2 ms | 92.9 ms |
| Orders list response | ~109 KB | ~109 KB |
| Orders summary API browser response duration, paired profile | 148.2 ms | 179.2 ms |

The first drawer now opens with order identity from the list while `/shopify/orders/detail/:id` loads. Full invoice information, actions, receipt rules, and printing still use the complete order detail. The detail response was ~12 KB and usually took 7–18 ms in the final run. The scoped `/followups/shopify-order` response for the measured order was 189 B; the previous full response was ~1.15 MB. An in-flight request and short-lived scoped Follow-ups cache avoid repeat reads when switching or reopening. Existing full Follow-ups routes remain unchanged. The full-order cache continues to invalidate on live updates and Orders revalidation, avoiding stale status or payment data.

The Orders list render profile traced the delay to `_syncSpNoteClamps`: alternating `scrollHeight`/`clientHeight` reads with `style.display` writes forced repeated layout. Batching reads before writes reduced the seven-run median re-render from 252.2 to 92.9 ms. The paired initial Orders navigation improved from 541.0 to 490.8 ms despite a slower summary API median in the after runs. A real-data visibility check found zero mismatches among 21 notes with expansion buttons. The list query, filters, and business rules were unchanged. The remaining Orders navigation time includes the summary API (~179 ms) and route initialization.

Invoice images are fetched independently of drawer readiness. One populated receipt image loaded (~50 KB, ~350–370 ms from the remote image path) without blocking the invoice. A different receipt image returned HTTP 404 in every final run. The missing remote image prevents a complete validation of that receipt's image and print appearance; it is not caused by the new scoped Follow-ups or drawer loading path. No image or receipt record was changed.

## Priority 2: Shopify → Transactions transfer

| Measure | Before | After |
| --- | ---: | ---: |
| Post-commit frontend refresh, real populated data replay | 773.7 ms | 173.2 ms |
| Post-commit API reads | 7 | 2 |
| Post-commit API response payload | 3,426,371 B | 112,732 B |
| Isolated backend approval service, seven runs | 8.4 ms median | Unchanged financial code |
| Isolated backend Mongo query count | 3 median | Unchanged financial code |

The browser replay called the same post-success refresh function using an existing transaction ID; it intentionally did not send an approval PATCH or write to the live database. The new two reads are the committed transaction detail and the current Orders summary page. The transaction detail request took roughly 7–13 ms, and Orders revalidation roughly 132–184 ms. The frontend still waits for the backend approval response before displaying success. A post-commit refresh failure is now reported as a refresh problem, rather than a failed transfer that might encourage a second attempt.

`backend/src/shopify/shopify.service.ts:approveOrder` and its financial writes, duplicate claim, vault, inventory, and follow-up logic were not changed. The isolated fixture benchmark exercised seven approvals against a disposable database (service timing 5.6–69.1 ms, median 8.4 ms; 3–6 Mongo queries). This fixture stubs external inventory/vault/follow-up collaborators, so it is not a production click-to-commit latency measurement. The existing isolated integration suite passed concurrent confirmations, failed transaction creation/retry, cancelled orders, and approval waiting (4 tests). No live transfer was attempted.

## Priority 3: Pickup / Preparations

The comparison below uses the seven-run build immediately before the Pickup change and seven final-runtime runs, with the same populated data and browser conditions.

| Measure | Before | After |
| --- | ---: | ---: |
| Pickup ready after navigation | 754.1 ms | 347.0 ms |
| API requests inside navigation window | 8 | 1 |
| API payload inside navigation window | 9,156,659 B | 2,981,208 B |
| Pickup feed alone | 4,837,701 B | 2,981,208 B |
| Pickup feed browser response duration | 214.6 ms | 164.5 ms |
| Mongo read duration, seven paired reads | 102.6 ms | 70.4 ms |
| JSON serialization duration, seven paired reads | 34.7 ms | 24.7 ms |
| Board nodes | 1,618 | 1,618 |
| Search repaint | 23.8 ms | 33.8 ms |
| Immediate revisit | 84.8 ms, zero reads | 76.6 ms, zero reads |

The new `/transactions/pickup-orders/workspace` endpoint keeps the existing sale filter, sort order, permission guard, items, shipping fields, status fields, and financial totals. It excludes only large histories and nested data that the board does not read. The old `/transactions/pickup-orders` response remains available to existing consumers; full transaction detail remains available by ID. A read-only parity check compared all 981 rows and every retained field for equality. Pickup's ready-to-ship Bosta badge now reads the same field from the workspace row when the global transaction history has not been loaded. No schema or financial calculation changed.

The grouped board requires all rows to construct its preparation groups and counts, so server-side pagination of this feed would change the board's current behavior. Search repaint is ~34 ms and immediate revisit uses no API requests; further pagination or filtering is not supported by the measured bottleneck. If the dataset grows substantially, a server-side group/count API and paged group details would be the safe next design.

## Verification and limits

- `node frontend/scripts/build-runtime.cjs` and backend `npm run build` passed. A restarted local frontend on port 8080 served the versioned core and Orders route assets with HTTP 200. Production Dockerfile runs the same runtime build script.
- `startup-route-fast-path.cjs`, `pickup-permissions.cjs`, and `shopify-filter-accuracy.cjs` passed. The new workspace route uses the same `pickup-orders` permission decorator as the legacy route. A populated non-admin denied-permission account was unavailable for a live 403 probe; the browser permission fixture exercised hidden/read-only states.
- `pickup-workspace-parity.cjs` passed for 981 real rows; `pickup-query-profile.cjs` contains seven paired read-only Mongo measurements. The old and new endpoint responses were 4,837,701 B and 2,981,208 B.
- `shopify-transfer-workflow.spec.ts` passed seven isolated approvals. `shopify-deposit-receipts.service.spec.ts` passed the four selected concurrency/failure cases. No live order or financial record was modified by these tests.
- The browser benchmark recorded no JavaScript exceptions in the final seven runs. One remote receipt image returned 404, as described above. Its storage state was left untouched. The full invoice and print action were present after hydration; switching displayed the requested order ID.
- Backend approval timings from the isolated fixture and browser post-commit refresh times measure different stages. A real production click-to-commit number would require a safe staging environment with the external financial collaborators active.

The remaining largest measured user-facing delay in these workflows is initial Orders navigation (~491 ms). The invoice drawer is visible in ~23 ms, transfer refresh takes ~173 ms after commit, and Pickup opens in ~347 ms. The Orders summary endpoint and the ~40–55 ms table-width layout check are now the main measured opportunities in this workflow; they should be profiled further before another change.
