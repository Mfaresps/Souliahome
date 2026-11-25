import { Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { BrowseAccessService } from './browse-access.service';

/** «طلب صلاحية التصفح» — any signed-in account asks; admins decide (Nov 25, 2026). */
@UseGuards(JwtAuthGuard)
@Controller('browse-access')
export class BrowseAccessController {
  constructor(private readonly service: BrowseAccessService) {}

  @Get('mine')
  mine(@Req() req: any) { return this.service.mine(req.user); }

  @Post('request')
  request(@Body() body: { scope?: string; reason?: string }, @Req() req: any) {
    return this.service.request(req.user, String(body?.scope || ''), String(body?.reason || ''));
  }

  @Get('pending')
  pending(@Req() req: any) {
    if (req.user?.role !== 'admin') throw new ForbiddenException('للمدير فقط');
    return this.service.pending();
  }

  @Post(':id/approve')
  approve(@Param('id') id: string, @Body() body: { hours?: number }, @Req() req: any) {
    if (req.user?.role !== 'admin') throw new ForbiddenException('للمدير فقط');
    return this.service.decide(id, req.user, true, body?.hours);
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Req() req: any) {
    if (req.user?.role !== 'admin') throw new ForbiddenException('للمدير فقط');
    return this.service.decide(id, req.user, false);
  }
}
