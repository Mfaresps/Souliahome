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
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
