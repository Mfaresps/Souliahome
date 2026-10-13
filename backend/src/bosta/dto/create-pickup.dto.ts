import { ArrayNotEmpty, ArrayUnique, IsArray, IsMongoId, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreatePickupDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  scheduledDate: string;
  @IsString() @MinLength(1) @MaxLength(100)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  businessLocationId: string;
  @IsArray() @ArrayNotEmpty() @ArrayUnique() @IsMongoId({ each: true })
  orderIds: string[];
  @IsString() @MinLength(1) @MaxLength(100)
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  contactName: string;
  @IsString() @Matches(/^(?:\+20|0020|20|0)1[0125]\d{8}$/)
  contactPhone: string;
}
