import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Category, CategorySchema } from './schemas/category.schema';
import { Collection, CollectionSchema } from './schemas/collection.schema';
import {
  CollectionProduct,
  CollectionProductSchema,
} from './schemas/collection-product.schema';
import { Product, ProductSchema } from '../products/schemas/product.schema';
import {
  Supplier,
  SupplierSchema,
} from '../suppliers/schemas/supplier.schema';
import { CategoriesService } from './categories.service';
import { CategoriesController } from './categories.controller';
import { CollectionsService } from './collections.service';
import { CollectionsController } from './collections.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Category.name, schema: CategorySchema },
      { name: Collection.name, schema: CollectionSchema },
      { name: CollectionProduct.name, schema: CollectionProductSchema },
      { name: Product.name, schema: ProductSchema },
      { name: Supplier.name, schema: SupplierSchema },
    ]),
  ],
  controllers: [CategoriesController, CollectionsController],
  providers: [CategoriesService, CollectionsService],
  exports: [CategoriesService, CollectionsService],
})
export class CollectionsModule {}
