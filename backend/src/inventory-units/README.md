# Inventory unit data model (Implementation 01)

Implementation 01 introduced the two models described below. Implementations 02–04
now add explicit APIs, durable request receipts, manual reconciliation and labels;
see [the current operational contract](IMPLEMENTATIONS-02-04.md). There is still no
automatic backfill, scheduled work or barcode enforcement. Model registration does
not create collections/indexes (`autoCreate` and `autoIndex` are false). Sections
below describe the original schema guarantees and cutover constraints; the current
contract specifies the new transactional writer and APIs.

## Identity and relationships

- `inventoryunits._id`: existing MongoDB ObjectId identity, unique and immutable at
  database level. No additional competing internal ID is needed.
- `barcode`: immutable `SU-` + uppercase hexadecimal `_id` (27 ASCII characters).
  It identifies a physical piece, never the shared Product SKU. A unique index
  prevents duplicate values; document validation binds the value to its `_id`.
- `productId`: immutable string ObjectId reference to existing `products`.
  Soulia has no separate Variant model. `Product.code` remains untouched.
- `warehouseCode`: nullable location key supplied by a future approved receiving/
  reconciliation workflow. It is NOT a foreign key: there is no local Warehouse
  registry. Null means unverified/unassigned; no fictitious default warehouse is
  created and Bosta pickup-location IDs are not treated as warehouse identities.
- `origin.kind`: `purchase`, `opening-stock`, or `legacy-unknown`.
  Purchase origin references an existing supplier purchase transaction containing
  the product. That invoice is the useful batch boundary; no duplicate Batch,
  Purchase, Supplier, or movement model is introduced. Opening stock points to
  the existing Product whose `openingBalance` holds the aggregate. Opening/unknown
  origins require a physical reconciliation reference. Unknown history cannot
  contain a purchase or an opening-stock claim. Origin is immutable after save.
- `assignment`: nullable `{transactionId, lineId}` for one current order line.
  It is required for reserved/picking/prepared/shipped/delivered units and forbidden
  for available units. The sale must exist and contain the same product with that
  stable line ID. Existing `[Object]` transaction items need no schema rewrite,
  but legacy lines have no stable `lineId`: they cannot be assigned until a later,
  explicitly reviewed line-identity step. Array indices are not persistent IDs.
- `registeredByUserId` / `registeredBy`: immutable actor reference and name snapshot.
  Users must exist at creation; snapshots remain meaningful if accounts are later
  removed. HTTP permission checks/actor derivation belong to later APIs.

## State and audit

States: available, reserved, picking, prepared, shipped, delivered, returned,
inspection-required, damaged, returned-to-supplier, lost, retired. New documents
default to inspection-required. These states are tracking metadata: none changes
`getInventory`, purchase/sale posting times, adjustments, valuation or finances.
Returned/inspection-required/damaged pieces are not implicitly sellable.

`inventoryunitevents` is an append-only identity/lifecycle audit. It records unit,
sequence, operation key, action, before/after state, actor and optional existing
transaction/movement references. It has no quantity delta, price, balance or cost.
Existing `inventorymovements` remains the quantity history/manual-adjustment source;
do not synthesize a second movement when adding a unit event.

Unique indexes on `(unitId, sequence)` and `(unitId, operationKey)` prevent duplicate
event slots and duplicate operation recording. They do not themselves implement
request replay, payload comparison, legal state transitions or line-capacity checks.
Those require the later transactional lifecycle writer. Unit `__v` uses Mongoose
optimistic concurrency for document saves. Stock is not derived from these models.

## Reference integrity and deletion

MongoDB has no native foreign keys. Mongoose `ref` metadata is supplemented by
document-save existence checks. Product/purchase/sale/movement deletes are guarded
through ordinary Mongoose query/document/bulk-delete paths when retained tracking
records refer to them. Units cannot be deleted/replaced; retire them. Events cannot
be updated/deleted/replaced. Unit query updates and tracking bulk inserts/writes
are deliberately unavailable because they bypass document reference validation.
Future conditional lifecycle writes must supply equivalent validation explicitly.

These are application-layer constraints, not raw-driver/database administrator
restrictions. Parent-check/child-insert races are NOT a MongoDB foreign key:
the later writer must coordinate parent mutation/deletion with shared write locks
inside verified transactions before enforcement can be enabled. No such writer
or transaction capability assumption is introduced in this phase.

## Explicit additive index migration

From the repository root, set an approved connection in an environment variable
without placing credentials in command arguments, then inspect:

```powershell
node scripts/inventory-unit-indexes.cjs --uri-env SOULIA_AUDIT_MONGODB_URI --db <database>
```

Inspection is read-only. `--apply` explicitly creates only the two new collections
and their missing indexes; it never inserts units/events, updates existing rows,
changes old indexes, drops collections or touches quantities/money. It is not run
at application startup. Production application is a separate approval step.
The runner uses the repository's existing `ts-node` development tooling; run it
from a matching source checkout with backend development dependencies installed.
Conflicting index definitions/TTL indexes fail closed; duplicate keys make unique
index creation fail. A partial index migration can be rerun idempotently after
review; it has no document migration or destructive down migration.

## Historical cutover (documentation only; no backfill included)

1. Take a consistent complete backup; pause affected writes for a reviewed cutover.
   Run the Phase 1 diagnostics and perform a physical count by SKU/location/condition.
2. Never generate units from product count, positive purchase totals, or a received
   PO alone. Products with zero actual physical stock receive no units. Negative,
   fractional or unexplained balances block that SKU's cutover; do not round/fix them.
3. Existing availability already excludes every active sale, including unshipped
   orders. Count sellable unallocated pieces separately from physically present
   pieces allocated to outstanding sales. Do not deduct those sales again.
4. Only attach a purchase origin when evidence identifies that piece's receipt.
   Aggregate invoice quantities do not prove which historical piece remains.
   Otherwise use legacy-unknown and an approved reconciliation reference. An
   opening-stock origin also requires evidence; never invent a supplier, date or cost.
5. Create future backfill records using persistent per-count-item operation keys,
   then reconcile available tracked pieces to existing derived availability and
   allocated on-premises pieces to reviewed outstanding requirements. Event and
   unit writes must be atomic. This phase contains no backfill implementation.
6. Leave enforcement off until reconciliation, legal transitions, allocation
   limits, retry/recovery behavior and transaction topology are reviewed/tested.

## Backup, restore and rollback

Both collections are included in the existing backup registry and share the
`inventoryUnits` restore section. They are excluded from generic clear-data.
Once units/events exist, resets/restores of related inventory collections are
blocked by data-maintenance guards: raw restore otherwise bypasses schema hooks.
Old backups remain usable when there is no tracking data; missing keys do not
mean empty collections. New tracking backups require the complete products,
transactions, movements, units and events datasets for full restoration.

Restore a complete consistent backup into a separate, quiescent database, apply/
verify indexes explicitly, and validate references, counts and financial baseline
before any separately authorized cutover. Existing restore machinery is not an
atomic database-wide restore and does not itself certify reconciliation.

Rollback before any tracking exists: stop loading the new module; leave empty
additive collections/indexes in place. After tracking exists: retain all identities
and audit rows, keep enforcement off and use coordinated recovery. Do not roll
back to an older writer that lacks deletion/maintenance protections against an
active tracking database. Never regenerate IDs or drop audit data as rollback.
