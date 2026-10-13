import { Body, Controller, Delete, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}
  @Get() settings(@Req() req: any) { return this.service.settings(req.user); }
  @Patch('preferences') preferences(@Req() req: any, @Body() body: any) { return this.service.preferences(req.user, body); }
  @Post('subscriptions') subscribe(@Req() req: any, @Body() body: any) { return this.service.subscribe(req.user, body); }
  @Delete('subscriptions') unsubscribe(@Req() req: any, @Body() body: any) { return this.service.unsubscribe(req.user, body); }
  @Post('test') test(@Req() req: any) { return this.service.test(req.user); }
}
