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
}

export const SettingsSchema = SchemaFactory.createForClass(Settings);
