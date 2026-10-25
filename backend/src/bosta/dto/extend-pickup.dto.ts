import { ArrayNotEmpty, ArrayUnique, IsArray, IsInt, IsMongoId, Min } from 'class-validator';

export class ExtendPickupDto {
  @IsArray() @ArrayNotEmpty() @ArrayUnique() @IsMongoId({ each: true })
  orderIds: string[];

  @IsInt() @Min(1)
  expectedNumberOfParcels: number;
}
