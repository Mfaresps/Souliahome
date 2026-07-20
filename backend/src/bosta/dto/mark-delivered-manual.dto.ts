import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';

export const MANUAL_DELIVERY_REASONS = [
  'Delivered before shipping integration',
  'Customer confirmed receiving order',
  'Other',
] as const;

export class MarkDeliveredManualDto {
  @IsString()
  @IsNotEmpty()
  @IsIn(MANUAL_DELIVERY_REASONS)
  readonly reason: string;

  @IsString()
  @IsOptional()
  readonly note?: string;
}
