import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Transaction, TransactionSchema } from './schemas/transaction.schema';
import { ReturnRequest, ReturnRequestSchema } from '../returns/schemas/return-request.schema';
import {
  SupplierReturnOrder,
  SupplierReturnOrderSchema,
} from '../supplier-returns/schemas/supplier-return.schema';
import {
  ShopifyOrder,
  ShopifyOrderSchema,
} from '../shopify/schemas/shopify-order.schema';
import { TransactionsService } from './transactions.service';
import { ReferenceDetailService } from './reference-detail.service';
import { ReportsExportService } from './reports-export.service';
import { CarrierStatementService } from './carrier-statement.service';
import { CarrierSettlementService } from './carrier-settlement.service';
import { CarrierAutoSettleService } from './carrier-auto-settle.service';
import { CarrierAutoSettleController } from './carrier-auto-settle.controller';
import { CarrierPayout, CarrierPayoutSchema } from './schemas/carrier-payout.schema';
import { BostaModule } from '../bosta/bosta.module';
import {
  CarrierImport,
  CarrierImportSchema,
} from './schemas/carrier-import.schema';
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
import { FollowUpsModule } from '../followups/followups.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: ReturnRequest.name, schema: ReturnRequestSchema },
      // Schema only, not SupplierReturnsModule — that module already imports this one, so importing
      // it back would be circular. The KPI methods only need to READ settled returns.
      { name: SupplierReturnOrder.name, schema: SupplierReturnOrderSchema },
      // Schema only, same reason as SupplierReturnOrder above: ShopifyModule is already imported
      // here, and the cancellations report only needs to READ orders cancelled on the Shopify page
      // — the ones that never became a transaction and are therefore invisible to every other
      // query in this service.
      { name: ShopifyOrder.name, schema: ShopifyOrderSchema },
      // Audit record for carrier settlement-file imports. Owned by this module because settling a
      // row goes through TransactionsService.collect() — see carrier-settlement.service.ts.
      { name: CarrierImport.name, schema: CarrierImportSchema },
      // Transfers from Bosta recorded in «كشف حساب بوسطة» — see carrier-auto-settle.service.ts.
      { name: CarrierPayout.name, schema: CarrierPayoutSchema },
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
    // Closing a failed delivery closes its follow-up ticket in the same call.
    // forwardRef because BostaModule already bridges these two in the other
    // direction, and this side must not be the one that decides load order.
    forwardRef(() => FollowUpsModule),
    // The automatic settlement reads each delivery from Bosta. No cycle: BostaModule imports
    // neither this module nor anything that does.
    BostaModule,
  ],
  controllers: [TransactionsController, CarrierAutoSettleController],
  providers: [
    TransactionsService,
    ReferenceDetailService,
    ReportsExportService,
    CarrierStatementService,
    CarrierSettlementService,
    CarrierAutoSettleService,
  ],
  exports: [TransactionsService, CarrierStatementService, CarrierSettlementService],
})
export class TransactionsModule {}
