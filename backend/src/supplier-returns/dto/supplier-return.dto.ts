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

export class SrAllocationDetailDto {
  @IsString()
  @IsNotEmpty()
  readonly code: string;

  @IsNumber()
  @Min(1)
  readonly qty: number;

  @IsNumber()
  @Min(0)
  readonly unitCost: number;

  @IsString()
  @IsOptional()
  readonly sourceTransactionId?: string;

  @IsString()
  @IsOptional()
  readonly sourceRef?: string;
}

export class SupplierReturnItemDto {
  @IsString()
  @IsNotEmpty()
  readonly code: string;

  @IsString()
  @IsOptional()
  readonly name?: string;

  @IsNumber()
  @Min(1)
  readonly qty: number;

  /** Required for the legacy single-invoice path and allocationMethod:'none' (admin enters the
   *  price directly). Omitted for 'fifo'/'average'/'manual' — the server derives it from
   *  purchase-history allocation, per SupplierReturnsService.validateGeneralized(). */
  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly price?: number;

  @IsString()
  @IsOptional()
  readonly note?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => SrAllocationDetailDto)
  readonly allocations?: SrAllocationDetailDto[];
}

export class CreateSupplierReturnDto {
  @IsString()
  @IsNotEmpty()
  readonly supplierId: string;

  @IsString()
  @IsNotEmpty()
  readonly supplierName: string;

  /** Legacy single-invoice path — still fully supported for the existing frontend. */
  @IsString()
  @IsOptional()
  readonly originalTransactionId?: string;

  @IsString()
  @IsOptional()
  readonly originalRef?: string;

  @IsString()
  @IsOptional()
  readonly originalDate?: string;

  /** New multi/no-invoice path. */
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  readonly linkedTransactionIds?: string[];

  @IsString()
  @IsOptional()
  @IsIn(['single-invoice', 'fifo', 'average', 'manual', 'none'])
  readonly allocationMethod?: string;

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

  /** Optional — the vault segment is chosen at completion, when it's known whether a cash refund
   *  actually happens. Accepted here for backward compatibility with older clients. */
  @IsString()
  @IsOptional()
  readonly vaultRefundAccount?: string;

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

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  readonly linkedTransactionIds?: string[];

  @IsString()
  @IsOptional()
  @IsIn(['single-invoice', 'fifo', 'average', 'manual', 'none'])
  readonly allocationMethod?: string;

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

export class ReverseSupplierReturnDto {
  @IsString()
  @IsNotEmpty()
  readonly reason: string;
}

export class CompleteSupplierReturnDto {
  /**
   * How the return's value is settled:
   *  - 'debt-offset' — apply against the supplier's outstanding debt first, then the remainder
   *    (if any) follows `remainderMode`. This is the historical default when the supplier has debt.
   *  - 'refund'      — pay the FULL value back in cash, leaving any debt untouched.
   *  - 'credit'      — hold the FULL value as standing supplier credit, leaving any debt untouched.
   * Omitted => legacy behavior (debt-offset first, remainder refunded).
   */
  @IsString()
  @IsOptional()
  @IsIn(['debt-offset', 'refund', 'credit'])
  readonly settlementMode?: 'debt-offset' | 'refund' | 'credit';

  /** Only meaningful with settlementMode:'debt-offset' — what to do with the portion of the
   *  return value that exceeds the debt. Defaults to 'refund'. */
  @IsString()
  @IsOptional()
  @IsIn(['refund', 'credit'])
  readonly remainderMode?: 'refund' | 'credit';

  /** Vault segment receiving the cash-refund portion. Required only when the chosen settlement
   *  actually produces a refund; overrides any value stamped at create-time. */
  @IsString()
  @IsOptional()
  readonly vaultRefundAccount?: string;
}
