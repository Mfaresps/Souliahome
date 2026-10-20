# Implementation 06 — shared barcode scanning

## Scope and verified behavior

Implemented an online shared scanner in the existing plain JavaScript frontend and
NestJS/Mongoose backend. The barcode management page has an explicit **Open unit
scanner** button. It opens a reusable component; camera access requires a second,
explicit **Start camera** action. No order preparation, Ready, Bosta, purchase posting,
return posting or financial workflow is wired to scan callbacks in this delivery.

Successful scanning is identity/eligibility validation, **not physical custody,
allocation, receipt, dispatch, return, stocktaking approval or a financial entry**.
Existing lifecycle APIs must revalidate versions, permissions, evidence, order-line
capacity and state when a future workflow actually commits an action. Successful
scan results are historical snapshots and must not be treated as a lasting claim.

Prerequisite limitation: the existing Implementation 03 bulk legacy migration is
still incomplete. This change does not certify all prerequisites, enable enforcement,
backfill units, deploy or touch production data. Lost assigned units and reshipments
remain blocked under the previously approved policy.

## API contracts

All routes use the existing JWT authentication (active database user and current
permissions), PermsGuard and DTO validation. Actors are never accepted from request
bodies. Prefix below is `/inventory-units` (the frontend proxy adds `/api`).

### POST /scans/validate

Example request:

```json
{
  "identifier": "SU-507F1F77BCF86CD799439031",
  "intent": "reserve",
  "productId": "507f1f77bcf86cd799439011",
  "transactionId": "507f1f77bcf86cd799439021",
  "lineId": "the-existing-stable-sale-line-id",
  "sessionKey": "the-same-scan-session-uuid",
  "operationKey": "unique-request-uuid-retained-on-retry",
  "reason": "Operator requested online unit identity validation",
  "inputMethod": "keyboard"
}
```

`identifier` is an exact backend barcode or a 24-character internal Unit ID. Input
methods: `keyboard`, `camera`, `manual-entry`, `manual-selection`. Maximum 160
characters; controls are rejected. A shared SKU is never resolved as a unit.

| Intent | Required permission beyond inventory-units-view | Required context | Eligible state |
| --- | --- | --- | --- |
| lookup | none | optional expected product | any recorded state; identity only |
| inspect | inventory-units-condition | productId | unassigned inspection-required / returned |
| reserve | inventory-units-allocate | productId, transactionId, lineId | unassigned available; live exact sale line and remaining dispatch capacity |
| picking | inventory-units-allocate | productId, transactionId, lineId | reserved, assigned to that exact live sale line |
| prepare | inventory-units-allocate | productId, transactionId, lineId | picking, assigned to that exact live sale line |
| return | inventory-units-condition | productId, transactionId, lineId | shipped / delivered, exact existing assignment/source line |
| count | inventory-units-reconcile | productId | any recorded state; observation identification only |

These state predicates follow existing lifecycle actions. Inspection/reservation/
picking/preparation reject new PO-origin units with reversed, archived, missing or
quantity/identity-mismatched purchase sources. Return identification permits financial
cancellation on its existing sale, matching the existing physical return action; it
does not reverse that cancellation or confirm possession. Damaged/lost units can be
identified in lookup/count, but cannot become pickable through this scanner.

Business results use the existing POST default HTTP 201, with
`outcome: accepted | rejected`, `code`, `operationId`, `stockChanged:false`,
`lifecycleChanged:false`. Accepted results include `_id`, exact barcode, productId,
status and version under `unit`, plus `eligibilityOnly:true`. Known rejection codes:
`UNKNOWN_BARCODE`, `WRONG_PRODUCT`, `INVALID_UNIT_STATE`, `DUPLICATE_SCAN`,
`UNAVAILABLE_UNIT`. These rejected outcomes are persisted too: a retry cannot silently
change a rejected operation into an acceptance after circumstances change.

Malformed context/input is HTTP 400. Authentication/permission denial is 401/403.
Missing transaction/index readiness is 503. Reusing a request key with another
payload conflicts. The client preserves uncertain/5xx/conflicting outcomes and never
assumes an operation failed merely because its response was lost.

