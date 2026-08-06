import { Injectable, Logger } from '@nestjs/common';
import { SuppliersService } from '../../suppliers/suppliers.service';
import { TransactionsService } from '../../transactions/transactions.service';
import { SupplierLedgerService } from '../supplier-ledger.service';

/**
 * One-time historical backfill for the SupplierLedger.
 *
 * IMPORTANT — do not run automatically. These write financial history and must be run
 * deliberately: dry-run against a copy/backup first, review the resulting balances against
 * known supplier statements, then get sign-off before running against production. Neither
 * method is called anywhere in application bootstrap or any other service — invoking them is
 * always an explicit, admin-triggered action.
 *
 * `backfillPurchaseDebt` replays every non-cancelled مشتريات transaction as a purchase-debt
 * ledger entry (total - deposit, since `deposit` already nets out historical payments recorded
 * via TransactionsService.collect()). This is the piece required for complete()'s debt-offset
 * logic to be meaningful from day one — without it every supplier starts at balance:0 regardless
 * of real outstanding debt.
 *
 * Historical COMPLETED supplier returns are deliberately NOT replayed: under the old logic every
 * completed return always paid out its full value as a cash refund (never netted against debt),
 * so backfilling them as debt-offset entries would double-count money that already left the vault.
 */
@Injectable()
export class SupplierLedgerBackfillService {
  private readonly logger = new Logger(SupplierLedgerBackfillService.name);

  constructor(
    private readonly suppliersService: SuppliersService,
    private readonly transactionsService: TransactionsService,
    private readonly supplierLedgerService: SupplierLedgerService,
  ) {}

  /**
   * dryRun:true (default) computes and returns what WOULD be posted, without writing anything —
   * use this first and compare against known supplier statements before running for real.
   */
  async backfillPurchaseDebt(dryRun = true): Promise<{
    dryRun: boolean;
    suppliersProcessed: number;
    entriesPlanned: Array<{
      supplierId: string;
      supplierName: string;
      transactionId: string;
      transactionRef: string;
      date: string;
      amount: number;
    }>;
    entriesPosted: number;
  }> {
    this.logger.log(
      `Starting supplier ledger purchase-debt backfill (dryRun=${dryRun})`,
    );
    const suppliers = await this.suppliersService.findAll();
    const entriesPlanned: Array<{
      supplierId: string;
      supplierName: string;
      transactionId: string;
      transactionRef: string;
      date: string;
      amount: number;
    }> = [];
    let entriesPosted = 0;

    for (const supplier of suppliers) {
      const supplierId = String(supplier._id);
      // Existing ledger entries for this supplier indicate the backfill (or live activity)
      // already ran — skip to avoid double-posting.
      const existing = await this.supplierLedgerService.findBySupplier(supplierId);
      if (existing.length > 0) {
        this.logger.log(
          `Skipping supplier ${supplier.name} (${supplierId}) — already has ${existing.length} ledger entries`,
        );
        continue;
      }
      const purchases = await this.transactionsService.findAllBySupplierName(
        supplier.name,
      );
      for (const purchase of purchases) {
        if (purchase.type !== 'مشتريات' || purchase.cancelled) continue;
        const amount = Number(purchase.total) - Number(purchase.deposit || 0);
        if (amount <= 0) continue;
        const plan = {
          supplierId,
          supplierName: supplier.name,
          transactionId: String(purchase._id),
          transactionRef: purchase.ref || String(purchase._id),
          date: purchase.date,
          amount,
        };
        entriesPlanned.push(plan);
        if (!dryRun) {
          const posted = await this.supplierLedgerService.postPurchaseDebt({
            supplierId,
            supplierName: supplier.name,
            transactionId: plan.transactionId,
            transactionRef: plan.transactionRef,
            date: plan.date,
            total: Number(purchase.total),
            upfrontDeposit: Number(purchase.deposit || 0),
            employee: 'backfill',
          });
          if (posted) entriesPosted++;
        }
      }
    }

    this.logger.log(
      `Backfill complete: ${entriesPlanned.length} entries ${dryRun ? 'planned (dry run)' : 'planned'}, ${entriesPosted} posted`,
    );
    return {
      dryRun,
      suppliersProcessed: suppliers.length,
      entriesPlanned,
      entriesPosted,
    };
  }
}
