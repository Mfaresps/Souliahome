import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type VaultEntryDocument = HydratedDocument<VaultEntry>;

@Schema({ timestamps: true })
export class VaultEntry {
  @Prop({ required: true })
  date: string;

  @Prop({ required: true })
  desc: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  seg: string;

  @Prop()
  method: string;

  @Prop({ default: '' })
  source: string;

  @Prop({ default: '' })
  ref: string;

  @Prop({ default: 0 })
  balCash: number;

  @Prop({ default: 0 })
  balVodafone: number;

  @Prop({ default: 0 })
  balInstapay: number;

  @Prop({ default: 0 })
  balBank: number;

  @Prop({ default: 0 })
  balance: number;

  @Prop({ default: '' })
  employee: string;

  @Prop({ default: '' })
  txNo: string;

  // Enhanced Fields
  @Prop({ default: 'completed', enum: ['completed', 'pending', 'frozen', 'cancelled'] })
  status: string;

  @Prop({ default: '' })
  transactionType: string;

  @Prop({ default: '' })
  customer: string;

  @Prop({ default: '' })
  supplier: string;

  @Prop({ default: '' })
  notes: string;

  @Prop({ default: '' })
  accountingJustification: string;

  @Prop({ default: '' })
  entityLabel: string;

  @Prop({ type: Object, default: null })
  editHistory: Array<{
    editor: string;
    editedAt: string;
    changes: Record<string, { oldValue: unknown; newValue: unknown }>;
  }>;

  @Prop({ default: null })
  frozenReason: string;

  @Prop({ default: false })
  requiresApproval: boolean;

  @Prop({ default: false })
  isApproved: boolean;

  @Prop({ default: '' })
  approvedBy: string;

  // ربط مع الحركة الأصلية (إن وجدت)
  @Prop({ default: null })
  linkedTransactionId: string;

  @Prop({ default: '' })
  linkedTransactionRef: string;
}

export const VaultEntrySchema = SchemaFactory.createForClass(VaultEntry);
VaultEntrySchema.index({ date: 1, seg: 1 });
VaultEntrySchema.index({ date: 1, source: 1, transactionType: 1 });
VaultEntrySchema.index({ status: 1 });
VaultEntrySchema.index({ employee: 1 });
VaultEntrySchema.index({ ref: 1 });
