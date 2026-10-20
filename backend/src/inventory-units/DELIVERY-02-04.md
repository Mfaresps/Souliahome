# Delivery: Implementations 02–04

## Scope clarification following the supplied migration specification

The originally defined Implementation 03 covered manual reconciliation and operational
safety. It does NOT complete the subsequently supplied bulk legacy migration scope:
batch dry-run manifests, explicit apply approval, per-physical-item stable mappings,
batch results/errors and resumable interrupted batch application remain unimplemented.
Implementation 04's existing UI can be tested against explicitly registered units,
but its prerequisite that the full migration Implementation 03 is verified is NOT met.
Do not treat the results below as migration or production-readiness certification.

## Result and boundaries

Implemented additive unit tracking APIs, durable retry/audit records, physical-count
attestation and review, and the responsive `#barcodes` search/preview/printing page.
See [specification, API contracts, permissions and recovery procedures](IMPLEMENTATIONS-02-04.md).

No production database was connected, no production migration/backfill/deployment
ran, and barcode enforcement is OFF. No new dependency was installed. Existing
stock arithmetic and financial posting services were not modified by this delivery.
All database integration tests used their own temporary loopback MongoDB processes.

Approved policies:

- Explicit custody/inspection confirmation; discrepancies remain blocked; existing
  stock adjustments, cancellation reversals and refunds stay in their existing flows.
- Assigned lost/damaged recovery and same-sale replacement dispatch remain blocked
  pending a separately reviewed policy. No invented financial replacement transaction.

Schema changes: one append-only `inventoryunitoperations` collection with string
receipt identity/fingerprint, actor, kind, result and timestamp; two additive indexes.
Optional event `details` preserves before/after custody/location snapshots. Two new
print-request event action names. Explicit API writes add tracking-only Product and
sale revision metadata; explicit line-identification adds missing sale line IDs.
Existing business fields, historical rows and quantity/financial sources are preserved.
The explicit migration now covers 11 named indexes across three collections; no
automatic index creation or destructive down migration was added.

## Exact files changed for this delivery

New:

- backend/src/inventory-units/inventory-unit.dto.ts
- backend/src/inventory-units/inventory-units.controller.ts
- backend/src/inventory-units/inventory-units.service.ts
- backend/src/inventory-units/schemas/inventory-unit-operation.schema.ts
- backend/src/inventory-units/IMPLEMENTATIONS-02-04.md
- backend/src/inventory-units/DELIVERY-02-04.md
- backend/test/helpers/tracking-mongo.ts
- backend/test/integration/inventory-unit-backend.spec.ts
- backend/test/integration/inventory-unit-ui.spec.ts
- frontend/public/inventory-units.js
- frontend/public/inventory-units.css

Modified:

- backend/src/inventory-units/inventory-unit.constants.ts
- backend/src/inventory-units/inventory-unit-index.migration.ts
- backend/src/inventory-units/inventory-unit-maintenance.ts
- backend/src/inventory-units/inventory-units.module.ts
- backend/src/inventory-units/schemas/inventory-unit-event.schema.ts
- backend/src/inventory-units/README.md
- backend/src/settings/settings.service.ts
- backend/test/unit/inventory-unit-schema.spec.ts
- backend/test/integration/settings-backup-coverage.spec.ts
- backend/test/integration/settings-backup-integrity.spec.ts
- frontend/public/index.html
- frontend/public/navigation-shell.js

Previous SKU/model-phase changes already existed in the working tree and remain
uncommitted. This list describes this delivery, not every pre-existing git change.

## Verification results

622 distinct targeted Jest tests in 33 suites passed across the runs below (updated
suites were rerun; repeated executions are not added to that total):

- 513 legacy regression tests / 26 suites: SKU permissions, concurrent creation,
  imports/edits, products/collections, purchases/sales/stock, customer and supplier
  returns, deposits/vault/reports, Shopify deposits/cancellations/retries and Bosta.
- 27 new backend tests: real isolated replica-set transactions, concurrent unit/line
  claims and count/receipt limits, duplicates, wrong products, stale versions,
  missing line identity, audit-failure rollback, restarts, cancellation custody,
  loss/damage restrictions, physical return/dispatch retry, exact label values,
  concurrent printing retries, actual HTTP contracts/permissions, count review,
  separate-database receipt/identity/financial-fixture recovery and standalone rejection.
- 8 real Chromium tests: responsive widths 360/768/1280, explicit sizes, exact
  identities, SVG previews, PDF dimensions within browser rounding tolerance,
  one label per page/no trailing blank page, request retries, distinct selection,
  overflow blocking, text escaping, permissions and Arabic/error/empty states.
- 74 existing/updated schema, index migration and backup/restore checks / five suites.
- 15 offline inventory diagnostic tests passed separately.

