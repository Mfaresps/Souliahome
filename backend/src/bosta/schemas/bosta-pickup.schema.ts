import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ timestamps: true })
export class BostaPickup {
  @Prop({ required: true }) scheduledDate: string;
  @Prop({ required: true }) businessLocationId: string;
  @Prop({ required: true, type: [String] }) orderIds: string[];
  @Prop({ required: true }) numberOfParcels: number;
  @Prop({ default: 'pending', enum: ['pending', 'created', 'rejected'] }) status: string;
  @Prop({ default: '' }) bostaPickupId: string;
  @Prop({ default: '' }) requestedBy: string;
  @Prop({ default: '' }) error: string;
  @Prop({ default: true }) active: boolean;
  @Prop({ default: 0 }) bostaErrorCode: number;
}
export type BostaPickupDocument = HydratedDocument<BostaPickup>;
export const BostaPickupSchema = SchemaFactory.createForClass(BostaPickup);
BostaPickupSchema.index({ scheduledDate: 1, businessLocationId: 1 }, { unique: true });
BostaPickupSchema.index({ orderIds: 1 }, { unique: true, partialFilterExpression: { active: true } });
