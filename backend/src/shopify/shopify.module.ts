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
import { SettingsModule } from '../settings/settings.module';
import { DiscountOtpModule } from '../discount-otp/discount-otp.module';
import { DepositReceiptsService } from './deposit-receipts.service';
import { DepositReceiptOcrService } from './deposit-receipt-ocr.service';

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
    // approveOrder reads settings.defaultCarrierCode to pre-resolve the shipping carrier.
    // Not forwardRef'd: SettingsModule does not depend on ShopifyModule, so this adds no cycle.
    SettingsModule,
    // بوابة OTP للخصم العالي على الأوردر — نفس الحد ونفس المسار المستخدمين في
    // سجل المعاملات. لا يضيف دورة: DiscountOtpModule لا يعتمد على ShopifyModule.
    DiscountOtpModule,
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
    // Deposit receipts: upload → OCR → manager approval → vault. Hosts the 04:30 cleanup cron.
    DepositReceiptsService,
    DepositReceiptOcrService,
  ],
  exports: [ShopifyAdminService, OrderAuditService],
})
export class ShopifyModule {}
