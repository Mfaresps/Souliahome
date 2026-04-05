import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true, unique: true })
  code: string;

  @Prop({ required: true })
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
}

export const ProductSchema = SchemaFactory.createForClass(Product);
