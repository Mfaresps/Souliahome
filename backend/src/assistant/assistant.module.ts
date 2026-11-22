import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { SupplierLedgerModule } from '../supplier-ledger/supplier-ledger.module';
import { SettingsModule } from '../settings/settings.module';
import { PurchasingEngineModule } from '../purchasing-engine/purchasing-engine.module';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';

@Module({
  imports: [
    forwardRef(() => AuthModule),
    forwardRef(() => TransactionsModule),
    ExpensesModule,
    forwardRef(() => SupplierLedgerModule),
    SettingsModule,
    PurchasingEngineModule,
  ],
  controllers: [AssistantController],
  providers: [AssistantService],
})
export class AssistantModule {}
