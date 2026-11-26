import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { PurchasingApiService } from './purchasing-api.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { ApiKeysService } from './api-keys.service';

/** Control panel for external API keys — admins only. Create / rotate / revoke need the system PIN. */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService, private readonly purchasing: PurchasingApiService) {}

  private actor(req: any) {
    return { userId: String(req.user?.userId || req.user?.sub || ''), name: String(req.user?.name || req.user?.username || '') };
  }

  @Get()
  overview() { return this.keys.overview(); }

  @Get('log')
  log(@Query() q: any) { return this.keys.requestLog(q); }

  // Purchase-order requests sent through the API (drafts) — declared before ':id' routes.
  @Get('po-drafts')
  drafts(@Query() q: any) { return this.purchasing.listDrafts(q); }

  @Get('po-drafts/:id')
  draft(@Param('id') id: string) { return this.purchasing.getDraft(id); }

  @Get('po-drafts/:id/pdf')
  async draftPdf(@Param('id') id: string, @Res() res: Response) {
    const { file, name } = await this.purchasing.draftPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.end(file);
  }

  @Post('po-drafts/:id/approve')
  approve(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.purchasing.approveDraft(id, body, this.actor(req)); }

  @Post('po-drafts/:id/reject')
  reject(@Param('id') id: string, @Body() body: { reason?: string }, @Req() req: any) { return this.purchasing.rejectDraft(id, body?.reason, this.actor(req)); }

  @Post('enabled')
  setEnabled(@Body() body: { enabled: boolean }, @Req() req: any) { return this.keys.setEnabled(body?.enabled !== false, this.actor(req)); }

  @Post()
  create(@Body() body: any, @Req() req: any) { return this.keys.create(body, this.actor(req)); }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @Req() req: any) { return this.keys.update(id, body, this.actor(req)); }

  @Post(':id/pause')
  pause(@Param('id') id: string, @Req() req: any) { return this.keys.setPaused(id, true, this.actor(req)); }

  @Post(':id/resume')
  resume(@Param('id') id: string, @Req() req: any) { return this.keys.setPaused(id, false, this.actor(req)); }

  @Post(':id/rotate')
  rotate(@Param('id') id: string, @Body() body: { pin?: string }, @Req() req: any) { return this.keys.rotate(id, body?.pin, this.actor(req)); }

  @Post(':id/revoke')
  revoke(@Param('id') id: string, @Body() body: { pin?: string }, @Req() req: any) { return this.keys.revoke(id, body?.pin, this.actor(req)); }

  @Post(':id/test-webhook')
  testWebhook(@Param('id') id: string) { return this.keys.testWebhook(id); }
}
