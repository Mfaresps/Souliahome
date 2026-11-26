import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ExpenseDocument = HydratedDocument<Expense>;

@Schema({ timestamps: true })
export class Expense {
  @Prop()
  complaintId?: string;

  @Prop()
  complaintCycle?: number;

  @Prop()
  vaultEntryId?: string;
  @Prop({ required: true })
  date: string;

  @Prop({ required: true })
  desc: string;

  @Prop({ required: true })
  category: string;

  @Prop({ required: true })
  amount: number;

  @Prop()
  employee: string;

  @Prop()
  notes: string;

  @Prop({ default: 'كاش' })
  account: string;

  @Prop({ default: 'معلق' })
  status: string;

  @Prop({ default: '' })
  expenseNo: string;

  @Prop()
  approvedBy: string;

  @Prop()
  approvedAt: string;

  @Prop()
  attachment: string;

  @Prop({ type: [String], default: [] })
  descItems: string[];

  /** The saved party (expensepayees) — ads / salary / subscription only. '' = none. */
  @Prop({ type: String, default: '' })
  payeeId: string;

  /** Name at the time of the expense (a later rename of the payee leaves it as it was). */
  @Prop({ type: String, default: '' })
  payeeName: string;

  @Prop({ type: String, default: '' })
  payeeKind: string;

  /** The period the expense pays for (YYYY-MM-DD, inclusive). '' = not stated. */
  @Prop({ type: String, default: '' })
  periodFrom: string;

  @Prop({ type: String, default: '' })
  periodTo: string;

  /** Salary breakdown (base, points × value, overtime, deductions, net) — «مرتبات» only. */
  @Prop({ type: Object, default: null })
  salary: Record<string, any> | null;
}

export const ExpenseSchema = SchemaFactory.createForClass(Expense);
ExpenseSchema.index({ payeeId: 1, periodFrom: 1 });
