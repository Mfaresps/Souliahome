import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type KnowledgeAuditLogDocument = HydratedDocument<KnowledgeAuditLog>;

export type KnowledgeEntityType = 'folder' | 'card';
export type KnowledgeAuditAction = 'created' | 'updated' | 'deleted';

@Schema({ timestamps: true })
export class KnowledgeAuditLog {
  @Prop({ required: true })
  entityType: KnowledgeEntityType;

  @Prop({ required: true })
  entityId: string;

  @Prop({ required: true })
  action: KnowledgeAuditAction;

  @Prop({ default: '' })
  userId: string;

  @Prop({ default: '' })
  username: string;

  @Prop({ required: true })
  summary: string;
}

export const KnowledgeAuditLogSchema = SchemaFactory.createForClass(KnowledgeAuditLog);
KnowledgeAuditLogSchema.index({ entityId: 1, createdAt: -1 });
