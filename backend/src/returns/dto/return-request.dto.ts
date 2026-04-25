import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsArray,
  ValidateNested,
  Min,
  IsIn,
  ValidateIf,
  ArrayMinSize,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';

/** أسباب الاسترجاع والاستبدال — يجب أن تطابق التحقق في ReturnsService */
const RETURN_AND_EXCHANGE_REASONS = [
  'تلف الشحنة',
  'شحنة خاطئة',
  'سبب آخر',
  'مقاس أو لون مختلف',
  'رغبة العميل بصنف آخر',
  'عيب مصنع',
] as const;

export class ReturnItemDto {
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

  @IsNumber()
  @Min(0)
  readonly total: number;
}

export class CreateReturnRequestDto {
  @IsString()
  @IsNotEmpty()
  readonly originalTransactionId: string;

  @IsString()
  @IsOptional()
  readonly originalRef?: string;

  @IsString()
  @IsNotEmpty()
  readonly originalDate: string;

  @IsString()
  @IsNotEmpty()
  readonly client: string;

  @IsString()
  @IsOptional()
  readonly phone?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  readonly items: ReturnItemDto[];

  @IsNumber()
  @Min(0)
  readonly total: number;

  @IsString()
  @IsNotEmpty()
  @IsIn([...RETURN_AND_EXCHANGE_REASONS])
  readonly reason: string;

  @IsString()
  @IsOptional()
  readonly reasonDetails?: string;

  @IsOptional()
  @Transform(({ value }) =>
    value === 'exchange' ? 'exchange' : 'return',
  )
  @IsString()
  @IsIn(['return', 'exchange'])
  readonly requestKind?: string;

  @IsOptional()
  @ValidateIf((o) => (o.requestKind || 'return') === 'exchange')
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  readonly exchangeItems?: ReturnItemDto[];

  @IsOptional()
  @ValidateIf((o) => (o.requestKind || 'return') === 'exchange')
  @IsNumber()
  @Min(0)
  readonly exchangeTotal?: number;

  @IsOptional()
  @IsNumber()
  readonly priceDifference?: number;

  @IsOptional()
  @IsString()
  readonly vaultRefundAccount?: string;

  @IsOptional()
  @IsString()
  readonly vaultCollectAccount?: string;
}

export class RejectReturnDto {
  @IsString()
  @IsOptional()
  readonly rejectedReason?: string;
}
