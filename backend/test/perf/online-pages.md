# Online page loading

The public baseline for `https://admin.soulia.store` is saved in
`artifacts/online-page-performance/live-baseline.json`. It measures the login
shell only, without an authenticated session. The first visit transferred
2.45 MB across 167 requests; the repeat visit still made 165 requests, mostly
conditional requests. DOMContentLoaded was 3.03 s and 0.80 s in that run.
These timings depend on the connection and do not measure order API latency.

The deployment must rebuild **both** backend and frontend. The frontend build
stamps content hashes onto script/style URLs; the matching nginx rule keeps
those versions cached. Existing hand-written version labels on the live site
show that its current frontend image predates that cache configuration.

## Production measurements

Set these values in the server's existing Compose `.env`:

```dotenv
PERFORMANCE_LOG_ENABLED=true
SLOW_REQUEST_MS=500
```

After the normal deployment, inspect:

```sh
docker compose logs -f --tail=100 backend
docker stats --no-stream soulia-backend soulia-frontend soulia-mongodb
```

`Performance` logs include requests taking at least 500 ms, their method,
route template, status, duration and active request count. Once a minute they
report request volume, CPU, RSS/heap memory, and event-loop p99/max delay.
Bodies, query strings, tokens and customer/order IDs are omitted.

Open Shopify Orders, Transactions and Pick-Up with the same account and filters,
then repeat with several staff tabs. Compare slow-request durations with the
server-load interval. High event-loop delay alongside CPU use indicates time
spent blocking Node; slow requests with low event-loop delay point towards
database, external-service or network waits. Docker statistics include MongoDB
and nginx, which the Node process measurements do not cover.

Disable `PERFORMANCE_LOG_ENABLED` and recreate the backend when measurements
are complete. No authenticated live-page timings were collected by this change.

## Regression checks

`backend/test/browser/startup-route-fast-path.cjs` deliberately leaves the
transaction overview unanswered while opening the three workspaces. Pick-Up
must request its workspace once and never download the transaction history;
Shopify must request one summary page. Presence heartbeats must not invalidate
those reads. `workspace-read-cache.spec.ts` verifies concurrent reads, purchase
visibility, private receipt drafts, and invalidation before/after business writes.

Only display reads are cached for 3–5 seconds. Stock checks used to approve a
sale continue to use the uncached transaction/session-aware inventory reads.
