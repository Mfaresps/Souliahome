import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import {
  Transaction,
  TransactionSchema,
} from '../transactions/schemas/transaction.schema';
import {
  Supplier,
  SupplierSchema,
} from '../suppliers/schemas/supplier.schema';
import { SearchService } from './search.service';
import { SearchController } from './search.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Product.name, schema: ProductSchema },
      { name: Transaction.name, schema: TransactionSchema },
      { name: Supplier.name, schema: SupplierSchema },
    ]),
  ],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
