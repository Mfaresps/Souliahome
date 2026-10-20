# Implementation 01: data model delivery, 2026-10-17

## Scope and result

Added only the data model, reference/retention checks, explicit index migration,
backup/restore protection, documentation and tests. No new APIs, lifecycle services,
frontend edits, scheduled jobs, historical backfill or production migration ran.
Prior Phase 2 changes and Phase 1 diagnostic scripts remain in the working tree.
This report lists only files changed for Implementation 01.

Two new collections:

| Collection | Identity / important fields | Indexes |
| --- | --- | --- |
| inventoryunits | Native immutable ObjectId `_id`; immutable unique derived barcode; immutable product/origin/registration actor; nullable warehouseCode; enum status; nullable sale-line assignment; timestamps and optimistic `__v` | Unique barcode; product/status/warehouse; purchase/product; reconciliation reference; transaction/line/status |
| inventoryunitevents | Native ObjectId; unitId, sequence, operationKey, action, before/after status, actor, optional existing transaction/movement links | Unique unit/sequence; unique unit/operationKey; transaction/time; movement |

There is no additional SKU, quantity balance, financial balance, cost ledger,
Variant, Warehouse or Batch collection. Existing purchase transactions supply the
meaningful batch relationship; Supplier remains reachable through that purchase.
Existing Product.openingBalance is the opening-stock reference. Unknown provenance
must remain explicit and cannot claim a purchase/opening history.

See README.md for states, historical reconciliation, migration and recovery rules.
No user account/permission records, application settings documents or existing
product/transaction/movement rows were migrated.

## Exact changed files

New:

- backend/src/inventory-units/inventory-unit.constants.ts
- backend/src/inventory-units/inventory-unit-integrity.ts
- backend/src/inventory-units/inventory-unit-maintenance.ts
- backend/src/inventory-units/inventory-unit-index.migration.ts
- backend/src/inventory-units/inventory-units.module.ts
- backend/src/inventory-units/schemas/inventory-unit.schema.ts
- backend/src/inventory-units/schemas/inventory-unit-event.schema.ts
- backend/src/inventory-units/README.md
- backend/src/inventory-units/IMPLEMENTATION-01.md
- scripts/inventory-unit-indexes.cjs
- backend/test/unit/inventory-unit-schema.spec.ts
- backend/test/integration/inventory-unit-model.mongo.spec.ts

Modified:

- backend/src/app.module.ts — register the data-only module.
- backend/src/products/schemas/product.schema.ts — referenced-product retention.
- backend/src/transactions/schemas/transaction.schema.ts — referenced purchase/sale/audit retention.
- backend/src/inventory-movements/schemas/inventory-movement.schema.ts — retain movements linked by unit audit.
- backend/src/settings/settings.service.ts — include both collections in backups;
  group their restore section; block unsafe raw restore/reset when tracking exists.
- backend/test/integration/settings-backup-coverage.spec.ts
- backend/test/integration/settings-backup-integrity.spec.ts
- backend/test/integration/settings-selective-restore.spec.ts

## Verification commands actually executed

From backend/:

```powershell
node node_modules/jest/bin/jest.js --runInBand --no-cache --coverage=false --runTestsByPath test/unit/inventory-unit-schema.spec.ts test/integration/inventory-unit-model.mongo.spec.ts test/integration/settings-backup-coverage.spec.ts test/integration/settings-selective-restore.spec.ts test/integration/settings-backup-integrity.spec.ts test/unit/product-code.spec.ts test/unit/product-sku-ui.spec.ts test/integration/products-sku.service.spec.ts test/integration/products-sku.mongo.spec.ts test/unit/product-features.spec.ts test/integration/collections.service.spec.ts test/integration/transactions.service.spec.ts test/integration/returns.service.spec.ts test/integration/returns-flow.service.spec.ts test/integration/supplier-returns-complete.service.spec.ts test/integration/supplier-returns-reverse.service.spec.ts test/integration/sr-allocation.service.spec.ts test/unit/inventory-stock.spec.ts test/unit/confirm-pickup-mixed.spec.ts test/unit/bosta-awb.spec.ts test/unit/auth-permissions.spec.ts test/unit/purchases.spec.ts test/unit/sales.spec.ts test/unit/reports.spec.ts test/unit/vault-stock-sync.spec.ts
node node_modules/typescript/bin/tsc --project tsconfig.build.json --noEmit --incremental false
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

From repository root:

```powershell
node scripts/inventory-unit-indexes.cjs --help
node --check scripts/inventory-unit-indexes.cjs
node --test scripts/inventory-diagnostics.test.cjs
git diff --check
& 'C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe' --version
```

Results:

- 25 targeted Jest suites, 452 tests passed; no skipped tests in this run.
- Real MongoDB 8.2.6 tests start their own temporary process/database; no existing
  MongoDB instance is used. Explicit index dry-run/application/idempotency/conflict
  tests ran there, along with reference, uniqueness, retention and concurrency tests.
- Migration preview/model initialization created zero pieces; applying indexes
  created zero unit/event documents and left all legacy fixture values unchanged.
- 15 existing offline diagnostic tests passed, including actual stock-method parity.
- Application-source type-check, migration-script syntax and whitespace checks passed.
- Repository-wide type-check still fails on the pre-existing Mongoose model typing
  errors at test/integration/shopify-config-http.spec.ts:64,91 and implicit-any errors
  in test/unit/shopify-edit-preview.spec.ts. No errors from this implementation remain.
- Existing duplicate schema-index warnings and expected failure-injection logs remain.
- The full repository suite was not run; the targeted regression selection above was.

## Remaining limits / next review

- Production data, MongoDB version/topology, indexes and transaction capabilities
  were not inspected or changed. Local MongoDB 8.2 testing does not certify deployment.
- MongoDB provides no native cross-collection FK. Model-level existence/deletion checks
  and raw-maintenance guards are implemented; raw admin writes bypass them. A future
  writer must coordinate parent mutations/child creation to close concurrent races.
- Line IDs, warehouse registry policy, cardinality/overscan limits, atomic unit+event
  writes, payload-aware idempotency, transitions and physical reconciliation remain
  later work. No API or enforcement should be enabled on these schemas alone.
- Index inspection is the CLI default; production --apply and every backfill require
  separate authorization. No destructive down migration is provided.
- Generic maintenance is deliberately blocked for affected inventory datasets once
  tracking exists. Coordinated complete recovery into a separate database must be
  reviewed, reconciled and tested before cutover.

Stopped at the requested data-model review gate.
