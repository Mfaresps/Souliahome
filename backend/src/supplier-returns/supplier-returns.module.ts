import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SupplierReturnOrder,
  SupplierReturnOrderSchema,
} from './schemas/supplier-return.schema';
import { SupplierReturnsService } from './supplier-returns.service';
import { SupplierReturnsController } from './supplier-returns.controller';
import { SrAllocationService } from './allocation.service';
import { TransactionsModule } from '../transactions/transactions.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { SupplierLedgerModule } from '../supplier-ledger/supplier-ledger.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SupplierReturnOrder.name, schema: SupplierReturnOrderSchema },
    ]),
    TransactionsModule,
    SuppliersModule,
    SupplierLedgerModule,
  ],
  controllers: [SupplierReturnsController],
  providers: [SupplierReturnsService, SrAllocationService],
  exports: [SupplierReturnsService],
})
export class SupplierReturnsModule {}
