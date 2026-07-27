import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Transaction,
  TransactionSchema,
} from '../transactions/schemas/transaction.schema';
import {
  ShopifyOrder,
  ShopifyOrderSchema,
} from '../shopify/schemas/shopify-order.schema';
import {
  DemandAnalysisLog,
  DemandAnalysisLogSchema,
} from './schemas/demand-analysis-log.schema';
import { DemandPlanningService } from './demand-planning.service';
import { DemandPlanningController } from './demand-planning.controller';
import { TransactionsModule } from '../transactions/transactions.module';
import { ProductsModule } from '../products/products.module';
import { PurchaseOrdersModule } from '../purchase-orders/purchase-orders.module';
import { SuppliersModule } from '../suppliers/suppliers.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: ShopifyOrder.name, schema: ShopifyOrderSchema },
      { name: DemandAnalysisLog.name, schema: DemandAnalysisLogSchema },
    ]),
    TransactionsModule,
    ProductsModule,
    PurchaseOrdersModule,
    SuppliersModule,
  ],
  controllers: [DemandPlanningController],
  providers: [DemandPlanningService],
  exports: [DemandPlanningService],
})
export class DemandPlanningModule {}
