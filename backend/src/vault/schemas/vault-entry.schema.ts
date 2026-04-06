import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type VaultEntryDocument = HydratedDocument<VaultEntry>;

@Schema({ timestamps: true })
export class VaultEntry {
  @Prop({ required: true })
  date: string;

  @Prop({ required: true })
  desc: string;

  @Prop({ required: true })
  amount: number;

  @Prop({ required: true })
  seg: string;

  @Prop()
  method: string;

  @Prop({ default: '' })
  source: string;

  @Prop({ default: '' })
  ref: string;

  @Prop({ default: 0 })
  balCash: number;

  @Prop({ default: 0 })
  balVodafone: number;

  @Prop({ default: 0 })
  balInstapay: number;

  @Prop({ default: 0 })
  balBank: number;

  @Prop({ default: 0 })
  balance: number;

  @Prop({ default: '' })
  employee: string;

  @Prop({ default: '' })
  txNo: string;
}

export const VaultEntrySchema = SchemaFactory.createForClass(VaultEntry);
