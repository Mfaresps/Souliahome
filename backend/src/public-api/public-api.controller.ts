import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { PurchasingApiService } from './purchasing-api.service';
import { ReportsApiService } from './reports-api.service';
import { ApiKeyGuard, ApiLogInterceptor, ApiScopeRequired } from './api-key.guard';
import { PublicApiService } from './public-api.service';
import { API_SCOPES } from './api-key.util';
import { ExternalAssistantService } from '../assistant/external-assistant.service';

/**
 * External API — `/api/v1/*`, authenticated by an API key only (never a session).
 *
 * ⚠ There is no delete, edit or cancel route here on purpose. Writes: adding a note to a follow-up,
 * opening a follow-up on an order (both `followups-write`), purchase-order requests, and the external
 * assistant's reply to a chat question (`assistant-write`, once per question). Do not add a write
 * route without a scope and the owner's decision.
 */
@UseGuards(ApiKeyGuard)
@UseInterceptors(ApiLogInterceptor)
@Controller('v1')
export class PublicApiController {
  constructor(
    private readonly api: PublicApiService,
    private readonly purchasing: PurchasingApiService,
    private readonly reportsApi: ReportsApiService,
    private readonly externalAssistant: ExternalAssistantService,
  ) {}

  /** Who am I — works with any active key; states what the key may reach. */
  @Get('me')
  me(@Req() req: any) {
    const k = req.apiKey;
    return {
      name: k.name,
      account: k.linkedUserName,
      scopes: k.scopes,
      scopeLabels: API_SCOPES.filter((s) => k.scopes.includes(s.code)).map((s) => ({ code: s.code, ar: s.ar, en: s.en })),
      rateLimitPerMinute: k.rateLimit,
      phones: k.phoneAccess || 'detail',
      expiresAt: k.expiresAt || null,
    };
  }

  // Orders
  @ApiScopeRequired('orders') @Get('orders')
  orders(@Query() q: any, @Req() req: any) { return this.api.listOrders(q, req.apiKey); }

  @ApiScopeRequired('orders') @Get('orders/:ref')
  order(@Param('ref') ref: string, @Req() req: any) { return this.api.orderDetail(ref, req.apiKey); }

  @ApiScopeRequired('followups') @Get('orders/:ref/followups')
  orderFollowups(@Param('ref') ref: string, @Req() req: any) { return this.api.orderFollowups(ref, req.apiKey); }

  // Opening a follow-up (owner, Nov 26, 2026) — same scope as adding a note.
  @ApiScopeRequired('followups-write') @Post('orders/:ref/followups') @HttpCode(201)
  openOrderFollowup(@Param('ref') ref: string, @Body() body: any, @Req() req: any) {
    req.apiLogDetail = `open follow-up on order ${String(ref).slice(0, 40)}`;
    return this.api.openFollowup(ref, body, req.apiKey);
  }

  @ApiScopeRequired('followups-write') @Post('orders/:ref/followup-notes') @HttpCode(201)
  addOrderNote(@Param('ref') ref: string, @Body() body: any, @Req() req: any) {
    req.apiLogDetail = `note on order ${String(ref).slice(0, 40)}`;
    return this.api.addNoteToOrder(ref, body, req.apiKey);
  }

  // Shipping
  @ApiScopeRequired('shipping') @Get('orders/:ref/shipping')
  orderShipping(@Param('ref') ref: string) { return this.api.orderShipping(ref); }

  @ApiScopeRequired('shipping') @Get('shipping/problems')
  shippingProblems(@Query() q: any, @Req() req: any) { return this.api.shippingProblems(q, req.apiKey); }

  // Follow-ups
  @ApiScopeRequired('followups') @Get('followups')
  followups(@Query() q: any, @Req() req: any) { return this.api.listFollowups(q, req.apiKey); }

  @ApiScopeRequired('followups') @Get('followups/:id')
  followup(@Param('id') id: string, @Req() req: any) { return this.api.followupDetail(id, req.apiKey); }

  @ApiScopeRequired('followups-write') @Post('followups/:id/notes') @HttpCode(201)
  addNote(@Param('id') id: string, @Body() body: any, @Req() req: any) {
    req.apiLogDetail = `note on follow-up ${String(id).slice(0, 30)}`;
    return this.api.addNote(id, body, req.apiKey);
  }

