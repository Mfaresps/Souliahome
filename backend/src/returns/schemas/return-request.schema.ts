import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ReturnRequestDocument = HydratedDocument<ReturnRequest>;

export class ReturnItem {
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

  /**
   * سليم | تالف — see RETURN_ITEM_CONDITIONS. A تالف unit is refunded to the customer but does
   * NOT re-enter sellable stock: TransactionsService reads this field off the return transaction's
   * items when deriving inventory. Defaults to سليم so pre-existing rows keep today's behaviour.
   */
  @Prop({ default: 'سليم' })
  condition: string;
}

@Schema({ timestamps: true })
export class ReturnRequest {
  @Prop({ required: true })
  originalTransactionId: string;

  @Prop({ required: true })
  originalRef: string;

  @Prop({ required: true })
  originalDate: string;

  @Prop({ required: true })
  client: string;

  @Prop()
  phone: string;

  @Prop({ type: [Object], required: true })
  items: ReturnItem[];

  @Prop({ required: true })
  total: number;

  @Prop({ default: 0 })
  itemsTotal: number;

  @Prop({ default: 0 })
  actualShipCost: number;

  @Prop({ default: 'return' })
  requestKind: string;

  @Prop({ type: [Object], default: [] })
  exchangeItems: ReturnItem[];

  @Prop({ default: 0 })
  exchangeTotal: number;

  @Prop({ default: 0 })
  priceDifference: number;

  @Prop({ required: true })
  reason: string;

  @Prop()
  reasonDetails: string;

  @Prop({ required: true })
  requestedBy: string;

  @Prop({ default: 'معلق' })
  status: string;

  @Prop()
  approvedBy: string;

  @Prop()
  approvedAt: string;

  @Prop()
  rejectedReason: string;

  @Prop({ default: 0 })
  daysRemaining: number;

  @Prop({ default: 14 })
  maxReturnDays: number;

  /** قسم الخزنة لسحب مبلغ الرد للعميل (استرجاع أو فرق استبدال لصالح العميل). */
  @Prop({ default: '' })
  vaultRefundAccount: string;

  /** قسم الخزنة لإيداع مبلغ التحصيل عندما الفرق لصالح الشركة (استبدال). */
  @Prop({ default: '' })
  vaultCollectAccount: string;

  /** شركة الشحن التي رجعت بها الشحنة المرتجعة من العميل (اختياري). */
  @Prop({ default: '' })
  returnShipCo: string;

  /** رقم تتبع شحنة المرتجع لدى شركة الشحن (اختياري). */
  @Prop({ default: '' })
  returnTrackingNumber: string;

  /**
   * The 'مرتجع' transaction created at approval. Without it, cancelling that transaction could not
   * be traced back here, which is what left reversed returns permanently deducted from net sales.
   */
  @Prop({ default: '' })
  returnTxId: string;

  /** Ref given to the return transaction — `{originalRef}-RET`, then `-RET-2`, `-RET-3`… */
  @Prop({ default: '' })
  returnTxRef: string;

  /**
   * 1 for the first return against an invoice, 2 for the second… Drives the ref suffix, so two
   * partial returns on one invoice can no longer collide on `{ref}-RET`.
   */
  @Prop({ default: 1 })
  sequence: number;

  /**
   * Ceiling the refund was validated against, stored for audit: an approver reading the request a
   * week later can see what the cap was without re-deriving the invoice's discount allocation.
   */
  @Prop({ default: 0 })
  maxRefundable: number;

  /** Value of the units returned as تالف — refunded but never added back to sellable stock. */
  @Prop({ default: 0 })
  damagedValue: number;

  /**
   * Set when the approved return's transaction is cancelled. Every aggregate filters on it
   * (NOT_REVERSED_FILTER) — status stays 'معتمد', mirroring how SupplierReturnOrder marks reversal.
   */
  @Prop({ default: null })
  reversedAt: string | null;

  @Prop({ default: '' })
  reversedBy: string;

  @Prop({ default: '' })
  reversalReason: string;
}

export const ReturnRequestSchema =
  SchemaFactory.createForClass(ReturnRequest);
