import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TransactionDocument = HydratedDocument<Transaction>;

export class TransactionItem {
  @Prop({ default: '' })
  productId: string;

  @Prop({ required: true })
  code: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: '' })
  imageUrl: string;

  @Prop({ required: true })
  qty: number;

  @Prop({ required: true })
  price: number;

  @Prop({ required: true })
  total: number;

  /**
   * Only meaningful on a 'مرتجع' transaction: سليم | تالف, copied from the approved ReturnRequest.
   * A تالف line is refunded but must NOT re-enter sellable stock — read by
   * `returnedItemQtyForStock`, which both derived-inventory loops go through. Empty/absent means
   * سليم, so every pre-existing return keeps the behaviour it had.
   */
  @Prop({ default: '' })
  condition: string;
}

@Schema({ timestamps: true })
export class Transaction {
  @Prop({ required: true })
  date: string;

  /** Business date chosen by user (YYYY-MM-DD). Defaults to creation date. Immutable created_at is in Mongoose timestamps. */
  @Prop({ default: '' })
  transactionDate: string;

  @Prop({
    required: true,
    enum: ['مبيعات', 'مشتريات', 'مرتجع مبيعات', 'مرتجع مشتريات', 'مرتجع'],
  })
  type: string;

  @Prop({ default: '' })
  client: string;

  /** Optional supplier reference for مشتريات transactions — populated going forward when the
   *  caller supplies it. Historical/unlinked purchases fall back to name matching on `client`. */
  @Prop({ default: '', index: true, sparse: true })
  supplierId: string;

  @Prop()
  phone: string;

  @Prop()
  ref: string;

  @Prop()
  notes: string;

  @Prop({ default: '' })
  payment: string;

  @Prop({ default: 0 })
  deposit: number;

  @Prop({ default: 0 })
  initialDeposit: number;

  @Prop({ default: 0 })
  remaining: number;

  /** Standing supplier ledger credit applied against this purchase's total (مشتريات only). */
  @Prop({ default: 0 })
  creditApplied: number;

  @Prop({ type: [Object], required: true })
  items: TransactionItem[];

  @Prop({ required: true })
  total: number;

  @Prop({ required: true })
  employee: string;

  @Prop()
  shipCo: string;

  @Prop()
  shipZone: string;

  /** شركة الشحن التي رجعت بها شحنة المرتجع من العميل (مرتجع مبيعات فقط، اختياري). */
  @Prop({ default: '' })
  returnShipCo: string;

  /** رقم تتبع شحنة المرتجع لدى شركة الشحن (مرتجع مبيعات فقط، اختياري). */
  @Prop({ default: '' })
  returnTrackingNumber: string;

  @Prop({ default: 0 })
  shipCost: number;

  @Prop({ default: 0 })
  discount: number;

  @Prop({ default: '' })
  discountCodeId: string; // ID of applied discount code (empty if manual)

  @Prop({ default: '' })
  discountCode: string; // Code string for display (e.g. "SUMMER15")

  @Prop({ default: '' })
  discountCodeType: string; // 'percent' | 'fixed' | '' (for code-applied discounts)

  @Prop({ default: 0 })
  manualDiscount: number; // Separate manual discount amount (stored directly, not inferred)

  @Prop({ default: '' })
  manualDiscountType: string; // 'fixed' | 'percent' (for display label only)

  @Prop()
  depMethod: string;

  @Prop({ default: 'معلق' })
  payStatus: string;

  @Prop({ default: 0 })
  itemsTotal: number;

  @Prop({ default: 0 })
  actualShipCost: number;

  @Prop({ default: 0 })
  shipLoss: number;

  @Prop({ default: false })
  cancelled: boolean;

  @Prop()
  cancelReason: string;

  @Prop()
  cancelledBy: string;

  @Prop()
  cancelledAt: string;

  /**
   * Set when a supplier waived this purchase invoice's unpaid remainder (credit-memo treatment).
   * The invoice's own `total`/`items` stay at their original, supplier-agreed values — only
   * `remaining` goes to 0 — so this field is the record of WHY it reads as settled.
   * Shape: { amount, reason, by, at }.
   */
  @Prop({ type: Object, default: null })
  writeOff: Record<string, unknown> | null;

  @Prop({ type: [Object], default: [] })
  editHistory: Record<string, unknown>[];

  @Prop()
  collectMethod: string;

  @Prop()
  collectNote: string;

  @Prop()
  collectedAt: string;

  @Prop({ default: false })
  archived: boolean;

  @Prop()
  archivedAt: string;

  @Prop()
  archivedBy: string;

