import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Supplier, SupplierSchema } from './schemas/supplier.schema';
import { ProductSupplier, ProductSupplierSchema } from './schemas/product-supplier.schema';
import { SuppliersService } from './suppliers.service';
import { SuppliersController } from './suppliers.controller';
import { ProductSuppliersService } from './product-suppliers.service';
import { ProductSuppliersController } from './product-suppliers.controller';
import { DiscountOtpModule } from '../discount-otp/discount-otp.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Supplier.name, schema: SupplierSchema },
      { name: ProductSupplier.name, schema: ProductSupplierSchema },
    ]),
    DiscountOtpModule,
  ],
  controllers: [SuppliersController, ProductSuppliersController],
  providers: [SuppliersService, ProductSuppliersService],
  exports: [SuppliersService, ProductSuppliersService],
})
export class SuppliersModule {}
