import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CarrierImportDocument = HydratedDocument<CarrierImport>;

/**
 * One settlement-file import, recorded as its own entity.
 *
 * WHY THIS COLLECTION EXISTS
 * Settling from a carrier file moves cash into the vault for many orders in one action. Without a
 * record of the operation itself, that shows up only as N unrelated payments scattered across N
 * transactions, and the questions people actually ask afterwards — "which file did this come
 * from?", "how much entered the vault from Bosta's 26 Aug payout?", "why was this order skipped?"
 * — have no answer anywhere in the system.
 *
 * ⚠ THIS IS AN AUDIT RECORD, NOT THE MONEY. The authoritative financial effect of a settlement
 *   lives where it always has: the vault entry and the `payments[]` row that
 *   `TransactionsService.collect()` writes, including its `snapshotBefore` (the undo record).
 *   Deleting a document here would lose the paper trail but would not un-collect anything, and
 *   nothing in the collection or reversal path reads from this collection to decide an amount.
 *
 * ⚠ ROWS ARE STORED FOR EVERY OUTCOME, NOT JUST THE SETTLED ONES. A row that was skipped as
 *   «محصَّل مسبقاً», refused as «تعارض», or flagged as «خصم بدون تحصيل» is precisely what someone
 *   needs to see later. Storing only successes would make every import look flawless and would
 *   silently discard the carrier-audit evidence (fee-only deductions and shipping overcharges)
 *   that is half the reason for this feature.
 */

/** One file row as it was classified, plus what actually happened to it at settlement time. */
@Schema({ _id: false })
export class CarrierImportRow {
  /** 1-based row number in the sheet, so a message can point at the real line. */
  @Prop({ default: 0 })
  row: number;

  @Prop({ default: '' })
  ref: string;

  @Prop({ default: '' })
  tracking: string;

  /** RowStatus from carrier-statement.constants.ts. Stored value — never rename one. */
  @Prop({ default: '' })
  status: string;

  /** MatchKey — 'ref' | 'tracking' | 'none'. Which field resolved this row. */
  @Prop({ default: 'none' })
  matchedBy: string;

  @Prop({ default: '' })
  txId: string;

  @Prop({ default: '' })
  txRef: string;

  @Prop({ default: '' })
  client: string;

  /** Cash the carrier collected from the customer. */
  @Prop({ default: 0 })
  cod: number;

  /** Everything the carrier deducted for itself. */
  @Prop({ default: 0 })
  totalFees: number;

  /** The carrier's own net figure — kept as the proof line, never used as an input. */
  @Prop({ default: 0 })
  netValue: number;

  /**
   * Fee breakdown.
   *
   * ⚠ `@Prop({ type: Object })` is mandatory on an object-valued prop — without it Mongoose throws
   *   CannotDetermineTypeError at module load and takes the whole API down. See the nullable-@Prop
   *   rule in CLAUDE.md.
   *
   * ⚠ Kept SPLIT rather than folded into `totalFees`. Bosta's «Total Fees» is
   *   shipping + insurance + VAT (verified on a real file), so a single number cannot answer
   *   whether an overcharge came from the tariff itself or from add-on fees — two different
   *   problems with two different conversations to have with the carrier.
   */
  @Prop({ type: Object, default: {} })
  fees: {
    shipping?: number;
    insurance?: number;
    vat?: number;
    codFees?: number;
  };

  /** What we billed the customer for shipping — the tariff frozen on the transaction. */
  @Prop({ default: 0 })
  billedShip: number;

  /** How much more the carrier took than we billed. 0 when they took less — that is not a finding. */
  @Prop({ default: 0 })
  shipVariance: number;

  /** 'ok' | 'notable' | 'high' — from varianceLevel(). */
  @Prop({ default: 'ok' })
  varianceLevel: string;

  /** File's city, kept so the report can derive a real per-governorate tariff. */
  @Prop({ default: '' })
  city: string;

  /** File name/phone disagreed with the matched transaction — the mistyped-reference signal. */
  @Prop({ default: false })
  identityMismatch: boolean;

  /** Did this row actually settle in this run? */
  @Prop({ default: false })
  settled: boolean;

  /** Cash that entered the vault for this row (COD minus what the carrier kept). */
  @Prop({ default: 0 })
  vaultAmount: number;

  /** Set when a selected row failed at settlement. Empty on success and on skipped rows. */
  @Prop({ default: '' })
  error: string;

  /** Human-readable reason for the row's classification. */
  @Prop({ default: '' })
  note: string;
}

export const CarrierImportRowSchema = SchemaFactory.createForClass(CarrierImportRow);

@Schema({ timestamps: true })
export class CarrierImport {
  /** Human-facing operation number, e.g. IMP-014. Assigned once, never reused. */
  @Prop({ required: true, unique: true, index: true })
  importNo: string;

  /** Carrier code from CARRIERS. Stored value. */
  @Prop({ default: 'bosta', index: true })
  carrier: string;

  @Prop({ default: '' })
  fileName: string;

  /**
   * SHA-256 of the uploaded bytes — the re-upload guard.
   *
   * ⚠ Indexed but deliberately NOT unique. Re-uploading the same file is a legitimate thing to
   *   do: the first run may have settled only some rows, and the rest are settled later from the
   *   same payout. A unique index would make that impossible; the duplicate check belongs in the
   *   service, which WARNS and lets a human decide, rather than in the database, which can only
   *   refuse.
   */
  @Prop({ default: '', index: true })
  fileHash: string;

  @Prop({ default: '' })
  sheet: string;

  /** Vault account the cash was posted to. */
  @Prop({ default: '' })
  collectMethod: string;

  @Prop({ default: '' })
  by: string;

  /** Row counts. `rowsRead` is the file's size; the rest describe what happened to it. */
  @Prop({ default: 0 })
  rowsRead: number;

  @Prop({ default: 0 })
  rowsMatched: number;

  @Prop({ default: 0 })
  rowsSettled: number;

  @Prop({ default: 0 })
  rowsFailed: number;

  @Prop({ default: 0 })
  rowsSkipped: number;

  /** Totals, in EGP. */
  @Prop({ default: 0 })
  totalCod: number;

  @Prop({ default: 0 })
  totalFees: number;

  /** What actually entered the vault. This is the figure the vault log must agree with. */
  @Prop({ default: 0 })
  totalVault: number;

  /** Carrier-audit totals — the reason this feature pays for itself more than once. */
  @Prop({ default: 0 })
  totalVariance: number;

  @Prop({ default: 0 })
  feeOnlyCount: number;

  @Prop({ default: 0 })
  feeOnlyAmount: number;

  /** Every row and its outcome — see the class comment on why failures are kept. */
  @Prop({ type: [CarrierImportRowSchema], default: [] })
  rows: CarrierImportRow[];

  /** Non-fatal problems surfaced to the user (unrecognised columns, duplicates, proof failures). */
  @Prop({ type: [String], default: [] })
  warnings: string[];

  /** ISO date the settlement was posted under. */
  @Prop({ default: '' })
  date: string;
}

export const CarrierImportSchema = SchemaFactory.createForClass(CarrierImport);
