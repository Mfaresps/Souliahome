import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { restrictInventoryParentDeletion } from '../../inventory-units/inventory-unit-integrity';

export type ProductDocument = HydratedDocument<Product>;

export class ProductDimensions {
  length?: number;
  width?: number;
  height?: number;
}

export class ProductActivityChange {
  field: string;
  label: string;
  oldValue: unknown;
  newValue: unknown;
}

export class ProductActivityEntry {
  action: string;
  detail: string;
  changes?: ProductActivityChange[];
  by: string; // اسم المستخدم
  at: string; // ISO timestamp
}

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true, unique: true, immutable: true })
  code: string;

  @Prop({ required: true, unique: true })
  name: string;

  @Prop({ default: 0 })
  sellPrice: number;

  @Prop({ default: 0 })
  buyPrice: number;

  /**
   * متوسط التكلفة المرجّح من فواتير الشراء (خطوة 3). null = لسه ماتحسبش، فالتكلفة = buyPrice.
   * ⚠ مش في أي DTO عن قصد: بيتكتب من ProductCostService بس. و`type: Number` إلزامي —
   * nullable من غير type بيوقّع الـAPI كله وقت التحميل.
   */
  @Prop({ type: Number, default: null })
  avgCost: number | null;

  @Prop({ type: String, default: '' })
  avgCostUpdatedAt: string;

  @Prop({ default: 10 })
  minStock: number;

  @Prop({ default: 0 })
  openingBalance: number;

  @Prop({ default: '' })
  supplier: string;

  /** عروض أسعار البيع لفترة محددة (shared/price-offer.util.ts). ⚠ في مافيش DTO — بتتعدّل من
   *  `POST /products/:id/offers` بس، عشان كل عرض يتسجل بسببه ومين عمله. */
  @Prop({ type: [Object], default: [] })
  priceOffers: Array<Record<string, unknown>>;

  /** المورد الأساسي (id). ⚠ في مافيش DTO — بيتكتب من primary-supplier.util بس، و`supplier`
   *  نسخة الاسم للعرض. '' = مافيش، أو اسم قديم مش مطابق لمورد. */
  @Prop({ default: '' })
  supplierId: string;

  @Prop({ default: '' })
  imageUrl: string;

  @Prop({ type: [String], default: [] })
  images: string[];

  @Prop({ type: String, default: null })
  categoryId: string | null;

  @Prop({ type: String, default: null })
  collectionId: string | null;

  @Prop({ type: String, default: '' })
  storageLocationId: string;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: '' })
  description: string;

  @Prop({ type: [String], default: [] })
  colors: string[];

  /**
   * خصائص الصنف (Waterproof, Anti Slip, …) — تتعايش مع `material` ولا تحل محلها:
   * الخامة واحدة وتحمل تعليمات العناية، والميزة تتراكم بلا حد. القيم مخزَّنة
   * بالإنجليزية (نفس اصطلاح `colors`) والترجمة تحدث في العرض فقط.
   */
  @Prop({ type: [String], default: [] })
  features: string[];

  @Prop({ default: false })
  isPattern: boolean;

  @Prop({ default: '' })
  pattern: string;

  @Prop({ default: '' })
  material: string;

  @Prop({ type: String, default: '' })
  sizeType: 'standard' | 'custom' | '';

  @Prop({ default: '' })
  size: string;

  @Prop({ type: Object, default: null })
  dimensions: ProductDimensions | null;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ default: '' })
  createdBy: string;

  @Prop({ type: [Object], default: [] })
  activityLog: ProductActivityEntry[];

  /** Edit request submitted by employee, pending manager approval */
  @Prop({ type: Object, default: null })
  editRequest: {
    requestedBy: string;
    requestedById?: string;
    requestedByUsername?: string;
    requestedAt: string;
    status: string; // 'معلق' | 'معتمد' | 'مرفوض'
    changes: {
      field: string;
      oldValue: unknown;
      newValue: unknown;
    }[];
    reviewedBy?: string;
    reviewedAt?: string;
    rejectedReason?: string;
  } | null;
}

export const ProductSchema = SchemaFactory.createForClass(Product);
ProductSchema.index({ storageLocationId: 1 });
restrictInventoryParentDeletion(ProductSchema, ['productId'], [], ['productId']);
