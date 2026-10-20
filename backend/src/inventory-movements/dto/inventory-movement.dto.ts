import { IsString, IsNotEmpty, IsNumber, NotEquals, IsOptional } from 'class-validator';

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
}
