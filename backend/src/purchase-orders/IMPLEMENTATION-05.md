# Implementation 05 — purchase receiving and unit identities

## Verified workflow and approved decision

Current PO lifecycle is `معلق → قيد التحضير → جاهز للاستلام → مستلم`.
Drafts/status updates do not post stock, supplier debt or cash. Stock is derived
from active purchase transactions, not from PO status or movement logs.
`POST /purchase-orders/:id/convert` was the existing posting event: it called
`TransactionsService.create`, then linked the PO in a separate write.

The user explicitly approved retaining invoice conversion as the posting event,
requiring physical confirmation for unit creation and making that conversion atomic
without changing accounting calculations. This delivery does not certify the missing
Implementation 03 bulk legacy migration. Production activation remains unapproved.

## Implemented behavior

- PO conversion now executes the EXISTING transaction, vault and supplier-ledger
  writers with one MongoDB session. Invoice, initial deposit history, cash delta,
  supplier payable, the normal stock movement, PO link, unit identities/events and
  durable operation receipt commit together. Failure aborts all those writes.
- Reuses the existing `inventoryunitoperations` receipt architecture. An identical
  actor/key/payload replays the committed result, even after restart/recovery. Different
  payload under a committed key conflicts; another key cannot convert a linked PO.
- Default operation key is `po-convert:<PO ObjectId>`; a tracked caller may supply
  its own operationKey. The fingerprint includes the invoice/receipt request; client
  createdBy is ignored in favor of the authenticated database User.
- All PO conversions, including invoice-only conversions, lock the singleton existing
  settings document. Different POs therefore serialize receipt payments/reference
  checks. PO edits/status updates/deletes now condition on the PO still being unlinked.
- Socket notifications and non-fatal OTP audit attachment occur after commit.
  The in-memory 15-second duplicate guard is bypassed ONLY within this persistent,
  transactional conversion path, so automatic transaction retries are not rejected.
- Optional unit tracking requires a separate backend permission and explicit actual
  possession, location and evidence. No checkbox is preselected. Untracked requests
  still create the existing financial invoice, with ZERO new unit identities.
- Tracking creates exactly one unit per received integer quantity, in
  `inspection-required`. No units are created from drafts, PO status alone, zero
  quantities, product lists, balances or unconfirmed goods.
- Unit origin now optionally retains purchaseOrderId and purchaseLineId. Tracked
  conversion assigns stable UUIDs to missing open-PO line metadata and to new invoice
  lines, with invoice-to-PO-line links. Product ID/SKU, PO quantities and money fields
  are retained. Unknown historical stock is not touched or assigned invented provenance.
- Supplier and cost trace through the existing PO/purchase/invoice line. Unit models
  carry NO duplicate price, financial balance, valuation or quantity ledger. Product
  buyPrice is not changed. Invoice discount stays on the invoice; no per-unit discount
  allocation or new costing rule is invented.
- Tracking refuses missing/duplicate SKUs, wrong product references and ambiguous
  supplier name/ID relationships. An explicit supplier ID is only stored when it
  agrees with the old name-based resolution; debt is never silently redirected.
- A validated transaction-only bulk writer checks actor, existing locked products,
  invoice lines, whole-piece quantities and document schemas before raw unit/event
  inserts. Ordinary unvalidated model bulk APIs remain blocked. Limit: 10,000 pieces
  per tracked conversion; larger requests fail and roll back, not partially commit.
- A new additive `inventory_unit_purchase_order_lookup` index is included in the
  existing explicit index migration. There are now 12 named tracking indexes, plus
  MongoDB primary-key indexes. Existing origin fields remain valid/optional; no data
  migration or destructive down migration is introduced.

## Partial quantities and reversals

The actual application supports ONE conversion with adjusted received quantities,
including omitted zero rows and explicitly acknowledged shortages/surpluses. It does
NOT support multiple incremental receipts on one linked PO. That rule is preserved:
no invented backorder or repeated receipt. Original ordered quantities remain intact;
received quantities live on the actual invoice. Tracking requires explicit approval
of any difference, including an omitted line.

