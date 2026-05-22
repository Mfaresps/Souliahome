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

  /** Pick-Up tracking: Pending | Preparing | Ready | Delivered */
  @Prop({ default: 'Pending' })
  pickupStatus: string;

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

  /** Shipping address (from Shopify or manual entry) */
  @Prop({ default: '' })
  shippingAddress: string;

  /** Shipping city extracted from Shopify shipping_address.city */
  @Prop({ default: '' })
  shippingCity: string;

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
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