### GET /scans/operations/:operationKey

Requires `inventory-units-view`. Looks up the existing SHA-256 actor/key receipt,
restricted to `kind:scan-validation`. Returns `{state:"resolved",result}` or
`{state:"unresolved",operationKey,retrySameRequest:true}`. Absence is not proof of
failure: the original request could still be executing. Another actor cannot retrieve
the receipt with the same key. Original context permissions are checked on retries;
view permission permits reading one's own historical identity validation result.

### GET /scans/eligible

Requires view + new `inventory-units-manual-select`, plus the intent permission.
Query accepts the same intent/session/product/transaction/line context, optional
exact barcode/Unit ID `q`, and optional ObjectId `cursor`. The server filters state,
product, assignment, purchase/sale validity, dispatch capacity and already-scanned
units using the same validator. Results have at most 20 units and `nextCursor`.
At most 50 candidates are examined per page; an empty page may have a continuation.
This is an advisory list, not a lock or a custody assertion.

Manual selection submits the listed Unit ID through `/scans/validate` with
`inputMethod:"manual-selection"`, `manualSelectionConfirmed:true` and a nonblank
operator reason. The server independently revalidates all eligibility and permissions,
so a stale/forged selection cannot bypass them. It appends
`manual-selection-confirmed` instead of `scan-validated`. Ordinary manual text entry
remains a supported input transport; neither transport metadata nor a confirmation
checkbox proves physical possession.

## Persistence, duplicate handling and recovery

- Reuses `inventoryunitoperations` and append-only `inventoryunitevents`. Two additive
  event enum values: `scan-validated` and `manual-selection-confirmed`. No new tables,
  unit fields, accounting records, TTL expiry or historical rewrite.
- Uses existing snapshot/majority transaction wrapper and index/topology preflight.
  Product tracking revision locks serialize scan/lifecycle/label audit appenders.
  A success event and operation receipt commit atomically. Actor attribution comes
  from the existing database user inside the transaction. Rejections have operation
  receipts; no fictitious event is written for an unknown unit.
- Same actor/session/unit is accepted once, even under concurrent different keys or
  when switching between barcode and Unit ID. Identical actor/key/payload replays its
  original result. A new explicit scan session allows another identity observation;
  old audit records remain. No unit version/state is changed by scanning.
- Existing primary-key, barcode, product/state, assignment, origin, event unit/sequence
  and operation actor indexes suffice. No automatic index migration or repair runs.
  Duplicate SKU checks retain the existing trimmed, case-sensitive rule. Manual list
  requests reuse one catalog snapshot rather than reread it per candidate.
- Browser sessionStorage stores actor/workflow-scoped session and pending request
  **before** transmission, without an auth token. Network loss, timeout, malformed
  responses and 5xx leave the exact payload/key intact. Reload restores it; check/retry
  buttons reuse it. New scans and new sessions stay blocked until resolution.
- Component destruction leaves pending requests recoverable. A late response from a
  destroyed mount cannot clear a newer mount's pending request. Session storage
  failures block sending. No offline mutation/queue or automatic retry exists.
- Use one mounted component per actor/workflow key. Use a unique workflow key for each
  independent batch/order/count and keep its context stable while a request is pending.
  Changing that context with a pending request fails closed; reopen the original
  context to resolve it. Do not clear browser session storage to force another request.
  Closing the tab/clearing storage loses browser recovery metadata; server receipts
  and audit history remain, but support must review them before forcing a new action.

Backup/restore uses the existing full tracking backup procedures: keep units, events,
operations, products, users and companion financial/source collections together. Stop
writes, restore into a separate database and verify IDs/indexes/retry receipts before
cutover. No scan-specific destructive migration is needed. To roll back this UI,
remove its entry point and routes while retaining the two historical event values and
existing operation receipts; never delete legitimate audit records.

## Reusable frontend contract and devices

