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
import {
  ALL_RETURN_REASONS,
  RETURN_ITEM_CONDITIONS,
  RETURN_CONDITION_SOUND,
} from '../returns.constants';

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

  /**
   * سليم | تالف. Absent means سليم, so existing clients keep working — but note the default is
   * applied HERE rather than only in the schema, because the value is copied onto the return
   * transaction's items and an undefined condition there would read as "unknown", not "sound".
   */
  @IsOptional()
  @Transform(({ value }) =>
    (RETURN_ITEM_CONDITIONS as readonly string[]).includes(String(value))
      ? String(value)
      : RETURN_CONDITION_SOUND,
  )
  @IsString()
  @IsIn([...RETURN_ITEM_CONDITIONS])
  readonly condition?: string;
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
  @IsIn([...ALL_RETURN_REASONS])
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

  @IsOptional()
  @IsString()
  readonly returnShipCo?: string;

  @IsOptional()
  @IsString()
  readonly returnTrackingNumber?: string;

  /**
   * Cost of the reverse shipment. The schema field existed with no writer, so this cost was simply
   * lost — neither charged to the customer nor recognised as a company loss. Recorded now and
   * surfaced on the request; whether it is deducted from the refund stays a policy decision.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  readonly actualShipCost?: number;
}

export class RejectReturnDto {
  @IsString()
  @IsOptional()
  readonly rejectedReason?: string;
}