  /** Cancel request submitted by employee, pending manager approval */
  @Prop({ type: Object, default: null })
  cancelRequest: {
    requestedBy: string;
    requestedById?: string;
    requestedByUsername?: string;
    reason: string;
    requestedAt: string;
    status: string; // 'معلق' | 'معتمد' | 'مرفوض'
    reviewedBy?: string;
    reviewedAt?: string;
    rejectedReason?: string;
  } | null;

  /** Deposit history log - initial and additional deposits */
  @Prop({ type: [Object], default: [] })
  deposits: Array<{
    id?: string;
    amount: number;
    method: string;
    note: string;
    date: string;
    by: string;
    reversed?: boolean;
    reversedAt?: string;
    reversedBy?: string;
    reversalReason?: string;
  }>;

  /** Payment/Collection history log */
  @Prop({ type: [Object], default: [] })
  payments: Array<{
    id?: string;
    amount: number;
    method: string;
    note: string;
    date: string;
    by: string;
    remaining: number;
    reversed?: boolean;
    reversedAt?: string;
    reversedBy?: string;
    reversalReason?: string;
  }>;

  @Prop({ default: '' })
  invoiceImageUrl: string;

  @Prop({ type: [String], default: [] })
  invoiceImages: string[];

  /** Employee comments on transaction */
  @Prop({ type: [Object], default: [] })
  comments: Array<{
    id: number;
    text: string;
    type: string; // 'عام' | 'تنبيه' | 'ملاحظة' | 'أسئلة'
    employee: string;
    timestamp: string;
    createdAt: string;
  }>;

  @Prop({ type: [String], default: [] })
  tags: string[];

  /** Pick-Up tracking: Pending | Preparing | Ready | Shipped | Delivered */
  @Prop({ default: 'Pending' })
  pickupStatus: string;

  /** ISO timestamp when order was shipped to Bosta */
  @Prop({ default: null })
  shippedAt: string;

  /** Employee who clicked "Send to Bosta" (operator name from the create-order request) */
  @Prop({ default: '' })
  shippedByName: string;

  @Prop()
  pickupDate: string;

  @Prop()
  pickupBy: string;

  /** Unique batch reference assigned when a group of orders are confirmed for pick-up */
  @Prop()
  pickupRef: string;

  /** Audit log for pick-up actions */
  @Prop({ type: [Object], default: [] })
  pickupHistory: Array<{
    action: string;      // 'preparing' | 'ready' | 'undo' | 'delivered' | 'revert-delivered'
    date: string;
    by: string;
    note?: string;
  }>;

  /** Preparation tick: true when this order has been marked ready within its prep group */
  @Prop({ default: false })
  prepChecked: boolean;

  /** Prep group metadata — persisted so groups survive localStorage wipe */
  @Prop({ default: '' })
  prepNote: string;

  @Prop({ default: '' })
  prepShipCo: string;

  @Prop({ default: '' })
  prepCreatedAt: string;

  @Prop({ default: '' })
  prepCreatedBy: string;

  /** Shopify order numeric ID — used to build admin link */
  @Prop({ default: '' })
  shopifyOrderId: string;

  /** Original creation time of the order in Shopify (before sync to this system) */
  @Prop({ default: '' })
  shopifyCreatedAt: string;

  /** Employee responsible for this order per shift-based auto-assignment (denormalized from ShopifyOrder.assignedToName at approval time) */
  @Prop({ default: '' })
  assignedToName: string;

  /** When the order was assigned to that employee (denormalized from ShopifyOrder.assignedAt). Empty on orders created before this field existed — the audit footer falls back to depositDetectedAt there. */
  @Prop({ default: '' })
  assignedAt: string;

  /** Who approved the originating ShopifyOrder into this transaction (denormalized from ShopifyOrder.reviewedBy) */
  @Prop({ default: '' })
  confirmedByName: string;

  /** When that approval happened (denormalized from ShopifyOrder.reviewedAt). Distinct from `date`, which carries the original Shopify order date. */
  @Prop({ default: '' })
  confirmedAt: string;

  /** When the deposit-note parser last ran on the originating ShopifyOrder (denormalized from ShopifyOrder.depositDetectedAt) */
  @Prop({ default: '' })
  depositDetectedAt: string;

  /** Shipping address (from Shopify or manual entry) */
  @Prop({ default: '' })
  shippingAddress: string;

  /** Shipping city extracted from Shopify shipping_address.city */
  @Prop({ default: '' })
  shippingCity: string;

  /** Governorate (محافظة) — set by city picker, used for Bosta mapping */
  @Prop({ default: '' })
  shippingGov: string;

