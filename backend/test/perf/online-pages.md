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

Returning from Transactions or Pick-Up to Shopify Orders now restores the last
matching account/view immediately. An unchanged page fetched within 30 seconds
is reused; older data or a write/live event triggers one background refresh.
Filters, selected rows and table scroll remain in place, and failed background
refreshes keep the existing rows visible with an error notification. Manual
refresh continues to fetch current data. `shopify-route-return.cjs` verifies
this behavior on desktop and mobile, including responses completed while away.

Transactions follows the same 30-second navigation reuse policy, including
desktop tables, phone lists and grid cards. Cached views are separated by
account, purchase permissions, filters and page. Writes and live changes cause
background refreshes; manual refresh still fetches current data. Returning
restores the table/window scroll and selection. Browser Back keeps its own
historical scroll snapshot. `movements-route-return.cjs` checks these paths,
including page clamping, off-page completion and failed background reads.

Transactions uses shimmer as its only loading effect. Initial table reads show
placeholders matching the real columns; loaded rows, phone cards and grid cards
appear together without cascade, fade or count-up animation.

New Transaction retains its initialized form for the same account/permissions.
Returning from Transactions no longer reloads the entire transaction history
or rebuilds customer/item inputs. Products, suppliers and display stock refresh
in the background after 30 seconds or a write/live change, without changing
entered quantities or prices. Unsaved-work prompts remain active; explicit
discard/reset and create/return-prefill actions still clear/start a fresh form.
`transaction-route-return.cjs` covers these cases, draft notes/comments, scroll,
reference refresh failures and late responses from another account.

Pickup Orders also reuses a recent view for 30 seconds on navigation, preserving
the board/ready/runs view, filters, selection, scroll and unsaved item edits.
Stale data refreshes in the background; identical responses retain the existing
cards. Responses completed off-page are painted on return, and account changes
invalidate the cached data and edits. Initial loading uses shimmer cards/table
rows with no staggered arrival. `pickup-route-return.cjs` covers these behaviors.

