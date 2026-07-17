import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SupplierReturnOrderDocument = HydratedDocument<SupplierReturnOrder>;

export class SupplierReturnItem {
  code: string;
  name: string;
  qty: number;
  price: number;
  total: number;
  note?: string;
}

export class SrStatusEntry {
  status: string;
  changedBy: string;
  changedAt: string;
  note?: string;
}

@Schema({ timestamps: true })
export class SupplierReturnOrder {
  @Prop({ required: true })
  supplierId: string;

  @Prop({ required: true })
  supplierName: string;

  @Prop({ required: true, unique: true })
  returnNumber: string;

  @Prop({ required: true })
  originalTransactionId: string;

  @Prop({ required: true })
  originalRef: string;

  @Prop({ required: true })
  originalDate: string;

  @Prop({ required: true })
  returnDate: string;

  @Prop({
    required: true,
    enum: ['تلف المنتج', 'منتج خاطئ', 'مشكلة جودة', 'أخرى'],
  })
  reason: string;

  @Prop({ default: '' })
  reasonDetails: string;

  @Prop({ type: [Object], required: true })
  items: SupplierReturnItem[];

  @Prop({ default: 0 })
  itemsTotal: number;

  @Prop({ required: true })
  total: number;

  @Prop({
    default: 'معلق',
    enum: ['مسودة', 'معلق', 'معتمد', 'مكتمل', 'مرفوض', 'ملغي'],
  })
  status: string;

  @Prop({ required: true })
  vaultRefundAccount: string;

  @Prop({ required: true })
  createdBy: string;

  @Prop()
  approvedBy: string;

  @Prop()
  approvedAt: string;

  @Prop()
  rejectedReason: string;

  @Prop({ default: '' })
  linkedTransactionId: string;

  @Prop({ type: [Object], default: [] })
  statusHistory: SrStatusEntry[];
}

export const SupplierReturnOrderSchema =
  SchemaFactory.createForClass(SupplierReturnOrder);
SupplierReturnOrderSchema.index({ supplierId: 1, status: 1 });
SupplierReturnOrderSchema.index({ returnNumber: 1 }, { unique: true });
SupplierReturnOrderSchema.index({ originalTransactionId: 1 });
