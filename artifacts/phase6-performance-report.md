# Phase 6 performance report

## Scope and method

I profiled the generated frontend served on `http://127.0.0.1:8081`. The paired baseline serves the same current source as one monolithic `app-core.js`; the optimized run serves the split assets. Both modes use the same deterministic, read-only browser fixtures: 891 Shopify orders, 1,053 transactions, 120 products, and 90 follow-ups. API writes never reach the backend, browser cache is disabled, and Socket.IO is stubbed to keep the runs isolated. Figures below are medians of five Chromium runs per mode. This is a populated fixture test, not a live database benchmark.

The paired baseline deliberately includes the new API deduplication and deferral code in both modes. It isolates the JavaScript split. The earlier audit trace showed a supplier request and two duty-board requests during Dashboard startup; the optimized populated run has no supplier read, one duty-board read, one users read, no mentionable-users read for admins, and one follow-ups read during startup. Overall paired API counts remain 23 because the two modes have identical data-flow code.

## Dependency findings

- The editable `index.html` application script contained a 595 KB Shopify Orders tail with 523 declarations. About 60 names from that tail are referenced earlier in the script. The split keeps the shared state bindings and deposit icon helper in core, and adds global function bridges for older inline handlers and callbacks.
- `shopify-kpis.js`, `deposit-history.js`, and `shopify-edit-approvals.js` are Orders and approval dependencies. They now load before the Orders route chunk on first use.
- `invoice-image.js` supplies an async export handler and can load on first document export. Excel and Chart.js were already on-demand.
- Follow-ups code shares globals with Dashboard badges, customer service, Shopify, and transaction navigation. Its data read is now deduplicated in flight, but its page code remains in core. Extracting that intertwined block without a more explicit module boundary would risk global handlers and operational status.

## Changes

- Generated a route chunk for Shopify Orders and served it from the development server and the production build output.
- Deferred the three Shopify companion scripts and invoice image code. The source HTML remains self-contained for existing browser fixtures; the generated runtime performs lazy loading.
- Prevented stale pending route navigation when a user changes pages while the route chunk loads.
- Shared in-flight Follow-ups reads across Dashboard, Shopify, and socket callbacks, and reused the Dashboard's fresh Follow-ups result in an order detail view.
- Deduplicated duty-board reads during Dashboard redraws, with a one-second recent-result window.
- Deferred suppliers until a supplier route opens. The route still waits for its required collection.
- Reused the full users response for admins and retained `/users/mentionable` as a fallback if that list is empty or the user lacks the users permission.

No backend schema, financial calculation, transaction operation, order rule, or database record was changed.

## Paired browser measurements

| Measure | Monolith | Split runtime | Change |
| --- | ---: | ---: | ---: |
| Startup JavaScript decoded bytes | 6,999,329 | 6,320,420 | -678,909 (-9.7%) |
| DOMContentLoaded | 839 ms | 683 ms | -156 ms |
| First Contentful Paint | 212 ms | 204 ms | -8 ms |
| Largest Contentful Paint | 1,052 ms | 1,084 ms | +32 ms |
| App interactive | 1,184 ms | 1,052 ms | -132 ms |
| Script execution | 145 ms | 131 ms | -14 ms |
| Total Blocking Time | 135 ms | 114 ms | -21 ms |
| Startup API requests | 23 | 23 | same paired data flow |
| DOM elements | 5,683 | 5,680 | essentially unchanged |

The current generated core is 5,054,685 bytes. The Orders chunk is 593,217 bytes and loads only when a dependent route opens. The generated HTML is 495,636 bytes. Median LCP is 32 ms slower in this sample, so the split does not establish an LCP improvement; the five runs varied substantially.

## Navigation with populated fixtures

| Route | Baseline data ready | Split data ready | Observation |
| --- | ---: | ---: | --- |
| Settings | 56 ms | 76 ms | Settings fragment and integrations load on first visit. |
| Shopify Orders | 160 ms | 196 ms | First visit downloads the route chunk and three companion scripts; one 30-row summary request serves a total of 891. |
| Movements | 66 ms | 109 ms | One 20-row movements page serves a total of 1,053. |
| Follow-ups | 72 ms | 112 ms | Still requests six transaction summary pages on entry. |
| Reports | 51 ms | 50 ms | No extra route asset after Orders was visited. |
| Invoice view | 34 ms | 35 ms | Route opens; image renderer loads on export. |

Opening the first Shopify order fetched `/shopify/orders/detail/o1` once and took 58 ms in one run. Invoice image export loaded `invoice-image.js` on demand and completed in 202 ms in that run. These are fixture timings, not backend latency. Navigation timings are sensitive to local browser load, so the 20–40 ms differences should be treated as indicative.

## Verification and remaining bottlenecks

- Direct route startup, lazy Settings, navigation permissions, notification settings, Shopify filtering, and invoice image browser checks passed. The populated profile completed five runs with no page errors or failed assets. The new Orders route asset returned HTTP 200 from both development ports after restarting the old frontend process.
- The production Dockerfile copies the generated runtime directory into nginx, including the new route chunk. Syntax checks passed for the builder, server, generated core, and route chunk.
- `app-core.js` remains about 5.05 MB. Reports, Follow-ups, and other shared code are still in core; safe extraction needs explicit interfaces for their global callbacks and inline handlers.
- Initial DOM remains about 5,680 elements. Existing Settings markup is lazy, but other inactive pages still contribute markup. This phase did not remove their DOM because startup script and API work were the measured targets here.
- Dashboard still makes 23 API requests in the populated fixture. Some feed global badges and notifications. Deferment requires smaller count endpoints or a shared boot snapshot to preserve accurate indicators.
- Follow-ups navigation still loads six transaction summary pages. That dependency is a separate route cost and should be redesigned around the exact transaction fields the page needs before removing it.
- Two narrow source-only browser tests (`shopify-kpis.cjs` and `deposit-history.cjs`) failed because their isolated fixtures lack the date-range global or expected mobile CSS behavior. They do not exercise the generated route split. The corresponding populated runtime route and other affected checks passed.

Raw run data: `phase6-populated-before.json` and `phase6-populated-after.json` in this directory.
