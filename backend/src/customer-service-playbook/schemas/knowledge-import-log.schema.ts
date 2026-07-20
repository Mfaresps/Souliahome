import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type KnowledgeImportLogDocument = HydratedDocument<KnowledgeImportLog>;

@Schema({ _id: false })
export class KnowledgeImportError {
  @Prop({ required: true })
  row: number;

  @Prop({ required: true })
  message: string;
}
export const KnowledgeImportErrorSchema = SchemaFactory.createForClass(KnowledgeImportError);

@Schema({ timestamps: true })
export class KnowledgeImportLog {
  @Prop({ default: '' })
  userId: string;

  @Prop({ default: '' })
  username: string;

  @Prop({ required: true })
  filename: string;

  @Prop({ default: 0 })
  createdFolders: number;

  @Prop({ default: 0 })
  createdCards: number;

  @Prop({ default: 0 })
  updatedCards: number;

  @Prop({ default: 0 })
  skippedDuplicates: number;

  @Prop({ type: [KnowledgeImportErrorSchema], default: [] })
  errors: KnowledgeImportError[];
}

export const KnowledgeImportLogSchema = SchemaFactory.createForClass(KnowledgeImportLog);
KnowledgeImportLogSchema.index({ createdAt: -1 });
