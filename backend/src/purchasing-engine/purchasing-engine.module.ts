import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TransactionsModule } from '../transactions/transactions.module';
import { PurchasingEngineController } from './purchasing-engine.controller';
import { PurchasingEngineService } from './purchasing-engine.service';

@Module({
  imports: [forwardRef(() => AuthModule), forwardRef(() => TransactionsModule)],
  controllers: [PurchasingEngineController],
  providers: [PurchasingEngineService],
  exports: [PurchasingEngineService],
})
export class PurchasingEngineModule {}
