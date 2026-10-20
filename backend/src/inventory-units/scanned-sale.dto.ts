import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDefined, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { CreateTransactionDto } from '../transactions/dto/transaction.dto';
import { OBJECT_ID_PATTERN } from './inventory-unit.constants';

export class SalePieceBindingDto {
  @IsString() @Matches(OBJECT_ID_PATTERN) productId: string;
  @IsOptional() @IsArray() @ArrayMaxSize(1000) @Matches(OBJECT_ID_PATTERN, { each: true }) unitIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @Matches(OBJECT_ID_PATTERN, { each: true }) packIds?: string[];
}
export class ScannedSaleDto {
  @IsString() @Matches(/^[A-Za-z0-9:_-]{8,120}$/) operationKey: string;
  @IsDefined() @ValidateNested() @Type(() => CreateTransactionDto) invoice: CreateTransactionDto;
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => SalePieceBindingDto) bindings: SalePieceBindingDto[];
}
