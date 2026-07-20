import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type KnowledgeFolderDocument = HydratedDocument<KnowledgeFolder>;

@Schema({ timestamps: true })
export class KnowledgeFolder {
  @Prop({ required: true })
  name: string;

  @Prop({ default: '' })
  description: string;

  @Prop({ default: '' })
  icon: string;

  @Prop({ default: 0 })
  order: number;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: '' })
  createdBy: string;

  @Prop({ default: '' })
  updatedBy: string;
}

export const KnowledgeFolderSchema = SchemaFactory.createForClass(KnowledgeFolder);
KnowledgeFolderSchema.index({ order: 1 });
