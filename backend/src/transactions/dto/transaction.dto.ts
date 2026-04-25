import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsArray,
  IsBoolean,
  ValidateNested,
  Min,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';

export class TransactionItemDto {
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

export class CreateTransactionDto {
  @IsString()
  @IsNotEmpty()
  readonly date: string;

  @IsString()
  @IsIn(['مبيعات', 'مشتريات', 'مرتجع مبيعات', 'مرتجع مشتريات', 'مرتجع'])
  readonly type: string;

  @IsString()
  @IsOptional()
  readonly client?: string;

  @IsString()
  @IsOptional()
  readonly phone?: string;

  @IsString()
  @IsOptional()
  readonly ref?: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsString()
  @IsOptional()
  readonly payment?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly deposit?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly remaining?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransactionItemDto)
  readonly items: TransactionItemDto[];

  @IsNumber()
  @Min(0)
  readonly total: number;

  @IsString()
  @IsNotEmpty()
  readonly employee: string;

  @IsArray()
  @IsOptional()
  readonly comments?: Array<{
    id: number;
    text: string;
    type: string;
    employee: string;
    timestamp: string;
    createdAt: string;
  }>;

  @IsString()
  @IsOptional()
  readonly shipCo?: string;

  @IsString()
  @IsOptional()
  readonly shipZone?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly shipCost?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly discount?: number;

  @IsString()
  @IsOptional()
  readonly depMethod?: string;

  @IsString()
  @IsOptional()
  readonly payStatus?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly itemsTotal?: number;
}

export class UpdateTransactionDto {
  @IsString()
  @IsOptional()
  readonly client?: string;

  @IsString()
  @IsOptional()
  readonly phone?: string;

  @IsString()
  @IsOptional()
  readonly ref?: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;

  @IsString()
  @IsOptional()
  readonly payment?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly deposit?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly remaining?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransactionItemDto)
  @IsOptional()
  readonly items?: TransactionItemDto[];

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly total?: number;

  @IsString()
  @IsOptional()
  readonly shipCo?: string;

  @IsString()
  @IsOptional()
  readonly shipZone?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly shipCost?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly discount?: number;

  @IsString()
  @IsOptional()
  readonly depMethod?: string;

  @IsString()
  @IsOptional()
  readonly payStatus?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly itemsTotal?: number;

  @IsArray()
  @IsOptional()
  readonly comments?: Array<{
    id: number;
    text: string;
    type: string;
    employee: string;
    timestamp: string;
    createdAt: string;
  }>;
}

export class CancelTransactionDto {
  @IsString()
  @IsNotEmpty()
  readonly cancelReason: string;

  @IsString()
  @IsNotEmpty()
  readonly cancelledBy: string;
}

export class CollectTransactionDto {
  @IsString()
  @IsNotEmpty()
  readonly collectMethod: string;

  @IsString()
  @IsOptional()
  readonly collectNote?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly collectAmount?: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  readonly actualShipCost?: number;
}

export class BulkDeleteDto {
  @IsArray()
  @IsString({ each: true })
  readonly ids: string[];
}

export class PostDiscountDto {
  @IsNumber()
  @Min(0.01)
  readonly amount: number;

  @IsString()
  @IsNotEmpty()
  readonly vaultAccount: string;

  @IsString()
  @IsOptional()
  readonly notes?: string;
}

export class RequestCancelDto {
  @IsString()
  @IsNotEmpty()
  readonly reason: string;

  @IsString()
  @IsNotEmpty()
  readonly requestedBy: string;
}

export class ReviewCancelDto {
  @IsString()
  @IsOptional()
  readonly rejectedReason?: string;
}