Application-source type-check, standalone JS syntax, every inline HTML script and
`git diff --check` passed. Temporary tracking MongoDB directories were cleaned up.
Chromium startup required execution outside the filesystem sandbox; no application
or production API service was started. Initial obsolete data-only-module assertions
were updated for the authorized API phase. The initial exact PDF-number-string
assertion was replaced by a physical-dimension tolerance and page-count check.

Repository-wide TypeScript checking still fails only on the pre-existing model typing
errors in `test/integration/shopify-config-http.spec.ts:64,91` and implicit-any errors
in `test/unit/shopify-edit-preview.spec.ts`. Existing duplicate schema-index warnings
and expected fault-injection log messages remain. The entire repository Jest suite
was not run; the targeted suites above were run.

## Commands executed

From backend/ (main focused run, then updated backend/schema/restore reruns):

```powershell
node node_modules/jest/bin/jest.js --runInBand --no-cache --coverage=false --runTestsByPath test/integration/inventory-unit-backend.spec.ts test/integration/inventory-unit-ui.spec.ts test/unit/inventory-unit-schema.spec.ts test/integration/inventory-unit-model.mongo.spec.ts test/integration/settings-backup-coverage.spec.ts test/integration/settings-selective-restore.spec.ts test/integration/settings-backup-integrity.spec.ts
node node_modules/jest/bin/jest.js --runInBand --no-cache --coverage=false --runTestsByPath test/integration/inventory-unit-backend.spec.ts test/unit/inventory-unit-schema.spec.ts test/integration/inventory-unit-model.mongo.spec.ts test/integration/settings-backup-integrity.spec.ts
node node_modules/jest/bin/jest.js --runInBand --no-cache --coverage=false --runTestsByPath test/integration/inventory-unit-backend.spec.ts
node node_modules/jest/bin/jest.js --runInBand --no-cache --coverage=false --runTestsByPath test/integration/inventory-unit-ui.spec.ts
node node_modules/typescript/bin/tsc --project tsconfig.build.json --noEmit --incremental false
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Legacy regression invocation:

```powershell
node node_modules/jest/bin/jest.js --runInBand --no-cache --coverage=false --runTestsByPath test/unit/product-code.spec.ts test/unit/product-sku-ui.spec.ts test/integration/products-sku.service.spec.ts test/integration/products-sku.mongo.spec.ts test/integration/products-sku-http.spec.ts test/unit/product-features.spec.ts test/integration/collections.service.spec.ts test/integration/transactions.service.spec.ts test/integration/returns.service.spec.ts test/integration/returns-flow.service.spec.ts test/integration/supplier-returns-complete.service.spec.ts test/integration/supplier-returns-reverse.service.spec.ts test/integration/sr-allocation.service.spec.ts test/unit/inventory-stock.spec.ts test/unit/confirm-pickup-mixed.spec.ts test/unit/bosta-awb.spec.ts test/unit/auth-permissions.spec.ts test/unit/purchases.spec.ts test/unit/sales.spec.ts test/unit/reports.spec.ts test/unit/vault-stock-sync.spec.ts test/integration/shopify-deposit-receipts.service.spec.ts test/integration/shopify-cancel-approval.service.spec.ts test/integration/shopify-token-retry.spec.ts test/unit/bosta-shipment-events.spec.ts test/unit/bosta-pickup.spec.ts
```

From the repository root:

```powershell
node --test scripts/inventory-diagnostics.test.cjs
node --check frontend/public/inventory-units.js
node --check frontend/public/navigation-shell.js
node --check scripts/inventory-unit-indexes.cjs
node scripts/inventory-unit-indexes.cjs --help
git diff --check
git status --short
```

Read-only `rg`, file inspections and a Node `vm.Script` sweep of inline scripts were
also used. Index --apply ran ONLY inside the disposable MongoDB tests. No production
URI was supplied to the migration or diagnostic CLI.

## Remaining release gates

1. Review this implementation and its API/custody contracts.
2. Separately approve production topology/index inspection and additive migration;
   transaction-capable MongoDB is mandatory for writes. Do not start the application
   as a migration runner because existing startup work is outside this feature.
3. Physically reconcile the intended SKUs and outstanding sales under a quiescent
   cutover; approve discrepancies through existing financial/stock workflows.
4. Coordinate legacy product/order edits/deletions with unit tracking before any
   enforcement. The new API's atomicity does not make those old workflows atomic.
5. Verify complete backup/restoration and physical QR scans using the actual printer,
   media and supported paper size. A QR-capable reader is required. Browser printing
   cannot verify physical output, scaling settings or printer-driver support.

Activation is deliberately unavailable in this delivery. Passing test fixtures or
an informational quantity check does not certify production readiness.
