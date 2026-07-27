import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsNumber,
  IsBoolean,
  Min,
  ArrayNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AnalyzeDemandDto {
  /** Transaction ids selected in the movements table */
  @IsArray()
  @ArrayNotEmpty({ message: 'لم يتم تحديد أي معاملات للتحليل' })
  @IsString({ each: true })
  readonly transactionIds: string[];

  /** When false the run is not written to the audit log (used for live preview) */
  @IsBoolean()
  @IsOptional()
  readonly persistLog?: boolean;
}

export class AnalyzeShopifyDemandDto {
  /** Pending Shopify order ids selected on the Shopify orders page */
  @IsArray()
  @ArrayNotEmpty({ message: 'لم يتم تحديد أي أوردرات للتحليل' })
  @IsString({ each: true })
  readonly orderIds: string[];

  @IsBoolean()
  @IsOptional()
  readonly persistLog?: boolean;
}

export class DemandLineDto {
  @IsString()
  @IsNotEmpty({ message: 'كود الصنف (SKU) مطلوب' })
  readonly sku: string;

  @IsString()
  @IsOptional()
  readonly name?: string;

  @IsNumber()
  @Min(1, { message: 'الكمية يجب أن تكون أكبر من صفر' })
  readonly qty: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly unitPrice?: number;
}

export class AddToPurchaseOrderDto {
  @IsString()
  @IsNotEmpty()
  readonly poId: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'لا توجد أصناف لإضافتها' })
  @ValidateNested({ each: true })
  @Type(() => DemandLineDto)
  readonly lines: DemandLineDto[];

  @IsString()
  @IsNotEmpty()
  readonly by: string;

  @IsString()
  @IsOptional()
  readonly byUsername?: string;

  /** Analysis provenance — recorded in the audit log */
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  readonly transactionIds?: string[];

  @IsString()
  @IsOptional()
  readonly note?: string;
}

export class CreatePoFromDemandDto {
  @IsString()
  @IsNotEmpty({ message: 'المورد مطلوب' })
  readonly supplierId: string;

  @IsString()
  @IsNotEmpty({ message: 'اسم المورد مطلوب' })
  readonly supplierName: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'لا توجد أصناف لإنشاء أمر شراء' })
  @ValidateNested({ each: true })
  @Type(() => DemandLineDto)
  readonly lines: DemandLineDto[];

  @IsString()
  @IsNotEmpty()
  readonly by: string;

  @IsString()
  @IsOptional()
  readonly byUsername?: string;

  @IsString()
  @IsOptional()
  readonly expectedDeliveryDate?: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  readonly transactionIds?: string[];

  /** Provenance note for the audit log (e.g. Shopify-sourced analysis) */
  @IsString()
  @IsOptional()
  readonly note?: string;
}