  /** Bosta-accepted English city name — set directly by city picker to avoid translation errors */
  @Prop({ default: '' })
  shippingBostaCity: string;

  // ── Bosta Shipping Integration ─────────────────────────────────────────────

  /** Bosta order ID returned after successful creation */
  @Prop({ default: '' })
  bostaOrderId: string;

  /** Bosta tracking number (waybill number) */
  @Prop({ default: '' })
  bostaTrackingNumber: string;

  /**
   * Bosta shipment status — mirrors Bosta state codes:
   * CREATED | PICKED_UP | IN_TRANSIT | OUT_FOR_DELIVERY |
   * DELIVERED | RETURNED | CANCELLED | FAILED_ATTEMPT
   */
  @Prop({ default: '' })
  bostaStatus: string;

  /** Human-readable Arabic label for bostaStatus */
  @Prop({ default: '' })
  bostaStatusLabel: string;

  /** ISO timestamp of last Bosta status sync */
  @Prop({ default: '' })
  bostaLastSync: string;

  /** Full Bosta API response payload — for audit / debugging */
  @Prop({ type: Object, default: null })
  bostaRawResponse: Record<string, unknown> | null;

  /**
   * Audit trail of out-of-order Bosta status updates that were ignored because
   * they would have regressed bostaStatus backwards (e.g. a delayed
   * OUT_FOR_DELIVERY webhook arriving after DELIVERED was already recorded).
   */
  @Prop({ type: [Object], default: [] })
  bostaStatusIgnoredEvents: Array<{
    at: string;            // ISO timestamp the ignored event was received
    source: string;        // 'sync' | 'webhook'
    currentStatus: string; // status that was kept
    incomingStatus: string; // status that was rejected
  }>;

  // ── Manual Delivery Confirmation (legacy orders) ───────────────────────────

  /** '' | 'BOSTA' | 'MANUAL' | 'SYSTEM' — how delivery was confirmed */
  @Prop({ default: '' })
  deliverySource: string;

  /** ISO timestamp delivery was confirmed */
  @Prop({ default: '' })
  deliveredAt: string;

  /** User (username) who manually confirmed delivery */
  @Prop({ default: '' })
  deliveredBy: string;

  /** Audit trail for manual delivery confirmations on legacy/edge-case orders */
  @Prop({ type: [Object], default: [] })
  deliveryAuditLog: Array<{
    action: string;          // 'MANUAL_DELIVERY_CONFIRMATION' | 'MANUAL_DELIVERY_UNDO'
    previousStatus: string;
    newStatus: string;       // 'DELIVERED' | previousStatus (on undo)
    reason: string;
    note?: string;
    by: string;
    at: string;
    // Snapshot of fields overwritten by the confirmation — used to precisely
    // restore state on undo. Only present on MANUAL_DELIVERY_CONFIRMATION entries.
    previousStatusLabel?: string;
    previousShippingStatus?: string;
    previousCodCollectionStatus?: string;
    previousPickupStatus?: string;
  }>;

  // ── COD (Cash-on-Delivery) Collection Tracking ─────────────────────────────

  /**
   * Granular Bosta shipping status — separate from bostaStatus (raw API code).
   * Values: Created | PickedUp | InTransit | OutForDelivery | Delivered | Returned | Cancelled
   * Set on every syncStatus call so the UI can show a progress timeline.
   */
  @Prop({ default: '' })
  bostaShippingStatus: string;

  /**
   * COD payment collection status — independent of shipping delivery status.
   * Shipping DELIVERED does NOT automatically advance this to Collected.
   *
   * Values:
   *   ''                     – not a COD order (prepaid / no COD amount)
   *   'PendingPayment'       – order not yet delivered (deposit paid / awaiting delivery)
   *   'DepositPaid'          – partial deposit paid, rest COD
   *   'CODWaitingCollection' – delivered by Bosta, employee must confirm cash receipt
   *   'CollectionProcessing' – transient atomic lock held during confirmCodCollection();
   *                            reverted to CODWaitingCollection on vault failure so employee can retry
   *   'Collected'            – employee confirmed receiving COD cash; vault income entry created
   *   'FailedCollection'     – collection attempt failed (shipment returned or cancelled)
   *   'ReversedCollection'   – previously Collected COD was reversed because the transaction
   *                            was cancelled; a negative vault entry offsets the original income
   */
  @Prop({ default: '' })
  codCollectionStatus: string;

  /** ISO timestamp when COD was confirmed as collected */
  @Prop({ default: '' })
  codCollectedAt: string;

  /** Employee who confirmed the COD collection */
  @Prop({ default: '' })
  codCollectedBy: string;