Purchase cancellation/refund/ledger reversal continue through existing procedures.
Real integration tests invoke `TransactionsService.cancel` and verify stock, cash and
supplier balances return to their starting values. Unit IDs/events are retained;
cancellation is not proof that goods were physically returned to the supplier.
The receipt summary exposes reversed/archived sources and quantity mismatches.
Forward unit activity on NEW PO-linked units is blocked if the source is reversed,
archived, missing or its line quantity/identity no longer matches. Custody recovery
must be reviewed; no identities are deleted, regenerated or silently reassigned.
Existing preparation UI, order preparation statuses, Ready and Bosta workflows are
not integrated or changed in this phase.

## API and permissions

`POST /purchase-orders/:id/convert` retains the existing invoice fields and response
`{ po, transaction }`, adding `receipt`, `quantityDifference`, `operationId` and
`enforcementEnabled:false`.

Optional request addition:

```json
{
  "tracking": {
    "physicalPossessionConfirmed": true,
    "warehouseCode": "actual operator-confirmed location",
    "reason": "signed receipt / physical count evidence",
    "acceptQuantityDifference": true,
    "operationKey": "optional-stable-retry-key"
  }
}
```

Tracked item rows may specify `purchaseOrderLineIndex` to select the exact existing
PO line; the server validates the SKU and creates persistent line IDs. Array indices
are selectors only and are NEVER stored as a unit's permanent line identity.

Conversion requires JWT + `purchase-create`. Tracking additionally requires
`inventory-units-receive`. Admin retains the existing bypass; no staff permissions
are automatically granted. The authenticated database User supplies audit attribution.

`GET /purchase-orders/:id/receipt` requires `purchase-view`. It reports actual invoice
quantities, created units per line, source price references, unresolved source errors,
and numbers of units with/without LABEL REQUESTS. `physicalPrintingVerified` is false.
`GET /inventory-units?purchaseTransactionId=<id>` provides paginated receipt-specific
units. The barcode page shows its receipt filter and permits clearing it.

UI: conversion includes optional custody/location fields; success opens a receipt
summary. PO details also open that summary later. Labels use the existing barcode
page and the same immutable IDs; no second purchase, payment or movement is posted.
Requesting/opening a print dialog is not claimed as physical printing.

## Compatibility / infrastructure / remaining risks

- All PO conversions now require transaction-capable MongoDB (replica set/mongos),
  sessions and existing initialized financial collections. Standalone is rejected.
  This is an intentional infrastructure requirement of the approved atomicity change.
- Read-only preflight checks the existing unique PO number and movementId indexes;
  tracking index readiness checks all 12 expected indexes and topology. Nothing
  creates/mends production indexes automatically. Missing storage/indexes fail closed.
- Backend `purchase-create` is now enforced for conversion. Clients without it must
  receive an explicit permission assignment; the new receiving permission is separate.
  Invoice-only clients need not send tracking fields, but must meet storage/permission
  requirements. No application startup was used as a migration runner.
- Session parameters are optional for existing non-PO callers; their existing
  financial behavior and latest-row selection are retained. New receipt writes
  refuse ambiguous historical ledger balances (different balances at the same latest
  timestamp), invalid/string-typed or future audit timestamps, rather than inventing
  a tie-breaker or migrating old data to change historical financial
  interpretation. New serialized receipt rows use monotonic audit timestamps;
  amount/sign formulas and business dates are unchanged.
- Other legacy direct-purchase, ledger-payment/edit/cancellation and raw maintenance
  paths are NOT all transaction-coordinated with this new path. Concurrent independent
  legacy ledger writes and human vault-number allocation retain their pre-existing
  concurrency limitations. Before production use, serialize affected financial writes
  in a reviewed cutover or extend coordination to those writers in a separate reviewed
  change. Do not infer a global accounting-serializability guarantee from these tests.
- Existing financial reversal failure/recovery limitations remain; the receipt path
  does not rewrite cancellation accounting. Current cancellation regressions pass.
- Legacy invoice edits can replace line identities. Tracking blocks mismatched receipt
  units and exposes the discrepancy instead of guessing a new financial/provenance link.
- Barcode enforcement stays OFF. Full legacy migration 03, production topology/data
  reconciliation and actual printer/QR scan testing remain release gates.

## Backup, recovery and rollback

New receipts use existing backup collections. Restoration of PO-linked unit data
requires the companion purchaseorders, suppliers, supplierledgerentries, vaultentries
and users datasets, in addition to products/transactions/movements/units/events/operations.
Generic related resets/partial restores remain blocked while tracking data exists.

