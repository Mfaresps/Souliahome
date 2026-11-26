import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MulterModule } from '@nestjs/platform-express';
import { Expense, ExpenseSchema } from './schemas/expense.schema';
import { ExpensePayee, ExpensePayeeSchema } from './schemas/expense-payee.schema';
import { ExpensesService } from './expenses.service';
import { ExpensesController } from './expenses.controller';
import { VaultModule } from '../vault/vault.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Expense.name, schema: ExpenseSchema },
      { name: ExpensePayee.name, schema: ExpensePayeeSchema },
    ]),
    MulterModule.register({}),
    VaultModule,
  ],
  controllers: [ExpensesController],
  providers: [ExpensesService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
