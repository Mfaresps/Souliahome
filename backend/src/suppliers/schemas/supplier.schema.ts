import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SupplierDocument = HydratedDocument<Supplier>;

@Schema({ timestamps: true })
export class Supplier {
  @Prop({ required: true })
  name: string;

  @Prop()
  phone: string;

  @Prop()
  address: string;

  @Prop()
  email: string;

  @Prop()
  products: string;

  @Prop()
  notes: string;
}

export const SupplierSchema = SchemaFactory.createForClass(Supplier);
