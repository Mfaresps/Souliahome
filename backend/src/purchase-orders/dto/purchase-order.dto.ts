import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsNumber,
  IsIn,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PurchaseOrderItemDto {
  @IsString()
  @IsOptional()
  readonly productCode?: string;

  @IsString()
  @IsOptional()
  readonly productName?: string;

  @IsString()
  @IsOptional()
  readonly productImage?: string;

  // Frontend-style fields (used when converting to invoice)
  @IsString()
  @IsOptional()
  readonly productId?: string;

  @IsString()
  @IsOptional()
  readonly code?: string;

  @IsString()
  @IsOptional()
  readonly name?: string;

  @IsNumber()
  @Min(1)
  readonly qty: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly unitPrice?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly price?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly total?: number;
}

export class CreatePurchaseOrderDto {
  @IsString()
  @IsNotEmpty()
  readonly supplierId: string;

  @IsString()
  @IsNotEmpty()
  readonly supplierName: string;

  @IsString()
  @IsOptional()
  readonly expectedDeliveryDate?: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  readonly items: PurchaseOrderItemDto[];

  @IsString()
  @IsNotEmpty()
  readonly createdBy: string;
}

export class UpdatePoStatusDto {
  @IsString()
  @IsIn(['معلق', 'قيد التحضير', 'جاهز للاستلام', 'مستلم'])
  readonly status: string;

  @IsString()
  @IsOptional()
  readonly note?: string;

  @IsString()
  @IsNotEmpty()
  readonly changedBy: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  readonly items?: PurchaseOrderItemDto[];
}

export class UpdatePoDto {
  @IsString()
  @IsOptional()
  readonly expectedDeliveryDate?: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  readonly items?: PurchaseOrderItemDto[];
}

export class ConvertPoToInvoiceDto {
  @IsString()
  @IsNotEmpty()
  readonly ref: string;

  @IsString()
  @IsOptional()
  readonly date?: string;

  @IsString()
  @IsOptional()
  readonly depMethod?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly deposit?: number;

  @IsString()
  @IsNotEmpty()
  readonly createdBy: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsString()
  @IsOptional()
  readonly purchaseOtpId?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderItemDto)
  readonly items?: PurchaseOrderItemDto[];

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  readonly invoiceImages?: string[];

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly discount?: number;
}
