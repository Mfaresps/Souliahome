import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TagDocument = HydratedDocument<Tag>;

export type TagCategory = 'operational' | 'risk' | 'system';

@Schema({ timestamps: true })
export class Tag {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop({ default: '#fff' })
  color: string;

  @Prop({ default: '#64748b' })
  bg: string;

  @Prop({ enum: ['operational', 'risk', 'system'], required: false })
  category?: TagCategory;
}

export const TagSchema = SchemaFactory.createForClass(Tag);