Restore a consistent complete backup into a separate quiescent database. Rebuild/
verify existing financial indexes AND explicit tracking indexes before enabling any
writes. Preserve ObjectIds, immutable barcodes, line UUIDs and string operation IDs.
Replaying the identical receipt must return its original IDs without posting money.
The recovery integration test initially caught absent financial indexes in its
restored scratch fixture; it now explicitly rebuilds them, matching the safe procedure.

On interruption before commit: no receipt finance, units or PO link survive. Retry
the identical request/key. On uncertain response after commit: retry identically;
do not change reference/quantity/key to force another invoice. Read the live summary
for later cancellation/edit state. Post-commit notification failure requires refresh,
not financial replay. There is no durable notification outbox guarantee here.

Rollback before use: disable this feature's routes/UI and retain empty additive
indexes. After use: retain session-aware receipt handling, identities/audits/retry
receipts and deletion/restore safeguards, or disable conversion entirely. Do not
roll back to a writer that can duplicate or delete tracked receipts. No destructive
production rollback or automatic backfill is supplied or executed.

## Exact changed files in this delivery

New:

- backend/src/shared/database-write-context.ts
- backend/src/purchase-orders/purchase-receiving.service.ts
- backend/src/purchase-orders/IMPLEMENTATION-05.md
- backend/test/integration/purchase-receiving.spec.ts
- frontend/public/purchase-receiving.js

Modified:

- backend/src/purchase-orders/dto/purchase-order.dto.ts
- backend/src/purchase-orders/purchase-orders.service.ts
- backend/src/purchase-orders/purchase-orders.controller.ts
- backend/src/purchase-orders/purchase-orders.module.ts
- backend/src/purchase-orders/schemas/purchase-order.schema.ts
- backend/src/products/products.service.ts
- backend/src/transactions/transactions.service.ts
- backend/src/settings/settings.service.ts
- backend/src/vault/vault.service.ts
- backend/src/supplier-ledger/supplier-ledger.service.ts
- backend/src/inventory-movements/inventory-movements.service.ts
- backend/src/inventory-units/inventory-units.service.ts
- backend/src/inventory-units/inventory-units.module.ts
- backend/src/inventory-units/schemas/inventory-unit.schema.ts
- backend/src/inventory-units/inventory-unit-maintenance.ts
- backend/test/unit/inventory-unit-schema.spec.ts
- backend/test/integration/inventory-unit-ui.spec.ts
- frontend/public/index.html
- frontend/public/inventory-units.js

Previous-phase working-tree changes remain intact and uncommitted; this list is
specific to Implementation 05. No dependencies, environment configuration or
production records were modified.

## Tests and commands actually executed

Final targeted coverage: 568 distinct Jest tests in 29 suites passed across the
runs below (overlapping reruns are counted once), plus 15 offline diagnostic tests.
The first broad run had one failing recovery fixture due to its missing restored
financial indexes. After correcting that fixture, all 21 new backend cases passed,
including native full/short/over receipts, missing indexes, financial rollback fault
injection, concurrent retries, different receipts/references, cancellation, restart,
complete-copy recovery, HTTP validation/permissions and label counts. All 10 Chromium
cases passed, including custody form opt-in, receipt summary and receipt-filtered
printing. Existing SKU, stock, ledger/vault, Shopify, Bosta, return and restore
regressions passed. New integration tests launch their own disposable local replica
set; the existing PO-numbering test uses its own uniquely named localhost scratch DB.

Application-source type-check, standalone JS checks, all inline script parsing and
whitespace checks passed. Repository-wide type-check still fails only on pre-existing
`shopify-config-http.spec.ts:64,91` model types and `shopify-edit-preview.spec.ts`
implicit-any errors. Existing duplicate-index warnings/fault-injection logs remain.
The full repository Jest suite was not run. No real printer was available/tested.

Final rerun after the historical ledger timestamp checks: purchase receiving,
supplier ledger and vault failure suites passed (3 suites, 53 tests). The application
source type-check and `git diff --check` passed again. A convenience `npx tsc`
invocation was blocked by PowerShell's script execution policy; invoking the existing
local TypeScript JavaScript entry point directly passed without changing that policy.

From backend/:

