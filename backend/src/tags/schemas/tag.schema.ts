import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TagDocument = HydratedDocument<Tag>;

@Schema({ timestamps: true })
export class Tag {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop({ default: '#fff' })
  color: string;

  @Prop({ default: '#64748b' })
  bg: string;
}

export const TagSchema = SchemaFactory.createForClass(Tag);
