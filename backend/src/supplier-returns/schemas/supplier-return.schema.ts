import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SupplierReturnOrderDocument = HydratedDocument<SupplierReturnOrder>;

export class SrAllocationDetail {
  code: string;
  qty: number;
  unitCost: number;
  sourceTransactionId: string;
  sourceRef: string;
}

export class SupplierReturnItem {
  code: string;
  name: string;
  qty: number;
  price: number;
  total: number;
  note?: string;
  /** Which source invoice(s)/cost this line's returned units were drawn from. Populated by the
   *  server for every allocation method (including 'single-invoice', for a uniform data source). */
  allocations: SrAllocationDetail[];
}

export class SrLinkedInvoice {
  transactionId: string;
  ref: string;
  date: string;
  allocatedTotal: number;
}

export class SrStatusEntry {
  status: string;
  changedBy: string;
  changedAt: string;
  note?: string;
}

export class SrSettlement {
  debtBalanceBeforeApplied: number;
  returnValue: number;
  debtOffsetAmount: number;
  creditAmount: number;
  refundAmount: number;
  settlementType: string;
  debtBalanceAfter: number;
  decidedBy: string;
  decidedAt: string;
}

/** Populated by reverseReturn() — an additive fact, not a status transition. status stays
 *  'مكتمل' after reversal; this field's presence is what "reversed" means. */
export class SrReversalInfo {
  reversedBy: string;
  reversedAt: string;
  reason: string;
  reversalTransactionId: string;
  reversedLedgerEntryIds: string[];
  balanceBeforeReversal: number;
  balanceAfterReversal: number;
}

@Schema({ timestamps: true })
export class SupplierReturnOrder {
  @Prop({ required: true })
  supplierId: string;

  @Prop({ required: true })
  supplierName: string;

  @Prop({ required: true, unique: true })
  returnNumber: string;

  /** @deprecated Use linkedInvoices[]. Kept populated = linkedInvoices[0].transactionId when exactly one invoice governs the return, else ''. Preserved for backward-compat reads (legacy frontend). */
  @Prop({ default: '' })
  originalTransactionId: string;

  /** @deprecated Use linkedInvoices[0].ref. */
  @Prop({ default: '' })
  originalRef: string;

  /** @deprecated Use linkedInvoices[0].date. */
  @Prop({ default: '' })
  originalDate: string;

  @Prop({ type: [Object], default: [] })
  linkedInvoices: SrLinkedInvoice[];

  @Prop({
    required: true,
    enum: ['single-invoice', 'fifo', 'average', 'manual', 'none'],
    default: 'single-invoice',
  })
  allocationMethod: string;

  @Prop({ required: true })
  returnDate: string;

  @Prop({
    required: true,
    enum: ['تلف المنتج', 'منتج خاطئ', 'مشكلة جودة', 'أخرى'],
  })
  reason: string;

  @Prop({ default: '' })
  reasonDetails: string;

  @Prop({ type: [Object], required: true })
  items: SupplierReturnItem[];

  @Prop({ default: 0 })
  itemsTotal: number;

  @Prop({ required: true })
  total: number;

  @Prop({
    default: 'معلق',
    enum: ['مسودة', 'معلق', 'معتمد', 'مكتمل', 'مرفوض', 'ملغي'],
  })
  status: string;

  /** Optional at create-time: whether any cash leaves the vault isn't known until complete()
   *  decides the settlement split, so asking for a vault segment up front is premature. It's
   *  supplied (or overridden) at completion when a refund portion actually exists — complete()
   *  enforces its presence only in that case. Still populated on older records. */
  @Prop({ default: '' })
  vaultRefundAccount: string;

  @Prop({ required: true })
  createdBy: string;

  @Prop()
  approvedBy: string;

  @Prop()
  approvedAt: string;

  @Prop()
  rejectedReason: string;

  @Prop({ default: '' })
  linkedTransactionId: string;

  /** Populated by complete() — the debt/credit/refund breakdown actually applied. */
  @Prop({ type: Object, default: null })
  settlement: SrSettlement | null;

  /** Populated by reverseReturn() — presence means this completed return's inventory/ledger/vault
   *  effects have been undone. status remains 'مكتمل'; this is what actually marks reversal. */
  @Prop({ type: Object, default: null })
  reversal: SrReversalInfo | null;

  @Prop({ type: [Object], default: [] })
  statusHistory: SrStatusEntry[];
}

export const SupplierReturnOrderSchema =
  SchemaFactory.createForClass(SupplierReturnOrder);
SupplierReturnOrderSchema.index({ supplierId: 1, status: 1 });
SupplierReturnOrderSchema.index({ returnNumber: 1 }, { unique: true });
SupplierReturnOrderSchema.index({ originalTransactionId: 1 });
SupplierReturnOrderSchema.index({ 'linkedInvoices.transactionId': 1 });
SupplierReturnOrderSchema.index({ 'reversal.reversedAt': 1 });
