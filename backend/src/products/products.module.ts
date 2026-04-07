import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from './schemas/product.schema';
import { Transaction, TransactionSchema } from '../transactions/schemas/transaction.schema';
import { ProductsService } from './products.service';
import { ProductAnalyticsService } from './product-analytics.service';
import { ProductsController } from './products.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Transaction.name, schema: TransactionSchema },
    ]),
  ],
  controllers: [ProductsController],
  providers: [ProductsService, ProductAnalyticsService],
  exports: [ProductsService],
})
export class ProductsModule {}
