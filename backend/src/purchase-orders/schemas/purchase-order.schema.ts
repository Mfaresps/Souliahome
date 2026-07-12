import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PurchaseOrderDocument = HydratedDocument<PurchaseOrder>;

export class PurchaseOrderItem {
  productCode: string;
  productName: string;
  productImage: string;
  qty: number;
  unitPrice: number;
  total: number;
}

export class PoStatusEntry {
  status: string;
  changedBy: string;
  changedAt: string;
  note?: string;
}

@Schema({ timestamps: true })
export class PurchaseOrder {
  @Prop({ required: true })
  supplierId: string;

  @Prop({ required: true })
  supplierName: string;

  @Prop({ required: true, unique: true })
  poNumber: string;

  @Prop({ required: true })
  createdDate: string;

  @Prop({ default: '' })
  expectedDeliveryDate: string;

  @Prop({ default: '' })
  notes: string;

  @Prop({
    default: 'معلق',
    enum: ['معلق', 'قيد التحضير', 'جاهز للاستلام', 'مستلم'],
  })
  status: string;

  @Prop({ type: [Object], default: [] })
  items: PurchaseOrderItem[];

  @Prop({ required: true })
  createdBy: string;

  @Prop({ default: '' })
  linkedTransactionId: string;

  @Prop({ type: [Object], default: [] })
  statusHistory: PoStatusEntry[];
}

export const PurchaseOrderSchema = SchemaFactory.createForClass(PurchaseOrder);
PurchaseOrderSchema.index({ supplierId: 1, status: 1 });
PurchaseOrderSchema.index({ poNumber: 1 }, { unique: true });
