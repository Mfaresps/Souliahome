import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { DepositReceipt } from './shopify-order.schema';

export type ManualDepositReceiptDocument = HydratedDocument<ManualDepositReceipt>;

/** Server-owned upload and OCR, before a manual sale exists. Never books money. */
@Schema({ timestamps: true })
export class ManualDepositReceipt {
  @Prop({ required: true, unique: true })
  receiptId: string;

  @Prop({ required: true })
  ownerId: string;

  @Prop({ default: '' })
  ref: string;

  @Prop({ default: '' })
  client: string;

  @Prop({ type: Object, required: true })
  receipt: DepositReceipt;

  @Prop({ default: 'draft', enum: ['draft', 'submitted', 'claiming', 'consumed', 'withdrawn'] })
  state: string;

  @Prop({ required: true })
  expiresAt: string;

  @Prop({ default: '' })
  transactionId: string;
}

export const ManualDepositReceiptSchema = SchemaFactory.createForClass(ManualDepositReceipt);
