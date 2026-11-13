import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProductCostEventDocument = HydratedDocument<ProductCostEvent>;

/**
 * سجل تغيّرات متوسط التكلفة (خطوة 3) — append-only. كل صف = حدث غيّر (أو حاول يغيّر) المتوسط.
 * `eventKey` فريد، فإعادة نفس الطلب مابتحسبش مرتين.
 */
@Schema({ timestamps: true, collection: 'productcostevents' })
export class ProductCostEvent {
  @Prop({ required: true, index: true })
  productId: string;

  @Prop({ required: true })
  code: string;

  @Prop({ required: true, unique: true })
  eventKey: string;

  /** purchase | purchase-edit | purchase-cancel | revalue | supplier-return | supplier-return-reversed */
  @Prop({ required: true, enum: ['purchase', 'purchase-edit', 'purchase-cancel', 'revalue', 'supplier-return', 'supplier-return-reversed'] })
  kind: string;

  @Prop({ default: '' })
  txId: string;

  @Prop({ default: '' })
  ref: string;

  @Prop({ default: 0 })
  stockBefore: number;

  @Prop({ default: 0 })
  avgBefore: number;

  /** الكمية والتكلفة اللي دخلت. في التعديل: الجديدة، والقديمة في oldQty/oldUnitCost. */
  @Prop({ default: 0 })
  qtyIn: number;

  @Prop({ default: 0 })
  unitCostIn: number;

  @Prop({ default: 0 })
  oldQty: number;

  @Prop({ default: 0 })
  oldUnitCost: number;

  @Prop({ default: 0 })
  avgAfter: number;

  @Prop({ default: '' })
  by: string;

  @Prop({ default: '' })
  reason: string;

  /** 'replay' (تعديل اتحسب بالترتيب الزمني) | 'added-now' (صنف اتضاف للفاتورة في تعديل) | '' */
  @Prop({ default: '' })
  method: string;

  /** تعديل فاتورة بعد ما اتباع منها: القطع اللي اتباعت من وقت الفاتورة، والفرق بين المتوسط الصح
   *  وقت كل بيعة والتكلفة المحفوظة عليها. للمراجعة — **البيعات نفسها مابتتغيّرش.** */
  @Prop({ default: 0 })
  soldQtySince: number;

  @Prop({ default: 0 })
  costVariance: number;
}

export const ProductCostEventSchema = SchemaFactory.createForClass(ProductCostEvent);
ProductCostEventSchema.index({ productId: 1, createdAt: -1 });
ProductCostEventSchema.index({ txId: 1, productId: 1 });
