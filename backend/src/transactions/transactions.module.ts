import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { ProductsModule } from '../products/products.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { VaultModule } from '../vault/vault.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
    ]),
    ProductsModule,
    ExpensesModule,
    VaultModule,
  ],
  controllers: [TransactionsController],
  providers: [TransactionsService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
