import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ShopifyController } from './shopify.controller';
import { ShopifyService } from './shopify.service';
import { ShopifyAdminService } from './shopify-admin.service';
import { OrderAuditController } from './order-audit.controller';
import { OrderAuditService } from './order-audit.service';
import { OrderAuditExportService } from './order-audit-export.service';
import { OrderAudit, OrderAuditSchema } from './schemas/order-audit.schema';
import {
  Transaction,
  TransactionSchema,
} from '../transactions/schemas/transaction.schema';
import {
  Product,
  ProductSchema,
} from '../products/schemas/product.schema';
import {
  ShopifyOrder,
  ShopifyOrderSchema,
} from './schemas/shopify-order.schema';
import { VaultModule } from '../vault/vault.module';
import { AuthModule } from '../auth/auth.module';
import { EmployeePerformanceModule } from '../employee-performance/employee-performance.module';
import { MentionsModule } from '../mentions/mentions.module';
import { UsersModule } from '../users/users.module';
import { InventoryMovementsModule } from '../inventory-movements/inventory-movements.module';
import { TransactionsModule } from '../transactions/transactions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: Product.name, schema: ProductSchema },
      { name: ShopifyOrder.name, schema: ShopifyOrderSchema },
      { name: OrderAudit.name, schema: OrderAuditSchema },
    ]),
    VaultModule,
    AuthModule,
    EmployeePerformanceModule,
    MentionsModule,
    UsersModule,
    // approveOrder writes the transaction directly via txModel, bypassing
    // TransactionsService.create() — so it must replicate that method's inventory
    // movement logging itself. TransactionsService supplies the pre-create stock
    // snapshot (getInventory), InventoryMovementsService writes the rows.
    // Both are forwardRef'd: InventoryMovementsModule <-> TransactionsModule is
    // already a cycle, and ShopifyModule now joins it.
    forwardRef(() => InventoryMovementsModule),
    forwardRef(() => TransactionsModule),
  ],
  controllers: [ShopifyController, OrderAuditController],
  providers: [
    ShopifyService,
    ShopifyAdminService,
    OrderAuditService,
    OrderAuditExportService,
  ],
  exports: [ShopifyAdminService, OrderAuditService],
})
export class ShopifyModule {}
