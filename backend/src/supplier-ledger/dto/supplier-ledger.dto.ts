import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsEnum,
  IsPositive,
  ValidateIf,
} from 'class-validator';

export class PostManualAdjustmentDto {
  @IsString()
  @IsNotEmpty()
  readonly date: string;

  @IsNumber()
  readonly amount: number;

  @IsString()
  @IsNotEmpty()
  readonly reason: string;
}

export const SR_BALANCE_ADJUSTMENT_KINDS = ['deposit', 'debit'] as const;
export type SrBalanceAdjustmentKind =
  (typeof SR_BALANCE_ADJUSTMENT_KINDS)[number];

export const SR_VAULT_SEGMENTS = [
  'cash',
  'vodafone',
  'instapay',
  'bank',
] as const;

/** Vault segment → the Arabic payment-method label the vault ledger stores in `method`. */
export const SR_VAULT_SEG_LABELS: Record<string, string> = {
  cash: 'كاش',
  vodafone: 'فودافون كاش',
  instapay: 'Instapay',
  bank: 'تحويل بنكي',
};

/**
 * Supplier balance adjustment — distinct from PostManualAdjustmentDto (a signed, cash-neutral
 * ledger correction). Here direction is explicit rather than encoded in the sign, and a
 * 'deposit' additionally withdraws real cash from a vault segment, so `vaultSeg` is required
 * for that kind and rejected for 'debit'.
 */
export class CreateBalanceAdjustmentDto {
  @IsEnum(SR_BALANCE_ADJUSTMENT_KINDS)
  readonly kind: SrBalanceAdjustmentKind;

  @IsNumber()
  @IsPositive()
  readonly amount: number;

  @IsString()
  @IsNotEmpty()
  readonly date: string;

  @IsString()
  @IsNotEmpty()
  readonly desc: string;

  @IsString()
  @IsOptional()
  readonly refNo?: string;

  /** Cash source. Required for deposits (money actually leaves the vault), unused for debits. */
  @ValidateIf((o: CreateBalanceAdjustmentDto) => o.kind === 'deposit')
  @IsEnum(SR_VAULT_SEGMENTS)
  readonly vaultSeg?: string;
}

export class LedgerQueryDto {
  @IsString()
  @IsOptional()
  readonly from?: string;

  @IsString()
  @IsOptional()
  readonly to?: string;
}
