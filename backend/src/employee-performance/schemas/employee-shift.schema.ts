import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EmployeeShiftDocument = HydratedDocument<EmployeeShift>;

/**
 * A weekly-recurring shift template: (employee, time window, set of weekdays).
 *
 * ⚠ One employee can now hold MULTIPLE shift documents (e.g. Sun–Tue 9–5 and
 * Wed–Thu 12–8) — `userId` deliberately carries no `unique` index any more.
 * Uniqueness moved to the (userId, daysOfWeek, window) combination, enforced
 * in EmployeeShiftService at the application layer (see assertNoOverlap),
 * because Mongo cannot express "no two documents whose daysOfWeek arrays
 * intersect" as a schema-level constraint.
 */
@Schema({ timestamps: true })
export class EmployeeShift {
  @Prop({ required: true })
  userId: string; // ref User._id — no longer unique; an employee may hold several shifts

  /**
   * The same employee, addressed by the identifier that survives a restore.
   *
   * See the identical field on EmployeePerformanceLog for the full reasoning. In short:
   * userId is a User._id, which is regenerated whenever an account is recreated on
   * another machine, so a backup carried between the local and the online install
   * leaves every shift pointing at an id that no longer exists. The roster is built
   * from this collection, so a broken userId empties the leaderboard for that person
   * even when their points re-linked perfectly.
   *
   * Defaults to '' so every pre-existing shift row remains valid with no migration.
   */
  @Prop({ default: '', index: true })
  userUsername: string;

  @Prop({ required: true })
  name: string; // denormalized display name

  @Prop({ required: true })
  shiftStart: string; // 'HH:mm', 24h

  @Prop({ required: true })
  shiftEnd: string; // 'HH:mm'; end < start means an overnight-wrapping shift

  /**
   * 0=Sunday … 6=Saturday (JS Date.getDay() convention — matches getUTCDay()
   * already used throughout this service for the overnight-wrap math).
   *
   * ⚠ Defaults to all seven days. This is what makes the migration purely
   * additive: every shift row that existed before this field was added reads
   * as "every day", i.e. exactly its old always-on behaviour. No backfill
   * script, no behaviour change for pre-existing data.
   */
  @Prop({ type: [Number], default: [0, 1, 2, 3, 4, 5, 6] })
  daysOfWeek: number[];

  @Prop({ default: true })
  isActive: boolean;

  @Prop({ default: false })
  isOnCall: boolean; // fallback/default assignee for orders outside any shift window, on this shift's days

  @Prop({ default: '' })
  createdBy: string;

  @Prop({ default: '' })
  updatedBy: string;
}

export const EmployeeShiftSchema = SchemaFactory.createForClass(EmployeeShift);
EmployeeShiftSchema.index({ userId: 1 });
