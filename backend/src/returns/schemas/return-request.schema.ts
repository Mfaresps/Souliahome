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
}

export const ReturnRequestSchema =
  SchemaFactory.createForClass(ReturnRequest);
