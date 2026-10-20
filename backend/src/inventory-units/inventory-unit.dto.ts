import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { OBJECT_ID_PATTERN, LABEL_SIZES } from './inventory-unit.constants';

export class TrackingRequestDto {
  @IsString() @Matches(/^[A-Za-z0-9:_-]{8,120}$/) operationKey: string;
  @IsString() @MaxLength(1000) reason: string;
}
export class RegisterUnitDto extends TrackingRequestDto {
  @IsString() @Matches(OBJECT_ID_PATTERN) productId: string;
  @IsString() @IsIn(['purchase', 'opening-stock', 'legacy-unknown']) originKind: string;
  @IsOptional() @IsString() @Matches(OBJECT_ID_PATTERN) purchaseTransactionId?: string;
  @IsString() @MaxLength(120) countReference: string;
  @IsInt() @Min(1) @Max(100000) observedPhysicalCount: number;
  @IsBoolean() physicalPossessionConfirmed: boolean;
  @IsOptional() @IsString() @MaxLength(120) warehouseCode?: string;
}
export class LegacyStockIdentifyDto extends TrackingRequestDto {
  @IsString() @Matches(OBJECT_ID_PATTERN) productId: string;
  @IsString() @MaxLength(120) warehouseCode: string;
  @IsInt() @Min(1) @Max(1000000) physicalQuantity: number;
  @IsInt() @Min(0) expectedRegistered: number;
  @IsInt() expectedBalance: number;
  @IsBoolean() physicalPossessionConfirmed: boolean;
  @IsBoolean() inspectionPassed: boolean;
}
export class UnitActionDto extends TrackingRequestDto {
  @IsOptional() @IsString() @MaxLength(1000) reason: string = '';
  @IsString() @IsIn(['reserve', 'release', 'picking', 'prepare', 'undo-picking', 'inspect', 'damage', 'lost', 'return', 'ship', 'deliver', 'supplier-return', 'receive-supplier-return', 'warehouse']) action: string;
  @IsOptional() @IsString() @Matches(OBJECT_ID_PATTERN) supplierReturnId?: string;
  @IsInt() @Min(0) expectedVersion: number;
  @IsOptional() @IsString() @Matches(OBJECT_ID_PATTERN) transactionId?: string;
  @IsOptional() @IsString() @MaxLength(120) lineId?: string;
  @IsOptional() @IsBoolean() physicalPossessionConfirmed?: boolean;
  @IsOptional() @IsBoolean() physicalCountConfirmed?: boolean;
  @IsOptional() @IsBoolean() inspectionPassed?: boolean;
  @IsOptional() @IsString() @MaxLength(120) warehouseCode?: string;
  @IsOptional() @IsString() @MaxLength(200) evidenceReference?: string;
}
export class OrderPickScanDto extends TrackingRequestDto {
  @IsString() @MaxLength(160) identifier: string;
  @IsString() @MaxLength(120) lineId: string;
  @IsBoolean() physicalPossessionConfirmed: boolean;
}
export class ReceiveCustomerPieceDto extends TrackingRequestDto {
  @IsString() @Matches(OBJECT_ID_PATTERN) unitId: string;
  @IsInt() @Min(0) expectedVersion: number;
  @IsString() @IsIn(['sound', 'damaged', 'review']) condition: string;
  @IsBoolean() physicalPossessionConfirmed: boolean;
}
export class OrderPickExceptionDto extends TrackingRequestDto {
  @IsOptional() @IsInt() @Min(1) quantity?: number;
  @IsString() @MaxLength(120) lineId: string;
  @IsString() @IsIn(['skip', 'undo']) action: string;
  @IsOptional() @IsString() @MaxLength(120) exceptionId?: string;
}
export class CreatePacksDto extends TrackingRequestDto {
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(1000) @ArrayUnique()
  @IsString({ each:true }) @Matches(OBJECT_ID_PATTERN,{each:true}) unitIds: string[];
  @IsInt() @Min(2) @Max(1000) piecesPerPack: number;
  @IsString() @IsIn(['reject','leave-single']) remainder: string;
}
export class PackLabelsDto extends TrackingRequestDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique()
  @IsString({each:true}) @Matches(OBJECT_ID_PATTERN,{each:true}) packIds: string[];
  @IsString() @IsIn(LABEL_SIZES.map(size=>size.id)) sizeId: string;
}
export class IdentifyPurchaseLineDto extends TrackingRequestDto {
  @IsString() @MaxLength(120) sku: string;
  @IsInt() @Min(1) @Max(10000) expectedQuantity: number;
  @IsInt() @Min(1) @Max(10000) physicalQuantity: number;
  @IsString() @MaxLength(120) warehouseCode: string;
  @IsBoolean() physicalPossessionConfirmed: boolean;
}
export class LabelRequestDto extends TrackingRequestDto {
  @IsOptional() @IsBoolean() allowReprint?: boolean;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ArrayUnique()
  @IsString({ each: true }) @Matches(OBJECT_ID_PATTERN, { each: true }) unitIds: string[];
  @IsString() @IsIn(LABEL_SIZES.map(size => size.id)) sizeId: string;
}
export class CountAttestationDto extends TrackingRequestDto {
  @IsString() @Matches(OBJECT_ID_PATTERN) productId: string;
  @IsString() @MaxLength(120) countReference: string;
  @IsInt() @Min(0) observedUnallocated: number;
  @IsInt() @Min(0) observedAllocatedOnPremises: number;
  @IsBoolean() physicalPossessionConfirmed: boolean;
}
export class CountReviewDto extends TrackingRequestDto {
  @IsString() @Matches(/^[a-f\d]{64}$/) countOperationId: string;
  @IsString() @IsIn(['accept-evidence', 'reject-evidence']) decision: string;
}
