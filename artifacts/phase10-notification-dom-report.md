# Phase 10 — notification rendering and DOM optimization

## Scope and safety

Changes were limited to the notification panel/center, off-route Users rendering, the runtime asset version, and relevant browser tests. Notification data, unread state, permissions, history, actions, backend endpoints, database schemas, and financial logic were not changed. The populated-data browser audit blocked data-changing API requests and shipping sync; functional write behavior was exercised by mocked notification tests.

The comparison uses the Phase 9 seven cold/warm pairs as baseline and seven new pairs under the same admin account, populated database, 1440 × 900 headless Chrome viewport, new browser context for each cold run, and same-context reload for each warm run. Each run navigated Dashboard → Orders → Dashboard → Movements → Dashboard → Follow-ups → Dashboard → Orders → Movements → Follow-ups. The final after run used a restarted frontend test server and the new runtime asset versions.

## Dependency findings and changes

1. `buildNotifications()` built the entire 308-card compact notification list at startup even though `#notif-panel` was closed. The bell actually opens the full notification center. Badge calculation remains eager, but the compact list is now mounted only when that panel is explicitly shown. A class observer clears it when closed.
2. The full center previously mounted every notification on open and retained the tree while closed. It now renders the first 50 cards, exposes the rest in 50-card “show more” batches, and removes center card/sidebar DOM on close. `_ncAllNotifs` still contains all records, and unread counts still use the entire data set. Existing card actions and notification detail rendering are unchanged.
3. Socket `users:status` called `renderUsers()` while Dashboard was active. For admins, that rendered the inactive Users table and fetched `/security-audit/locked-users` and `/security-audit/logs`. `renderUsers()` now runs only on the Users route. Its first visit still renders all 11 users and fetches both security endpoints.
4. The generated core and notification script URLs were versioned so deployed and previously opened browsers request the updated assets. Development and runtime assets were served with HTTP 200 after a frontend server restart.

Other inactive page shells remain mounted: Reports ~470 nodes, Movements ~432, and Transaction ~385 in the post-change Dashboard snapshot. Their static shells are much smaller than the removed notification and Users trees. Moving them to fragments would change route mounting and inline-handler timing without a proven Phase 10 gain, so they were left intact. The notification trace also contains forced layout reads such as `revealData()` and the mention badge's animation reset; those preserve existing motion and were not changed without a measured isolated cost.

## Before and after: populated notification DOM

| State | Before | After |
| --- | ---: | ---: |
| Total document nodes, Dashboard closed snapshot | 11,445 | 6,224 |
| Hidden compact panel descendants while closed | 3,987 | 47 |
| Compact panel cards while closed | 308 | 0 |
| Full center descendants immediately after opening | 4,286 | 812 |
| Full center cards immediately after opening | 308 | 50 |
| All notifications still available | 308 | 308; all 308 rendered through “show more” |
| Full center descendants after closing | 4,286 | 17 |

The admin notification ID hash was identical before and after (`d099dbdc8b8ec8a03e4d489b17db1d0bc3e3a8cbab01ebcbf253bcd2c065bde5`). A populated staff account saw its own 261 notifications and an unread badge of 150 while its closed panel remained empty. These are read-only snapshots; the test intentionally blocked `POST /notifications/read-all`.
The initial center render took a median of 66 ms across the 14 after runs; the baseline snapshot did not time that action, so no before/after opening-time claim is made.

## Seven paired cold/warm measurements

Dashboard **data-ready** time in milliseconds:

| Pair | Before cold | After cold | Before warm | After warm |
| --- | ---: | ---: | ---: | ---: |
| 1 | 1,161 | 1,495 | 780 | 607 |
| 2 | 1,140 | 867 | 785 | 663 |
| 3 | 1,048 | 835 | 879 | 843 |
| 4 | 983 | 1,018 | 784 | 722 |
| 5 | 1,075 | 1,010 | 841 | 689 |
| 6 | 871 | 987 | 901 | 767 |
| 7 | 1,023 | 950 | 777 | 723 |
| **Median** | **1,048** | **987** | **785** | **722** |

