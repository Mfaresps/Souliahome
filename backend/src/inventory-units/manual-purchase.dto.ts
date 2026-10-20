import { Type } from 'class-transformer';
import { IsDefined, IsString, Matches, ValidateNested } from 'class-validator';
import { CreateTransactionDto } from '../transactions/dto/transaction.dto';
import { PurchaseReceiptTrackingDto } from '../purchase-orders/dto/purchase-order.dto';

export class ManualPurchaseReceiptDto {
  @IsString() @Matches(/^[A-Za-z0-9:_-]{8,120}$/) operationKey: string;
  @IsDefined() @ValidateNested() @Type(() => CreateTransactionDto) invoice: CreateTransactionDto;
  @IsDefined() @ValidateNested() @Type(() => PurchaseReceiptTrackingDto) tracking: PurchaseReceiptTrackingDto;
}
