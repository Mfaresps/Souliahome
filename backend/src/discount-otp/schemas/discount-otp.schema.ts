import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

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
