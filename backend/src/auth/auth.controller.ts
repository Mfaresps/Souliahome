import { Controller, Post, Body, Get, UseGuards, Req } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PresenceGateway } from './presence.gateway';
import { Request } from 'express';
import { UsersService } from '../users/users.service';
import { TotpService } from './totp.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly presenceGateway: PresenceGateway,
    private readonly usersService: UsersService,
    private readonly totpService: TotpService,
  ) {}

  @UseGuards(ThrottlerGuard)
  @Post('login')
  async login(@Body() loginDto: LoginDto, @Req() req: Request) {
    const ip = (req.headers as Record<string, string>)['x-forwarded-for'] || (req as any).ip || '';
    return this.authService.login(loginDto, ip);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  getProfile(@Req() req: Request) {
    const user = req.user as Record<string, unknown>;
    return {
      id: user.userId,
      username: user.username,
      name: user.name,
      role: user.role,
      phone: user.phone || '',
      avatar: user.avatar || '',
      perms: user.perms || [],
    };
  }

  @Post('set-status')
  async setStatus(
    @Req() req: Request,
    @Body() body: { status: 'online' | 'offline'; userId?: string },
  ) {
    try {
      const user = req.user as Record<string, unknown> | undefined;
      const userId = body.userId || (user?.sub as string);
      if (!userId) {
        return { message: 'No userId provided' };
      }
      return this.authService.setUserStatus(userId, body.status);
    } catch (err) {
      return { message: 'Status updated', error: err.message };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('update-last-seen')
  async updateLastSeen(@Req() req: Request) {
    try {
      const user = req.user as Record<string, unknown> | undefined;
      const userId = user?.sub as string;
      if (!userId) {
        return { success: false, message: 'No userId' };
      }
      await this.usersService.updateLastSeen(userId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('active-sessions')
  getActiveSessions(@Req() req: Request) {
    const user = req.user as Record<string, unknown> | undefined;
    if (!user || user.role !== 'admin') {
      return { sessions: [], error: 'forbidden' };
    }
    return { sessions: this.presenceGateway.getActiveSessions() };
  }

  @Get('users-status')
  async getUsersStatus() {
    try {
      const onlineIds = this.presenceGateway.getOnlineUserIds();
      const allUsers = await this.usersService.findAll();
      const usersWithStatus = allUsers.map(u => ({
        id: u._id.toString(),
        username: u.username,
        name: u.name,
        isOnline: onlineIds.includes(u._id.toString()),
        lastSeen: u.lastSeen ? new Date(u.lastSeen).toISOString() : null,
      }));
      return { users: usersWithStatus };
    } catch (err) {
      return { users: [], error: err.message };
    }
  }

  // ─── TOTP 2FA Endpoints ───────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('totp/setup')
  async totpSetup(@Req() req: Request) {
    const user = req.user as Record<string, unknown>;
    return this.totpService.generateSetup(user.userId as string);
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/confirm')
  async totpConfirm(@Req() req: Request, @Body() body: { token: string }) {
    const user = req.user as Record<string, unknown>;
    await this.totpService.confirmSetup(user.userId as string, body.token);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/disable')
  async totpDisable(@Req() req: Request) {
    const user = req.user as Record<string, unknown>;
    await this.totpService.disableTotp(user.userId as string);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/revoke-devices')
  async revokeDevices(@Req() req: Request) {
    const user = req.user as Record<string, unknown>;
    await this.totpService.revokeTrustedDevices(user.userId as string);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('totp/global-status')
  async getGlobal2faStatus(@Req() req: Request) {
    const user = req.user as Record<string, unknown>;
    if (user.role !== 'admin') return { error: 'forbidden' };
    const enabled = await this.totpService.getGlobal2faStatus();
    return { enabled };
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/global-toggle')
  async toggleGlobal2fa(@Req() req: Request, @Body() body: { enabled: boolean }) {
    const user = req.user as Record<string, unknown>;
    if (user.role !== 'admin') return { error: 'forbidden' };
    await this.totpService.setGlobal2fa(body.enabled);
    return { success: true, enabled: body.enabled };
  }

  @Post('totp/verify')
  async totpVerify(@Body() body: { userId: string; token: string; deviceToken?: string; trustDevice?: boolean }) {
    return this.authService.verifyTotpStep(body.userId, body.token, body.deviceToken, body.trustDevice);
  }

  // Used during forced setup flow (admin first login) — no JWT yet
  @Post('totp/setup-confirm')
  async totpSetupConfirm(@Body() body: { userId: string; token: string }) {
    await this.totpService.confirmSetup(body.userId, body.token);
    return { success: true };
  }

  // Used during forced setup flow (admin first login) — no JWT yet
  @Post('totp/setup-init')
  async totpSetupInit(@Body() body: { userId: string }) {
    return this.totpService.generateSetup(body.userId);
  }

  // Step 1: verify username exists and has TOTP enabled → returns userId
  @Post('forgot-password/verify-username')
  async forgotVerifyUsername(@Body() body: { username: string }) {
    return this.authService.forgotVerifyUsername(body.username);
  }

  // Step 2: verify TOTP code → returns a reset token
  @Post('forgot-password/verify-totp')
  async forgotVerifyTotp(@Body() body: { userId: string; token: string }) {
    return this.authService.forgotVerifyTotp(body.userId, body.token);
  }

  // Step 3: set new password using reset token
  @Post('forgot-password/reset')
  async forgotReset(@Body() body: { resetToken: string; newPassword: string }) {
    return this.authService.forgotReset(body.resetToken, body.newPassword);
  }

  // Emergency: bypass TOTP using current password (when authenticator is unavailable)
  @Post('forgot-password/verify-password')
  async forgotVerifyPassword(@Body() body: { userId: string; currentPassword: string }) {
    return this.authService.forgotVerifyPassword(body.userId, body.currentPassword);
  }

  // Emergency: disable 2FA without auth (protected by EMERGENCY_KEY env var)
  @Post('emergency/disable-2fa')
  async emergencyDisable2fa(@Body() body: { key: string }) {
    const emergencyKey = process.env.EMERGENCY_KEY;
    if (!emergencyKey || body.key !== emergencyKey) {
      return { error: 'forbidden' };
    }
    await this.totpService.setGlobal2fa(false);
    return { success: true, message: '2FA disabled' };
  }
}
