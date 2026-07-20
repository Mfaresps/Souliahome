import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type KnowledgeCardDocument = HydratedDocument<KnowledgeCard>;

export type CardType = 'response' | 'policy' | 'procedure' | 'warning';

@Schema({ timestamps: true })
export class KnowledgeCard {
  @Prop({ type: Types.ObjectId, ref: 'KnowledgeFolder', required: true, index: true })
  folderId: Types.ObjectId;

  @Prop({ required: true })
  title: string;

  @Prop({ default: '' })
  scenario: string;

  @Prop({ default: '' })
  customerQuestion: string;

  @Prop({ required: true })
  response: string;

  @Prop({ default: '' })
  internalNotes: string;

  @Prop({ default: 'response', enum: ['response', 'policy', 'procedure', 'warning'] })
  cardType: CardType;

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ default: 0 })
  copyCount: number;

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: '' })
  createdBy: string;

  @Prop({ default: '' })
  updatedBy: string;
}

export const KnowledgeCardSchema = SchemaFactory.createForClass(KnowledgeCard);
KnowledgeCardSchema.index({ folderId: 1, isActive: 1 });
KnowledgeCardSchema.index(
  { title: 'text', scenario: 'text', customerQuestion: 'text', response: 'text', tags: 'text' },
  { name: 'KnowledgeCardSearchIndex' },
);
