import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DraftDocument = HydratedDocument<Draft>;

@Schema({ timestamps: true })
export class Draft {
  @Prop({ required: true })
  draftId: string;

  @Prop({ required: true, type: Object })
  snap: Record<string, any>;

  @Prop({ required: true })
  by: string;

  @Prop({ required: true })
  byUsername: string;

  @Prop({ default: 0 })
  createdAt: number;

  @Prop({ default: 0 })
  updatedAt: number;

  // Live editing lock: set when someone opens/resumes this draft
  @Prop({ default: '' })
  lockedBy: string;

  @Prop({ default: '' })
  lockedByUsername: string;

  @Prop({ default: 0 })
  lockedAt: number;
}

export const DraftSchema = SchemaFactory.createForClass(Draft);
DraftSchema.index({ draftId: 1 }, { unique: true });
DraftSchema.index({ updatedAt: -1 });
