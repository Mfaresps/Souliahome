# Inventory tracking backend, operational safety and labels

This is the specification and operational contract for Implementations 02–04.
Implementation 01's report is historical. This module now has explicit APIs;
there is still no startup migration/backfill, automatic stock posting or enforcement.

Scope clarification: the subsequently supplied Implementation 03 bulk legacy migration
specification is not implemented by the manual reconciliation APIs below. A batch
dry-run/apply/approval/resume workflow remains outstanding. The existing Implementation
04 interface is available for isolated verification, but that migration prerequisite
has not passed and production readiness is not established.

## Verified existing behavior

- `TransactionsService.getInventory` is authoritative: opening balance + supplier
  purchases + sound customer returns - sales - supplier returns + manual adjustments.
  Cancelled/archived transactions are excluded. Product codes are trimmed and case-sensitive.
- Sales consume aggregate availability when posted, BEFORE preparation. Purchases
  contribute when their transaction is posted, not when a unit label is generated.
- `ShopifyService.approveOrder` posts its own transaction; it is not unit registration.
- `setPickupPreparing`, `togglePrepChecked` and `confirmPickup` use order-level
  statuses/booleans. They do not establish physical custody of an individual piece.
- `BostaService.createOrder` accepts Preparing/Ready/Picked-Up and has its own
  retry/resend behavior. Creation of an AWB is not physical carrier handover.
- Returns, deposits, refunds, COD, fees, supplier ledgers and vault effects stay in
  their existing services. Tracking calls never invoke those posting functions.

## Implementation 02 specification and acceptance contract

### Data and write boundary

Keep Product.code and all unit IDs/barcodes immutable. Existing unit/event schemas
remain the source of identity and lifecycle history. Add `inventoryunitoperations`,
an append-only durable request receipt with a string SHA-256 `_id`, canonical payload
fingerprint, kind, actor, result and timestamp. No TTL or expiry is allowed.

Every tracking write:

1. Requires JWT authentication and an explicit action permission. The service also
   validates action permissions and requires a live, active database User. Names in
   audit rows come from that User, never a client-supplied actor field.
2. Verifies replica-set/mongos, session and wire-version capabilities via `hello`,
   plus every required tracking index. Fails closed; no standalone fallback, no
   automatic index migration and no database connection from an implicit script URI.
3. Uses snapshot/majority `withTransaction`; successful writes prove actual transaction
   execution, rather than relying only on `hello`. Unit save, event and request receipt
   commit together. The callback performs no external network or accounting effect.
4. Locks the affected Product(s), sorted for label batches, with tracking-only
   `unitTrackingRevision`. Allocation also writes a tracking revision on the sale,
   serializing competing claims/capacity checks. These fields have no stock meaning.
5. Replays an identical committed receipt, including after restart/recovery; rejects
   the same actor/key with a different route/payload. Event operationKey is the same
   actor/key hash as the receipt ID, so different actors cannot collide accidentally.
   Event sequence and operation
   uniqueness remain database constraints. No success is inferred from duplicate-key
   errors without checking the committed receipt fingerprint.

Lifecycle events also preserve server-built before/after assignment/location and
physical-confirmation snapshots in an optional `details` field. Existing events remain
valid; there is no history rewrite or additional quantity ledger.

The legacy product/order writers do NOT share a comprehensive coordination protocol.
They can edit/cancel after a tracking commit, or race a parent retention pre-check.
This is an explicit activation blocker, not a claim of native MongoDB foreign keys.
Tracking mode must remain advisory; no production enforcement is provided here.

### Unit registration and receiving

`POST /inventory-units` registers ONE physically attested piece. It never generates
pieces from purchase quantities or product lists. Required: productId, originKind,
countReference, observedPhysicalCount (>0 integer), physicalPossessionConfirmed=true,
operationKey and reason. Optional: warehouseCode and purchaseTransactionId.

