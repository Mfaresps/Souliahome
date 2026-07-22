import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type FollowUpDocument = HydratedDocument<FollowUp>;

@Schema({ _id: true, timestamps: true })
export class FollowUpComment {
  _id?: Types.ObjectId;

  @Prop({ required: true })
  authorId: string;

  @Prop({ required: true })
  authorName: string;

  @Prop({ required: true })
  text: string;

  @Prop({ default: false })
  edited: boolean;
}

export const FollowUpCommentSchema = SchemaFactory.createForClass(FollowUpComment);

@Schema({ timestamps: true })
export class FollowUp {
  @Prop({ required: true })
  orderRef: string; // transaction ref pulled from system

  @Prop()
  transactionId: string;

  @Prop()
  shopifyOrderId: string; // set when orderRef was picked from a Shopify order instead of a system sales transaction

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
  comment: string; // deprecated — legacy single-note field, kept for old records; use `comments` going forward

  @Prop({ type: [FollowUpCommentSchema], default: [] })
  comments: FollowUpComment[]; // full comment thread — one entry per user note, each editable/deletable by its author

  @Prop({ default: '' })
  reasonOther: string; // free-text reason when reason === 'أخرى'

  @Prop({ default: '' })
  resolution: string; // free-text resolution method when status === 'تم حل المشكلة'

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ default: false })
  notified: boolean; // whether notification was sent for this reason

  @Prop({ default: Date.now })
  escalationBaseline: Date; // resets when status/reason change — start point for 12h/24h/day reminders

  @Prop({ default: 0 })
  escalationLevel: number; // highest reminder threshold already sent (0=none, 1=12h, 2=24h, 3=48h, ...)
}

export const FollowUpSchema = SchemaFactory.createForClass(FollowUp);
