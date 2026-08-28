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
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SupplierReturnOrder.name, schema: SupplierReturnOrderSchema },
    ]),
    TransactionsModule,
    SuppliersModule,
    SupplierLedgerModule,
    // لحل صورة الصنف بالكود في مسار التخصيص العام (fifo/average/manual/none)،
    // اللي مافيهوش فاتورة أصلية واحدة نقرأ منها. مفيش دورة: ProductsModule
    // مابيستوردش supplier-returns.
    ProductsModule,
  ],
  controllers: [SupplierReturnsController],
  providers: [SupplierReturnsService, SrAllocationService],
  exports: [SupplierReturnsService],
})
export class SupplierReturnsModule {}
