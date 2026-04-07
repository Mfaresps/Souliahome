import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ReturnRequest,
  ReturnRequestSchema,
} from './schemas/return-request.schema';
import { ReturnsService } from './returns.service';
import { ReturnsValidationService } from './returns-validation.service';
import { ReturnsController } from './returns.controller';
import { TransactionsModule } from '../transactions/transactions.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { VaultModule } from '../vault/vault.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReturnRequest.name, schema: ReturnRequestSchema },
    ]),
    TransactionsModule,
    ExpensesModule,
    VaultModule,
  ],
  controllers: [ReturnsController],
  providers: [ReturnsService, ReturnsValidationService],
  exports: [ReturnsService, ReturnsValidationService],
})
export class ReturnsModule {}