```javascript
const scanner = SouliaScanner.mount(container, {
  api, actorId: authenticatedUserId, workflowKey: 'pick:<saleId>:<lineId>',
  context: { intent: 'reserve', productId, transactionId, lineId },
  lang: 'ar', canManualSelect: hasPerm('inventory-units-manual-select')
});
// scanner.client.check()/retry() preserve a pending request.
// scanner.destroy() releases the camera/listeners and preserves recovery metadata.
```

Optional `onResult(code,result)` reports advisory feedback, not authority to commit a
workflow. `ScanClient` can be used without DOM; transport, storage and timeout are
injectable for testing. `normalize` strips only the selected terminal suffix, never
trims spaces, uppercases identifiers or strips interior controls.

| Input | Requirements and behavior |
| --- | --- |
| USB / Bluetooth | Keyboard-wedge mode with input focused; configurable Enter/CR/LF, Tab or no suffix. No suffix requires Validate. QR-capable hardware for current labels; no WebUSB/WebBluetooth pairing API required. Modifier/composition/repeat events do not submit. |
| Manual entry | Exact barcode or Unit ID; no frontend identity generation. Same backend checks. |
| Camera | HTTPS or localhost, camera permission, getUserMedia, canvas/video and a modern browser. Rear camera preferred. QR reader matches current label symbology. Permission denied, missing devices, decoder/network failure and unsupported browsers retain keyboard/manual fallback. |
| Recovery | Secure randomUUID, fetch/AbortController, sessionStorage and JavaScript. Pending request survives reload in the same tab and user/workflow scope. No offline mutations. |