  /** Payment method used for COD collection (كاش / فودافون كاش / Instapay / تحويل بنكي) */
  @Prop({ default: '' })
  codCollectionMethod: string;

  /** Vault entry ID created when COD was confirmed — used for audit trail linking */
  @Prop({ default: '' })
  codVaultEntryId: string;

  /**
   * Immutable snapshot of the COD amount sent to Bosta at shipment creation.
   * Set once in createOrder and never changed — used as the canonical collection amount.
   * Prevents drift if `remaining` is later edited between delivery and collection.
   */
  @Prop({ default: 0 })
  bostaOriginalCod: number;

  /** Amount actually collected (stored for reversal reference after remaining is zeroed) */
  @Prop({ default: 0 })
  codCollectedAmount: number;

  /** Vault entry ID for the COD reversal, if a collected COD was reversed on cancellation */
  @Prop({ default: '' })
  codReversalVaultEntryId: string;

  /** ISO timestamp when COD collection was reversed */
  @Prop({ default: '' })
  codReversedAt: string;

  /** Operator who reversed the COD collection */
  @Prop({ default: '' })
  codReversedBy: string;

  /**
   * Full immutable audit log of every COD collection action.
   * Each entry records who did what and when — never deleted or mutated.
   */
  @Prop({ type: [Object], default: [] })
  codCollectionHistory: Array<{
    action: string;        // 'confirmed' | 'reversed' | 'vault_error' | 'failed' | 'note_added'
    by: string;            // employee username
    at: string;            // ISO timestamp
    amount: number;        // amount collected (negative for reversals)
    method: string;        // payment method
    note?: string;         // optional free-text
    vaultEntryId?: string; // linked vault entry
    bostaRef?: string;     // Bosta tracking/order reference for traceability
  }>;

  // ── Failed-delivery processing ─────────────────────────────────────────────
  // These five fields are the whole "does this order still need attention?"
  // answer. They exist because the dashboard's مشاكل الشحن card used to read
  // `bostaStatus` directly, and Bosta never changes RETURNED once it settles —
  // so a row could enter that card and had no way to ever leave it.
  //
  // ⚠ The card must filter on `shipIssueState`, never on `bostaStatus`.

  /**
   * ''          – no delivery problem was ever reported
   * 'open'      – reported; nobody has resolved it yet
   * 'reshipped' – a new waybill went out, the order is back in the shipping cycle
   * 'awaiting'  – goods heading back to us; physical receipt not confirmed yet
   * 'closed'    – finished, whatever the outcome. Leaves the card.
   */
  @Prop({ default: '' })
  shipIssueState: string;

  /** ISO timestamp the problem was first reported by the courier */
  @Prop({ default: '' })
  shipIssueOpenedAt: string;

  /** Courier status code that opened it, e.g. 'RETURNED' */
  @Prop({ default: '' })
  shipIssueTrigger: string;

  /**
   * The closing decision. Written once by closeFailedDelivery() and never edited.
   * `null` until closed — declared `type: Object` because a nullable @Prop with
   * no explicit type throws CannotDetermineTypeError at module load and takes
   * the entire API down with it (see CLAUDE.md).
   *
   *   outcome:      'refused' | 'unreachable' | 'bad-address' | 'courier-error' | 'lost'
   *   goodsBack:    false only for 'lost' — the shipment never came back
   *   returnShipCost: what the courier charges for the return leg. Recorded as a
   *                 cost on this order, NOT posted to the vault: the courier nets
   *                 it out of other orders' collections, so the vault already
   *                 falls by that amount when the smaller transfer lands.
   *   refundAmount / shipRetained: set only when the customer's money was held.
   */
  @Prop({ type: Object, default: null })
  failedDelivery: {
    outcome: string;
    goodsBack: boolean;
    returnShipCost: number;
    refundAmount: number;
    shipRetained: number;
    refundVaultEntryId?: string;
    retainedVaultEntryId?: string;
    note?: string;
    closedAt: string;
    closedBy: string;
  } | null;

  /**
   * One entry per waybill this order has travelled on. Needed because
   * bostaOrderId/bostaTrackingNumber are single fields: shipping a second time
   * overwrites them, erasing the record of the attempt that failed. Appended by
   * reship() before the new waybill is created.
   */
  @Prop({ type: [Object], default: [] })
  shipmentAttempts: Array<{
    attemptNo: number;
    bostaOrderId: string;
    bostaTrackingNumber: string;
    finalStatus: string;   // status this attempt ended on, e.g. 'RETURNED'
    shipCost: number;      // what this attempt cost
    chargedToCustomer: boolean;
    startedAt: string;
    endedAt: string;
    by: string;
  }>;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
