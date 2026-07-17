import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SupplierReturnOrder,
  SupplierReturnOrderSchema,
} from './schemas/supplier-return.schema';
import { SupplierReturnsService } from './supplier-returns.service';
import { SupplierReturnsController } from './supplier-returns.controller';
import { TransactionsModule } from '../transactions/transactions.module';
import { SuppliersModule } from '../suppliers/suppliers.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SupplierReturnOrder.name, schema: SupplierReturnOrderSchema },
    ]),
    TransactionsModule,
    SuppliersModule,
  ],
  controllers: [SupplierReturnsController],
  providers: [SupplierReturnsService],
  exports: [SupplierReturnsService],
})
export class SupplierReturnsModule {}
