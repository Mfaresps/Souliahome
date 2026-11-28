import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { AccountEmailService } from './account-email.service';

/**
 * Account email of employees (Nov 27, 2026). Under /auth/security so a coded 401 (wrong password)
 * keeps the page signed in (api() rule in index.html).
 */
@UseGuards(JwtAuthGuard)
@Controller('auth/security/account-email')
export class AccountEmailController {
  constructor(private readonly accountEmail: AccountEmailService) {}

  private actor(req: Request) {
    const u = (req.user || {}) as Record<string, unknown>;
    return { id: String(u.userId || u.sub || ''), name: String(u.name || u.username || ''), role: String(u.role || '') };
  }

  @Get()
  state(@Req() req: Request) {
    return this.accountEmail.state(this.actor(req));
  }

  @UseGuards(ThrottlerGuard)
  @Post('request')
  request(@Req() req: Request, @Body() body: { email?: string; password?: string }) {
    return this.accountEmail.requestOwn(this.actor(req), String(body?.email || ''), String(body?.password || ''));
  }

  @UseGuards(ThrottlerGuard)
  @Post('resend')
  resend(@Req() req: Request) {
    return this.accountEmail.resendOwn(this.actor(req));
  }

  @UseGuards(ThrottlerGuard)
  @Post('confirm')
  confirm(@Req() req: Request, @Body() body: { code?: string }) {
    return this.accountEmail.confirmOwn(this.actor(req), String(body?.code || ''));
  }

  @Delete('pending')
  cancel(@Req() req: Request) {
    return this.accountEmail.cancelOwn(this.actor(req));
  }

  /** Admin, add-user window: a code to the typed address before the account exists. */
  @UseGuards(ThrottlerGuard)
  @Post('new-account/send')
  newAccountSend(@Req() req: Request, @Body() body: { email?: string; previousToken?: string }) {
    return this.accountEmail.startNewAccountCode(this.actor(req), String(body?.email || ''), String(body?.previousToken || ''));
  }

  /** Admin, add-user window: the code the employee received. */
  @UseGuards(ThrottlerGuard)
  @Post('new-account/confirm')
  newAccountConfirm(@Req() req: Request, @Body() body: { token?: string; code?: string }) {
    return this.accountEmail.confirmNewAccountCode(this.actor(req), String(body?.token || ''), String(body?.code || ''));
  }

  /** Admin: send a confirmation code to an address for an employee (the employee confirms it). */
  @UseGuards(ThrottlerGuard)
  @Post('user/:userId')
  requestForUser(@Req() req: Request, @Param('userId') userId: string, @Body() body: { email?: string }) {
    return this.accountEmail.requestForUser(this.actor(req), userId, String(body?.email || ''));
  }

  @Delete('user/:userId/pending')
  cancelForUser(@Req() req: Request, @Param('userId') userId: string) {
    return this.accountEmail.cancelForUser(this.actor(req), userId);
  }
}
