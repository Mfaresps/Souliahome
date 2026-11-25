import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiKeyGuard, ApiLogInterceptor, ApiScopeRequired } from './api-key.guard';
import { PublicApiService } from './public-api.service';
import { API_SCOPES } from './api-key.util';

/**
 * External API — `/api/v1/*`, authenticated by an API key only (never a session).
 *
 * ⚠ There is no delete, edit or cancel route here on purpose: the only write is adding a note to a
 * follow-up. Do not add a write route without a new scope and the owner's decision.
 */
@UseGuards(ApiKeyGuard)
@UseInterceptors(ApiLogInterceptor)
@Controller('v1')
export class PublicApiController {
  constructor(private readonly api: PublicApiService) {}

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
  @ApiScopeRequired('reports') @Get('reports/daily')
  daily(@Query() q: any) { return this.api.dailyReport(q); }
}
