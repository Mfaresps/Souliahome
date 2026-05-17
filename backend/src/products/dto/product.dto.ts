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
  @IsNotEmpty()
  readonly code: string;

  @IsString()
  @IsNotEmpty()
  readonly name: string;

  @IsOptional()
  @Type(() => Number)
  readonly sellPrice?: number;

  @IsOptional()
  @Type(() => Number)
  readonly buyPrice?: number;

  @IsOptional()
  @Type(() => Number)
  readonly minStock?: number;

  @IsOptional()
  @Type(() => Number)
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

export class RequestProductEditDto {
  @IsString()
  @IsNotEmpty()
  readonly requestedBy: string;

  @IsString()
  @IsOptional()
  readonly requestedById?: string;

  @IsString()
  @IsOptional()
  readonly requestedByUsername?: string;

  @IsOptional()
  readonly changes?: {
    sellPrice?: number;
    buyPrice?: number;
    minStock?: number;
    openingBalance?: number;
    supplier?: string;
    name?: string;
    code?: string;
    imageUrl?: string;
  };
}

export class ReviewProductEditDto {
  @IsString()
  @IsOptional()
  readonly rejectedReason?: string;
}
