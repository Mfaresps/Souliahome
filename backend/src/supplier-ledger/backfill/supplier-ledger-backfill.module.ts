import { Module } from '@nestjs/common';
import { SupplierLedgerBackfillService } from './supplier-ledger-backfill.service';
import { SupplierLedgerBackfillController } from './supplier-ledger-backfill.controller';
import { SuppliersModule } from '../../suppliers/suppliers.module';
import { TransactionsModule } from '../../transactions/transactions.module';
import { SupplierLedgerModule } from '../supplier-ledger.module';

/**
 * Kept as its own module (rather than folded into SupplierLedgerModule) so that
 * SupplierLedgerModule itself stays a low-dependency leaf — TransactionsModule already imports
 * SupplierLedgerModule, so SupplierLedgerModule importing TransactionsModule back would create
 * a cycle. This module sits above both instead.
 */
@Module({
  imports: [SuppliersModule, TransactionsModule, SupplierLedgerModule],
  controllers: [SupplierLedgerBackfillController],
  providers: [SupplierLedgerBackfillService],
})
export class SupplierLedgerBackfillModule {}
