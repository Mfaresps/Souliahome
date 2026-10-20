import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { TrackingRequestDto } from './inventory-unit.dto';
import { OBJECT_ID_PATTERN } from './inventory-unit.constants';

export const SCAN_INTENTS = ['lookup', 'inspect', 'reserve', 'picking', 'prepare', 'return', 'count'] as const;
export class ScanContextDto {
  @IsString() @IsIn(SCAN_INTENTS) intent: string;
  @IsString() @Matches(/^[A-Za-z0-9:_-]{8,120}$/) sessionKey: string;
  @IsOptional() @IsString() @Matches(OBJECT_ID_PATTERN) productId?: string;
  @IsOptional() @IsString() @Matches(OBJECT_ID_PATTERN) transactionId?: string;
  @IsOptional() @IsString() @MaxLength(120) lineId?: string;
}
export class ScanRequestDto extends TrackingRequestDto {
  @IsString() @IsIn(SCAN_INTENTS) intent: string;
  @IsString() @Matches(/^[A-Za-z0-9:_-]{8,120}$/) sessionKey: string;
  @IsOptional() @IsString() @Matches(OBJECT_ID_PATTERN) productId?: string;
  @IsOptional() @IsString() @Matches(OBJECT_ID_PATTERN) transactionId?: string;
  @IsOptional() @IsString() @MaxLength(120) lineId?: string;
  @IsString() @MaxLength(160) identifier: string;
  @IsString() @IsIn(['keyboard', 'camera', 'manual-entry', 'manual-selection']) inputMethod: string;
  @IsOptional() @IsBoolean() manualSelectionConfirmed?: boolean;
}
export class EligibleScanQueryDto extends ScanContextDto {
  @IsOptional() @IsString() @MaxLength(160) q?: string;
  @IsOptional() @IsString() @Matches(OBJECT_ID_PATTERN) cursor?: string;
}
