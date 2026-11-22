import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PurchasingEngineService, cairoDay } from './purchasing-engine.service';

/** Read-only. Recommendations only — creating a purchase order stays a separate, reviewed action. */
@UseGuards(JwtAuthGuard)
@Controller('purchasing-engine')
export class PurchasingEngineController {
  constructor(private readonly engine: PurchasingEngineService) {}

  private allowed(req: any) {
    const u = req.user || {};
    if (u.role === 'admin') return;
    const perms: string[] = u.perms || [];
    if (!['purchase-create', 'purchase-view', 'inventory'].some((p) => perms.includes(p))) throw new ForbiddenException('Permission required');
  }

  @Get('plan')
  async plan(@Req() req: any) {
    this.allowed(req);
    const run = await this.engine.run(cairoDay(Date.now()));
    return { today: run.today, builtAt: run.builtAt, historyFrom: run.historyFrom, params: run.params, leadTimes: run.leadTimes, plans: run.plans };
  }

  @Get('validation')
  async validation(@Req() req: any) {
    this.allowed(req);
    const run = await this.engine.run(cairoDay(Date.now()));
    return { today: run.today, historyFrom: run.historyFrom, historyDays: run.historyDays, validation: run.validation, leadTimes: run.leadTimes };
  }
}
