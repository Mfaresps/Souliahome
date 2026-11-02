import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class DepositObjectionDto {
  @IsInt() @Min(0) revision: number;
  @IsString() @MaxLength(60) reasonCode: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class ShippingDecisionDto {
  @IsBoolean() enabled: boolean;
  @IsInt() @Min(0) revision: number;
  @IsOptional() @IsString() @MaxLength(60) reasonCode?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MaxLength(60) exceptionCode?: string;
  @IsOptional() @IsString() @MaxLength(500) exceptionNote?: string;
}
