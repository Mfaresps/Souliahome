import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CategoryDocument = HydratedDocument<Category>;

@Schema({ timestamps: true })
export class Category {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop({ type: String, default: null })
  parentId: string | null;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: '' })
  description: string;
}

export const CategorySchema = SchemaFactory.createForClass(Category);