  // Returns & exchanges (both systems; current stage, approver and refund)
  @ApiScopeRequired('returns') @Get('returns')
  returns(@Query() q: any) { return this.api.listReturns(q); }

  // The external assistant's answer to a question an employee sent from the SOULIA chat
  // (target = external, delivered by email). 404 MESSAGE_NOT_FOUND · 409 ALREADY_REPLIED ·
  // 400 REPLY_INVALID / REPLY_TOO_LARGE.
  @ApiScopeRequired('assistant-write') @Post('assistant/replies') @HttpCode(201)
  assistantReply(@Body() body: any, @Req() req: any) {
    req.apiLogDetail = `assistant reply ${String(body?.messageId || '').slice(0, 40)}`;
    return this.externalAssistant.receiveReply(body, req.apiKey);
  }

  // Mentions
  @ApiScopeRequired('mentions') @Get('mentions')
  mentions(@Query() q: any, @Req() req: any) { return this.api.listMentions(q, req.apiKey); }

  @ApiScopeRequired('mentions') @Post('mentions/:id/read') @HttpCode(200)
  mentionRead(@Param('id') id: string, @Req() req: any) { return this.api.markMentionRead(id, req.apiKey); }

  // Complaints
  @ApiScopeRequired('complaints') @Get('complaints')
  complaints(@Query() q: any, @Req() req: any) { return this.api.listComplaints(q, req.apiKey); }

  @ApiScopeRequired('complaints') @Get('complaints/:id')
  complaint(@Param('id') id: string, @Req() req: any) { return this.api.complaintDetail(id, req.apiKey); }

  // Inventory
  @ApiScopeRequired('inventory') @Get('inventory')
  inventory(@Query() q: any) { return this.api.inventory(q); }

  // Reports
  /** The reports page: KPIs with the previous period, products, customers, cancellations, daily trend
   *  (+ profit, expenses, purchases when the key holds `reports-financial`). */
  @ApiScopeRequired('reports') @Get('reports')
  reports(@Query() q: any, @Req() req: any) { return this.reportsApi.reports(q, req.apiKey); }

  @ApiScopeRequired('reports') @Get('reports/daily')
  daily(@Query() q: any) { return this.api.dailyReport(q); }

  // Products: active / inactive, and units sold per product in a period (ABC ranking)
  @ApiScopeRequired('products') @Get('products')
  products(@Query() q: any) { return this.purchasing.products(q); }

  @ApiScopeRequired('products') @Get('products/sales')
  productSales(@Query() q: any) { return this.purchasing.salesByProduct(q); }

  // Purchasing: suggestions with their full calculation; purchase-order requests (drafts) + PDF
  @ApiScopeRequired('purchasing') @Get('purchasing/suggestions')
  suggestions(@Query() q: any) { return this.purchasing.suggestions(q); }

  @ApiScopeRequired('stock-analysis') @Get('purchasing/order-analysis')
  orderAnalysis(@Query() q: any, @Req() req: any) { return this.purchasing.orderAnalysis(q, req.apiKey); }

  @ApiScopeRequired('purchasing') @Get('purchase-orders')
  drafts(@Query() q: any, @Req() req: any) { return this.purchasing.listDrafts(q, String(req.apiKey._id)); }

  @ApiScopeRequired('purchasing') @Get('purchase-orders/:id')
  draft(@Param('id') id: string, @Req() req: any) { return this.purchasing.getDraft(id, String(req.apiKey._id)); }

  @ApiScopeRequired('purchasing') @Get('purchase-orders/:id/pdf')
  async draftPdf(@Param('id') id: string, @Req() req: any, @Res() res: Response) {
    const { file, name } = await this.purchasing.draftPdf(id, String(req.apiKey._id));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.end(file);
  }

  @ApiScopeRequired('purchasing-write') @Post('purchase-orders') @HttpCode(201)
  async createDraft(@Body() body: any, @Req() req: any) {
    const r = await this.purchasing.createDraft(body, req.apiKey);
    req.apiLogDetail = `purchase-order request ${r.draft.draftNo}${r.duplicate ? ' (repeat)' : ''}`;
    return r;
  }
}
