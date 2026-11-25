import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { ApiKeysService } from './api-keys.service';

/** Control panel for external API keys — admins only. Create / rotate / revoke need the system PIN. */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  private actor(req: any) {
    return { userId: String(req.user?.userId || req.user?.sub || ''), name: String(req.user?.name || req.user?.username || '') };
  }

  @Get()
  overview() { return this.keys.overview(); }

  @Get('log')
  log(@Query() q: any) { return this.keys.requestLog(q); }

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
