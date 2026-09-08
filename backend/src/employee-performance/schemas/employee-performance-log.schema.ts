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

  /**
   * The same employee, addressed by the one identifier that survives a restore.
   *
   * ⚠ employeeId is a User._id, which is REGENERATED whenever an account is recreated
   * on another machine — so a backup carried from the local install to the online one
   * (or back) leaves every row here pointing at an id that no longer exists, and the
   * leaderboard comes back empty even though all rows were captured perfectly. This is
   * the same class of failure that once emptied the Performance Hub.
   *
   * The username is what login, findByUsername and restoreUsersMerge all match on, and it
   * carries the unique index — so it is stable across databases. It is stored ALONGSIDE
   * employeeId, never instead of it: employeeId stays the primary key for every query
   * (it is indexed and already written on 600+ rows), and this field is the fallback
   * used to re-link a row whose id went stale. See relinkOrphanedLogs().
   *
   * Defaults to '' so every pre-existing row remains valid with no migration.
   */
  @Prop({ default: '', index: true })
  employeeUsername: string;

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
