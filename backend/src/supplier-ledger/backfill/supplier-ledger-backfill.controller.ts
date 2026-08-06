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
}