```powershell
node node_modules/jest/bin/jest.js --runInBand --no-cache --coverage=false --runTestsByPath test/integration/purchase-receiving.spec.ts test/integration/inventory-unit-backend.spec.ts test/unit/purchases.spec.ts test/unit/purchases-extended.spec.ts test/integration/transactions.service.spec.ts test/integration/returns.service.spec.ts test/integration/returns-flow.service.spec.ts test/integration/supplier-returns-complete.service.spec.ts test/integration/supplier-returns-reverse.service.spec.ts test/integration/sr-allocation.service.spec.ts test/unit/vault-stock-sync.spec.ts test/unit/inventory-stock.spec.ts test/unit/confirm-pickup-mixed.spec.ts test/integration/settings-backup-coverage.spec.ts test/integration/settings-backup-integrity.spec.ts test/integration/settings-selective-restore.spec.ts test/unit/inventory-unit-schema.spec.ts test/integration/inventory-unit-model.mongo.spec.ts test/integration/purchase-order-numbering.spec.ts
node node_modules/jest/bin/jest.js --runInBand --no-cache --coverage=false --runTestsByPath test/integration/purchase-receiving.spec.ts test/integration/supplier-ledger.service.spec.ts test/unit/vault-system-entry-failure.spec.ts test/integration/products-sku.service.spec.ts test/integration/products-sku.mongo.spec.ts test/integration/products-sku-http.spec.ts test/unit/product-sku-ui.spec.ts test/integration/shopify-deposit-receipts.service.spec.ts test/integration/shopify-cancel-approval.service.spec.ts test/unit/bosta-awb.spec.ts
node node_modules/jest/bin/jest.js --runInBand --no-cache --coverage=false --runTestsByPath test/integration/inventory-unit-ui.spec.ts
node node_modules/typescript/bin/tsc --project tsconfig.build.json --noEmit --incremental false
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

From the repository root:

```powershell
node --test scripts/inventory-diagnostics.test.cjs
node --check frontend/public/inventory-units.js
node --check frontend/public/purchase-receiving.js
git diff --check
git status --short
```

Read-only source searches, an inline `vm.Script` parser sweep and focused test reruns
were also executed. No production migration, deployment, preparation integration or
barcode enforcement ran. Stop here for review before subsequent integration work.

## Follow-up — manual purchase receiving and receipt form repair (2026-10-17)

Implemented the user's requested opt-in unit receiving in **New transaction → Purchase**,
alongside the existing PO conversion flow. Fixed the receipt controls with dedicated
`purchase-receiving.css`: explicit 18px native checkboxes, properly stretched fields,
RTL/mobile layout and details hidden/disabled until tracking is selected. Turning
tracking off clears physical confirmation. Manual and PO forms use separate `tx` / `conv`
IDs. Ordinary manual purchasing stays on its existing path when tracking is not selected.

The actual `saveTx` and `confirmTxSave` functions submit tracked purchases through a
separate authenticated endpoint, not through the existing offline transaction queue.
They show the received-unit summary and reuse existing unit label printing. New purchase
confirmation shows the unit quantity/location. No existing invoice is retroactively
reposted and no purchase order is invented for a direct purchase.

API additions (prefix `/api/inventory-units`):

- `GET /purchases/readiness`: `purchase-create` + `inventory-units-receive`, existing
  read-only Mongo transaction/index readiness. Checked before submitting a new invoice.
- `POST /purchases/receive`: same permissions; body `{operationKey, invoice, tracking}`.
  `invoice` uses the actual `CreateTransactionDto`; `tracking` requires explicit physical
  possession, warehouse and reason. Integer quantities/totals, supplier/SKU identity,
  initialized financial storage and unique movement index are checked. Response:
  `{transaction, receipt, operationId, enforcementEnabled:false}`.
- `GET /purchases/:id/receipt`: `purchase-view`, current invoice/unit/label-request counts
  and visible reversal/line discrepancies. No claim of physically printed labels.

`ManualPurchaseReceivingService` uses the existing durable operation transaction wrapper
(`kind:manual-purchase-receive`) and the SAME financial settings lock as PO receipts.
Existing transaction, cash, supplier debt/credit, normal inventory movement, units and
events commit together. Unit origins reference the actual new purchase and a server
line UUID, without a PO ID. The invoice remains the cost/supplier source; no extra
valuation ledger is introduced. Identical requests replay after retries/restart;
different keys cannot bypass the existing invoice reference check.

Standing supplier credit preserves the existing arithmetic: balance availability and
`postCreditUsed` now accept the same optional session as the purchase-debt writer.
Legacy callers retain their original invocation and calculations. Tests verify credit
concurrency, rollback and credit-only purchases with ZERO cash withdrawal. New units
remain inspection-required. Forward unit actions and scan eligibility now validate
direct-purchase line sources too, so cancellation/edit cannot silently make those
units available. Existing cancellation reversals remain the financial mechanism; unit
IDs are retained and physical custody recovery requires review.

Browser recovery saves the exact request/key in actor-scoped sessionStorage before
posting. Double submissions are blocked. Unknown responses retain that payload across
reload; the pending-receipt button reviews/retries it. A later permission denial cannot
erase an original request whose financial outcome is unknown. New invoices are blocked
while that request is unresolved. Failed readiness checks occur BEFORE posting/storing
a financial request. There is no offline receiving mutation or automatic discard of an
uncertain request. OTP/permission/recovery exceptions that cannot be resolved by exact
replay require operator review, not a fresh invoice/reference to bypass the safeguard.

Native recovery/backup uses existing units/events/operations and financial collections.
Backup validation now also requires financial/actor companions for direct purchase-line
origins. Existing PO guards are retained. Existing uncoordinated legacy financial
writers still require the reviewed cutover/coordination described above; this addition
does not claim global serializability for all accounting APIs.

### Verification and local infrastructure gate

**407 tests passed in 16 suites** in the final runs: 360 backend/regression cases and
47 Chromium cases. Includes 32 PO/manual receiving cases, real financial writers on an
owned disposable replica set, fault rollback, duplicate/concurrent retries, mixed
manual/PO receipts, insufficient credit, credit-only payment, permissions, cancellation,
backup safety and actual extracted new-transaction frontend functions. Build, JavaScript
and all 3 inline script parses passed. An initial new cancellation fixture used the
wrong existing DTO field; it was corrected and the final suite passes. Known duplicate
schema-index warnings and intentional failure-injection logs remain.

Read-only diagnostics of the configured LOCAL development database found:

- MongoDB is standalone (`transactionsSupported:false`).
- `inventoryunits`, `inventoryunitevents`, `inventoryunitoperations` do not exist.
- All 12 explicit tracking indexes are absent (6/4/2 respectively).

Consequently **tracked receiving is NOT activated on the current development DB**.
The UI now blocks it before posting and explains the server setup requirement. No
tracking migration, balance adjustment, legacy-unit creation, database copy or
connection change was applied. A request for explicit approval is pending for a separate
local replica set, quiescent backup/copy, data verification and development connection
cutover. The original DB must be preserved. Legacy inventory migration 03 remains a
separate reviewed task; a replica set does not prove physical stock or authorize backfill.

The new backend was built and the local process restarted under the user's existing
development restart approval. Both direct port 4000 and proxied port 8080 new readiness
and receipt routes return 401 without credentials, proving route registration/auth;
the receipt CSS returns 200. Authenticated create is verified in the isolated tests,
not by posting a real purchase to the current DB. Existing 03:00 nightly backup also
updated `backend/backups/registry.json`; that runtime change was retained, not manually
edited or reverted. Physical printer/scanner testing is still required.

### Changed files for this follow-up

New:

- backend/src/inventory-units/manual-purchase.dto.ts
- backend/src/inventory-units/manual-purchase-receiving.service.ts
- backend/test/integration/manual-purchase-ui.spec.ts
- frontend/public/purchase-receiving.css

Modified:

- backend/src/inventory-units/inventory-units.controller.ts
- backend/src/inventory-units/inventory-units.module.ts
- backend/src/inventory-units/inventory-units.service.ts
- backend/src/inventory-units/inventory-scanning.service.ts
- backend/src/inventory-units/inventory-unit-maintenance.ts
- backend/src/transactions/transactions.service.ts
- backend/src/supplier-ledger/supplier-ledger.service.ts
- backend/src/shared/database-write-context.ts
- backend/test/integration/purchase-receiving.spec.ts
- backend/test/integration/inventory-unit-backend.spec.ts
- backend/test/integration/inventory-scanning.spec.ts
- backend/test/integration/inventory-unit-ui.spec.ts
- backend/test/unit/inventory-unit-schema.spec.ts
- frontend/public/purchase-receiving.js
- frontend/public/index.html
- backend/src/purchase-orders/IMPLEMENTATION-05.md

Review image with fixture data: `artifacts/barcode-ui/manual-purchase-receipt.png`.
No dependency or environment configuration changes were made in this follow-up.

Final commands from backend (earlier focused/debug reruns also ran):

```powershell
node node_modules/@nestjs/cli/bin/nest.js build
node node_modules/jest/bin/jest.js test/integration/purchase-receiving.spec.ts test/integration/inventory-unit-backend.spec.ts test/integration/inventory-scanning.spec.ts test/unit/inventory-unit-schema.spec.ts test/integration/supplier-ledger.service.spec.ts test/unit/vault-system-entry-failure.spec.ts test/integration/transactions.service.spec.ts test/unit/purchases.spec.ts test/unit/purchases-extended.spec.ts test/unit/vault-stock-sync.spec.ts test/integration/settings-backup-coverage.spec.ts test/integration/settings-backup-integrity.spec.ts test/integration/settings-selective-restore.spec.ts --runInBand --silent
node node_modules/jest/bin/jest.js test/integration/manual-purchase-ui.spec.ts test/integration/inventory-unit-ui.spec.ts test/integration/inventory-scanning-ui.spec.ts --runInBand --silent
```

From root: `node --check frontend/public/purchase-receiving.js`, inline `vm.Script`
parsing, `git diff --check`, read-only HTTP and Mongo topology/index metadata checks.

## Approved local development database cutover — 17 October 2026

The user explicitly approved pausing development writers, backing up the existing
database, copying it to a separate local replica set, verifying it, changing the
development connection, and creating tracking indexes. This approval does not
authorize a production migration or legacy unit creation.

Completed:

- Stopped the verified backend listener on port 4000. The original standalone
  MongoDB on port 27017 and its files were retained.
- Started a separate loopback-only single-member `souliaDev` replica set on 27018.
  This supports transactions; it is not a highly available production deployment.
- Temporarily fsync-locked the source server during backup/copy/verification,
  preventing TTL and other writers from changing the cross-collection snapshot.
  The lock was released in `finally`. Target TTL was disabled during restoration,
  then restored to normal in the persistent startup configuration.
- Backed up raw BSON documents plus collection/index metadata. Copied and verified
  **43 original collections, 8,301 documents**, using sorted raw-BSON SHA-256
  fingerprints, document counts and index metadata. Empty collections and BSON
  types were retained. Verification passed again after MongoDB and backend restart.
- Created the 12 declared indexes across the three new tracking collections.
  A second index inspection reported no missing indexes. All three collections
  still contain zero documents: no invented physical stock or financial postings.
- Verified a real snapshot transaction/abort. The actual readiness service reports
  `writesReady: true`, `transactionsSupported: true`, `blockers: []`, and
  `enforcementEnabled: false`.
- Updated only local `backend/.env` to the new development URI and restarted the
  existing compiled backend. Authenticated read-only config and purchase-readiness
  HTTP checks returned 200 on ports 4000 and 8080; unauthenticated checks returned
  401. A short-lived local development token was used only in memory and not logged.

Local private recovery files (ignored by Git; contain confidential data):

- `backend/.local-mongodb/backend.env.before-replica`: exact previous environment.
- `backend/.local-mongodb/backup-before-replica-20261017/`: numbered raw `.bson`
  files, `manifest.json` with checksums/index metadata, `verified.json`.
- `backend/.local-mongodb/replica-20261017/`: persistent new database files/logs.
- `backend/.local-mongodb/mongod.cfg`: persistent replica configuration.

Files changed for this infrastructure fix:

- `.gitignore`: exclude the private local database/backup/runtime directory.
- `scripts/local-replica-copy.cjs`: explicit loopback-only copy, verification and
  restore utility; no `.env` loading, application startup, target overwrites,
  document deletion or automatic financial/unit migration.
- `scripts/inventory-unit-indexes.cjs`: use the compiled application index plan
  instead of unavailable `ts-node`; refuse missing/stale compiled schema modules.
- `scripts/start-local-mongodb.ps1`: start or verify the configured local replica,
  without copying, initializing a new replica, installing a service or migrating.
- `backend/test/integration/local-replica-copy.spec.ts`: five disposable database
  tests covering BSON/index parity, empty collections, backup recovery/corruption,
  interrupted-copy unlocking, refusal to overwrite, address restrictions, and the
  real index CLI including repeat application with zero created units.
- This report and the ignored local environment/runtime files listed above.

Commands executed from root (URI environment variables were scoped to the shell
and held only explicit local development addresses; no secrets printed):

```powershell
node scripts/local-replica-copy.cjs copy SOULIA_COPY_SOURCE SOULIA_COPY_TARGET backend/.local-mongodb/backup-before-replica-20261017
node scripts/inventory-unit-indexes.cjs --uri-env SOULIA_TRACKING_TARGET --db soulia --apply
node scripts/inventory-unit-indexes.cjs --uri-env SOULIA_TRACKING_TARGET --db soulia
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-local-mongodb.ps1
git diff --check
```

From `backend`, the Nest build passed. The previous 13 backend regression suites
plus `test/integration/local-replica-copy.spec.ts` passed: **365 tests, 14 suites**.
The five copy/CLI tests also passed after the final test cleanup. Existing duplicate
schema-index warnings remain; simulated financial-failure logs in regression tests
are expected fixtures, not writes against the development database. No frontend
files or dependencies changed in this fix. Hardware printing/scanning remains
subject to actual printer/label verification.

### Development restart and recovery

After a computer restart, run from repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-local-mongodb.ps1
```

