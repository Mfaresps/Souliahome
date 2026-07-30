import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Res,
  Request,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { OrderAuditService } from './order-audit.service';
import { OrderAuditExportService } from './order-audit-export.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';

/**
 * Order Range Audit — reconciliation between Shopify order numbers
 * and the sales transactions registered inside Soulia.
 * Accessible to admins, or staff granted the 'reports-orderaudit' permission.
 */
@Controller('order-audit')
@UseGuards(JwtAuthGuard, PermsGuard)
@RequirePerms('reports-orderaudit')
export class OrderAuditController {
  constructor(
    private readonly auditService: OrderAuditService,
    private readonly exportService: OrderAuditExportService,
  ) {}

  private user(req: any): string {
    return req?.user?.username || req?.user?.name || 'admin';
  }

  /** Run the audit over a range. Persists an entry in the audit history. */
  @Get('run')
  async run(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('persist') persist: string,
    @Request() req: any,
  ) {
    return this.auditService.runAudit(Number(from), Number(to), {
      persist: persist !== 'false',
      generatedBy: this.user(req),
      source: 'manual',
    });
  }

  /** Audit history log */
  @Get('history')
  async history(@Query('limit') limit?: string) {
    return this.auditService.getHistory(limit ? Number(limit) : 50);
  }

  @Delete('history/:id')
  async deleteHistory(@Param('id') id: string) {
    return this.auditService.deleteHistoryEntry(id);
  }

  /** Daily-monitor alert payload for the notification bell */
  @Get('monitor-alert')
  async monitorAlert() {
    return this.auditService.getMonitorAlert();
  }

  /** Run the daily monitor on demand */
  @Post('monitor/run')
  async runMonitor() {
    await this.auditService.dailyMonitor();
    return this.auditService.getMonitorAlert();
  }

  /** Mark reviewed / attach an investigation note to a missing order */
  @Patch('missing/:orderNumber/review')
  async review(
    @Param('orderNumber') orderNumber: string,
    @Body() body: { reviewed?: boolean; note?: string },
    @Request() req: any,
  ) {
    return this.auditService.reviewMissingOrder(orderNumber, body || {}, this.user(req));
  }

  /** Attempt to re-pull a missing order from Shopify */
  @Post('missing/:orderNumber/retry-sync')
  async retrySync(@Param('orderNumber') orderNumber: string) {
    return this.auditService.retrySync(orderNumber);
  }

  /** Export the audit report as Excel or PDF */
  @Get('export')
  async export(
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('format') format: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    const fmt = (format || 'excel').toLowerCase();
    if (fmt !== 'excel' && fmt !== 'pdf') {
      throw new BadRequestException('صيغة التصدير يجب أن تكون excel أو pdf');
    }

    // Export must not pollute the audit history with a duplicate entry.
    const result = await this.auditService.runAudit(Number(from), Number(to), {
      persist: false,
      generatedBy: this.user(req),
    });

    const base = `order_audit_${result.from}_${result.to}`;

    if (fmt === 'pdf') {
      const buf = await this.exportService.buildPdf(result);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.pdf"`);
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
      return;
    }

    const buf = await this.exportService.buildExcel(result);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${base}.xlsx"`);
    res.setHeader('Content-Length', buf.length);
    res.end(buf);
  }
}
