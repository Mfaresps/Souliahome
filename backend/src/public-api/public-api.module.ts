import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { FollowUpsModule } from '../followups/followups.module';
import { SettingsModule } from '../settings/settings.module';
import { PurchasingEngineModule } from '../purchasing-engine/purchasing-engine.module';
import { PurchaseOrdersModule } from '../purchase-orders/purchase-orders.module';
import { MentionsModule } from '../mentions/mentions.module';
import { DemandPlanningModule } from '../demand-planning/demand-planning.module';
import { ExpensesModule } from '../expenses/expenses.module';
import { ReportsApiService } from './reports-api.service';
import { PurchasingApiService } from './purchasing-api.service';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { PublicApiService } from './public-api.service';
import { PublicApiController } from './public-api.controller';
import { ApiKeyGuard, ApiLogInterceptor } from './api-key.guard';
import { ExternalAssistantModule } from '../assistant/external-assistant.module';

/** External API (`/api/v1`, API keys) + its admin control panel (`/api/api-keys`). */
@Module({
  imports: [forwardRef(() => AuthModule), forwardRef(() => TransactionsModule), FollowUpsModule, SettingsModule, PurchasingEngineModule, forwardRef(() => PurchaseOrdersModule), MentionsModule, forwardRef(() => DemandPlanningModule), ExpensesModule, ExternalAssistantModule],
  controllers: [PublicApiController, ApiKeysController],
  providers: [ApiKeysService, PublicApiService, PurchasingApiService, ReportsApiService, ApiKeyGuard, ApiLogInterceptor],
})
export class PublicApiModule {}
