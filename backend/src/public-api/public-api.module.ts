import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { FollowUpsModule } from '../followups/followups.module';
import { SettingsModule } from '../settings/settings.module';
import { ApiKeysService } from './api-keys.service';
import { ApiKeysController } from './api-keys.controller';
import { PublicApiService } from './public-api.service';
import { PublicApiController } from './public-api.controller';
import { ApiKeyGuard, ApiLogInterceptor } from './api-key.guard';

/** External API (`/api/v1`, API keys) + its admin control panel (`/api/api-keys`). */
@Module({
  imports: [forwardRef(() => AuthModule), forwardRef(() => TransactionsModule), FollowUpsModule, SettingsModule],
  controllers: [PublicApiController, ApiKeysController],
  providers: [ApiKeysService, PublicApiService, ApiKeyGuard, ApiLogInterceptor],
})
export class PublicApiModule {}
