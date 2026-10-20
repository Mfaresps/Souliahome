import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PurchaseOrder, PurchaseOrderSchema } from './schemas/purchase-order.schema';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { TransactionsModule } from '../transactions/transactions.module';
import { InventoryUnitsModule } from '../inventory-units/inventory-units.module';
import { PurchaseReceivingService } from './purchase-receiving.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PurchaseOrder.name, schema: PurchaseOrderSchema },
    ]),
    TransactionsModule,
    InventoryUnitsModule,
  ],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService, PurchaseReceivingService],
  exports: [PurchaseOrdersService],
})
export class PurchaseOrdersModule {}
