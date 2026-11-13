import { IsString, IsNotEmpty, IsNumber, NotEquals, IsOptional, IsArray, ArrayMaxSize, MaxLength, IsBoolean } from 'class-validator';

export class AdjustInventoryDto {
  @IsOptional() @IsString()
  readonly warehouseCode?: string;
  @IsString()
  @IsNotEmpty()
  readonly productId: string;

  @IsNumber()
  @NotEquals(0)
  readonly qtyDelta: number;

  @IsString()
  @IsNotEmpty()
  readonly reason: string;

  /** القطع المحددة اللي التسوية بتشطبها — بتمنع تسجيل خسارة نفس القطعة مرتين. */
  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsString({ each: true })
  readonly unitIds?: string[];

  /** تأكيد صريح لتسوية بالنقص من غير تحديد قطع. */
  @IsOptional() @IsBoolean()
  readonly unidentifiedConfirmed?: boolean;

  /** ليه القطع مش متحددة (إجباري مع التأكيد). */
  @IsOptional() @IsString() @MaxLength(300)
  readonly unidentifiedNote?: string;

  /** مفتاح الطلب — نفس المفتاح مابيسجّلش تسوية تانية. */
  @IsOptional() @IsString() @MaxLength(120)
  readonly requestKey?: string;
}
