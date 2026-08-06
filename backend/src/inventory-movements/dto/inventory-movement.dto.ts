import { IsString, IsNotEmpty, IsNumber, NotEquals } from 'class-validator';

export class AdjustInventoryDto {
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
