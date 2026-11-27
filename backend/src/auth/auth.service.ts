import { Injectable, UnauthorizedException, Inject, forwardRef, HttpException, HttpStatus } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { MentionsService } from '../mentions/mentions.service';
import { SecurityAuditService } from '../security-audit/security-audit.service';
import { LoginDto } from './dto/login.dto';
import { ClientContext } from '../shared/client-context.util';
import { SignInVerificationService } from './sign-in-verification.service';
import { AuthUserPayload, buildAuthUserPayload } from './auth-user-payload';

import { LoginGuardService } from './login-guard.service';
import { TrustedDevicesService } from './trusted-devices.service';
import { BLOCKED_MESSAGE, GENERIC_LOGIN_ERROR, lockedMessage, userKeyOf } from './login-guard.util';
import { deviceLabel } from './auth-security.util';

let DUMMY_HASH = '';
/** A real bcrypt hash compared against when the username does not exist. */
function dummyHash(): string {
  if (!DUMMY_HASH) DUMMY_HASH = bcrypt.hashSync('soulia-no-such-account-' + Math.random(), 10);
  return DUMMY_HASH;
}

export { buildAuthUserPayload };
export type { AuthUserPayload };

// In-memory user status tracker
const usersStatus: Record<string, { status: 'online' | 'offline'; lastSeen: Date }> = {};