Then start the backend normally from `backend`; frontend remains on port 8080.
The replica process is persistent while running but has not been installed as an
automatically starting Windows service. Keep it bound to loopback. Do not point
production at this unauthenticated development replica.

Before any rollback/recovery, stop all application writers and back up the current
active replica as well as its environment. **Once new application writes occur,
the old standalone and pre-cutover backup are stale. Do not just switch back to
port 27017: that would omit new purchases, balances and tracking history.**
Recover the entire latest consistent database into a separate empty replica;
verify all original and tracking/financial collections, then change the connection
under a new reviewed recovery operation. Never restore selected financial tables
or delete legitimate unit/event/operation records as a shortcut.

For interrupted initial copies, the utility never overwrites a partial target.
Preserve it and restore the complete checksum-verified backup to a fresh empty
database with target TTL disabled until verification completes:

```powershell
node scripts/local-replica-copy.cjs restore SOULIA_RECOVERY_TARGET backend/.local-mongodb/backup-before-replica-20261017
node scripts/local-replica-copy.cjs verify SOULIA_RECOVERY_TARGET backend/.local-mongodb/backup-before-replica-20261017
```

The target variable must specify a separate explicit loopback development replica
database; these examples do not authorize running a recovery over the active DB.
If the copying process or host is forcibly interrupted, the original server may
retain its fsync lock. Inspect lock ownership before issuing one `fsyncUnlock`
against that source. Normal errors already unlock automatically. The initial
backup preserves data as of cutover only; ongoing backups must cover the active
replica, including all three tracking collections.