New pieces always enter `inspection-required`. Count references are scoped to a
product; observed counts cannot change under the same reference. Registrations in
that count cannot exceed its attested count. Purchase provenance additionally requires
a live real supplier purchase containing the SKU and cannot exceed its invoiced qty
across registrations. Purchase transaction is the batch; do not create another PO,
purchase, inventory movement or financial entry. An invoice alone is insufficient
evidence that its goods are physically present.

Operators must NOT count the same piece under multiple count references. Software
cannot distinguish an unlabelled piece counted twice; custody/count procedures are
required. Unknown historical provenance MUST use `legacy-unknown`, not an inferred
purchase/supplier. Opening provenance requires actual opening-stock evidence.

### Lifecycle API

`POST /inventory-units/:identifier/actions`, identifier = ObjectId or exact backend
barcode. All actions require operationKey, nonblank reason, expectedVersion. Stale
versions return 409. Duplicate request keys replay; new duplicate scan operations
   are rejected by state/capacity checks. Backend derives product identity from the unit.

| action | required source | result / additional requirements |
| --- | --- | --- |
| inspect | unassigned inspection-required / returned | available; passed inspection, physical confirmation and evidenceReference |
| reserve | unassigned available | reserved; exact live sale transactionId + lineId for same SKU; safe integer qty and remaining line entitlement |
| picking | reserved | picking; physical confirmation + evidence |
| prepare | picking | prepared; physical confirmation + evidence |
| release | reserved / picking / prepared | inspection-required, clears assignment; physical confirmation + evidence even if sale cancelled |
| ship | prepared | shipped; explicit physical handover confirmation + evidence, never AWB inference |
| deliver | shipped | delivered; explicit delivery confirmation + evidence |
| return | shipped / delivered | returned, clears assignment; explicit physical receipt + evidence; NOT a refund |
| damage | unassigned available / inspection-required / returned | damaged; physical confirmation + evidence; no automatic stock adjustment |
| lost | unassigned available / inspection-required / returned | lost; physicalCountConfirmed=true + investigation evidence, not a false claim of possession; no automatic adjustment |
| warehouse | unassigned | status unchanged; explicit location, physical confirmation + evidence |

Per user approval, allocated damaged/lost pieces, repair, recovered losses, supplier handback and retirement
are deliberately unavailable pending a reviewed custody recovery policy. No silent
release on cancellation. Returned pieces cannot become available without inspection.
Historical shipped unit IDs continue to consume that sale line's dispatch entitlement;
a return cannot reopen the original line for another dispatch. Reshipments require
a separately reviewed replacement/sale in existing workflows. No automatic replacement
order, charge, refund or inferred stock adjustment is created by this module.

Legacy transaction items are plain objects without stable line IDs. Explicit
`POST /inventory-units/orders/:id/identify-lines` adds UUID line IDs ONLY to missing
IDs on a live sale, retains existing IDs, rejects duplicates, preserves every business
field and stores the request/result as an audited receipt. No startup/history rewrite.
This metadata step is required before allocating legacy lines. Array indices are
never used as persistent line identity. Existing legacy edit paths may replace lines;
such assignments must be reconciled again, not silently retargeted.

### Query and label APIs

| method / path under `/inventory-units` | contract / permission |
| --- | --- |
| GET `/config` | statuses, explicit templates, QR symbology, enforcement=false; inventory-units-view |
| GET `/` | q (name, colors, size, SKU, barcode, unit ID), productId, status, page, limit (1–100); separate products and units; inventory-units-view |
| GET `/:identifier` | unit + latest 200 ordered events; inventory-units-view |
| GET `/readiness` | topology/index diagnostics only; inventory-units-reconcile |
| POST `/` | register; inventory-units-register |
| POST `/orders/:id/identify-lines` | explicit line metadata; inventory-units-allocate |
| POST `/:identifier/actions` | reserve/release/picking/prepare: inventory-units-allocate; all other actions: inventory-units-condition |
| POST `/labels/preview` | read-only graphics; inventory-units-view |
| POST `/labels/requests` | durable print/reprint request; inventory-units-view AND inventory-units-print |
| GET `/reconciliation` | informational reconciliation; inventory-units-reconcile |
| GET `/reconciliation/counts` | latest 100 counts + reviews, optional productId; inventory-units-reconcile |
| POST `/reconciliation/counts` | physical count attestation; inventory-units-reconcile |
| POST `/reconciliation/reviews` | accept/reject count evidence; inventory-units-reconcile-approve |

