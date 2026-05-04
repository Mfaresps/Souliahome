import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type SettingsDocument = HydratedDocument<Settings>;

export class ShipCompany {
  @Prop({ required: true })
  name: string;

  @Prop({ default: 110 })
  cairo: number;

  @Prop({ default: 150 })
  gov: number;
}

export class DiscountCode {
  @Prop({ required: true })
  id: string; // UUID generated on creation

  @Prop({ required: true })
  code: string; // e.g. SUMMER15

  @Prop({ default: '' })
  description: string;

  @Prop({ required: true, enum: ['percent', 'fixed'] })
  type: string; // 'percent' | 'fixed'

  @Prop({ required: true })
  value: number; // 15 for 15% or 50 for 50 EGP

  @Prop({ type: String, default: null })
  startDate: string | null; // ISO date string

  @Prop({ type: String, default: null })
  endDate: string | null; // ISO date string

  @Prop({ default: true })
  active: boolean;

  @Prop({ default: 0 })
  usageCount: number;

  @Prop({ default: '' })
  createdBy: string;

  @Prop({ default: '' })
  createdAt: string;

  @Prop({ type: [Object], default: [] })
  auditLog: Array<{
    action: string; // 'created' | 'updated' | 'activated' | 'deactivated' | 'deleted'
    by: string;
    at: string;
    note?: string;
  }>;

  @Prop({ type: [Object], default: [] })
  usageHistory: Array<{
    txRef: string;
    txId: string;
    client: string;
    amount: number; // discount amount applied
    by: string;
    at: string;
  }>;
}

@Schema({ timestamps: true })
export class Settings {
  @Prop({ default: 110 })
  cairoPrice: number;

  @Prop({ default: 150 })
  govPrice: number;

  @Prop({ type: [Object], default: [] })
  shipCos: ShipCompany[];

  @Prop({ default: '1234' })
  vaultPass: string;

  @Prop({ default: 0 })
  vaultBalance: number;

  @Prop({ default: 0 })
  vaultCash: number;

  @Prop({ default: 0 })
  vaultVodafone: number;

  @Prop({ default: 0 })
  vaultInstapay: number;

  @Prop({ default: 0 })
  vaultBank: number;

  @Prop({ default: 'ar' })
  lang: string;

  @Prop({ default: true })
  langEnabled: boolean;

  @Prop({ default: false })
  darkMode: boolean;

  @Prop({ default: '2.4.0' })
  systemVersion: string;

  @Prop({ type: Date, default: () => new Date() })
  lastVersionUpdate: Date;

  @Prop({ type: Date, default: () => new Date() })
  lastLiveUpload: Date;

  @Prop({ default: false })
  staffDiscountEnabled: boolean;

  @Prop({ default: true })
  printIncludePolicy: boolean;

  @Prop({ default: '' })
  printPolicySales: string;

  @Prop({ default: '' })
  printPolicyPurchase: string;

  @Prop({ default: 10 })
  printPolicyFontSize: number;

  @Prop({ default: 'normal' })
  printPolicyFontWeight: string;

  @Prop({ default: true })
  printPolicyHighlight: boolean;

  @Prop({ type: [Object], default: [] })
  discountCodes: DiscountCode[];
}

export const SettingsSchema = SchemaFactory.createForClass(Settings);
