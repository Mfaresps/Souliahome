import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsArray,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  readonly code: string;

  @IsString()
  @IsNotEmpty()
  readonly name: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly sellPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly buyPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly minStock?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly openingBalance?: number;

  @IsString()
  @IsOptional()
  readonly supplier?: string;

  @IsString()
  @IsOptional()
  readonly imageUrl?: string;
}

export class UpdateProductDto {
  @IsString()
  @IsOptional()
  readonly code?: string;

  @IsString()
  @IsOptional()
  readonly name?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly sellPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly buyPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly minStock?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly openingBalance?: number;

  @IsString()
  @IsOptional()
  readonly supplier?: string;

  @IsString()
  @IsOptional()
  readonly imageUrl?: string;
}

export class ImportProductItemDto {
  @IsString()
  readonly code: string;

  @IsString()
  readonly name: string;

  @IsNumber()
  @IsOptional()
  readonly sellPrice?: number;

  @IsNumber()
  @IsOptional()
  readonly buyPrice?: number;

  @IsNumber()
  @IsOptional()
  readonly minStock?: number;

  @IsNumber()
  @IsOptional()
  readonly openingBalance?: number;

  @IsString()
  @IsOptional()
  readonly supplier?: string;

  @IsString()
  @IsOptional()
  readonly imageUrl?: string;
}

export class ImportProductsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportProductItemDto)
  readonly items: ImportProductItemDto[];
}

export class BulkUpdateProductDto {
  @IsArray()
  readonly ids: string[];

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly sellPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly buyPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly minStock?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly openingBalance?: number;

  @IsString()
  @IsOptional()
  readonly supplier?: string;
}

export class BulkDeleteProductDto {
  @IsArray()
  readonly ids: string[];
}
