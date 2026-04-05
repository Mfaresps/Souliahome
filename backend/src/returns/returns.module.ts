import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  ReturnRequest,
  ReturnRequestSchema,
} from './schemas/return-request.schema';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';
import { TransactionsModule } from '../transactions/transactions.module';
import { ExpensesModule } from '../expenses/expenses.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ReturnRequest.name, schema: ReturnRequestSchema },
    ]),
    TransactionsModule,
    ExpensesModule,
  ],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