Preview/request body: unitIds (1–100 unique ObjectIds), sizeId (`50x30`, `60x40`,
`70x40`, `80x40`, `80x50`, `100x50` or `100x70`, all millimeters),
operationKey and reason. Responses contain exact stable unitId, barcode, SKU, product
name, SVG, template mm dimensions and physicalPrintingVerified=false. No client identity
generation. Request/reprint events describe requests, not actual physical printing.
GET search returns at most 100 product cards with an explicit truncation indicator;
unit search includes all matching products and is independently paginated.

Admin retains the repository's existing permission bypass. No staff/viewer account
receives permissions automatically. Permissions are separately assignable in the UI.

## Implementation 03 specification and acceptance contract

Reconciliation uses the EXISTING `getInventory`, not a copied stock calculator.
Reports compare available units with aggregate availability, separately show explicitly
allocated on-premises pieces, unknown provenance, quarantined/damaged/lost pieces,
missing/duplicate SKUs, stale/over-capacity allocations and orphan unit references.
Negative/fractional aggregate values block the quantity check.

Report reads are explicitly non-atomic relative to legacy writers. A passing numeric
check is NOT cutover approval. `activationAllowed` and `enforcementEnabled` stay false.

`POST /reconciliation/counts`: productId, countReference, observedUnallocated,
observedAllocatedOnPremises, physicalPossessionConfirmed=true, operationKey, reason.
Stores the actor, observations and report snapshot in a permanent receipt. Returns
operationId. Counts never create units or change financial balances.

`POST /reconciliation/reviews`: countOperationId, decision (`accept-evidence` /
`reject-evidence`), operationKey, reason. Dedicated permission required. One committed
review per count; new evidence requires a new count. Accepting evidence does NOT
approve an inventory adjustment: discrepancies remain `...still-blocked`. Rejection
requires recount. All decisions retain the original count and its actor.

Outstanding sales are ALREADY deducted from aggregate availability. Physically count
unallocated sellable goods separately from units still held for those sales. Register
the latter only with custody evidence, allocate against their existing lines and do
not subtract their quantity again. Order status is not physical-possession evidence.
Fully discounted sales, deposits, COD and fees have no bearing on piece identity.

Legacy backfill is explicit per physically counted unit, using stable request keys,
unknown provenance when necessary and quarantine before inspection. No production
backfill is executed. Damaged/lost units can expose a discrepancy against aggregate
availability; an authorized user must resolve it through the EXISTING adjustment/
return workflow after financial review. This module never resolves it automatically.

### Controlled activation and required future decisions

There is NO activation switch/API in this delivery. Before a separately approved
production activation: verify production topology/indexes; pause affected writes;
take a consistent complete backup; physically reconcile every scoped SKU and open
sale; resolve discrepancies through approved existing workflows; verify recovery;
coordinate all legacy mutation/deletion paths with tracking. Review physical custody
handling for assigned damaged/lost units, repair/recovery, supplier returns and
reshipments that lack a distinct existing replacement sale. These alternatives can
affect valuation or balances and are not invented here.

### Backup, restoration, rollback and recovery

- Backups include products, transactions, inventorymovements, users, units, events
  and inventoryunitoperations. Retry receipt STRING IDs/fingerprints must survive JSON
  restore unchanged; standard ObjectId conversion must not regenerate them.
- Once any tracking collection has records, generic affected resets/partial restores
  remain blocked. Full tracking recovery requires all related datasets, including
  operations. Missing collections in older backups never mean permission to erase them.
