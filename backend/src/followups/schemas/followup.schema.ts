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

  @Prop({ default: 'note' })
  kind: string; // 'note' | 'call' — 'call' entries mark a logged customer call attempt

  @Prop()
  callAttemptNo?: number; // 1-3, set only when kind === 'call'

  @Prop()
  callOutcome?: string; // 'answered' | 'no_answer' — set only when kind === 'call'
}

export const FollowUpCommentSchema = SchemaFactory.createForClass(FollowUpComment);

@Schema({ timestamps: true })
export class FollowUp {
  // Human-facing ticket id, unique per follow-up: FU-YYMMDD-{orderRef}, with a
  // -2/-3 suffix when the same order gets more than one follow-up the same day.
  // Mirrors the Complaint.complaintNo scheme (CMP-YYMMDD-REF) so both
  // customer-service records read the same way. Not `required` at the schema
  // level: records created before this field existed are backfilled on boot.
  @Prop({ unique: true, sparse: true, index: true })
  ticketNo: string;

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

  @Prop({ default: false })
  cancelled: boolean; // true once an "Action → إلغاء" decision has been recorded

  @Prop({ default: '' })
  cancelReason: string; // one of FU_CANCEL_REASONS, or free text when 'سبب آخر'

  @Prop()
  cancelledAt?: Date;

  @Prop({ default: '' })
  cancelledById: string;

  @Prop({ default: '' })
  cancelledByName: string;
}

export const FollowUpSchema = SchemaFactory.createForClass(FollowUp);
