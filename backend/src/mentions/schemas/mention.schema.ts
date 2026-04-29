import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MentionDocument = HydratedDocument<Mention>;

@Schema({ timestamps: true })
export class Mention {
  @Prop({ required: true, index: true })
  targetUserId: string;

  @Prop()
  targetUsername: string;

  @Prop()
  targetName: string;

  @Prop({ required: true })
  fromUserId: string;

  @Prop({ required: true })
  fromName: string;

  @Prop({ required: true })
  txId: string;

  @Prop()
  txRef: string;

  @Prop({ default: 0 })
  commentId: number;

  @Prop({ required: true })
  commentText: string;

  @Prop({ default: false, index: true })
  read: boolean;
}

export const MentionSchema = SchemaFactory.createForClass(Mention);
