import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EmployeeLeaveDocument = HydratedDocument<EmployeeLeave>;

/**
 * A one-off day (or date range) an employee is off — independent from the
 * weekly shift template on purpose. A shift is a recurring pattern; a leave
 * is a single event. Folding leave into the shift template (e.g. toggling
 * `isActive` on the whole week) would require remembering to flip it back,
 * and would take the employee off EVERY day their template covers, not just
 * the one day they are actually away.
 *
 * `fromDate`/`toDate` are plain 'YYYY-MM-DD' strings — never a JS Date/ISO
 * timestamp. This mirrors the date-window rule already documented for
 * transactions/vault entries in this codebase: a bare date string compares
 * correctly with `<=`/`>=` against another bare date string, and there is no
 * time-of-day component to a "day off". Do not switch this to an ISO
 * timestamp — see date-window.util.ts for why that class of bug is subtle
 * and was expensive to find elsewhere in this codebase.
 */
@Schema({ timestamps: true })
export class EmployeeLeave {
  @Prop({ required: true })
  userId: string; // ref User._id

  @Prop({ required: true })
  name: string; // denormalized display name, same convention as EmployeeShift

  @Prop({ required: true })
  fromDate: string; // 'YYYY-MM-DD', inclusive

  @Prop({ required: true })
  toDate: string; // 'YYYY-MM-DD', inclusive; equals fromDate for a single day off

  @Prop({ default: '' })
  reason: string;

  @Prop({ default: '' })
  createdBy: string;
}

export const EmployeeLeaveSchema = SchemaFactory.createForClass(EmployeeLeave);
EmployeeLeaveSchema.index({ userId: 1, fromDate: 1, toDate: 1 });
