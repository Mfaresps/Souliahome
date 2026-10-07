import { Controller, Get, Post, Delete, Body, Param, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { RequirePerms } from '../core/decorators/perms.decorator';
import { CarrierAutoSettleService } from './carrier-auto-settle.service';

/**
 * «تسويات بوسطة» and «كشف حساب بوسطة».
 *
 * ⚠ Four perms, four levels of authority — not one:
 *   carrier-settle-view     read the lists, the statement and the figures
 *   carrier-settle-run      fetch Bosta's price for selected orders and settle them
 *   carrier-settle-approve  decide what stopped for review, open a dispute, record a transfer
 *   carrier-settle-reverse  undo a settlement (moves vault money back)
 * ⚠ Static routes are declared before `:txId` — Nest matches in declaration order.
 */
@UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
@Controller('carrier-settlements')
export class CarrierAutoSettleController {
  constructor(private readonly svc: CarrierAutoSettleService) {}

  private by(req: any): string {
    return req?.user?.name || req?.user?.username || 'مستخدم';
  }

  private id(v: string): string {
    if (!isValidObjectId(v)) throw new BadRequestException('معرّف غير صالح');
    return v;
  }

  @RequirePerms('carrier-settle-view')
  @Get()
  list(@Query() q: any) {
    return this.svc.list(q || {});
  }

  @RequirePerms('carrier-settle-view')
  @Get('summary')
  summary(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.summary(from, to);
  }

  @RequirePerms('carrier-settle-view')
  @Get('statement')
  statement(@Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.statement(from, to);
  }

  @RequirePerms('carrier-settle-run')
  @Post('preview')
  preview(@Body() body: { txIds: string[] }, @Req() req: any) {
    return this.svc.preview(body?.txIds, req?.user?.role === 'admin');
  }

  @RequirePerms('carrier-settle-run')
  @Post('settle')
  settle(@Body() body: { txIds: string[]; vaultMethod: string }, @Req() req: any) {
    return this.svc.settleMany(body?.txIds, String(body?.vaultMethod || ''), this.by(req));
  }

  @RequirePerms('carrier-settle-view')
  @Get('payouts/preview')
  payoutPreview(@Query('date') date: string) {
    return this.svc.payoutPreview(date);
  }

  @RequirePerms('carrier-settle-approve')
  @Post('payouts')
  recordPayout(@Body() body: any, @Req() req: any) {
    return this.svc.recordPayout(
      {
        date: String(body?.date || ''),
        amount: Number(body?.amount),
        fee: body?.fee === undefined ? undefined : Number(body.fee),
        vaultMethod: String(body?.vaultMethod || ''),
        bostaRef: String(body?.bostaRef || ''),
        note: String(body?.note || ''),
        bookDifference: body?.bookDifference === true,
      },
      this.by(req),
    );
  }

  @Roles('admin')
  @Delete('payouts/:id')
  deletePayout(@Param('id') id: string) {
    return this.svc.deletePayout(this.id(id));
  }

  /** Live Bosta details for the invoice page. Read-only; anyone who can open the invoice can read it. */
  @Get(':txId/bosta-details')
  bostaDetails(@Param('txId') txId: string, @Query('fresh') fresh?: string) {
    return this.svc.bostaDetails(this.id(txId), fresh === '1');
  }

  /** Pre-fill for the failed-delivery dialog. Read-only, so open to anyone who can open that dialog. */
  @Get(':txId/return-fees')
  returnFees(@Param('txId') txId: string) {
    return this.svc.returnFees(this.id(txId));
  }

  @RequirePerms('carrier-settle-approve')
  @Post(':txId/approve')
  approve(@Param('txId') txId: string, @Body() body: { vaultMethod?: string }, @Req() req: any) {
    return this.svc.approve(this.id(txId), String(body?.vaultMethod || ''), this.by(req));
  }

  @RequirePerms('carrier-settle-approve')
  @Post(':txId/dispute')
  dispute(@Param('txId') txId: string, @Body() body: { note?: string }, @Req() req: any) {
    return this.svc.dispute(this.id(txId), String(body?.note || ''), this.by(req));
  }

  @RequirePerms('carrier-settle-reverse')
  @Post(':txId/reverse')
  reverse(@Param('txId') txId: string, @Req() req: any) {
    return this.svc.reverse(this.id(txId), this.by(req));
  }
}