- Restore a consistent full backup into a SEPARATE quiescent database, apply additive
  indexes explicitly, verify identity/event sequences, references, receipt replay,
  counts and financial baseline before an authorized cutover. Existing backup APIs
  are not database-wide atomic snapshots; take writes offline for a consistent copy.
- A failed tracking transaction leaves no unit/event/receipt/revision commit. On an
  uncertain response retry the identical actor/key/payload. Different keys are new
  operations. Inspect committed receipt/event history before manual recovery.
- Before any tracking: roll back loading the feature, retain empty additive indexes.
  After tracking exists: disable routes/navigation, preserve identities/events/receipts
  and retain maintenance/deletion safeguards; do not run an older unprotected writer.
  No destructive down migration or identity regeneration is supplied.

Explicit migration (dry-run is default; URI must be supplied in an approved environment
variable, never command text):

```powershell
node scripts/inventory-unit-indexes.cjs --uri-env SOULIA_AUDIT_MONGODB_URI --db <database>
# --apply requires separate approval for production. Never run Nest startup as a migration.
```

## Implementation 04 specification and acceptance contract

`#barcodes` uses the existing minimal UI, JWT API helper, permission registry, navigation
and Arabic/English language setting. Products/SKUs and individual units have separate
sections. Search is debounced, paginated and supports product size/colors rather than
inventing a Variant collection. Selection is a Set capped at 100; batch responses are
checked against exact IDs, uniqueness and supported templates.

QR is an individually encoded 2D barcode using the existing installed `qrcode@1.5.4`
dependency, without another library/CDN. It encodes EXACT backend barcode text, includes
four-module quiet zones and uses SVG to avoid bitmap blur. A QR-capable scanner or
camera is required; a linear-only laser scanner is not certified by this delivery.
Templates are 60×40mm / 23mm QR and 80×50mm / 28mm QR with 2mm margins. They are digital
layouts, not a claim that a specific printer supports those dimensions. Size selection
is explicit; there is no default paper size or silent substitution.

Labels include product name, SKU, full human-readable Unit ID and exact barcode.
Preview is read-only. Single/batch printing use existing units only, record append-only
print-request/reprint-request events and keep a stable operation key on uncertain
network retries. Controls lock during preview/printing. Actual rendered overflow or
image failure blocks printing rather than shrinking codes or clipping identifiers.

Print documents use mm dimensions, @page with matching size, zero page margin,
one label per page, no blank trailing page and SVG images. Browser settings still
require matching paper, 100% scaling, zero margins, disabled headers/footers and
printer-driver validation. Dialog open/close is NEVER reported as physical success.
Actual printer/label stock, adhesive/media, scan distance and readable contrast must
be validated physically before production printing is approved.

Loading, empty, error, denied-access and request-recorded states are explicit. Responsive
cards and labelled controls support desktop/mobile. No receiving, order preparation,
Shopify approval, Bosta shipment, aggregate quantity or accounting UI was rewritten.

## Acceptance tests

Isolated real MongoDB replica set: immutable uniqueness, topology/index gating,
transaction rollback, concurrent count admission, allocation/capacity conflicts,
duplicate scan/replay, wrong SKU, receipt caps, cancellation custody, returns,
damaged/lost allocation rejection, dispatch/reship limits, durable recovery and
financial/aggregate baseline preservation. A separate disposable standalone verifies
fail-closed writes. No test uses application connection credentials or AppModule.

Real Chromium: mobile/tablet/desktop overflow, explicit label sizes, exact identities,
preview-only behavior, mm dimensions/PDF page sizes and pagination, print retries,
duplicate-free batches, unsafe text escaping, overflow blocking, permissions,
empty/error/localized states. Existing transaction, stock, return, SKU, Shopify,
Bosta, permissions and backup regressions must remain green. Physical printer testing
is a separate mandatory release gate, not an automated-test claim.
