import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { ReturnRequest, ReturnRequestSchema } from '../returns/schemas/return-request.schema';
import {
  SupplierReturnOrder,
  SupplierReturnOrderSchema,
} from '../supplier-returns/schemas/supplier-return.schema';
import { TransactionsService } from './transactions.service';
import { ReferenceDetailService } from './reference-detail.service';
import { ReportsExportService } from './reports-export.service';
import { TransactionsController } from './transactions.controller';
import { ProductsModule } from '../products/products.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { VaultModule } from '../vault/vault.module';
import { AuthModule } from '../auth/auth.module';
import { MentionsModule } from '../mentions/mentions.module';
import { DiscountOtpModule } from '../discount-otp/discount-otp.module';
import { SettingsModule } from '../settings/settings.module';
import { ShopifyModule } from '../shopify/shopify.module';
import { SupplierLedgerModule } from '../supplier-ledger/supplier-ledger.module';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { InventoryMovementsModule } from '../inventory-movements/inventory-movements.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: ReturnRequest.name, schema: ReturnRequestSchema },
      // Schema only, not SupplierReturnsModule — that module already imports this one, so importing
      // it back would be circular. The KPI methods only need to READ settled returns.
      { name: SupplierReturnOrder.name, schema: SupplierReturnOrderSchema },
    ]),
    ProductsModule,
    ExpensesModule,
    VaultModule,
    AuthModule,
    MentionsModule,
    DiscountOtpModule,
    SettingsModule,
    ShopifyModule,
    SupplierLedgerModule,
    SuppliersModule,
    forwardRef(() => InventoryMovementsModule),
  ],
  controllers: [TransactionsController],
  providers: [TransactionsService, ReferenceDetailService, ReportsExportService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
