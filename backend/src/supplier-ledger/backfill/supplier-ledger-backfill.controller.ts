import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { SupplierLedgerBackfillService } from './supplier-ledger-backfill.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';

/**
 * Admin-only, explicitly-triggered historical backfill. Never invoked automatically —
 * see SupplierLedgerBackfillService for the dry-run-first, review-before-production guidance.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('supplier-ledger/backfill')
export class SupplierLedgerBackfillController {
  constructor(
    private readonly backfillService: SupplierLedgerBackfillService,
  ) {}

  @Roles('admin')
  @Post('purchase-debt')
  async backfillPurchaseDebt(@Body() body: { dryRun?: boolean }) {
    const dryRun = body?.dryRun !== false; // defaults to true — real run requires an explicit {dryRun:false}
    return this.backfillService.backfillPurchaseDebt(dryRun);
  }

  /**
   * Copies VaultEntry.txNo onto ledger rows that already have a vaultEntryId — the readable
   * number the statement links to. Safe compared to the debt backfill (it writes no amounts),
   * but kept behind the same admin + dry-run-by-default gate.
   */
  @Roles('admin')
  @Post('vault-tx-no')
  async backfillVaultTxNo(@Body() body: { dryRun?: boolean }) {
    const dryRun = body?.dryRun !== false;
    return this.backfillService.backfillVaultTxNo(dryRun);
  }
}
