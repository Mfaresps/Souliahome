import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema';
import { Transaction, TransactionSchema } from '../transactions/schemas/transaction.schema';
import {
  CollectionProduct,
  CollectionProductSchema,
} from '../collections/schemas/collection-product.schema';
import { ProductsService } from './products.service';
import { ProductCostService } from './product-cost.service';
import { ProductCostEvent, ProductCostEventSchema } from './schemas/product-cost-event.schema';
import { ProductAnalyticsService } from './product-analytics.service';
import { ProductsController } from './products.controller';
import { AuthModule } from '../auth/auth.module';
import { MentionsModule } from '../mentions/mentions.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Transaction.name, schema: TransactionSchema },
      { name: CollectionProduct.name, schema: CollectionProductSchema },
      { name: ProductCostEvent.name, schema: ProductCostEventSchema },
    ]),
    AuthModule,
    MentionsModule,
  ],
  controllers: [ProductsController],
  providers: [ProductsService, ProductAnalyticsService, ProductCostService],
  exports: [ProductsService, ProductCostService],
})
export class ProductsModule {}
