import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  SupplierLedgerEntry,
  SupplierLedgerEntrySchema,
} from './schemas/supplier-ledger-entry.schema';
import { SupplierLedgerService } from './supplier-ledger.service';
import { SupplierLedgerController } from './supplier-ledger.controller';
import { SuppliersModule } from '../suppliers/suppliers.module';
import { VaultModule } from '../vault/vault.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: SupplierLedgerEntry.name, schema: SupplierLedgerEntrySchema },
    ]),
    SuppliersModule,
    VaultModule,
  ],
  controllers: [SupplierLedgerController],
  providers: [SupplierLedgerService],
  exports: [SupplierLedgerService],
})
export class SupplierLedgerModule {}