export interface LoginResponse {
  accessToken?: string;
  user?: AuthUserPayload;
  requireTotp?: boolean;
  requireTotpSetup?: boolean;
  requireVerification?: boolean;
  challenge?: string;
  [key: string]: unknown;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    @Inject(forwardRef(() => MentionsService)) private readonly mentionsService: MentionsService,
    private readonly auditService: SecurityAuditService,
    private readonly verification: SignInVerificationService,
    private readonly guard: LoginGuardService,
    private readonly devices: TrustedDevicesService,
  ) {}

  /**
   * `client` is the request fingerprint (browser / OS / device / IP). It is
   * attached to every audit row this method writes, because "4 failed attempts"
   * with no origin cannot distinguish an employee mistyping their own password
   * from someone else attacking the account — which is the only question an
   * admin looking at a lockout actually has.
   *
   * ⚠ A right password finishes the sign-in only when no second step is needed. Otherwise it
   * returns a CHALLENGE (SignInVerificationService); the second step needs that challenge, so a
   * Google/email code can never replace the password (Nov 27, 2026 — the old /auth/totp/verify
   * signed in with userId + code only).
   */
  async login(
    loginDto: LoginDto,
    ipAddress?: string,
    client?: ClientContext,
    guardIp?: string,
  ): Promise<LoginResponse> {
    // ⚠ Locks and limits key on the real peer IP (nginx X-Real-IP), never on X-Forwarded-For, which
    // the caller can write — `guardIp` comes from the controller. Password-guessing protection:
    // login-guard.util.ts (a lock falls on the SOURCE guessing, never on the account).
    const ip = guardIp || ipAddress || '';
    const userKey = userKeyOf(loginDto.username);
    const label = deviceLabel(client);
    const logBase = { username: loginDto.username, ip, device: client?.device || '', browser: client?.browser || '', os: client?.os || '' };

    if (this.guard.overIpRate(ip)) {
      await this.guard.log({ ...logBase, result: 'rate-limited' });
      throw new HttpException({ message: 'عدد كبير من المحاولات من هذا الجهاز. حاول مرة أخرى بعد دقيقة.', code: 'RATE_LIMITED' }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const user = await this.usersService.findByUsername(loginDto.username);
    const device = user && loginDto.deviceToken ? await this.devices.findValid(String(user._id), loginDto.deviceToken) : null;
    const trusted = !!device;
    const sourceId = device ? `dev:${device._id}` : `ip:${ip}`;
    const userId = user ? String(user._id) : '';
    const st = await this.guard.state(userKey, sourceId, ip, trusted);

    if (st.hard) {
      await this.guard.log({ ...logBase, userId, result: 'blocked', trusted, sourceId });
      throw new HttpException({ message: BLOCKED_MESSAGE, code: 'LOGIN_BLOCKED', canUnlock: true }, 423);
    }
    const waitMin = Math.max(st.lockedMinutes, st.ipBlockedMinutes);
    if (waitMin > 0) {
      await this.guard.log({ ...logBase, userId, result: 'locked', trusted, sourceId });
      throw new HttpException({ message: lockedMessage(waitMin), code: 'LOGIN_LOCKED', minutes: waitMin, canUnlock: true }, 423);
    }
    if (st.powRequired) {
      const bind = `${userKey}|${ip}`;
      // Cloudflare Turnstile when its keys are set; the proof of work otherwise, or when Cloudflare
      // cannot be reached.
      const siteKey = this.guard.captchaSiteKey();
      const captcha = siteKey ? await this.guard.verifyCaptcha(loginDto.captcha, ip) : 'unavailable';
      if (captcha === 'bad') {
        await this.guard.log({ ...logBase, userId, result: loginDto.captcha ? 'captcha-failed' : 'captcha-required', trusted, sourceId });
        throw new HttpException({ message: 'يلزم التحقق من أنك لست برنامجًا آليًا.', code: 'CAPTCHA_REQUIRED', captcha: { provider: 'turnstile', siteKey } }, HttpStatus.PRECONDITION_REQUIRED);
      }
      if (captcha === 'unavailable' && !this.guard.usePow(bind, loginDto.pow)) {
        await this.guard.log({ ...logBase, userId, result: loginDto.pow ? 'pow-failed' : 'pow-required', trusted, sourceId });
        throw new HttpException({ message: 'يلزم التحقق من أنك لست برنامجًا آليًا.', code: 'POW_REQUIRED', pow: this.guard.issuePow(bind) }, HttpStatus.PRECONDITION_REQUIRED);
      }
    }

    // An unknown username costs the same time as a wrong password (no account discovery by timing).
    const passwordOk = await bcrypt.compare(String(loginDto.password || ''), user?.password || dummyHash());
    if (!user || !passwordOk) {
      const out = await this.guard.fail({ userKey, sourceId, ip, device: label, trusted });
      await this.guard.log({ ...logBase, userId, result: 'bad-credentials', trusted, sourceId });
      if (user && (out.newlyLocked || out.newlyHard)) {
        await this.verification.loginAttackAlert(user, { ip, client, sourceId, userKey, hard: out.newlyHard, minutes: out.lockedMinutes }).catch(() => undefined);
      }
      if (user && out.attackStarted) {
        this.auditService.log({ userId, username: user.username, violationType: 'login_attack' as any, action: 'محاولات تخمين متكررة على الحساب من عدة مصادر — طُلب التحقق من الجميع لمدة ساعة', ipAddress: ip, client }).catch(() => undefined);
      }
      if (out.newlyHard) throw new HttpException({ message: BLOCKED_MESSAGE, code: 'LOGIN_BLOCKED', canUnlock: true }, 423);
      if (out.newlyLocked) throw new HttpException({ message: lockedMessage(out.lockedMinutes), code: 'LOGIN_LOCKED', minutes: out.lockedMinutes, canUnlock: true }, 423);
      // ⚠ One message for every failure: no remaining-attempts count, no hint which part was wrong.
      throw new UnauthorizedException({ message: GENERIC_LOGIN_ERROR, code: 'BAD_CREDENTIALS' });
    }

    // A disabled account is named only to someone who knows its password.
    if (user.isActive === false) {
      await this.guard.log({ ...logBase, userId, result: 'disabled', trusted, sourceId });
      throw new UnauthorizedException(`🔒 تم تعطيل هذا الحساب — ${user.lockReason || 'تواصل مع المدير لإعادة التفعيل'}`);
    }

    await this.guard.success(userKey, sourceId);
    await this.usersService.resetLoginAttempts(userId);
    await this.guard.log({ ...logBase, userId, result: 'password-ok', trusted, sourceId });
    // Under attack, even a trusted device passes the second step (owner's rule).
    return this.verification.afterPassword(user, client, loginDto.deviceToken, { forceVerify: st.underAttack }) as Promise<LoginResponse>;
  }

  private async _notifyAdmins(_username: string, _name: string, message: string): Promise<void> {
    try {
      const allUsers = await this.usersService.findAll();
      const admins = allUsers.filter(u => u.role === 'admin');
      if (!admins.length) return;
      await this.mentionsService.createMany(
        admins.map(a => ({
          targetUserId: a._id.toString(),
          targetUsername: a.username,
          targetName: a.name,
          fromUserId: 'system',
          fromName: 'نظام الأمان',
          commentText: message,
          read: false,
        })),
      );
    } catch {
      // Non-fatal — don't break login flow
    }
  }

  async setUserStatus(
    userId: string,
    status: 'online' | 'offline',
  ): Promise<{ message: string }> {
    usersStatus[userId] = {
      status,
      lastSeen: new Date(),
    };
    return { message: `تم تحديث الحالة إلى ${status === 'online' ? 'متصل' : 'غير متصل'}` };
  }

  async getUsersStatus(): Promise<{
    online: Record<string, { status: string; lastSeen: string }>;
  }> {
    const online: Record<string, { status: string; lastSeen: string }> = {};
    for (const [userId, status] of Object.entries(usersStatus)) {
      online[userId] = {
        status: status.status,
        lastSeen: status.lastSeen.toISOString(),
      };
    }
    return { online };
  }
}
