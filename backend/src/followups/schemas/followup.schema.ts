import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type FollowUpDocument = HydratedDocument<FollowUp>;

@Schema({ timestamps: true })
export class FollowUp {
  @Prop({ required: true })
  orderRef: string; // transaction ref pulled from system

  @Prop()
  transactionId: string;

  @Prop()
  clientName: string;

  @Prop()
  clientPhone: string;

  @Prop({ required: true })
  responsibleId: string;

  @Prop({ required: true })
  responsibleName: string;

  @Prop({ default: '' })
  reason: string; // triggers notification when set

  @Prop({ default: 'قيد المتابعة' })
  status: string; // قيد المتابعة | تمت المتابعة | بانتظار العميل | يحتاج مراجعة | لم يتم الحل

  @Prop({ default: '' })
  comment: string;

  @Prop({ default: '' })
  reasonOther: string; // free-text reason when reason === 'أخرى'

  @Prop({ default: '' })
  resolution: string; // free-text resolution method when status === 'تم حل المشكلة'

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ default: false })
  notified: boolean; // whether notification was sent for this reason
}

export const FollowUpSchema = SchemaFactory.createForClass(FollowUp);
