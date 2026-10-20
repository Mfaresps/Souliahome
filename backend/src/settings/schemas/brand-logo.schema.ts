import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type BrandLogoDocument = HydratedDocument<BrandLogo>;

@Schema({ timestamps: true, collection: 'brandlogos' })
export class BrandLogo {
  @Prop({ required: true, unique: true }) id: string;
  @Prop({ required: true, maxlength: 80 }) name: string;
  @Prop({ required: true, select: false }) imageBase64: string;
  @Prop({ required: true, select: false }) iconBase64: string;
  @Prop({ required: true }) width: number;
  @Prop({ required: true }) height: number;
  @Prop({ required: true }) sourceWidth: number;
  @Prop({ required: true }) sourceHeight: number;
  @Prop({ required: true }) bytes: number;
}

export const BrandLogoSchema = SchemaFactory.createForClass(BrandLogo);