Camera uses pinned [@zxing/browser 0.2.1](https://github.com/zxing-js/browser),
following its documented stream reader/control API. The exact local UMD and license
files are committed under `frontend/public/vendor`; no runtime CDN. It is loaded only
when starting the camera. One decoded frame stops the scanner before submitting.
Stop, component removal, page hiding and late permission grants release stream tracks.
Arabic/English text, live status, keyboard focus, non-color-only feedback and layouts
down to 320px are covered. Optional sound is not enabled.

Vendoring: `cd frontend; npm.cmd ci; npm.cmd run vendor:scanner` (run as separate shell
commands). The locked peer `@zxing/library@0.23.0` declares Node >=24; this checkout
uses Node 25.9.0. The static nginx image copies committed public assets and needs no
Node runtime. Verify local/CI Node compatibility before refreshing dependencies.

Actual Chromium was tested with simulated media streams, including real QR decoding.
Safari/iOS, Android device cameras, USB/Bluetooth scanners and actual printed labels
remain physical device acceptance tests. No device/browser certification is claimed.

## Exact files changed in this phase

New:

- backend/src/inventory-units/inventory-scan.dto.ts
- backend/src/inventory-units/inventory-scanning.service.ts
- backend/src/inventory-units/IMPLEMENTATION-06.md
- backend/test/integration/inventory-scanning.spec.ts
- backend/test/integration/inventory-scanning-ui.spec.ts
- frontend/public/inventory-scanner.js
- frontend/public/inventory-scanner.css
- frontend/scripts/vendor-scanner.cjs
- frontend/public/vendor/zxing-browser-0.2.1.min.js
- frontend/public/vendor/zxing-browser-LICENSE.txt
- frontend/public/vendor/zxing-library-LICENSE.txt
- frontend/public/vendor/ts-custom-error-LICENSE.txt
- frontend/public/vendor/zxing-text-encoding-LICENSE.txt

Modified:

- backend/src/inventory-units/inventory-unit.constants.ts
- backend/src/inventory-units/inventory-units.service.ts
- backend/src/inventory-units/inventory-units.controller.ts
- backend/src/inventory-units/inventory-units.module.ts
- backend/test/integration/inventory-unit-backend.spec.ts
- backend/test/integration/inventory-unit-ui.spec.ts
- frontend/package.json
- frontend/package-lock.json
- frontend/public/index.html
- frontend/public/inventory-units.js

Previous phase changes are retained uncommitted. No production configuration, data,
stock arithmetic or financial calculation was modified in this phase.

## Verification and commands

Final results: **366 distinct Jest tests in 14 suites passed** across targeted runs,
plus **15 offline diagnostic tests**. Overlapping reruns are counted once:

| Run | Suites | Passed tests |
| --- | --- | --- |
| Scanning + tracking/model/schema + purchase receiving | 5 | 111 |
| Scanning + transactions/purchases/vault + backup/restore | 8 | 238 |
| Final scanner backend (additional pagination case and return-source check) | 1 | 18 |
| Final Chromium scanner + existing barcode/receipt UI | 2 | 33 |

The first two runs share the same original 17 scanner tests. The final focused run
adds one case. Chromium covers 22 shared-engine cases and 11 barcode/receiving UI
cases. Native integration tests use an owned disposable Mongo replica set and verify
stock, unit versions, purchase/sale records, vault and supplier rows remain unchanged
after scans. They also verify duplicate concurrent keys, same-key restart recovery,
audit failure rollback, permissions, source reversal checks, manual eligibility,
pagination and persistent rejected outcomes. Browser cases cover actual generated
QR decoding through the real reader and a simulated stream, suffixes/repeats, input
errors, response loss, reload/retry/query, late responses, denied camera permission,
late camera grants, hidden-page cleanup, storage failure, Arabic and 320px layouts.

Application-source TypeScript, JavaScript syntax, all 3 inline scripts and whitespace
checks passed. The repository-wide TypeScript check still fails on the pre-existing
`shopify-config-http.spec.ts:64,91` model types and `shopify-edit-preview.spec.ts`
implicit-any errors. No new type errors were reported. Existing duplicate schema-index
warnings and intentional fault-injection logs remain.

Initial npm access and Chromium startup were blocked inside the sandbox; approved
escalated reruns succeeded. An initial browser fixture collided with the DOM's named
`window.scanner` property; that fixture was corrected, and final tests pass. No full
repository Jest run, production migration, deployment or physical scanner test ran.

From backend:

```powershell
node node_modules/jest/bin/jest.js test/integration/inventory-scanning.spec.ts test/integration/inventory-unit-backend.spec.ts test/integration/purchase-receiving.spec.ts test/unit/inventory-unit-schema.spec.ts test/integration/inventory-unit-model.mongo.spec.ts --runInBand --silent
node node_modules/jest/bin/jest.js test/integration/inventory-scanning.spec.ts test/integration/transactions.service.spec.ts test/unit/purchases.spec.ts test/unit/purchases-extended.spec.ts test/unit/vault-stock-sync.spec.ts test/integration/settings-backup-coverage.spec.ts test/integration/settings-backup-integrity.spec.ts test/integration/settings-selective-restore.spec.ts --runInBand --silent
node node_modules/jest/bin/jest.js test/integration/inventory-scanning-ui.spec.ts test/integration/inventory-unit-ui.spec.ts --runInBand --silent
node node_modules/jest/bin/jest.js test/integration/inventory-scanning.spec.ts --runInBand --silent
node node_modules/typescript/bin/tsc --project tsconfig.build.json --noEmit --incremental false
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

From root:

```powershell
node --test scripts/inventory-diagnostics.test.cjs
node --check frontend/public/inventory-scanner.js
node --check frontend/public/inventory-units.js
git diff --check
git status --short
```

Dependency commands executed from frontend:

```powershell
npm.cmd view @zxing/browser version dist.tarball dependencies --json --fetch-retries=0 --fetch-timeout=15000
npm.cmd install --save-exact @zxing/browser@0.2.1 --ignore-scripts --no-audit --no-fund --fetch-retries=0 --fetch-timeout=20000
node scripts/vendor-scanner.cjs
```

## Follow-up: barcode page redesign and local 404 repair (2026-10-17)

Confirmed the running development API returned 404 both directly on port 4000 and
through the frontend proxy on 8080. Source registration was correct, but the local
compiled `dist/app.module.js` lacked InventoryUnitsModule and its compiled controller
was absent. Rebuilt with `node node_modules/@nestjs/cli/bin/nest.js build`. After the
user explicitly confirmed this was development and approved restart (startup invokes
SeedService/settings initialization), restarted only the verified compiled Node backend
listening on 4000. Both live URLs now return 401 without authentication, rather than
404. The isolated authenticated route test verifies 200 and the actual QR config.
The frontend serves the updated JavaScript with HTTP 200. No production deployment,
tracking index migration, financial calculation change or inventory backfill ran.

Redesigned the page using existing Soulia colors, with a connection indicator,
scanner entry point, filtered-result/selection counts, search/status filters, distinct
unit rows, a label workspace, explicit preview and a separate collapsible SKU catalog.
Failures are distinct from zero units: missing API, permission and connection states
show a retry action and disable dependent controls. Requests from older renders cannot
overwrite a newer page. Scanner controls are excluded from label busy-state disabling
so the camera Stop button remains usable. Label dimensions and existing identities
remain unchanged; physical printing is never inferred from the print dialog.

Changed files for this follow-up:

- frontend/public/inventory-units.js
- frontend/public/inventory-units.css
- backend/test/integration/inventory-unit-ui.spec.ts
- backend/test/integration/inventory-unit-backend.spec.ts
- backend/src/inventory-units/IMPLEMENTATION-06.md

Final targeted verification: **106 tests passed in 5 suites** (39 Chromium UI/scanner
tests, 67 backend/scanning/receiving tests). Build, JavaScript syntax and whitespace
checks passed. The backend fixture now uses the real `/api` prefix and explicitly
checks config authentication. New UI cases cover missing API/retry, data failure vs
empty stock, selection counts/preview invalidation, old response races, SKU/barcode
search, status filters and layouts down to 320px. Generated review images with
representative fixture data are under `artifacts/barcode-ui/desktop.png`, `mobile.png`
and `service-unavailable.png`; they are not screenshots of real inventory.

```powershell
# From backend, in addition to the build command above:
node node_modules/jest/bin/jest.js test/integration/inventory-unit-ui.spec.ts test/integration/inventory-scanning-ui.spec.ts --runInBand --silent
node node_modules/jest/bin/jest.js test/integration/inventory-unit-backend.spec.ts test/integration/inventory-scanning.spec.ts test/integration/purchase-receiving.spec.ts --runInBand --silent
```

Open `http://localhost:8080/#barcodes`, sign in and hard-refresh to load the current
assets. Live authenticated customer-session testing and physical printer/scanner
acceptance are not claimed by the unauthenticated live checks or isolated tests.

## Saved scan recovery follow-up — 17 October 2026

The user confirmed that the unknown-outcome warning appeared immediately when
opening the scanner, before a new scan. The component previously displayed the
network/timeout message for any saved pending request without contacting the
server. This was a restored request, not evidence of a new network failure.
Read-only live checks confirmed both backend and frontend proxy were reachable;
no synthetic scan or purchase was submitted against application data.

Updated `frontend/public/inventory-scanner.js`:

- On reopening, show a localized saved-request/checking message and automatically
  query the original actor-scoped operation key using GET. Never automatically
  POST a scan, change session identity, create a unit or discard a pending request.
- A resolved receipt clears pending state normally. An unresolved server response
  explicitly says no confirmed result is available and offers checking again or
  an explicit retry of the exact saved request. It does not imply success/failure
  or describe a successful lookup as a network error.
- Disable conflicting controls while recovery is in flight, retain new-scan
  blocking until resolution, and ignore responses after the component is destroyed.
- A later authentication/validation denial cannot erase a request whose earlier
  result is unknown. First-attempt definitive denials still clear rejected input;
  uncertain requests survive denial and reload for later authoritative lookup.

Updated `backend/test/integration/inventory-scanning-ui.spec.ts` to verify automatic
read-only recovery, no POST on reopening, exact operation-key reuse, distinct
Arabic/English pending feedback, retained unknown outcomes after later 403/reload,
and successful eventual lookup. Chromium can transparently retry a disconnected
connection; the test checks that every attempt retains the identical payload/key,
rather than assuming a fixed transport-attempt count.

Validation: scanner Chromium suite **24 tests passed**; barcode-management and
manual-purchase Chromium suites **25 tests passed**; backend scanning suite
**18 tests passed** on an owned disposable replica. Total **67 tests in four
suites**. The initial new transport-count assertion failed because Chromium retried
a disconnected connection; it was corrected to verify payload identity and the
relative explicit retry count. The added Arabic recovery case initially waited
for English success text and timed out; its expected text was corrected to Arabic.
The scanner suite passed on final rerun. JavaScript
syntax and whitespace checks passed. Live port-8080 asset content matches the
updated file. No backend, schema, dependencies or financial behavior changed.

```powershell
# From backend:
node node_modules/jest/bin/jest.js test/integration/inventory-scanning.spec.ts --runInBand --silent
node node_modules/jest/bin/jest.js test/integration/inventory-scanning-ui.spec.ts test/integration/inventory-unit-ui.spec.ts test/integration/manual-purchase-ui.spec.ts --runInBand --silent
# Focused final Chromium rerun:
node node_modules/jest/bin/jest.js test/integration/inventory-scanning-ui.spec.ts --runInBand --silent
# From root:
node --check frontend/public/inventory-scanner.js
git diff --check
```

Hard-refresh the existing app and reopen the scanner. If the server still has no
confirmed receipt, use **Retry same request**. Do not clear session storage or
start a new operation to work around an unresolved result. Physical hardware
acceptance remains separate.

## Branded labels and additional sizes — 17 October 2026

The user selected **format the existing identifier only**, declining a new dated
sequential display identity. The label now prints SOULIA HOME, an inset solid frame,
and all 24 original Unit ID characters as six groups of four on two lines. SKU,
stored unit ID, encoded QR payload and historical rows are unchanged. No alias,
counter, schema/index migration, legacy update or new unit creation was introduced.

The supported stocks are 50x30, 60x40, 70x40, 80x40, 80x50, 100x50 and 100x70 mm.
Dimensions, QR size and padding come from a single backend `LABEL_SIZES` constant
shared by DTO validation/configuration and both label services. Initial HTTP testing
caught the old DTO accepting only two sizes; shared validation corrected that
compatibility issue. Unsupported sizes still fail. Long names/SKUs that do not fit
still block printing and require a larger size; content is not silently cropped.
Preview and print share the branded template, including a frame inset from the
page edge. QR quiet zones and exact backend values are preserved.

The additive label response field `receivedDate` is YYYY-MM-DD in Africa/Cairo,
derived only from a purchase unit's registered event with explicit
`physicalPossessionConfirmed: true`. No invoice date, ObjectId timestamp or legacy
registration date is substituted. Unknown dates return null and are omitted on
the label. Replays of older durable print receipts without this field still work.

Scanning behavior is unchanged: QR encodes `SU-` plus the original unit identifier,
not an HTTP URL. A phone's ordinary camera may show that text or offer text actions
depending on the device, but does not have a Soulia web address to navigate to.
Inside Soulia, the shared authenticated scanner validates the exact identity with
the backend and returns the unit/status or a specific rejection. Lookup does not
allocate, sell, receive, change stock or post money. No public product/unit landing
page or externally accessible inventory endpoint was introduced.

Changed files:

- `backend/src/inventory-units/inventory-unit.constants.ts`
- `backend/src/inventory-units/inventory-unit.dto.ts`
- `backend/src/inventory-units/inventory-units.service.ts`
- `frontend/public/inventory-units.js`
- `frontend/public/inventory-units.css`
- `backend/test/integration/inventory-unit-ui.spec.ts`
- `backend/test/integration/inventory-unit-backend.spec.ts`
- `backend/test/integration/purchase-receiving.spec.ts`
- `backend/src/inventory-units/IMPLEMENTATIONS-02-04.md`
- This report.

Verification: Nest build passed; **135 tests in five suites passed** (107 backend
tests across tracking, purchase receiving, scanning and schemas; 28 Chromium label
UI tests). All seven size previews decoded their exact original barcode through
the existing ZXing library from rendered QR images at a simulated 203 DPI. All
seven print layouts produced two distinct label pages at their expected PDF media
dimensions. Tests cover framing/brand, complete grouped ID, receipt dates from real
confirmed receiving fixtures, no fabricated legacy dates, reprints/idempotency,
permissions, overflow rejection and existing purchase/accounting invariants.

```powershell
# From backend:
node node_modules/@nestjs/cli/bin/nest.js build
node node_modules/jest/bin/jest.js test/integration/inventory-unit-backend.spec.ts test/integration/purchase-receiving.spec.ts test/integration/inventory-scanning.spec.ts test/unit/inventory-unit-schema.spec.ts --runInBand --silent
node node_modules/jest/bin/jest.js test/integration/inventory-unit-ui.spec.ts --runInBand --silent
# From root:
node --check frontend/public/inventory-units.js
git diff --check
```

Restarted the local development backend using its current verified replica
configuration. Authenticated checks through port 8080 returned config 200 with all
seven sizes, and read-only label preview 201 for an existing unit at 50x30. Barcode
matched the stored value, physical receipt date was available, and the unit document
was byte-identical before/after preview. No print request or purchase was generated
by these live checks. Fixture review images were inspected at
`artifacts/barcode-ui/label-50x30.png` and `label-60x40.png`; all seven size images are
in that folder. These are design fixtures, not screenshots of customer records.

Hard-refresh the app and choose the size that matches the physical labels. Use
100% scale, zero browser margins and no headers/footers. Actual printer clipping,
label stock, camera focus and hardware scan acceptance still require a physical
print-and-scan test; simulated decoding does not certify production readiness.

### Right-aligned branding, print date and selling price

Follow-up requested by the user: SOULIA HOME is now at the right of the header,
with a small print-document date at the left, formatted DD/MM/YYYY in Africa/Cairo.
The date is generated when rendering the preview/print document; it is separate
from verified receipt date and does not assert that physical printing completed.

Label API data adds `sellPrice` from the existing current `Product.sellPrice`.
Only finite nonnegative numeric prices are printed (EGP, two decimal places).
Missing/invalid prices show an unavailable message, never purchase cost or an
invented zero. Reprints keep normal persistent idempotency semantics: retrying an
old print operation replays its original receipt, which may lack a new price field.
New print operations read the current selling price. No product price, purchase,
stock balance, barcode, stored unit or financial entry is modified by these fields.

Files changed: `inventory-units.service.ts`, `frontend/public/inventory-units.js`,
`frontend/public/inventory-units.css`, `inventory-unit-backend.spec.ts`,
`inventory-unit-ui.spec.ts`, and this report (backend paths are relative to the
existing inventory-units source and test directories).

Nest build, JavaScript syntax and whitespace checks passed. **88 tests passed in
three suites**: 60 tracking/receiving backend tests and 28 Chromium label tests.
The existing seven-size tests check right alignment, date, the exact selling
price, no overflow, real QR decoding at simulated 203 DPI and exact PDF page sizes.
The 50x30 review image was visually inspected with all new fields. The backend
test explicitly distinguishes sellPrice 249.50 from buyPrice 100.00.

```powershell
# From backend:
node node_modules/@nestjs/cli/bin/nest.js build
node node_modules/jest/bin/jest.js test/integration/inventory-unit-backend.spec.ts test/integration/purchase-receiving.spec.ts --runInBand --silent
node node_modules/jest/bin/jest.js test/integration/inventory-unit-ui.spec.ts --runInBand --silent
```

### Global search scan button: product details only

The header general-search field now includes a permission-gated scan icon. As
clarified by the user, scanning displays the matched product and selling price in
the dialog itself; it never replaces the general-search query, starts another
general search, navigates to another page or offers inventory/financial actions.
Existing text search is unchanged.

It reuses the shared camera/keyboard/manual-entry scanner in lookup context, with
a separate actor-scoped `global-search-lookup` recovery slot. Camera permission is
requested only through explicit camera start. Closing/Escape/logout releases the
scanner/camera, and pending requests remain recoverable with their original key.
Manual unit-selection overrides are not offered here. Existing validation may
record scan audit evidence; no receipt, allocation, stock quantity, lifecycle or
financial mutation is triggered by this UI.

After authoritative validation, existing authenticated GET `/inventory-units`
search loads the exact matched unit and GET `/products/:id` loads its current
product. The result verifies matching product ID/SKU and displays name, SKU,
size/colors when present, warehouse, unit status and current `Product.sellPrice`
in EGP. It does not expose purchase cost or label price snapshots. Unavailable
prices remain unavailable rather than defaulting to zero. Amounts use the existing
`.amt-num` privacy treatment. Text uses textContent, not injected product HTML.
Details failures can retry GET alone without posting another scan. Late results
are ignored after close, another validation or actor change. A code with no
registered physical unit continues to receive the existing unknown-barcode result;
this does not create identities for legacy stock.

Files changed:

- `frontend/public/global-search-scanner.js` (new)
- `frontend/public/global-search-scanner.css` (new)
- `frontend/public/index.html` (load the two new files after the shared scanner)
- `backend/test/integration/global-search-scanner-ui.spec.ts` (new)
- This report.

Verification: **54 tests passed in three suites**: nine actual Chromium integration
tests for the new entry point, 24 shared scanner browser tests and 21 existing
search relevance tests. Coverage includes ordinary typing, exact lookup and sale
price, no navigation/query rewrite, safe text rendering, permissions/logout,
unknown/denied scans, original-key recovery, GET-only details retry, explicit camera
permission/denial, Escape/focus and Arabic/English layouts at 320/390/1280px. The
initial camera fixture omitted the locally bundled decoder route; that fixture was
corrected and the final scanner suites passed. No backend service/schema/permissions,
dependencies or data were changed for this feature.

```powershell
# From backend:
node node_modules/jest/bin/jest.js test/unit/search-relevance.spec.ts --runInBand --silent
node node_modules/jest/bin/jest.js test/integration/global-search-scanner-ui.spec.ts test/integration/inventory-scanning-ui.spec.ts --runInBand --silent
# From root:
node --check frontend/public/global-search-scanner.js
git diff --check
```

The live frontend serves both new assets with HTTP 200. Hard-refresh to load the
entry point; backend restart and production deployment were not needed/performed.

### Arabic/English header overlap and barcode navigation icon

Corrected the scan button, clear button, shortcut and input text to use separate
reserved positions in both directions. The actual navigation shell positions its
clear button and Ctrl+K shortcut differently from the original scanner fixture;
the tests now load that shipped CSS and the actual scanner resources. Ctrl+K
retains LTR text, so its outer position is explicitly mirrored by the document
direction, including when the user has no scanner permission. Mobile hides the
shortcut and reserves room for scan/clear controls without covering input text.

The barcode navigation item now uses a dedicated barcode SVG in `NAV_ICONS`,
instead of the inventory cube. Other navigation icons and routes are unchanged.

Changed files: `frontend/public/global-search-scanner.css`,
`frontend/public/navigation-shell.css`, `frontend/public/index.html`,
`backend/test/integration/global-search-scanner-ui.spec.ts`,
`backend/test/browser/navigation-shell.cjs`, and this report.

Verification: **10 Chromium integration tests passed**, including geometric
non-overlap assertions for both directions, scanner permission present/absent, and
320/390/768/1024/1440px widths. The full shipped-page isolated browser QA passed
**76 checks**, including a distinct barcode icon, existing navigation/search,
geometric separation from input text and other icons, and no browser runtime
errors. Screenshots at `design-preview/search-controls-rtl-390.png` and
`search-controls-ltr-1440.png` were visually inspected. The QA intercepts network
requests and uses fixture identities; no application records are written.

```powershell
# From backend:
node node_modules/jest/bin/jest.js test/integration/global-search-scanner-ui.spec.ts --runInBand --silent
node test/browser/navigation-shell.cjs
# From root:
git diff --check
node --check frontend/public/global-search-scanner.js
node --check backend/test/browser/navigation-shell.cjs
```

No backend restart, database/schema change or financial/inventory operation was
required. Hard-refresh to fetch the updated CSS and navigation icon.
