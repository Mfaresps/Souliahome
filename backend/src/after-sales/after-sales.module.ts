import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ReturnRequest, ReturnRequestSchema } from '../returns/schemas/return-request.schema';
import { TransactionsModule } from '../transactions/transactions.module';
import { ReturnsModule } from '../returns/returns.module';
import { InventoryUnitsModule } from '../inventory-units/inventory-units.module';
import { VaultModule } from '../vault/vault.module';
import { BostaModule } from '../bosta/bosta.module';
import { AfterSalesService } from './after-sales.service';
import { AfterSalesController } from './after-sales.controller';
@Module({ imports: [MongooseModule.forFeature([{ name: ReturnRequest.name, schema: ReturnRequestSchema }]),
  TransactionsModule, ReturnsModule, InventoryUnitsModule, VaultModule, BostaModule],
  controllers: [AfterSalesController], providers: [AfterSalesService] })
export class AfterSalesModule {}