## Pickup barcode integration — 19 October 2026

The existing Prep group orders workspace now exposes per-line barcode scanning for
accounts with `inventory-units-view` and `inventory-units-allocate`. Stable sale line
IDs are assigned through the existing idempotent line-identification operation when
needed. A scan binds one physically confirmed unit to the selected live sale line in
one transaction, rejects wrong-SKU, duplicate, unavailable, over-quantity and
reversed-receipt cases, and records the authenticated operator and reason. The scan
does not post a second inventory quantity movement.

The existing Prepare action checks identity coverage for tracked lines, advances
picked units to `prepared`, then records the existing prep checkbox. The transaction
tracking revision prevents a concurrent new scan from racing the final checkbox
update. A tracked line that cannot cover its invoice quantity blocks preparation and
requires inventory reconciliation; a line with no registered units keeps the
existing manual path for legacy stock. Undo restores the unit to its exact pre-scan
state and requires a reason. The latest pending pick remains undoable after reopening
the order. These operations leave financial and aggregate stock arithmetic unchanged.

Purchase and sales invoice detail rows now have a staff-only barcode action. Purchase
lines filter by invoice and stable purchase line; sales lines show only units assigned
to that invoice line after pickup scanning. Preview uses immutable unit IDs and does
not claim that a label was physically printed. Opening an invoice does not assign
units to a sale.

Verification after these changes: Nest build passed; the purchase receiving, backend
unit and scanning integration suites passed (81 tests). The existing browser UI
suite timed out waiting for its fixture page to render, so visual/browser assertions
remain unverified in this environment. The authenticated API route check returned
401 without credentials after backend restart.
