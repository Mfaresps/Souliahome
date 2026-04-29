import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type VaultBalanceDocument = VaultBalance & Document;

@Schema({ timestamps: true })
export class VaultBalance {
  @Prop({ required: true, unique: true })
  segment: string; // 'cash', 'vodafone', 'instapay', 'bank'

  @Prop({ required: true, default: 0 })
  balance: number;

  @Prop({ required: true, default: 0 })
  version: number; // For optimistic locking

  @Prop({ type: Date })
  lastUpdated: Date;

  @Prop()
  lastUpdatedBy: string;

  @Prop()
  lastTransactionRef: string;

  @Prop({ type: Object })
  metadata: {
    totalDeposits?: number;
    totalWithdrawals?: number;
    transactionCount?: number;
  };
}

export const VaultBalanceSchema = SchemaFactory.createForClass(VaultBalance);

// Add index for fast lookups
VaultBalanceSchema.index({ segment: 1 });
