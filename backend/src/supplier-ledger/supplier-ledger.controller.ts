import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupplierLedgerService } from './supplier-ledger.service';
import {
  PostManualAdjustmentDto,
  LedgerQueryDto,
  CreateBalanceAdjustmentDto,
  SR_VAULT_SEG_LABELS,
} from './dto/supplier-ledger.dto';
import { SuppliersService } from '../suppliers/suppliers.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';

@UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
@Controller('supplier-ledger')
export class SupplierLedgerController {
  constructor(
    private readonly supplierLedgerService: SupplierLedgerService,
    private readonly suppliersService: SuppliersService,
  ) {}

  /**
   * All supplier balances at once, keyed by supplierId — feeds the suppliers list page.
   * Declared above the `supplier/:supplierId` routes so 'balances' is never read as a supplierId.
   */
  @Get('balances')
  async getAllBalances() {
    return this.supplierLedgerService.getAllBalances();
  }

  /**
   * The سجل المديونية tab's own content — gated on the tab perm.
   *
   * The two balance-summary routes are deliberately NOT gated: they return a single aggregate
   * that the profile KPI strip and the suppliers list already show to anyone who can open the
   * page. Gating them would blank those numbers for a user who merely lacks the ledger TAB,
   * which is a different decision from hiding the entry-by-entry history.
   */
  @RequirePerms('suppliers-tab-ledger')
  @Get('supplier/:supplierId')
  async findBySupplier(
    @Param('supplierId') supplierId: string,
    @Query() query: LedgerQueryDto,
  ) {
    return this.supplierLedgerService.findBySupplier(supplierId, query);
  }

  @Get('supplier/:supplierId/balance')
  async getBalance(@Param('supplierId') supplierId: string) {
    return this.supplierLedgerService.getBalanceSummary(supplierId);
  }

  /**
   * Advance deposit (cash leaves the vault, supplier credit rises) or debit charge (cash-neutral).
   * It moves real money and has no source document behind it, so the description IS the audit
   * trail. Was @Roles('admin'); now delegable via suppliers-deposit — PermsGuard still passes any
   * admin unconditionally, so admin behaviour is unchanged.
   */
  @RequirePerms('suppliers-deposit')
  @Post('supplier/:supplierId/balance-adjustment')
  async postBalanceAdjustment(
    @Param('supplierId') supplierId: string,
    @Body() dto: CreateBalanceAdjustmentDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const employee = req.user.name || req.user.username;
    const supplier = await this.suppliersService.findById(supplierId);
    const entry = await this.supplierLedgerService.postBalanceAdjustment({
      supplierId,
      supplierName: supplier.name,
      kind: dto.kind,
      amount: dto.amount,
      date: dto.date,
      desc: dto.desc,
      refNo: dto.refNo,
      vaultSeg: dto.vaultSeg,
      employee,
    });
    const isDeposit = dto.kind === 'deposit';
    await this.suppliersService.addLog(supplierId, {
      action: isDeposit ? 'عربون/دفعة مقدمة لمورد' : 'خصم على حساب المورد',
      detail:
        `${isDeposit ? 'دفع' : 'تحميل'} ${dto.amount} ج` +
        `${isDeposit ? ` من خزنة ${SR_VAULT_SEG_LABELS[dto.vaultSeg || ''] || dto.vaultSeg}` : ''}` +
        ` — ${dto.desc}` +
        `${dto.refNo ? ` — مرجع ${dto.refNo}` : ''}` +
        ` — الرصيد بعد التسوية: ${entry.runningBalance} ج`,
      by: employee,
    });
    return entry;
  }

  /** Cash-neutral ledger correction — a separate perm from the cash-moving deposit above. */
  @RequirePerms('suppliers-ledger-adjust')
  @Post('supplier/:supplierId/adjustment')
  async postAdjustment(
    @Param('supplierId') supplierId: string,
    @Body() dto: PostManualAdjustmentDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const employee = req.user.name || req.user.username;
    const supplier = await this.suppliersService.findById(supplierId);
    const entry = await this.supplierLedgerService.postManualAdjustment({
      supplierId,
      supplierName: supplier.name,
      date: dto.date,
      amount: dto.amount,
      reason: dto.reason,
      employee,
    });
    // Mirror into the supplier activity log so a manual balance change is visible in سجل النشاط
    // too, not only inside the ledger table — it's an admin override and should be conspicuous.
    await this.suppliersService.addLog(supplierId, {
      action: 'تسوية يدوية للمديونية',
      detail: `${dto.amount > 0 ? 'زيادة المستحق للمورد بـ' : 'تقليل المستحق للمورد بـ'} ${Math.abs(dto.amount)} ج — السبب: ${dto.reason} — الرصيد بعد التسوية: ${entry.runningBalance} ج`,
      by: employee,
    });
    return entry;
  }
}
