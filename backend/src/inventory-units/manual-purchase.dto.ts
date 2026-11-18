import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDefined, IsInt, IsString, Matches, Max, Min, ValidateNested } from 'class-validator';
import { CreateTransactionDto } from '../transactions/dto/transaction.dto';
import { PurchaseReceiptTrackingDto } from '../purchase-orders/dto/purchase-order.dto';

const OBJECT_ID = /^[a-f\d]{24}$/i;

export class ManualPurchaseReceiptDto {
  @IsString() @Matches(/^[A-Za-z0-9:_-]{8,120}$/) operationKey: string;
  @IsDefined() @ValidateNested() @Type(() => CreateTransactionDto) invoice: CreateTransactionDto;
  @IsDefined() @ValidateNested() @Type(() => PurchaseReceiptTrackingDto) tracking: PurchaseReceiptTrackingDto;
}

/** One invoice line received by scanning pre-printed QR labels. Its quantity must equal the scanned pieces. */
export class ScannedReceiptLineDto {
  @IsInt() @Min(0) @Max(499) lineIndex: number;
  @IsArray() @ArrayMaxSize(10000) @IsString({ each: true }) @Matches(OBJECT_ID, { each: true }) unitIds: string[];
  @IsArray() @ArrayMaxSize(2000) @IsString({ each: true }) @Matches(OBJECT_ID, { each: true }) packIds: string[];
}

/** Invoice + new barcodes for unlabelled lines + scanned labels, committed together or not at all. */
export class ScannedPurchaseReceiptDto extends ManualPurchaseReceiptDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => ScannedReceiptLineDto) scans: ScannedReceiptLineDto[];
}

export class PrelabelScanCheckDto {
  @IsArray() @ArrayMaxSize(2000) @IsString({ each: true }) @Matches(OBJECT_ID, { each: true }) unitIds: string[];
  @IsArray() @ArrayMaxSize(2000) @IsString({ each: true }) @Matches(OBJECT_ID, { each: true }) packIds: string[];
}
