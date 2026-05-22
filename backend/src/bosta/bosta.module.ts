import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Transaction,
  TransactionSchema,
} from '../transactions/schemas/transaction.schema';
import {
  ShopifyOrder,
  ShopifyOrderSchema,
} from '../shopify/schemas/shopify-order.schema';
import { BostaService } from './bosta.service';
import { BostaController } from './bosta.controller';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: ShopifyOrder.name, schema: ShopifyOrderSchema },
    ]),
    AuthModule,
    SettingsModule,
  ],
  controllers: [BostaController],
  providers: [BostaService],
  exports: [BostaService],
})
export class BostaModule {}
