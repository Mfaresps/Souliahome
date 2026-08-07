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
import { Roles } from '../core/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
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
   * Admin-only like the sibling manual adjustment below — it moves real money and has no source
   * document behind it, so the description IS the audit trail.
   */
  @Roles('admin')
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

  @Roles('admin')
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
