import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EmployeePerformanceLogDocument = HydratedDocument<EmployeePerformanceLog>;

// 'deposit_full' | 'deposit_partial_50' | 'deposit_partial_low' | 'deposit_none'
// | 'confirmation_speed' | 'delivery_completed' | 'manual_bonus'
export type PerformanceActionType =
  | 'deposit_full'
  | 'deposit_partial_50'
  | 'deposit_partial_low'
  | 'deposit_none'
  | 'confirmation_speed'
  | 'delivery_completed'
  | 'manual_bonus';

/** Append-only audit log — rows are only ever inserted, never updated or deleted. */
@Schema({ timestamps: true })
export class EmployeePerformanceLog {
  @Prop({ required: true, index: true })
  employeeId: string; // User._id as string

  @Prop({ default: '', index: true })
  orderId: string; // ShopifyOrder._id as string — empty for manual_bonus rows (not tied to an order)

  @Prop({ required: true })
  actionType: string;

  @Prop({ required: true })
  points: number;

  @Prop({ default: '' })
  note: string; // human-readable breakdown, e.g. "إيداع 100% محصل"

  @Prop({ type: Object, default: null })
  meta: Record<string, unknown> | null; // e.g. {depositPct, speedMinutes}
}

export const EmployeePerformanceLogSchema = SchemaFactory.createForClass(EmployeePerformanceLog);
