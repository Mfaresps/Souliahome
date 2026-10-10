import { IsBoolean, IsNumber, Min } from 'class-validator';
import { DepositReceiptEntryDto } from '../../shopify/dto/deposit-receipt.dto';

export class ConfirmManualDepositReceiptDto extends DepositReceiptEntryDto {
  @IsNumber()
  @Min(0)
  total: number;

  @IsBoolean()
  confirmed: boolean;
}
