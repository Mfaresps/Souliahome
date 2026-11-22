import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { AssistantService } from './assistant.service';

/**
 * «مساعد SOULIA». Every logged-in account may ask; each answer checks the asker's own
 * permissions inside the service (a refused topic says so — it never answers 0).
 * ⚠ `review` is declared before `:id/wrong` — Nest matches in declaration order.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('assistant')
export class AssistantController {
  constructor(private readonly service: AssistantService) {}

  @Post('ask')
  ask(@Req() req: any, @Body() body: any) {
    return this.service.ask(req.user, body || {});
  }

  @Get('popular')
  popular() {
    return this.service.popular();
  }

  /** Admin header counter: today's morning report (built 08:30 Cairo, or on first request). */
  @Get('daily-status')
  @Roles('admin')
  dailyStatus() {
    return this.service.dailyStatus();
  }

  @Get('review')
  @Roles('admin')
  review(@Query('days') days?: string) {
    return this.service.review(Number(days) || 30);
  }

  @Post(':id/wrong')
  wrong(@Req() req: any, @Param('id') id: string) {
    return this.service.markWrong(req.user, id);
  }
}
