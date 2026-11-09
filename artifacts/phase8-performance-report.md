# Phase 8: Dashboard data loading and payload audit

## Scope and test conditions

Read-only tests used the populated local database (1,053 transactions, 538 Follow-ups), the same admin account, a 1440 × 900 headless browser, disabled browser cache, and the Dashboard route. The browser harness blocked every non-GET API request and the shipping sync GET. The old and new endpoints were also compared in interleaved runs against the same application and database. No database records or financial rules were changed.

## Dependency audit

| Response | Dashboard needs | Fields reserved for the full page or record | Cause of excess payload |
| --- | --- | --- | --- |
| Follow-ups | Ticket/order and transaction links, assignee, status, reason, cancellation/outcome, creation and defer dates for badges, notifications, and reminders | Complete comment threads, call history, customer phone, escalation and resolution metadata, update history | `comments` alone contributed 692,952 bytes of 1,149,876 bytes (60.3%); the full list was loaded at startup. |
| Transactions overview | Existing operational rows and active count, status, deposit/payment indicators, shipping state, limited carrier settlement status and amounts | Carrier settlement audit details and fee breakdown; full order detail remains available through the existing detail route | `carrierSettlement` contributed 366,502 bytes of 999,957 bytes (36.7%). |

The Dashboard Follow-up trail previously fetched all 538 full records when opening one record. The Follow-ups page, exports, Shopify order views, and invoice views continue to use full records when their features need them. The transaction overview retains its existing row filter and active count query, so all status and payment checks see the same transactions. Existing date filters are unchanged.

## Implemented

- Added `GET /followups/dashboard-summary` with an explicit Dashboard projection. `GET /followups` still returns the complete list.
- Added `GET /followups/:id` for a single complete record. Opening a Dashboard trail now requests that record and merges it into the in-memory list. The frontend falls back to the old full-list read on a 404 during a rolling deployment.
- Added `GET /transactions/dashboard-overview`, keeping the existing row criteria, visibility rule, active count, and role masking, while projecting only the carrier settlement fields required by Dashboard consumers. `GET /transactions/startup-overview` remains unchanged.
- Switched Dashboard boot, refresh, socket updates, and inactive-page reminders to the lightweight responses. Routes requiring full Follow-up data still load the full endpoint. In-flight Follow-up reads are coalesced, and the Shopify full-record cache is invalidated when a summary is loaded.
- New routes use the same JWT and managed-role permission rules as their existing counterparts.

## Before and after

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Follow-ups startup response, 538 rows | 1,149,876 B | 239,221 B | −910,655 B (−79.2%) |
| Transactions overview, 1,007 rows; active count 1,027 for admin | 999,957 B | 695,816 B | −304,141 B (−30.4%) |
| Combined targeted responses | 2,149,833 B | 935,037 B | −1,214,796 B (−56.5%) |
| Total Dashboard startup API body bytes, representative paired runs | 2,756,177 B | 1,541,379–1,541,381 B | −44.1% |
| Startup API requests | 24–25 | 24–25 | No material change |
| Follow-up trail opened from Dashboard | Full 1,149,876 B list | One 3,716 B detail | −99.7% for the tested record |

The full legacy endpoints still returned the same 1,149,876 B and 999,957 B after implementation. The Dashboard receives every Follow-up row and every overview transaction row; this phase reduces fields, not record counts.

## Timing and remaining bottleneck

Direct API samples: Follow-ups 71 ms before, 42 ms after; transactions overview 82 ms before, 47 ms after. MongoDB `explain` reported 2 ms before and 1 ms after for Follow-ups (538 documents examined), and 4 ms before and 7 ms after for transactions (about 1,057 documents examined). These small query times vary between runs and do not establish a database speedup. The transaction endpoint still performs its original row query plus active-count query; Follow-ups still scans 538 records. The improvement is response size and transfer/JSON work.

Three interleaved old/new browser pairs measured Dashboard interactive time at **1,220 / 1,419 / 1,643 ms** for old responses and **1,546 / 1,635 / 1,498 ms** for new responses (old/new medians: **1,419 / 1,546 ms**). Median script execution was 181 / 174 ms; median Total Blocking Time was 206 / 209 ms. There is **no demonstrated interactive-time improvement** in these runs. Network and main-thread scheduling varied enough to outweigh the smaller payload. A final full browser verification measured 1,541,381 startup API bytes, 25 requests, 1,957 ms interactive time, and 359 ms TBT. The remaining Dashboard startup workload includes roughly 1.54 MB of API bodies, 24–25 startup requests, and about 11,445 DOM nodes in that final run. Further work on these areas would be a separate phase.

## Accuracy, permissions, and regression verification

- Read-only endpoint parity compared every projected value with the corresponding legacy response, preserving row order and counts for admin and staff. Admin active count remained 1,027; staff active count remained 986.
- The Dashboard snapshot matched before/after: shipping KPIs `967 / 11 / 2`, 538 Follow-ups, 11 unseen Follow-ups, 1,007 transaction overview rows, active count 1,027, 308 notifications, and the same notification-content hash.
- The Follow-ups route loaded all 538 complete records, including comment threads, and rendered its first 40 rows. An invoice view loaded and hydrated successfully.
- A Dashboard trail opened with three comments using one 3,716 B detail request, with no full-list request, console error, failed asset request, or blocked write.
- Backend and frontend runtime builds passed. `followup-reminders.cjs`, `startup-route-fast-path.cjs`, and `navigation-permissions.cjs` passed. The unrelated `notification-stability.cjs` had an existing subpixel `scrollTop` assertion failure (approximately 1.3 px versus 0); it does not load the changed Phase 8 files.

Raw measurements: `phase8-payload-before.json`, `phase8-payload-after.json`, `phase8-old-endpoints-after.json`, `phase8-timing-{old,new}-{1..3}.json`, `phase8-browser-final.json`, `phase8-dashboard-trail.json`, and `phase8-endpoint-parity-final.json` in this directory.
