import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type TransactionDocument = HydratedDocument<Transaction>;

export class TransactionItem {
  @Prop({ required: true })
  code: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  qty: number;

  @Prop({ required: true })
  price: number;

  @Prop({ required: true })
  total: number;
}

@Schema({ timestamps: true })
export class Transaction {
  @Prop({ required: true })
  date: string;

  @Prop({
    required: true,
    enum: ['مبيعات', 'مشتريات', 'مرتجع مبيعات', 'مرتجع مشتريات', 'مرتجع'],
  })
  type: string;

  @Prop({ default: '' })
  client: string;

  @Prop()
  phone: string;

  @Prop()
  ref: string;

  @Prop()
  notes: string;

  @Prop({ default: '' })
  payment: string;

  @Prop({ default: 0 })
  deposit: number;

  @Prop({ default: 0 })
  initialDeposit: number;

  @Prop({ default: 0 })
  remaining: number;

  @Prop({ type: [Object], required: true })
  items: TransactionItem[];

  @Prop({ required: true })
  total: number;

  @Prop({ required: true })
  employee: string;

  @Prop()
  shipCo: string;

  @Prop()
  shipZone: string;

  @Prop({ default: 0 })
  shipCost: number;

  @Prop({ default: 0 })
  discount: number;

  @Prop()
  depMethod: string;

  @Prop({ default: 'معلق' })
  payStatus: string;

  @Prop({ default: 0 })
  itemsTotal: number;

  @Prop({ default: 0 })
  actualShipCost: number;

  @Prop({ default: 0 })
  shipLoss: number;

  @Prop({ default: false })
  cancelled: boolean;

  @Prop()
  cancelReason: string;

  @Prop()
  cancelledBy: string;

  @Prop()
  cancelledAt: string;

  @Prop({ type: [Object], default: [] })
  editHistory: Record<string, unknown>[];

  @Prop()
  collectMethod: string;

  @Prop()
  collectNote: string;

  @Prop()
  collectedAt: string;

  @Prop({ default: false })
  archived: boolean;

  @Prop()
  archivedAt: string;

  @Prop()
  archivedBy: string;

  /** Cancel request submitted by employee, pending manager approval */
  @Prop({ type: Object, default: null })
  cancelRequest: {
    requestedBy: string;
    reason: string;
    requestedAt: string;
    status: string; // 'معلق' | 'معتمد' | 'مرفوض'
    reviewedBy?: string;
    reviewedAt?: string;
    rejectedReason?: string;
  } | null;

  /** Deposit history log - initial and additional deposits */
  @Prop({ type: [Object], default: [] })
  deposits: Array<{
    amount: number;
    method: string;
    note: string;
    date: string;
    by: string;
  }>;

  /** Payment/Collection history log */
  @Prop({ type: [Object], default: [] })
  payments: Array<{
    amount: number;
    method: string;
    note: string;
    date: string;
    by: string;
    remaining: number;
  }>;

  /** Employee comments on transaction */
  @Prop({ type: [Object], default: [] })
  comments: Array<{
    id: number;
    text: string;
    type: string; // 'عام' | 'تنبيه' | 'ملاحظة' | 'أسئلة'
    employee: string;
    timestamp: string;
    createdAt: string;
  }>;
}

export const TransactionSchema = SchemaFactory.createForClass(Transaction);
