import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsNumber,
  IsIn,
  IsBoolean,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SupplierReturnItemDto {
  @IsString()
  @IsNotEmpty()
  readonly code: string;

  @IsString()
  @IsNotEmpty()
  readonly name: string;

  @IsNumber()
  @Min(1)
  readonly qty: number;

  @IsNumber()
  @Min(0)
  readonly price: number;

  @IsString()
  @IsOptional()
  readonly note?: string;
}

export class CreateSupplierReturnDto {
  @IsString()
  @IsNotEmpty()
  readonly supplierId: string;

  @IsString()
  @IsNotEmpty()
  readonly supplierName: string;

  @IsString()
  @IsNotEmpty()
  readonly originalTransactionId: string;

  @IsString()
  @IsOptional()
  readonly originalRef?: string;

  @IsString()
  @IsOptional()
  readonly originalDate?: string;

  @IsString()
  @IsIn(['تلف المنتج', 'منتج خاطئ', 'مشكلة جودة', 'أخرى'])
  readonly reason: string;

  @IsString()
  @IsOptional()
  readonly reasonDetails?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SupplierReturnItemDto)
  readonly items: SupplierReturnItemDto[];

  @IsString()
  @IsNotEmpty()
  readonly vaultRefundAccount: string;

  @IsBoolean()
  @IsOptional()
  readonly saveAsDraft?: boolean;
}

export class UpdateSupplierReturnDto {
  @IsString()
  @IsOptional()
  @IsIn(['تلف المنتج', 'منتج خاطئ', 'مشكلة جودة', 'أخرى'])
  readonly reason?: string;

  @IsString()
  @IsOptional()
  readonly reasonDetails?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => SupplierReturnItemDto)
  readonly items?: SupplierReturnItemDto[];

  @IsString()
  @IsOptional()
  readonly vaultRefundAccount?: string;
}

export class RejectSupplierReturnDto {
  @IsString()
  @IsOptional()
  readonly rejectedReason?: string;
}

export class CancelSupplierReturnDto {
  @IsString()
  @IsOptional()
  readonly reason?: string;
}
