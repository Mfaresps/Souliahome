import { Body, Controller, Get, Param, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { MAX_INVOICE_UPLOAD_BYTES } from '../invoice-images/invoice-images.service';
import { InvitationsService } from './invitations.service';

const actorOf = (req: any) => ({
  id: String(req.user?.userId || req.user?.sub || ''),
  name: String(req.user?.name || req.user?.username || ''),
  role: String(req.user?.role || ''),
});

/** Admin side: send, list, re-send, cancel. */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Roles('admin')
  @Get()
  list(@Req() req: any) { return this.invitations.list(actorOf(req)); }

  @Roles('admin')
  @Post()
  create(@Req() req: any, @Body() body: any) { return this.invitations.create(actorOf(req), body || {}); }

  @Roles('admin')
  @Post(':id/resend')
  resend(@Req() req: any, @Param('id') id: string, @Body() body: any) { return this.invitations.resend(actorOf(req), id, body?.origin); }

  @Roles('admin')
  @Post(':id/cancel')
  cancel(@Req() req: any, @Param('id') id: string) { return this.invitations.cancel(actorOf(req), id); }
}

/** The page the link opens — no session; the token is the only key. Rate-limited. */
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller('join')
export class JoinController {
  constructor(private readonly invitations: InvitationsService) {}

  @Get(':token')
  view(@Param('token') token: string) { return this.invitations.publicView(token); }

  @Get(':token/username')
  username(@Param('token') token: string, @Query('name') name = '', @Query('username') username = '') {
    return this.invitations.usernameCheck(token, name, username);
  }

  @Post(':token/photo')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_INVOICE_UPLOAD_BYTES } }))
  photo(@Param('token') token: string, @UploadedFile() file: any) { return this.invitations.uploadPhoto(token, file); }

  @Post(':token/accept')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  accept(@Param('token') token: string, @Body() body: any) { return this.invitations.accept(token, body || {}); }
}
