import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ComplaintDocument = HydratedDocument<Complaint>;

@Schema({ timestamps: true })
export class Complaint {
  @Prop({ required: true, unique: true })
  complaintNo: string;

  @Prop()
  transactionId: string;

  @Prop()
  transactionRef: string;

  @Prop()
  clientName: string;

  @Prop({ required: true })
  description: string;

  @Prop({ required: true })
  submittedBy: string;

  @Prop({ required: true })
  submittedById: string;

  @Prop({ default: 'معلق' })
  status: string; // معلق | مقبول | مرفوض

  @Prop()
  managerAction: string; // استبدال | استرداد | تعويض | رفض | أخرى

  @Prop()
  actionNote: string;

  @Prop()
  resolvedBy: string;

  @Prop()
  resolvedAt: string;

  @Prop({ default: false })
  inFollowUp: boolean;

  @Prop({ unique: true, sparse: true })
  surveyToken: string;

  @Prop({ min: 1, max: 5 })
  surveyRating: number;

  @Prop()
  surveyComment: string;

  @Prop()
  surveySentAt: string;

  @Prop()
  surveyCompletedAt: string;
}

export const ComplaintSchema = SchemaFactory.createForClass(Complaint);