Complaint records now open at `#complaints/view/<id>` as document pages, with
workflow stages and follow-up context in the header. Only individual actions,
execution requests and photo previews use dialogs. Saves reuse the returned
record; execution Back/close/Escape preserves the document scroll and request
draft. Direct complaint links can open their invoice without loading the full
transaction index. `complaint-page.cjs` (also run by `complaint-workflow.cjs`)
covers these paths, Arabic/English layouts at 320–1440px, reduced motion,
delayed responses, image drafts/retries, workflow saves and permissions.
The list puts compact, color-coded resolution badges before the workflow stage
and separates Cairo dates from times. Ticket numbers open their complaint;
adjacent copy buttons copy the complete number. `complaint-table.cjs` checks
compact row heights, unclipped ticket numbers, text contrast in both themes,
responsive layouts and independent table actions.
Row, ticket and Open actions share a short opacity transition into the complaint;
rapid clicks create one route entry. New visits start at the header, browser Back
keeps its scroll snapshot, and unchanged background reads preserve the rendered
document. Reduced motion bypasses the transition.
The final table column shows the owner's initial with the full name available
as its accessible label and tooltip. In a complaint, invoice and phone appear
beside the customer name; solution, due date and cycle precede the quieter owner
context. Resolution badges and execution links are shared with the list.
Issue timeline shows at most six main milestones for the current resolution
cycle, retaining registration and grouping repeated changes. Titles replace
generic descriptions. The complete audit loads on demand in ten-event pages;
notes stay expandable and no history is deleted. `complaint-timeline.cjs` checks
long histories, reopened cycles, pagination, escaped notes and responsive layouts.
New complaints require an issue category in the form, DTO and creation service;
editing older records keeps its existing optional-field contract. The smaller
create dialog uses inline validation after a save attempt and compact image
thumbnails with a local gallery preview. Draft files upload on submission;
retrying incomplete uploads reuses the existing complaint. `complaint-create.cjs`
covers these interactions and draft recovery across languages and phone sizes.
Affected products keep their name, full-frame thumbnail and quantity together
in compact cards. The solution picker uses the same six solution icons in its
options and selected value; the shared picker retains material icons unchanged.
Return and exchange creation uses a compact request row, product/quantity cards,
and a settlement column. Delivery dates are brief; unit codes and fee details
expand on demand. The submit action stays visible while long invoices scroll.
The shared menu opens in the dialog's top layer, with icons, full option labels
and keyboard selection. Returning to the complaint preserves the execution draft.
`after-sales-create.cjs` checks both request types, fees and submitted values,
Arabic/English, phone layouts, dark mode, menus and long invoices.
Issue categories use official Lucide package, truck, headset and ellipsis SVGs
in the picker and complaint context. Placeholder values stay without icons;
selection updates keep a single decorative icon and the full text label.
After-sales request types keep their native select invisible when disabled,
preventing duplicate text and arrows behind the custom control.
Selected complaint products each require an issue type and their own description
(color, size, wrong product, missing, damage, quality or other). Quantity input
is bounded immediately to the invoice quantity; saves also validate the range.
Drafts and product edits retain each line's issue and unit IDs. The workspace
shows these details on individual product cards; general notes are optional.
The API validates nested item payloads and invoice limits, stores normalized
per-line issues, and derives the searchable description from actual invoice names.
Legacy complaints retain their existing description until explicitly edited.
`complaint-product-issues.cjs` covers independent validation, drafts and cards in
Arabic/English, phone sizes and dark mode; integration tests cover persisted
issues, malformed API payloads, transaction rollback and legacy records.
Solution menus wrap labels without horizontal scrolling. Follow-up actions use
the shared single-date calendar and a separate time field; saved timestamps
remain in Cairo time regardless of the browser zone. The calendar uses the
modal's top layer and Escape closes it before the form. Recent notes show at
most three entries with follow-up dates and contact channel/result, while the
six-milestone timeline and complete paginated audit retain their compact layout.
Saving a solution opens its next execution form automatically: a linked return
or exchange request, resolution evidence, or customer payment. Each execution
still requires its own submission. Failed plans stay on their original form.
`complaint-solution-followup.cjs` covers all six solutions, menu sizing, calendar
interaction, visible notes, Cairo winter/summer conversion and failed saves.
Complaint actions prioritize a compact resolution plan, followed by products
and request linking. Once saved, its label and editing form read Change solution.
Contact, assignment, follow-up, notes and management remain smaller text actions
with icons and no individual boxes. Existing workflow and permission gates still
control which actions are available.
The plan, products and request-link controls size to their labels and wrap onto
the next line when needed; the plan uses a quiet tint instead of a large fill.
The shared select panel keeps overflow inside one vertical list. Its height
calculation includes borders, padding and the search field's rendered size;
long option text wraps, and menus stay within the viewport. Product-issue tests
cover the final option after scrolling and searchable menus outside a modal.
Each affected-product card in the complaint file labels its own Issue and
Description beneath the product name, photo and quantity. Missing legacy values
are marked as unrecorded; the case's general description is never copied to
individual products.
After-sales dialogs animate their full frame and backdrop on entry and exit,
including requests opened from a complaint and resumed drafts. Invoice loading
uses the request width; delayed content changes animate the frame dimensions.
Closing invalidates pending reads, and reopening cancels the pending exit so
neither a late response nor an old animation can dismiss/reopen the wrong view.
Reduced motion bypasses these transitions. `after-sales-motion.cjs` verifies
direct/linked return and exchange requests, resize, drafts and interruption cases.
Product saves verify that the server returned the same per-line issue and
description before clearing the draft or reporting completion. If an older
server drops these fields, the created case ID and intended product details
stay in the draft. Retrying updates that case through the items workflow rather
than creating a duplicate. Product edits use the same verification, including a
fresh detail read if the write response is incomplete. Deploy backend and
frontend together: older picker versions only send line index and quantity,
while older servers may discard the new issue fields.
