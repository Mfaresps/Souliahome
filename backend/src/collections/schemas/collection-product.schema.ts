import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CollectionProductDocument = HydratedDocument<CollectionProduct>;

@Schema({ timestamps: true })
export class CollectionProduct {
  @Prop({ required: true, index: true })
  collectionId: string;

  @Prop({ required: true, index: true })
  productId: string;

  @Prop({ default: '' })
  addedBy: string;

  @Prop({ default: '' })
  addedAt: string;
}

export const CollectionProductSchema =
  SchemaFactory.createForClass(CollectionProduct);

CollectionProductSchema.index(
  { collectionId: 1, productId: 1 },
  { unique: true },
);