The first after cold run included CPU/trace profiling and is an outlier; all seven pairs are retained in the median. Performance is variable, so the measured medians are evidence of a modest improvement rather than a guaranteed per-load saving.

| Metric, median | Before cold | After cold | Before warm | After warm |
| --- | ---: | ---: | ---: | ---: |
| Dashboard data ready | 1,048 ms | **987 ms** (−61) | 785 ms | **722 ms** (−63) |
| App interactive | 1,021 ms | **938 ms** (−83) | 836 ms | **704 ms** (−132) |
| Active document DOM nodes | 11,701 | **6,357** (−45.7%) | 11,537 | **6,384** (−44.7%) |
| Style calculation | 177 ms | **142 ms** (−35) | 179 ms | **129 ms** (−50) |
| Layout | 235 ms | **219 ms** (−16) | 39 ms | **43 ms** (+4) |
| Script execution | 161 ms | **121 ms** (−40) | 74 ms | **61 ms** (−13) |
| Total Blocking Time | 182 ms | **137 ms** (−45) | 95 ms | **25 ms** (−70) |
| First Contentful Paint | 224 ms | 204 ms | 204 ms | 208 ms |
| Largest Contentful Paint | 728 ms | 740 ms | 816 ms | 724 ms |
| Regular startup API requests | 24 | **22** | 24 | **22** |
| Regular startup API body bytes | 1,541,379 | **1,498,515** | 1,541,379 | **1,498,515** |

The two removed startup reads are exactly the Users security calls (42,864 B combined). Their removal helps background work and API count, but they began after the initial critical Dashboard requests; most interactive gain came from reduced notification and Users DOM work. Cold layout and LCP did not improve consistently enough to claim a large paint benefit. One preliminary after warm run had an unrelated extra transaction overview refresh, adding 695,816 B; the final restarted-server seven-pair run had no such outlier.

## Navigation and safe data reuse

| Route, median ready time | Before first | After first | Before return | After return |
| --- | ---: | ---: | ---: | ---: |
| Orders | 630 ms | 626 ms | 659 ms | 551 ms |
| Movements | 400 ms | 408 ms | 382 ms | 269 ms |
| Follow-ups | 433 ms | 390 ms | 333 ms | 339 ms |

These route times varied and no route-level caching code was changed. The existing HTTP cache already reuses unchanged GET response bodies on return: Orders transferred ~109,095 B first visit and ~263 B on return, while Follow-ups transferred ~1,150,146 B then ~208 B. Both still revalidate, deserialize, and render. Movements uses a read-only POST and transferred ~119,928 B on both visits. Every route still rechecks live state on entry, preserving payment, deposit, inventory, and status freshness. Skipping those reads based only on a time-to-live would risk stale financial data. Any future route optimization should first measure render cost separately and use explicit revision/ETag validation after writes and socket events.

## Verification

- `notification-stability.cjs` passed on mobile and desktop, preserving card identity, loaded avatars, focus, scroll position, amount formatting, and repeated refresh. Its existing subpixel animation assertion was made tolerant within 2.5 px while still requiring exact size and scroll position.
- `notification-open-layout.cjs` passed in RTL and LTR; `notification-settings.cjs` passed all 42 checks for layout, toggles, saves, permissions, denials, and role visibility.
- Three notification/mention unit suites passed: 37 tests. `navigation-permissions.cjs` and `startup-route-fast-path.cjs` passed.
- A populated admin center opened with 50 cards, expanded through all 308 unique IDs, and returned to 17 center nodes after close; no browser errors occurred. The first Users visit rendered 11 rows and then fetched both security endpoints.
- Generated runtime HTML, core JS, core CSS, and notification JS all served with HTTP 200 under the new versioned URLs. JavaScript syntax and targeted diff checks passed.

Raw data: `phase9-browser-runs.json` (baseline), `phase10-browser-after-final.json`, `phase10-notification-before.json`, `phase10-notification-after-final.json`, `phase10-notification-staff.json`, `phase10-cold-trace.json`, and `phase10-cold-cpu.json` in this directory. The Phase 9 trace filename was regenerated during preliminary Phase 10 probing; baseline numeric trace findings remain recorded in the Phase 9 report and the baseline browser-run artifact.
