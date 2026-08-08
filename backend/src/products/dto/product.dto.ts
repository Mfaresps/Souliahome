import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsArray,
  IsBoolean,
  ValidateNested,
  Min,
  ArrayMaxSize,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ProductDimensionsDto {
  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly length?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly width?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly height?: number;
}

export class CreateProductDto {
  @IsString()
  @IsOptional()
  readonly code?: string;

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

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  readonly images?: string[];

  @IsString()
  @IsOptional()
  readonly categoryId?: string;

  @IsString()
  @IsOptional()
  readonly collectionId?: string;

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;

  @IsString()
  @IsOptional()
  readonly description?: string;

  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @IsOptional()
  readonly colors?: string[];

  /** خصائص الصنف (Waterproof, Anti Slip, …) — بلا حد أقصى، بعكس الألوان. */
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @IsOptional()
  readonly features?: string[];

  @IsBoolean()
  @IsOptional()
  readonly isPattern?: boolean;

  @IsString()
  @IsOptional()
  readonly pattern?: string;

  @IsString()
  @IsOptional()
  readonly material?: string;

  @IsIn(['standard', 'custom', ''])
  @IsOptional()
  readonly sizeType?: string;

  @IsString()
  @IsOptional()
  readonly size?: string;

  @ValidateNested()
  @Type(() => ProductDimensionsDto)
  @IsOptional()
  readonly dimensions?: ProductDimensionsDto;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  readonly tags?: string[];
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

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  readonly images?: string[];

  @IsString()
  @IsOptional()
  readonly categoryId?: string;

  @IsString()
  @IsOptional()
  readonly collectionId?: string;

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;

  @IsString()
  @IsOptional()
  readonly description?: string;

  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @IsOptional()
  readonly colors?: string[];

  /** خصائص الصنف (Waterproof, Anti Slip, …) — بلا حد أقصى، بعكس الألوان. */
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @IsOptional()
  readonly features?: string[];

  @IsBoolean()
  @IsOptional()
  readonly isPattern?: boolean;

  @IsString()
  @IsOptional()
  readonly pattern?: string;

  @IsString()
  @IsOptional()
  readonly material?: string;

  @IsIn(['standard', 'custom', ''])
  @IsOptional()
  readonly sizeType?: string;

  @IsString()
  @IsOptional()
  readonly size?: string;

  @ValidateNested()
  @Type(() => ProductDimensionsDto)
  @IsOptional()
  readonly dimensions?: ProductDimensionsDto;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  readonly tags?: string[];
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

  @IsString()
  @IsOptional()
  readonly categoryId?: string;

  @IsString()
  @IsOptional()
  readonly collectionId?: string;

  @IsString()
  @IsOptional()
  readonly description?: string;

  @IsArray()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @IsOptional()
  readonly colors?: string[];

  /** خصائص الصنف (Waterproof, Anti Slip, …) — بلا حد أقصى، بعكس الألوان. */
  @IsArray()
  @ArrayMaxSize(40)
  @IsString({ each: true })
  @IsOptional()
  readonly features?: string[];

  @IsBoolean()
  @IsOptional()
  readonly isPattern?: boolean;

  @IsString()
  @IsOptional()
  readonly pattern?: string;

  @IsString()
  @IsOptional()
  readonly material?: string;

  @IsIn(['standard', 'custom', ''])
  @IsOptional()
  readonly sizeType?: string;

  @IsString()
  @IsOptional()
  readonly size?: string;

  @ValidateNested()
  @Type(() => ProductDimensionsDto)
  @IsOptional()
  readonly dimensions?: ProductDimensionsDto;

  @IsBoolean()
  @IsOptional()
  readonly isActive?: boolean;
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
    images?: string[];
    categoryId?: string;
    collectionId?: string;
    isActive?: boolean;
    description?: string;
    colors?: string[];
    features?: string[];
    isPattern?: boolean;
    pattern?: string;
    material?: string;
    sizeType?: string;
    size?: string;
    dimensions?: { length?: number; width?: number; height?: number };
    tags?: string[];
  };
}

export class ReviewProductEditDto {
  @IsString()
  @IsOptional()
  readonly rejectedReason?: string;
}
