import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ExpenseDocument = HydratedDocument<Expense>;

@Schema({ timestamps: true })
export class Expense {
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
}

export const ExpenseSchema = SchemaFactory.createForClass(Expense);
