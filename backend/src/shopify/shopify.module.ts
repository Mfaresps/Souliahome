import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ShopifyController } from './shopify.controller';
import { ShopifyService } from './shopify.service';
import { ShopifyAdminService } from './shopify-admin.service';
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

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Transaction.name, schema: TransactionSchema },
      { name: Product.name, schema: ProductSchema },
      { name: ShopifyOrder.name, schema: ShopifyOrderSchema },
    ]),
    VaultModule,
    AuthModule,
  ],
  controllers: [ShopifyController],
  providers: [ShopifyService, ShopifyAdminService],
  exports: [ShopifyAdminService],
})
export class ShopifyModule {}
