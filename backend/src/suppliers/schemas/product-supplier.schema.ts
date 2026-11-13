import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProductSupplierDocument = HydratedDocument<ProductSupplier>;

/**
 * سعر مورد لمنتج — خطوة 4 من خطة تصحيح الربح.
 *
 * ⚠ ده **سعر عرض** بس: بيملا سعر السطر في فاتورة الشراء وبينبّه لو السعر اختلف. الربح
 *   **مابيتحسبش منه أبدًا** (الربح بيقرا التكلفة المحفوظة على سطر البيع — line-cost.util.ts).
 * المنتج ليه أي عدد من الموردين؛ صف واحد لكل (منتج، مورد).
 */
@Schema({ timestamps: true, collection: 'productsuppliers' })
export class ProductSupplier {
  @Prop({ required: true, index: true })
  productId: string;

  @Prop({ required: true, index: true })
  supplierId: string;

  /** الاسم وقت آخر تحديث — يفضل مقروء لو المورد اتمسح. */
  @Prop({ default: '' })
  supplierName: string;

  /** سعر الوحدة اللي المورد بيبيع بيه (سعر السطر قبل خصم الفاتورة). null = مورد أساسي لسه
   *  مالوش سعر (اتحدد من الكارت قبل أي فاتورة) — فاتورة الشراء بتاخد سعر الكارت ساعتها. */
  @Prop({ type: Number, default: null, min: 0 })
  price: number | null;

  @Prop({ required: true, enum: ['purchase', 'manual'] })
  priceSource: string;

  /** تاريخ العمل اللي السعر جاي منه (YYYY-MM-DD). فاتورة بتاريخ أقدم مابتكتبش فوق سعر أحدث. */
  @Prop({ default: '' })
  priceDate: string;

  @Prop({ default: '' })
  priceUpdatedAt: string;

  @Prop({ default: '' })
  priceUpdatedBy: string;

  /** آخر فاتورة شراء: { txId, ref, date, qty, price, unitCost } — unitCost بعد نصيبه من الخصم. */
  @Prop({ type: Object, default: null })
  lastPurchase: Record<string, unknown> | null;

  @Prop({ default: true })
  active: boolean;

  /** آخر سعر يدوي { price, date, at, by } — محفوظ لوحده عشان إعادة الحساب من الفواتير
   *  (تعديل/إلغاء فاتورة) تعرف تقارنه بآخر فاتورة: الأحدث تاريخًا يكسب. */
  @Prop({ type: Object, default: null })
  manualPrice: Record<string, unknown> | null;

  /** المورد الأساسي للمنتج — سطر واحد بس لكل منتج (primary-supplier.util.ts). */
  @Prop({ default: false })
  primary: boolean;

  @Prop({ type: [Object], default: [] })
  activityLog: Record<string, unknown>[];
}

export const ProductSupplierSchema = SchemaFactory.createForClass(ProductSupplier);
ProductSupplierSchema.index({ productId: 1, supplierId: 1 }, { unique: true, name: 'product_supplier_unique' });
ProductSupplierSchema.index({ productId: 1 }, { unique: true, name: 'product_primary_supplier_unique', partialFilterExpression: { primary: true } });
