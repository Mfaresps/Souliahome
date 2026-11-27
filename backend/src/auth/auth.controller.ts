import {
  Controller, Post, Body, Get, UseGuards, Req, Param, Query, Optional,
  ForbiddenException, NotFoundException, BadRequestException, ServiceUnavailableException,
} from '@nestjs/common';
import { UserSessionsService } from './user-sessions.service';
import { endedMessage } from './user-sessions.util';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AuthService, buildAuthUserPayload } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PresenceGateway } from './presence.gateway';
import { Request } from 'express';
import { UsersService } from '../users/users.service';
import { TotpService } from './totp.service';
import { buildClientContext } from '../shared/client-context.util';
import { SignInVerificationService } from './sign-in-verification.service';
import { PasswordPolicyService } from './password-policy.service';
import * as crypto from 'crypto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly presenceGateway: PresenceGateway,
    private readonly usersService: UsersService,
    private readonly totpService: TotpService,
    private readonly verification: SignInVerificationService,
    @Optional() private readonly sessions?: UserSessionsService,
    @Optional() private readonly passwords?: PasswordPolicyService,
  ) {}

  private requirePasswords(): PasswordPolicyService {
    if (!this.passwords) throw new ServiceUnavailableException('خدمة كلمات المرور غير متاحة');
    return this.passwords;
  }

  // ─── Password policy (Nov 27, 2026 — password-policy.service.ts) ─────────

  /** Admin, own password, step 1: the current password. */
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Post('security/password/check')
  async passwordCheck(@Req() req: Request, @Body() body: { currentPassword?: string }) {
    return this.requirePasswords().checkCurrent(this.actor(req), String(body?.currentPassword || ''), buildClientContext(req as any));
  }

  /** Own (or a staff member's, with `userId`) new password: strong enough and not one of the last 5. */
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Post('security/password/validate')
  async passwordValidate(@Req() req: Request, @Body() body: { newPassword?: string; userId?: string }) {
    const me = this.actor(req);
    if (body?.userId && String(body.userId) !== me.id) return this.requirePasswords().validateStaff(me, String(body.userId), String(body?.newPassword || ''));
    if (me.role !== 'admin') throw new ForbiddenException('يُغيّر مدير النظام كلمات مرور الموظفين.');
    return this.requirePasswords().validateNew(me.id, String(body?.newPassword || ''));
  }

  /** Admin, own password: current + new + a finished step-up 'password-change'. Signs every device out. */
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Post('security/password')
  async passwordChange(@Req() req: Request, @Body() body: { currentPassword?: string; newPassword?: string; stepUp?: string }) {
    return this.requirePasswords().changeOwn(this.actor(req), String(body?.currentPassword || ''), String(body?.newPassword || ''), String(body?.stepUp || ''), buildClientContext(req as any));
  }

  /** May I reset staff passwords? (the users page asks before drawing the button) */
  @UseGuards(JwtAuthGuard)
  @Get('security/staff-password/allowed')
  async staffPasswordAllowed(@Req() req: Request) {
    return { allowed: await this.requirePasswords().canResetStaff(this.actor(req)) };
  }

  /** Staff password reset by an allowed admin: typed or generated, after a step-up 'staff-password'. */
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Post('security/staff-password/:userId')
  async staffPasswordReset(@Req() req: Request, @Param('userId') userId: string, @Body() body: { password?: string; generate?: boolean; stepUp?: string }) {
    return this.requirePasswords().resetStaff(this.actor(req), userId, { password: body?.password ? String(body.password) : undefined, generate: !!body?.generate }, String(body?.stepUp || ''), buildClientContext(req as any));
  }

  /** The owner allows / stops another admin resetting staff passwords. */
  @UseGuards(JwtAuthGuard)
  @Post('security/staff-password-right/:userId')
  async staffPasswordRight(@Req() req: Request, @Param('userId') userId: string, @Body() body: { allowed?: boolean }) {
    return this.requirePasswords().setResetRight(this.actor(req), userId, !!body?.allowed);
  }

  /**
   * The peer IP nginx saw (X-Real-IP = $remote_addr). ⚠ Never X-Forwarded-For for locks and limits:
   * the caller writes that header and could change "IP" on every attempt.
   */
  private realIp(req: Request): string {
    const v = req.headers['x-real-ip'];
    const real = String(Array.isArray(v) ? v[0] : v || '').trim();
    return (real || req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);
  }

  private deviceToken(req: Request): string {
    const v = req.headers['x-device-token'];
    return String(Array.isArray(v) ? v[0] : v || '').slice(0, 128);
  }

  // ─── Sign-in sessions («الجلسات والأجهزة», Nov 27, 2026) ──────────────────

  private actor(req: Request) {
    const u = (req.user || {}) as Record<string, unknown>;
    return {
      id: String(u.userId || u.sub || ''),
      name: String(u.name || u.username || ''),
      role: String(u.role || ''),
      sid: String(u.sid || ''),
    };
  }

  private requireSessions(): UserSessionsService {
    if (!this.sessions) throw new ServiceUnavailableException('سجل الجلسات غير متاح');
    return this.sessions;
  }

  /** Ends this device's session. Always succeeds for the caller (the page signs out anyway). */
  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@Req() req: Request) {
    const me = this.actor(req);
    if (me.sid && this.sessions) {
      await this.sessions.end(me.sid, 'logout', { id: me.id, name: me.name });
      this.presenceGateway.disconnectSessions((u) => u.sid === me.sid, endedMessage({ endReason: 'logout', endedBy: null }));
    }
    return { success: true };
  }

  /** Admin: every account, its open sessions (devices), and its last sign-in. */
  @UseGuards(JwtAuthGuard)
  @Get('sessions/overview')
  async sessionsOverview(@Req() req: Request) {
    const me = this.actor(req);
    if (me.role !== 'admin') throw new ForbiddenException('للمدير فقط');
    const onlineUsers = new Set(this.presenceGateway.getOnlineUserIds());
    const result = await this.requireSessions().overview(this.presenceGateway.getOnlineSids(), onlineUsers, me.sid);
    // Devices still on a token from before sessions existed: shown, ended only by «خروج من كل الأجهزة».
    const legacy = this.presenceGateway.getActiveSessions().filter((s) => !s.sid);
    return { ...result, currentSid: me.sid, legacySockets: legacy };
  }

  /** Login history. Admin: any account; anyone else: their own. */
  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  async sessionsHistory(@Req() req: Request, @Query() q: { userId?: string; status?: string; page?: string; limit?: string }) {
    const me = this.actor(req);
    const userId = me.role === 'admin' ? (q.userId || undefined) : me.id;
    return this.requireSessions().history(
      { userId, status: q.status, page: Number(q.page) || 1, limit: Number(q.limit) || 30 },
      this.presenceGateway.getOnlineSids(),
      me.sid,
    );
  }

  /** Ends one session. Admin: any; anyone else: only their own other devices. */
  @UseGuards(JwtAuthGuard)
  @Post('sessions/:sid/revoke')
  async revokeSession(@Req() req: Request, @Param('sid') sid: string) {
    const me = this.actor(req);
    const sessions = this.requireSessions();
    const row = await sessions.findOne(String(sid || ''));
    if (!row) throw new NotFoundException('الجلسة غير موجودة');
    if (me.role !== 'admin' && row.userId !== me.id) throw new ForbiddenException('لا يمكنك إنهاء جلسة مستخدم آخر');
    if (row._id === me.sid) throw new BadRequestException('هذه جلستك الحالية — استخدم «تسجيل الخروج»');
    const by = { id: me.id, name: me.name };
    const { changed, row: after } = await sessions.end(row._id, 'revoked', by);
    const devices = changed
      ? this.presenceGateway.disconnectSessions((u) => u.sid === row._id, endedMessage({ endReason: 'revoked', endedBy: by }))
      : 0;
    return { success: true, changed, disconnected: devices, session: after ? { id: after._id, endedAt: after.endedAt, endReason: after.endReason } : null };
  }

  /**
   * «خروج من كل الأجهزة» for one account. Admin: any account; anyone else: their own.
   * The caller's own current session is kept when they sign out their own other devices.
   */
  @UseGuards(JwtAuthGuard)
  @Post('sessions/user/:userId/revoke-all')
  async revokeAllSessions(@Req() req: Request, @Param('userId') userId: string) {
    const me = this.actor(req);
    const target = String(userId || '');
    if (!target) throw new BadRequestException('حدّد المستخدم');
    if (me.role !== 'admin' && target !== me.id) throw new ForbiddenException('لا يمكنك إنهاء جلسات مستخدم آخر');
    const self = target === me.id;
    const by = { id: me.id, name: me.name };
    // Own account on an old token (no sid): refusing old tokens would sign this very device out.
    const { ended } = await this.requireSessions().endAllForUser(target, by, {
      exceptSid: self ? me.sid : undefined,
      keepLegacy: self && !me.sid,
    });
    // Keep this device's own sockets: its session, or (old token) every old-token socket.
    const keep = (u: { sid: string }) => self && (me.sid ? u.sid === me.sid : !u.sid);
    const disconnected = this.presenceGateway.disconnectSessions(
      (u) => u.userId === target && !keep(u),
      endedMessage({ endReason: 'revoked-all', endedBy: by }),
    );
    return { success: true, ended: ended.length, disconnected };
  }

  @UseGuards(ThrottlerGuard)
  @Post('login')
  async login(@Body() loginDto: LoginDto, @Req() req: Request) {
    // ⚠ Built from the request, never from the body — a client that could
    // name its own browser/IP could forge the audit trail it is being
    // recorded in. `buildClientContext` reads headers only.
    const client = buildClientContext(req as any);
    return this.authService.login(loginDto, client.ipAddress, client, this.realIp(req));
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async getProfile(@Req() req: Request) {
    const reqUser = req.user as Record<string, unknown>;
    const userId = (reqUser.userId || reqUser.sub) as string;
    // Read the full document rather than the JWT projection — the profile page
    // needs lastLogin/createdAt, which the token payload does not carry.
    const doc = userId ? await this.usersService.findById(userId) : null;
    if (doc) return buildAuthUserPayload(doc);
    return buildAuthUserPayload({ ...reqUser, _id: userId });
  }

  // ⚠ Both were open to anyone without a session (Nov 27, 2026): users-status listed every
  // account id and username to an anonymous caller.
  @UseGuards(JwtAuthGuard)
  @Post('set-status')
  async setStatus(
    @Req() req: Request,
    @Body() body: { status: 'online' | 'offline'; userId?: string },
  ) {
    try {
      const user = req.user as Record<string, unknown> | undefined;
      const userId = (user?.userId || user?.sub) as string;
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
      const userId = (user?.userId || user?.sub) as string;
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

  @UseGuards(JwtAuthGuard)
  @Get('users-status')
  async getUsersStatus() {
    try {
      const allUsers = await this.usersService.findAll();
      const onlineIds = this.presenceGateway.getOnlineUserIds();
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

  // ─── Sign-in verification (Nov 27, 2026) ──────────────────────────────────
  // Public routes take the CHALLENGE a correct password created — never a userId.

  @UseGuards(ThrottlerGuard)
  @Post('challenge/verify')
  async challengeVerify(@Body() body: { challenge: string; method: string; code: string; trustDevice?: boolean }, @Req() req: Request) {
    return this.verification.verifyCode(String(body?.challenge || ''), String(body?.method || '') as any, String(body?.code || ''), !!body?.trustDevice, buildClientContext(req as any));
  }

  @UseGuards(ThrottlerGuard)
  @Post('challenge/email')
  async challengeEmail(@Body() body: { challenge: string }) {
    return this.verification.sendEmailCode(String(body?.challenge || ''));
  }

  @UseGuards(ThrottlerGuard)
  @Post('challenge/approval')
  async challengeApproval(@Body() body: { challenge: string }) {
    return this.verification.requestApproval(String(body?.challenge || ''));
  }

  @UseGuards(ThrottlerGuard)
  @Post('challenge/approval/status')
  async challengeApprovalStatus(@Body() body: { challenge: string; trustDevice?: boolean }, @Req() req: Request) {
    return this.verification.approvalStatus(String(body?.challenge || ''), !!body?.trustDevice, buildClientContext(req as any));
  }

  // Forced Google Authenticator setup (an admin with no verification method yet).
  @UseGuards(ThrottlerGuard)
  @Post('challenge/setup-init')
  async challengeSetupInit(@Body() body: { challenge: string }) {
    return this.verification.setupInit(String(body?.challenge || ''));
  }

  @UseGuards(ThrottlerGuard)
  @Post('challenge/setup-confirm')
  async challengeSetupConfirm(@Body() body: { challenge: string; code: string; trustDevice?: boolean }, @Req() req: Request) {
    return this.verification.setupConfirm(String(body?.challenge || ''), String(body?.code || ''), !!body?.trustDevice, buildClientContext(req as any));
  }

  // Forgot password (admin accounts): start → verify with the challenge routes → reset.
  @UseGuards(ThrottlerGuard)
  @Post('forgot-password/start')
  async forgotStart(@Body() body: { username: string }, @Req() req: Request) {
    // Staff (and unknown names) send a request to the admins; only an active admin gets the recovery codes.
    const client = buildClientContext(req as any);
    const staff = this.passwords ? await this.passwords.staffRequest(String(body?.username || ''), client) : null;
    if (staff) return staff;
    return this.verification.forgotStart(String(body?.username || ''), client);
  }

  @UseGuards(ThrottlerGuard)
  @Post('forgot-password/reset')
  async forgotReset(@Body() body: { challenge: string; newPassword: string }, @Req() req: Request) {
    return this.verification.resetPassword(String(body?.challenge || ''), String(body?.newPassword || ''), buildClientContext(req as any));
  }

  // ─── Password-guessing protection (login-guard) ───────────────────────────

  /** «فتح القفل برمز التحقق» on a locked sign-in source (this IP). */
  @UseGuards(ThrottlerGuard)
  @Post('login-unlock/start')
  async loginUnlockStart(@Body() body: { username: string }, @Req() req: Request) {
    return this.verification.unlockStart(String(body?.username || ''), buildClientContext(req as any), this.realIp(req));
  }

  /** «هل هذا أنت؟» alerts of my account. */
  @UseGuards(JwtAuthGuard)
  @Get('login-alerts')
  async loginAlerts(@Req() req: Request) {
    return this.verification.pendingLoginAlerts(this.actor(req));
  }

  @UseGuards(JwtAuthGuard)
  @Post('login-alerts/:id')
  async decideLoginAlert(@Req() req: Request, @Param('id') id: string, @Body() body: { decision: string }) {
    return this.verification.decideLoginAlert(this.actor(req), String(id || ''), String(body?.decision || ''));
  }

  /** Every sign-in attempt (admin). */
  @UseGuards(JwtAuthGuard)
  @Get('login-attempts')
  async loginAttempts(@Req() req: Request, @Query() q: { q?: string; username?: string; ip?: string; result?: string; page?: string; limit?: string }) {
    return this.verification.loginAttempts(this.actor(req), { q: q.q, username: q.username, ip: q.ip, result: q.result, page: Number(q.page) || 1, limit: Number(q.limit) || undefined });
  }

  // ─── Signed in: my security settings ──────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get('security')
  async security(@Req() req: Request) {
    return this.verification.securityOverview(this.actor(req), this.deviceToken(req));
  }

  /** «تأكيد الهوية» before a sensitive change: returns a challenge finished with the challenge routes. */
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Post('security/step-up')
  async securityStepUp(@Req() req: Request, @Body() body: { action: string }) {
    return this.verification.stepUpStart(this.actor(req), String(body?.action || ''), buildClientContext(req as any));
  }

  /** The system PIN («الرقم السري للنظام») — only with a finished step-up for 'system-pin'. */
  @UseGuards(JwtAuthGuard)
  @Post('security/system-pin')
  async securitySystemPin(@Req() req: Request, @Body() body: { pin: string; stepUp: string; currentPin?: string }) {
    return this.verification.changeSystemPin(this.actor(req), String(body?.pin || ''), String(body?.stepUp || ''), buildClientContext(req as any), String(body?.currentPin || ''));
  }

  /** Step 1 of «تغيير الرقم السري»: is this the current system PIN? (Wrong → 401 CURRENT_PIN_WRONG.) */
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Post('security/system-pin/check')
  async securitySystemPinCheck(@Req() req: Request, @Body() body: { currentPin?: string }) {
    return this.verification.checkCurrentPin(this.actor(req), String(body?.currentPin || ''), buildClientContext(req as any));
  }

  @UseGuards(JwtAuthGuard)
  @Post('security/email/request')
  async securityEmailRequest(@Req() req: Request, @Body() body: { email: string; password: string; stepUp?: string }) {
    return this.verification.emailRequest(this.actor(req), String(body?.email || ''), String(body?.password || ''), String(body?.stepUp || ''));
  }

  @UseGuards(JwtAuthGuard)
  @Post('security/email/confirm')
  async securityEmailConfirm(@Req() req: Request, @Body() body: { code: string }) {
    return this.verification.emailConfirm(this.actor(req), String(body?.code || ''));
  }

  @UseGuards(JwtAuthGuard)
  @Post('security/email/remove')
  async securityEmailRemove(@Req() req: Request, @Body() body: { password: string; stepUp?: string }) {
    return this.verification.emailRemove(this.actor(req), String(body?.password || ''), String(body?.stepUp || ''));
  }

  /** Another admin resets an account's 2FA (lost phone). Needs the system PIN. */
  @UseGuards(JwtAuthGuard)
  @Post('security/users/:userId/reset-2fa')
  async adminReset2fa(@Req() req: Request, @Param('userId') userId: string, @Body() body: { pin: string }) {
    return this.verification.adminReset2fa(this.actor(req), String(userId || ''), String(body?.pin || ''));
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/setup')
  async totpSetup(@Req() req: Request) {
    return this.totpService.generateSetup(this.actor(req).id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/confirm')
  async totpConfirm(@Req() req: Request, @Body() body: { token: string }) {
    return this.verification.totpConfirm(this.actor(req), String(body?.token || ''));
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/disable')
  async totpDisable(@Req() req: Request, @Body() body: { password: string; stepUp?: string }) {
    return this.verification.totpDisable(this.actor(req), String(body?.password || ''), this.deviceToken(req), String(body?.stepUp || ''));
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/backup-codes')
  async totpBackupCodes(@Req() req: Request, @Body() body: { code: string }) {
    return this.verification.regenerateBackupCodes(this.actor(req), String(body?.code || ''));
  }

  // ─── Trusted devices ──────────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get('trusted-devices')
  async trustedDevices(@Req() req: Request, @Query('userId') userId?: string) {
    return this.verification.listDevices(this.actor(req), userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('trusted-devices/revoke-all')
  async revokeAllDevices(@Req() req: Request, @Body() body: { userId?: string }) {
    return this.verification.revokeAllDevices(this.actor(req), body?.userId, this.deviceToken(req));
  }

  @UseGuards(JwtAuthGuard)
  @Post('trusted-devices/:id/revoke')
  async revokeDevice(@Req() req: Request, @Param('id') id: string, @Body() body: { userId?: string }) {
    return this.verification.revokeDevice(this.actor(req), String(id || ''), body?.userId);
  }

  /** Older pages: «إلغاء ثقة الأجهزة المحفوظة». */
  @UseGuards(JwtAuthGuard)
  @Post('totp/revoke-devices')
  async revokeDevicesLegacy(@Req() req: Request) {
    return this.verification.revokeAllDevices(this.actor(req), undefined, this.deviceToken(req));
  }

  // ─── Approving a sign-in from a trusted device ────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get('login-approvals')
  async loginApprovals(@Req() req: Request) {
    return this.verification.pendingApprovals(this.actor(req), this.deviceToken(req));
  }

  @UseGuards(JwtAuthGuard)
  @Post('login-approvals/:id')
  async decideLoginApproval(@Req() req: Request, @Param('id') id: string, @Body() body: { decision: 'approve' | 'deny'; number?: string }) {
    return this.verification.decideApproval(this.actor(req), String(id || ''), body?.decision, String(body?.number || ''), this.deviceToken(req));
  }

  // ─── System-wide switch ───────────────────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Get('totp/global-status')
  async getGlobal2faStatus(@Req() req: Request) {
    if (this.actor(req).role !== 'admin') throw new ForbiddenException('للمدير فقط');
    const enabled = await this.totpService.getGlobal2faStatus();
    return { enabled };
  }

  @UseGuards(JwtAuthGuard)
  @Post('totp/global-toggle')
  async toggleGlobal2fa(@Req() req: Request, @Body() body: { enabled: boolean }) {
    if (this.actor(req).role !== 'admin') throw new ForbiddenException('للمدير فقط');
    await this.totpService.setGlobal2fa(!!body?.enabled);
    return { success: true, enabled: !!body?.enabled };
  }

  // Emergency: turn the system-wide switch off (staff only — admins always verify a new device).
  // Protected by EMERGENCY_KEY (server environment).
  @UseGuards(ThrottlerGuard)
  @Post('emergency/disable-2fa')
  async emergencyDisable2fa(@Body() body: { key: string }) {
    const emergencyKey = String(process.env.EMERGENCY_KEY || '');
    const a = Buffer.from(emergencyKey);
    const b = Buffer.from(String(body?.key || ''));
    if (emergencyKey.length < 16 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new ForbiddenException('forbidden');
    }
    await this.totpService.setGlobal2fa(false);
    return { success: true, message: '2FA disabled' };
  }
}
