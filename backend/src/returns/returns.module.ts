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
import { VaultModule } from '../vault/vault.module';

// ExpensesModule was imported only for an ExpensesService that ReturnsService injected and never
// used. Damaged returns need no expense record: the cash left the vault and no stock came back, so
// the loss is already recognised by the derived-inventory + vault figures.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReturnRequest.name, schema: ReturnRequestSchema },
    ]),
    TransactionsModule,
    VaultModule,
  ],
  controllers: [ReturnsController],
  providers: [ReturnsService, ReturnsValidationService],
  exports: [ReturnsService, ReturnsValidationService],
})
export class ReturnsModule {}
