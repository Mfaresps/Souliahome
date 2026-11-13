import { Global, Module } from '@nestjs/common';
import { PromotionsController } from './promotions.controller';
import { PromotionAuditService } from './promotion-audit.service';

// @Global so the settings / products / tags controllers can record management actions without a
// module import (they inject it @Optional, so their own test modules need no change).
@Global()
@Module({
  controllers: [PromotionsController],
  providers: [PromotionAuditService],
  exports: [PromotionAuditService],
})
export class PromotionsModule {}
