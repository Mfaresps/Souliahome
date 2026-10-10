import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CarrierPayoutDocument = HydratedDocument<CarrierPayout>;

/**
 * One transfer from Bosta to us. `mode: batch` owns one net vault credit and the linked orders.
 * Shipping, return and transfer fees have already reduced that credit; they never post again.
 *
 * Legacy transfers are reconciliation-only: every delivered order already entered the vault on the
 *   day it was settled (the automatic settlement books the net at delivery). Booking the transfer
 *   again would count the same money twice. What the transfer DOES book:
 *     • `fee` — Bosta's transfer fee, as an approved expense dated on the transfer (`feeExpenseId`);
 *     • `adjustment` — when what landed differs from what the statement says Bosta held, and the
 *       user chose to book that difference (return-leg fees and any other deduction the vault
 *       never saw). Positive = more than expected arrived; negative = less.
 * The statement reads this collection for its payout lines; nothing else does.
 */
@Schema({ timestamps: true })
export class CarrierPayout {
  /** A single scheduled transfer owns all its orders, including fee-only prepaid orders. */
  @Prop()
  batchKey?: string;

  @Prop({ default: 'legacy' })
  mode: string;

  @Prop({ default: 'completed' })
  state: string;

  @Prop({ default: '' })
  lockAt: string;

  @Prop({ default: '' })
  vaultEntryId: string;

  @Prop({ type: [String], default: [] })
  transactionIds: string[];

  @Prop({ type: [String], default: [] })
  returnTransactionIds: string[];

  @Prop({ default: '' })
  error: string;

  @Prop({ required: true })
  payoutNo: string;

  @Prop({ default: 'bosta' })
  carrier: string;

  /** Business date the transfer landed (YYYY-MM-DD). */
  @Prop({ required: true })
  date: string;

  /** What landed in the account. */
  @Prop({ required: true })
  amount: number;

  @Prop({ default: 0 })
  fee: number;

  @Prop({ default: '' })
  feeExpenseId: string;

  /** The vault account the transfer landed in. The fee and any adjustment post here too. */
  @Prop({ required: true })
  vaultMethod: string;

  /** Statement balance at the moment of recording — what Bosta should have held. */
  @Prop({ default: 0 })
  expected: number;

  /** expected − amount − fee. Zero when the transfer reconciles. */
  @Prop({ default: 0 })
  difference: number;

  /**
   * Return-leg fees (failedDelivery.returnShipCost) recorded since the previous transfer. Bosta
   * nets them out of its wallet, so they reach the vault only here — closeFailedDelivery
   * deliberately posts nothing. Booked as part of `adjustmentVaultEntryId`.
   */
  @Prop({ default: 0 })
  returnFeesBooked: number;

  /** Vault delta booked for the unexplained difference: −difference when booked, 0 when left open. */
  @Prop({ default: 0 })
  adjustment: number;

  @Prop({ default: '' })
  adjustmentVaultEntryId: string;

  @Prop({ default: '' })
  bostaRef: string;

  @Prop({ default: '' })
  note: string;

  @Prop({ default: '' })
  by: string;
}

export const CarrierPayoutSchema = SchemaFactory.createForClass(CarrierPayout);
CarrierPayoutSchema.index({ batchKey: 1 }, { unique: true, sparse: true });
