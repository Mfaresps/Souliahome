import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema';
import { Transaction, TransactionSchema } from '../transactions/schemas/transaction.schema';
import {
  CollectionProduct,
  CollectionProductSchema,
} from '../collections/schemas/collection-product.schema';
import { ProductsService } from './products.service';
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
    ]),
    AuthModule,
    MentionsModule,
  ],
  controllers: [ProductsController],
  providers: [ProductsService, ProductAnalyticsService],
  exports: [ProductsService],
})
export class ProductsModule {}
