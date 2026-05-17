import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ required: true, unique: true })
  name: string;

  @Prop({ default: 0 })
  sellPrice: number;

  @Prop({ default: 0 })
  buyPrice: number;

  @Prop({ default: 10 })
  minStock: number;

  @Prop({ default: 0 })
  openingBalance: number;

  @Prop({ default: '' })
  supplier: string;

  @Prop({ default: '' })
  imageUrl: string;

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
