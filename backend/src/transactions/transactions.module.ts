import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { ReturnRequest, ReturnRequestSchema } from '../returns/schemas/return-request.schema';
import { TransactionsService } from './transactions.service';
import { ReferenceDetailService } from './reference-detail.service';
import { ReportsExportService } from './reports-export.service';
import { TransactionsController } from './transactions.controller';
import { ProductsModule } from '../products/products.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { VaultModule } from '../vault/vault.module';
import { AuthModule } from '../auth/auth.module';
import { MentionsModule } from '../mentions/mentions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: ReturnRequest.name, schema: ReturnRequestSchema },
    ]),
    ProductsModule,
    ExpensesModule,
    VaultModule,
    AuthModule,
    MentionsModule,
  ],
  controllers: [TransactionsController],
  providers: [TransactionsService, ReferenceDetailService, ReportsExportService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
