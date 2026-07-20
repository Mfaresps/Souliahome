import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ComplaintDocument = HydratedDocument<Complaint>;

@Schema({ _id: false })
export class ComplaintNote {
  @Prop({ required: true })
  id: string;

  @Prop({ required: true })
  text: string;

  @Prop({ required: true })
  author: string;

  @Prop({ default: '' })
  authorId: string; // empty for system-generated notes

  @Prop({ required: true })
  createdAt: string;

  @Prop()
  updatedAt: string;

  @Prop({ default: 'note' })
  kind: string; // note | system
}
export const ComplaintNoteSchema = SchemaFactory.createForClass(ComplaintNote);

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

  @Prop()
  phone: string;

  @Prop()
  productId: string;

  @Prop()
  productCode: string;

  @Prop()
  productName: string;

  @Prop()
  productImageUrl: string;

  @Prop()
  productQty: number;

  @Prop({ default: '' })
  variantDetail: string; // ملاحظة نصية اختيارية عن اللون/المقاس

  @Prop({ default: '' })
  categoryGroup: string; // مشكلة في المنتج | مشكلة في الشحن | خدمة العملاء | أخرى

  @Prop({ default: '' })
  category: string; // السبب المحدد داخل المجموعة

  @Prop({ default: '' })
  imageUrl: string; // رابط صورة المشكلة

  @Prop()
  imageAddedBy: string;

  @Prop()
  imageAddedAt: string;

  @Prop({ required: true })
  description: string;

  @Prop({ required: true })
  submittedBy: string;

  @Prop({ required: true })
  submittedById: string;

  @Prop({ default: 'معلق' })
  status: string; // معلق | مقبول | مرفوض

  @Prop({ default: 'متوسطة' })
  priority: string; // عالية | متوسطة | منخفضة

  @Prop({ default: '' })
  progressStage: string; // جاري العمل على حل المشكلة | تم حل المشكلة بنجاح | ...

  @Prop({ type: [ComplaintNoteSchema], default: [] })
  notes: ComplaintNote[];

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

  @Prop({ unique: true, sparse: true })
  surveySlug: string;

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
