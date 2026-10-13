import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { AnnouncementsService } from './announcements.service';

// ⚠ `config` and `mine` are declared before the `:id/…` routes — Nest matches in declaration order.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly service: AnnouncementsService) {}

  @Get('config')
  config() { return this.service.getConfig(); }

  @Patch('config')
  @Roles('admin')
  setConfig(@Body() body: any) { return this.service.setConfig(body); }

  @Get('mine')
  mine(@Req() req: any) { return this.service.mine(req.user); }

  @Get()
  @Roles('admin')
  history() { return this.service.history(); }

  @Post()
  @Roles('admin')
  create(@Req() req: any, @Body() body: any) { return this.service.create(req.user, body); }

  @Post(':id/cancel')
  @Roles('admin')
  cancel(@Param('id') id: string) { return this.service.cancel(id); }

  @Post(':id/ack')
  acknowledge(@Req() req: any, @Param('id') id: string) { return this.service.acknowledge(req.user, id); }
}
