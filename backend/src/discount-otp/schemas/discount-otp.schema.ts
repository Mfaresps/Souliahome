import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import mongoose from 'mongoose';

export type DiscountOtpDocument = HydratedDocument<DiscountOtp>;

@Schema({ timestamps: true })
export class DiscountOtp {
  @Prop({ required: true, index: true })
  otp: string;

  @Prop({ required: true, default: 0 })
  discountAmount: number;

  @Prop({ default: 0 })
  itemsTotal: number;

  @Prop({ default: '' })
  client: string;

  @Prop({ default: '' })
  txType: string;

  @Prop({ default: 'discount' })
  kind: string; // 'discount' | 'purchase' | 'delete-product' | 'delete-supplier' | 'vault-access' | 'add-product' | 'edit-tx'

  @Prop({ type: [Object], default: [] })
  purchaseItems: Array<{ name: string; qty: number; price: number; total: number }>;

  @Prop({ type: [String], default: [] })
  importItemNames: string[];

  // edit-tx OTP fields
  @Prop({ default: '' })
  editTxId: string;

  @Prop({ default: '' })
  editTxType: string; // 'مبيعات' | 'مشتريات'

  @Prop({ type: [String], default: [] })
  editChanges: string[];

  @Prop({ type: mongoose.Schema.Types.Mixed, default: {} })
  editPayload: Record<string, any>; // the full update body to apply on approval

  @Prop({ default: '' })
  editStatus: string; // '' | 'approved' | 'rejected'

  @Prop({ default: '' })
  editReviewedBy: string;

  @Prop({ default: '' })
  editReviewedAt: string;

  @Prop({ default: '' })
  requestedById: string;

  @Prop({ default: '' })
  requestedByName: string;

  @Prop({ default: '' })
  requestedByUsername: string;

  @Prop({ required: true })
  createdAt: string;

  @Prop({ required: true })
  expiresAt: string;

  @Prop({ default: '', index: true })
  status: string;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ default: '' })
  usedAt: string;

  @Prop({ default: '' })
  txId: string;

  @Prop({ default: '' })
  txRef: string;

  @Prop({ default: 0 })
  thresholdAtRequest: number;
}

export const DiscountOtpSchema = SchemaFactory.createForClass(DiscountOtp);
