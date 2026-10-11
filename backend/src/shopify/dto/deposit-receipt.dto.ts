import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { DEPOSIT_VAULT_METHODS } from '../deposit-receipts.util';

/**
 * ⚠ Every field a route reads must be declared here — the global whitelist pipe strips the rest
 *   silently, and a stripped amount would reach the service as `undefined`.
 */
export class DepositReceiptEntryDto {
  @IsOptional()
  @IsString()
  @MaxLength(5)
  screenshotTime?: string;
  @IsOptional()
  @IsString()
  @MaxLength(30)
  senderPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  senderName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  senderHandle?: string;

  @IsOptional()
  @IsBoolean()
  acknowledgeImageWarning?: boolean;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(10_000_000)
  amount: number;

  @IsIn(DEPOSIT_VAULT_METHODS as unknown as string[])
  method: string;
}

export class DepositReceiptReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
