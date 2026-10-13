import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get() settings(@Req() req: any) { return this.service.settings(req.user); }
  @Get('history') history(@Req() req: any, @Query('before') before?: string) { return this.service.history(req.user, before); }
  @Post('history/:id/read') read(@Req() req: any, @Param('id') id: string) { return this.service.markHistoryRead(req.user, id); }
  @Patch('preferences') preferences(@Req() req: any, @Body() body: any) { return this.service.preferences(req.user, body); }
  @Post('subscriptions') subscribe(@Req() req: any, @Body() body: any) { return this.service.subscribe(req.user, body); }
  @Delete('subscriptions') unsubscribe(@Req() req: any, @Body() body: any) { return this.service.unsubscribe(req.user, body); }
  @Post('test') test(@Req() req: any) { return this.service.test(req.user); }
}
