import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ExpensePayeeDocument = HydratedDocument<ExpensePayee>;

/**
 * A saved expense party — ad agency, employee on payroll, subscribed service.
 * Expenses keep their own copy of the name (`payeeName`), so renaming a payee never
 * rewrites history; they are tied to it by `payeeId`.
 */
@Schema({ timestamps: true, collection: 'expensepayees' })
export class ExpensePayee {
  @Prop({ type: String, required: true, enum: ['ads', 'salary', 'subscription'] })
  kind: string;

  @Prop({ type: String, required: true })
  name: string;

  /** payeeNameKey(name) — unique per kind. */
  @Prop({ type: String, required: true })
  nameKey: string;

  /** Default amount: monthly salary, subscription price per cycle, usual ad budget. 0 = none. */
  @Prop({ type: Number, default: 0 })
  amount: number;

  /** Default vault the expense is paid from ('' = no default). */
  @Prop({ type: String, default: '' })
  account: string;

  /** ads only: meta | tiktok | google | snapchat | influencer | other. */
  @Prop({ type: String, default: '' })
  platform: string;

  /** subscription only: monthly | quarterly | yearly. */
  @Prop({ type: String, default: '' })
  billingCycle: string;

  /** salary only: EGP per performance point (the monthly bonus rate). */
  @Prop({ type: Number, default: 0 })
  pointValue: number;

  /** salary only: the linked system account, when the employee has one. */
  @Prop({ type: String, default: '' })
  userId: string;

  @Prop({ type: String, default: '' })
  notes: string;

  @Prop({ type: Boolean, default: true })
  active: boolean;

  @Prop({ type: String, default: '' })
  createdBy: string;

  @Prop({ type: String, default: '' })
  lastUsedAt: string;
}

export const ExpensePayeeSchema = SchemaFactory.createForClass(ExpensePayee);
ExpensePayeeSchema.index({ kind: 1, nameKey: 1 }, { unique: true, name: 'expense_payee_kind_name_unique' });
