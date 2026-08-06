import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SupplierLedgerEntryDocument = HydratedDocument<SupplierLedgerEntry>;

/**
 * Sign convention: amount > 0 increases the payable balance (we owe the supplier more).
 * amount < 0 decreases it (we owe less, or it goes negative = standing credit in our favor).
 * runningBalance is the payable balance immediately AFTER this entry is applied.
 * This is the opposite sign convention from VaultEntry.amount (positive = cash in) —
 * intentional, since the ledger tracks our liability to the supplier, not our cash.
 */
export const SR_LEDGER_ENTRY_TYPES = [
  'purchase-debt', // +amount: new مشتريات invoice booked on credit (total - upfront deposit)
  'payment', // -amount: TransactionsService.collect() payment to supplier
  'return-debt-offset', // -amount: supplier-return value applied against outstanding debt
  'return-credit', // -amount: supplier-return value beyond debt, converted to standing credit
  'credit-used', // +amount: standing credit consumed against a new purchase
  'refund-paid', // amount:0 — audit-only row; cash refund is captured by the vault entry, not netted here
  'manual-adjustment', // signed, admin-entered correction, always requires a reason
  'advance-deposit', // -amount: cash paid to the supplier ahead of any invoice; ALSO withdraws from a vault segment
  'debit-adjustment', // +amount: cash-neutral increase of what we owe (supplier-side charge/correction)
] as const;

export type SrLedgerEntryType = (typeof SR_LEDGER_ENTRY_TYPES)[number];

@Schema({ timestamps: true })
export class SupplierLedgerEntry {
  @Prop({ required: true, index: true })
  supplierId: string;

  @Prop({ required: true })
  supplierName: string;

  @Prop({ required: true })
  date: string;

  @Prop({ required: true, enum: SR_LEDGER_ENTRY_TYPES })
  entryType: SrLedgerEntryType;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  runningBalance: number;

  @Prop({ required: true })
  desc: string;

  @Prop({ default: '' })
  sourceType: string; // 'transaction' | 'supplier-return' | 'manual' | ''

  @Prop({ default: '' })
  sourceId: string;

  @Prop({ default: '' })
  sourceRef: string;

  @Prop({ default: '' })
  vaultEntryId: string;

  /** Vault segment the cash moved from, for entry types that move cash ('advance-deposit'). */
  @Prop({ default: '' })
  vaultSeg: string;

  /** User-supplied external reference (supplier receipt no., transfer id, cheque no.). */
  @Prop({ default: '' })
  refNo: string;

  @Prop({ default: '' })
  employee: string;

  @Prop({ default: false })
  reversed: boolean;

  @Prop({ default: '' })
  reversalOfEntryId: string;

  @Prop({ type: Object, default: null })
  meta: Record<string, unknown> | null;
}

export const SupplierLedgerEntrySchema =
  SchemaFactory.createForClass(SupplierLedgerEntry);
SupplierLedgerEntrySchema.index({ supplierId: 1, date: 1 });
SupplierLedgerEntrySchema.index({ supplierId: 1, createdAt: -1 });
SupplierLedgerEntrySchema.index({ sourceType: 1, sourceId: 1 });
