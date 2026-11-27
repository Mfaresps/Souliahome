import {
  BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException,
  Optional, ServiceUnavailableException, UnauthorizedException, forwardRef, Inject,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { MentionsService } from '../mentions/mentions.service';
import { SecurityAuditService } from '../security-audit/security-audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Settings } from '../settings/schemas/settings.schema';
import type { ClientContext } from '../shared/client-context.util';
import { TotpService } from './totp.service';
import { AuthChallengeService, ChallengeRow, ChallengeState } from './auth-challenge.service';
import { TrustedDevicesService } from './trusted-devices.service';
import { SecurityMailerService, securityMailBody } from './security-mailer.service';
import { TokenIssuerService } from './token-issuer.service';
import { PresenceGateway } from './presence.gateway';
import { UserSessionsService } from './user-sessions.service';
import type { SessionMethod } from './user-sessions.util';
import { buildAuthUserPayload } from './auth-user-payload';
import { LoginGuardService } from './login-guard.service';
import { userKeyOf } from './login-guard.util';
import {
  AvailableMethods, CHALLENGE_MAX_ATTEMPTS, EMAIL_CODE_TTL_MS, STEP_UP_ACTIONS, StepUpAction, TRUST_DAYS, VerifyMethod,
  codeHash, deviceLabel, isValidEmail, loginRequirement, maskEmail, methodAllowed, needsSecondStep,
  normalizeDigits, normalizeEmail, openGroups, passwordProblem, randomCode6, requirementMet,
  resetRequirement, safeEqual, stepUpRequirement,
} from './auth-security.util';

type Actor = { id: string; name: string; role: string; sid: string };

const CODE_SECRET = () => String(process.env.JWT_SECRET || 'soulia');

const STEP_UP_LABEL: Record<StepUpAction, string> = {
  'system-pin': 'تغيير الرقم السري للنظام',
  'security-email': 'تغيير بريد التحقق',
  'totp-disable': 'تعطيل Google Authenticator',
  'password-change': 'تغيير كلمة المرور',
  'staff-password': 'إعادة تعيين كلمة مرور موظف',
};

const cairo = (d: Date) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  timeZone: 'Africa/Cairo', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(d);

/**
 * The second step of signing in, password reset, trusted devices and the security email
 * (Nov 27, 2026). Rules: auth-security.util.ts.
 *
 * ⚠ Every route here takes a challenge created by a correct password (or, for a reset, by a
 * username) — never a bare userId. A code alone can no longer sign anyone in.
 */
@Injectable()
export class SignInVerificationService {
  private readonly logger = new Logger(SignInVerificationService.name);

  constructor(
    private readonly users: UsersService,
    private readonly totp: TotpService,
    private readonly challenges: AuthChallengeService,
    private readonly devices: TrustedDevicesService,
    private readonly mailer: SecurityMailerService,
    private readonly tokens: TokenIssuerService,
    private readonly audit: SecurityAuditService,
    @Inject(forwardRef(() => MentionsService)) private readonly mentions: MentionsService,
    private readonly presence: PresenceGateway,
    @InjectModel(Settings.name) private readonly settingsModel: Model<Settings>,
    private readonly guard: LoginGuardService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly sessions?: UserSessionsService,
  ) {}

  // ─── What an account can use ────────────────────────────────────────────

  /** A verified security email that can actually be sent to (admin accounts only). */
  private emailOf(user: any): string {
    if (user?.role !== 'admin' || !user?.securityEmail || !user?.securityEmailVerifiedAt) return '';
    return normalizeEmail(user.securityEmail);
  }

  async methodsFor(user: any): Promise<AvailableMethods> {
    const totp = !!user?.totpEnabled && !!user?.totpSecret;
    return {
      totp,
      email: !!this.emailOf(user) && this.mailer.configured(),
      approval: await this.devices.hasActive(String(user._id)),
      backup: totp && this.totp.backupCodesLeft(user) > 0,
    };
  }

  private presentMethods(m: AvailableMethods, user: any) {
    return { totp: m.totp, email: m.email ? maskEmail(this.emailOf(user)) : null, approval: m.approval, backup: m.backup };
  }

  // ─── Sign in ─────────────────────────────────────────────────────────────

  /** Called by AuthService.login once the password is right. */
  async afterPassword(user: any, client: ClientContext | undefined, deviceToken: string | undefined, opts: { forceVerify?: boolean } = {}) {
    const userId = String(user._id);
    const previousLogin: Date | null = user.lastLogin ?? null;
    const global2fa = await this.totp.getGlobal2faStatus();
    if (!needsSecondStep(user, global2fa)) return this.finish(user, 'password', client, previousLogin);

    if (deviceToken && !opts.forceVerify) {
      const device = await this.devices.findValid(userId, deviceToken);
      if (device) return this.finish(user, 'trusted-device', client, previousLogin);
      const migrated = await this.devices.migrateLegacy(user, deviceToken, client);
      if (migrated) {
        const res = await this.finish(user, 'trusted-device', client, previousLogin);
        return { ...res, deviceToken: migrated.token, trustedUntil: migrated.row.expiresAt };
      }
    }

    const m = await this.methodsFor(user);
    let requirement = loginRequirement(m);
    // No way to verify at all (admin who never set anything up): Google Authenticator is set up now.
    const setupRequired = requirement.length === 0;
    if (setupRequired) requirement = [['totp']];
    const { token } = await this.challenges.create({ user, purpose: 'login', requirement, setupRequired, client });
    return {
      requireVerification: true,
      requireTotp: true, // older pages
      requireTotpSetup: setupRequired,
      setupRequired,
      challenge: token,
      methods: this.presentMethods(m, user),
      account: { name: user.name || '', username: user.username || '' },
      trustDays: TRUST_DAYS,
      maxAttempts: CHALLENGE_MAX_ATTEMPTS,
    };
  }

  private async finish(user: any, method: SessionMethod, client: ClientContext | undefined, previousLogin: Date | null) {
    await this.users.updateLastLogin(String(user._id));
    return {
      accessToken: await this.tokens.issue(user, method, client),
      user: buildAuthUserPayload(user, previousLogin),
    };
  }

  private challengeError(st: ChallengeState): HttpException {
    const map: Record<string, [string, string]> = {
      missing: ['CHALLENGE_INVALID', 'انتهت جلسة التحقق. سجّل الدخول مرة أخرى.'],
      expired: ['CHALLENGE_EXPIRED', 'انتهت مهلة التحقق. سجّل الدخول مرة أخرى.'],
      locked: ['CHALLENGE_LOCKED', 'تم إيقاف محاولة تسجيل الدخول هذه. سجّل الدخول مرة أخرى.'],
      used: ['CHALLENGE_USED', 'سبق استخدام محاولة التحقق هذه. سجّل الدخول مرة أخرى.'],
    };
    const [code, message] = map[st.reason] || map.missing;
    return new UnauthorizedException({ message, code });
  }

  private async live(token: string, purpose?: 'login' | 'reset'): Promise<ChallengeRow> {
    const st = await this.challenges.get(token, purpose);
    if (!st.ok || !st.row) throw this.challengeError(st);
    return st.row;
  }

  /** A wrong code. After the last attempt the challenge is closed, the owner and admins told. */
  private async wrong(row: ChallengeRow, method: VerifyMethod): Promise<never> {
    const left = await this.challenges.fail(row._id);
    const label = { totp: 'Google Authenticator', email: 'رمز البريد', approval: 'الموافقة', backup: 'رمز احتياطي' }[method];
    try {
      await this.audit.log({
        userId: row.userId, username: row.username, violationType: 'otp_violation',
        action: `رمز تحقق خاطئ عند ${row.purpose === 'reset' ? 'استعادة كلمة المرور' : 'تسجيل الدخول'} (${label})`,
        ipAddress: row.client.ipAddress, client: row.client,
      });
    } catch { /* the refusal does not depend on the audit row */ }
    if (left > 0) throw new UnauthorizedException({ message: `رمز التحقق غير صحيح. المحاولات المتبقية: ${left}.`, code: 'CODE_WRONG', attemptsLeft: left });
    this.onLocked(row).catch(() => undefined);
    throw new UnauthorizedException({ message: `تم إيقاف محاولة تسجيل الدخول بعد ${CHALLENGE_MAX_ATTEMPTS} محاولات غير صحيحة. سجّل الدخول مرة أخرى.`, code: 'CHALLENGE_LOCKED' });
  }

  private async onLocked(row: ChallengeRow) {
    await this.audit.log({
      userId: row.userId, username: row.username, violationType: 'login_challenge_failed' as any,
      action: `إيقاف محاولة ${row.purpose === 'reset' ? 'استعادة كلمة المرور' : 'تسجيل دخول'} بعد ${CHALLENGE_MAX_ATTEMPTS} رموز خاطئة`,
      detail: deviceLabel(row.client), ipAddress: row.client.ipAddress, client: row.client,
    }).catch(() => undefined);
    const user = await this.users.findById(row.userId);
    const to = this.emailOf(user);
    if (to) {
      const body = securityMailBody({
        title: 'تنبيه أمان: محاولات تحقق خاطئة على حسابك',
        lines: [
          `أُدخلت ${CHALLENGE_MAX_ATTEMPTS} رموز تحقق خاطئة على حساب ${row.username} بعد كتابة كلمة المرور الصحيحة.`,
          `الجهاز: ${deviceLabel(row.client)} · IP ${row.client.ipAddress || 'غير معروف'} · ${cairo(new Date())}`,
          'إذا لم تكن أنت، فكلمة المرور معروفة لشخص آخر: غيّرها فورًا.',
        ],
      });
      this.mailer.sendQuietly({ to, subject: 'SOULIA — تنبيه أمان على حسابك', ...body });
    }
  }

  /** Google Authenticator / backup code / email code. */
  async verifyCode(token: string, method: VerifyMethod, code: string, trustDevice: boolean, client?: ClientContext) {
    if (!['totp', 'backup', 'email'].includes(method)) throw new BadRequestException('طريقة التحقق غير معروفة.');
    const row = await this.live(token);
    if (row.setupRequired) throw new BadRequestException({ message: 'أكمل تفعيل التحقق بخطوتين أولًا.', code: 'SETUP_REQUIRED' });
    if (!methodAllowed(row.requirement, row.done, method)) throw new BadRequestException({ message: 'طريقة التحقق هذه غير متاحة.', code: 'METHOD_NOT_ALLOWED' });
    let ok = false;
    if (method === 'totp') ok = await this.totp.verifyAndSpend(row.userId, code);
    else if (method === 'backup') ok = await this.totp.useBackupCode(row.userId, code);
    else {
      const digits = normalizeDigits(code);
      ok = digits.length === 6 && !!row.email?.codeHash
        && await this.challenges.spendEmailCode(row._id, codeHash(CODE_SECRET(), row._id, digits));
    }
    if (!ok) return this.wrong(row, method);
    if (method === 'backup') {
      const user = await this.users.findById(row.userId);
      const left = this.totp.backupCodesLeft(user);
      this.audit.log({ userId: row.userId, username: row.username, violationType: 'two_factor_changed' as any, action: `استُخدم رمز احتياطي — تبقى ${left}`, ipAddress: row.client.ipAddress, client: row.client }).catch(() => undefined);
    }
    const after = await this.challenges.markDone(row._id, method);
    if (!after) throw this.challengeError({ ok: false, reason: 'locked', row });
    return this.advance(after, method, trustDevice, client);
  }

  /** Either the next factor is still needed, or the sign-in finishes / the reset is unlocked. */
  private async advance(row: ChallengeRow, method: VerifyMethod, trustDevice: boolean, client?: ClientContext) {
    if (!requirementMet(row.requirement, row.done)) {
      return { done: false, remaining: openGroups(row.requirement, row.done) };
    }
    if (row.purpose === 'reset') {
      await this.challenges.markResetReady(row._id);
      return { done: true, resetReady: true };
    }
    if (row.purpose === 'stepup') {
      await this.challenges.markResetReady(row._id);
      return { done: true, stepUpReady: true };
    }
    if (row.purpose === 'unlock') {
      if (!(await this.challenges.complete(row._id))) throw this.challengeError({ ok: false, reason: 'used', row });
      const ip = row.client.ipAddress || '';
      await this.guard.clearSource(userKeyOf(row.username), `ip:${ip}`, ip);
      await this.syncLoginBlock(row.userId, row.username);
      this.audit.log({ userId: row.userId, username: row.username, violationType: 'account_unlocked', action: `فتح صاحب الحساب قفل محاولات الدخول من ${ip || 'جهاز'} برمز التحقق`, ipAddress: ip, client: row.client }).catch(() => undefined);
      return { done: true, unlocked: true };
    }
    if (!(await this.challenges.complete(row._id))) throw this.challengeError({ ok: false, reason: 'used', row });
    const user = await this.users.findById(row.userId);
    if (!user || user.isActive === false) throw new UnauthorizedException('هذا الحساب غير متاح.');
    const previousLogin: Date | null = user.lastLogin ?? null;
    let device: { token: string; row: { expiresAt: Date } } | null = null;
    if (trustDevice) device = await this.devices.create(row.userId, client, method);
    const sessionMethod: SessionMethod = method;
    const res = await this.finish(user, sessionMethod, client, previousLogin);
    this.newDeviceNotice(user, client, method, !!device).catch(() => undefined);
    return { done: true, ...res, ...(device ? { deviceToken: device.token, trustedUntil: device.row.expiresAt } : {}) };
  }

  /** «تم تسجيل الدخول من جهاز جديد» — to the account itself only (in-app + email). */
  private async newDeviceNotice(user: any, client: ClientContext | undefined, method: VerifyMethod, trusted: boolean) {
    const how = { totp: 'Google Authenticator', email: 'رمز البريد', approval: 'موافقة من جهاز موثوق', backup: 'رمز احتياطي' }[method];
    const where = `${deviceLabel(client)} · IP ${client?.ipAddress || 'غير معروف'}`;
    const text = `تم تسجيل الدخول إلى حسابك من جهاز جديد (${where}) عبر ${how}${trusted ? '، وأُضيف إلى الأجهزة الموثوقة' : ''}. إذا لم تكن أنت، غيّر كلمة المرور وألغِ الأجهزة الموثوقة فورًا.`;
    try {
      await this.mentions.createMany([{ targetUserId: String(user._id), targetUsername: user.username, targetName: user.name, fromUserId: 'system', fromName: 'نظام الأمان', txId: 'security', commentId: 0, commentText: text, read: false } as any]);
    } catch { /* best effort */ }
    const to = this.emailOf(user);
    if (to) {
      this.mailer.sendQuietly({ to, subject: 'SOULIA — تسجيل دخول من جهاز جديد', ...securityMailBody({
        title: 'تسجيل دخول جديد إلى حسابك',
        lines: [`الحساب: ${user.username}`, `الجهاز: ${where}`, `الوقت: ${cairo(new Date())}`, `طريقة التحقق: ${how}`, 'إذا لم تكن أنت، غيّر كلمة المرور فورًا من «نسيت كلمة المرور».'],
      }) });
    }
  }

  // ─── Email code ──────────────────────────────────────────────────────────

  async sendEmailCode(token: string) {
    const row = await this.live(token);
    if (!methodAllowed(row.requirement, row.done, 'email')) throw new BadRequestException({ message: 'التحقق عبر البريد الإلكتروني غير متاح.', code: 'METHOD_NOT_ALLOWED' });
    const user = await this.users.findById(row.userId);
    const to = this.emailOf(user);
    if (!to) throw new BadRequestException('لا يوجد بريد إلكتروني مؤكَّد لهذا الحساب.');
    if (!this.mailer.configured()) throw new ServiceUnavailableException({ message: 'إرسال البريد الإلكتروني غير متاح حاليًا. استخدم طريقة تحقق أخرى.', code: 'SMTP_NOT_CONFIGURED' });
    const code = randomCode6();
    const now = new Date();
    const r = await this.challenges.reserveEmail(row, to, codeHash(CODE_SECRET(), row._id, code), now);
    if (!r.ok) {
      const msg = r.reason === 'wait' ? `يمكنك طلب رمز جديد بعد ${r.waitSec} ثانية.`
        : r.reason === 'limit' ? 'وصلت إلى الحد الأقصى لإرسال الرموز. سجّل الدخول مرة أخرى.'
          : 'طلبت عددًا كبيرًا من الرموز خلال ساعة. حاول لاحقًا أو استخدم طريقة تحقق أخرى.';
      throw new HttpException({ message: msg, code: 'EMAIL_RATE_LIMITED', waitSec: r.waitSec }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const reset = row.purpose === 'reset';
    const stepUp = row.purpose === 'stepup';
    const what = stepUp ? (STEP_UP_LABEL[row.action as StepUpAction] || 'تغيير إعدادات الأمان') : '';
    try {
      await this.mailer.send({ to, subject: stepUp ? `SOULIA — رمز تأكيد ${what}: ${code}` : reset ? `SOULIA — رمز استعادة كلمة المرور: ${code}` : `SOULIA — رمز تسجيل الدخول: ${code}`, ...securityMailBody({
        title: stepUp ? `رمز تأكيد ${what}` : reset ? 'رمز استعادة كلمة المرور' : 'رمز تسجيل الدخول من جهاز جديد',
        code,
        lines: [
          `الحساب: ${row.username}`,
          `الجهاز: ${deviceLabel(row.client)} · IP ${row.client.ipAddress || 'غير معروف'}`,
          `الوقت: ${cairo(now)}`,
          `الرمز صالح ${Math.round(EMAIL_CODE_TTL_MS / 60000)} دقائق ويُستخدم مرة واحدة. لا تشاركه مع أي شخص.`,
          stepUp ? `طُلب هذا الرمز لـ${what} من حسابك. إذا لم تطلبه، فغيّر كلمة المرور فورًا.`
            : reset ? 'إذا لم تطلب استعادة كلمة المرور، تجاهل هذه الرسالة.' : 'إذا لم تحاول تسجيل الدخول، فكلمة مرورك معروفة لشخص آخر: غيّرها فورًا.',
        ],
      }) });
    } catch {
      await this.challenges.releaseEmail(row._id, now);
      throw new ServiceUnavailableException({ message: 'تعذّر إرسال البريد الإلكتروني. حاول بعد قليل أو استخدم طريقة تحقق أخرى.', code: 'EMAIL_SEND_FAILED' });
    }
    return { sentTo: maskEmail(to), resendIn: r.waitSec, expiresInMin: Math.round(EMAIL_CODE_TTL_MS / 60000) };
  }

  // ─── Approval from a trusted device ─────────────────────────────────────

  async requestApproval(token: string) {
    const row = await this.live(token, 'login');
    if (!methodAllowed(row.requirement, row.done, 'approval')) throw new BadRequestException({ message: 'لا يوجد جهاز موثوق لهذا الحساب.', code: 'METHOD_NOT_ALLOWED' });
    const approval = await this.challenges.startApproval(row);
    if (!approval) throw this.challengeError({ ok: false, reason: 'missing', row: null });
    this.presence.emitToUser(row.userId, 'auth:login-approval', { id: row.publicId });
    try {
      await this.notifications?.enqueue('security', `login-approval:${row.publicId}:${new Date(approval.requestedAt).getTime()}`, '', `login-approval:${row.publicId}`, row.userId, undefined, {
        actionKey: 'login-approval', actorName: deviceLabel(row.client), status: 'pending', expiresAt: new Date(approval.expiresAt).toISOString(),
      });
    } catch { /* push is best effort; the in-app request still works */ }
    return { number: approval.number, expiresAt: approval.expiresAt };
  }

  /** Polled by the new device. */
  async approvalStatus(token: string, trustDevice: boolean, client?: ClientContext) {
    const st = await this.challenges.get(token, 'login');
    const row = st.row;
    if (row?.approval?.status === 'denied') return { status: 'denied' };
    if (!st.ok || !row) throw this.challengeError(st);
    const a = row.approval;
    if (!a) return { status: 'none' };
    if (a.status === 'pending') {
      if (new Date(a.expiresAt).getTime() <= Date.now()) return { status: 'expired' };
      return { status: 'pending', expiresAt: a.expiresAt, number: a.number };
    }
    const after = await this.challenges.markDone(row._id, 'approval');
    if (!after) throw this.challengeError({ ok: false, reason: 'used', row });
    const res = await this.advance(after, 'approval', trustDevice, client);
    return { status: 'approved', ...res };
  }

  /** Requests waiting on this account — shown on its trusted devices. Never includes the number. */
  async pendingApprovals(actor: Actor, deviceToken: string) {
    const device = await this.devices.findValid(actor.id, deviceToken);
    if (!device) return { trusted: false, requests: [] };
    const rows = await this.challenges.pendingApprovals(actor.id);
    return {
      trusted: true,
      requests: rows.map((r) => ({
        id: r.publicId, device: deviceLabel(r.client), browser: r.client.browser || '', os: r.client.os || '',
        ip: r.client.ipAddress || '', requestedAt: r.approval!.requestedAt, expiresAt: r.approval!.expiresAt, choices: r.approval!.choices,
      })),
    };
  }

  async decideApproval(actor: Actor, publicId: string, decision: 'approve' | 'deny', number: string, deviceToken: string) {
    if (!['approve', 'deny'].includes(decision)) throw new BadRequestException('قرار غير معروف');
    const device = await this.devices.findValid(actor.id, deviceToken);
    if (!device) throw new ForbiddenException({ message: 'لا يمكن الموافقة على تسجيل الدخول إلا من جهاز موثوق.', code: 'NOT_TRUSTED_DEVICE' });
    const row = await this.challenges.findByPublicId(publicId);
    if (!row || row.userId !== actor.id || row.approval?.status !== 'pending') throw new NotFoundException('انتهت صلاحية طلب تسجيل الدخول.');
    const by = { sid: actor.sid, deviceId: device._id, label: device.label };
    const wrongNumber = decision === 'approve' && !safeEqual(normalizeDigits(number), row.approval.number);
    const res = await this.challenges.decideApproval(publicId, actor.id, wrongNumber ? 'deny' : decision, by);
    if (!res) throw new BadRequestException('انتهت صلاحية طلب تسجيل الدخول.');
    this.presence.emitToUser(actor.id, 'auth:login-approval-done', { id: publicId });
    if (wrongNumber || decision === 'deny') {
      this.audit.log({
        userId: row.userId, username: row.username, violationType: 'login_approval_denied' as any,
        action: wrongNumber ? 'رُفض طلب دخول من جهاز جديد (رقم غير مطابق)' : 'رُفض طلب دخول من جهاز جديد',
        detail: `${deviceLabel(row.client)} — رفضه: ${device.label}`, ipAddress: row.client.ipAddress, client: row.client,
      }).catch(() => undefined);
    }
    if (wrongNumber) throw new BadRequestException({ message: 'الرقم الذي اخترته لا يطابق الرقم الظاهر على الجهاز الآخر، لذلك تم رفض الطلب.', code: 'NUMBER_MISMATCH' });
    return { success: true, status: decision === 'approve' ? 'approved' : 'denied' };
  }

  // ─── Password-guessing protection: owner unlock, alerts (login-guard) ─────

  /**
   * «فتح القفل برمز التحقق»: the owner of a locked source proves who they are with a second
   * factor (Google, a code to the security email, or a backup code) and the lock on THIS IP ends.
   * The password is still needed afterwards.
   */
  async unlockStart(username: string, client: ClientContext | undefined, ip: string) {
    const refuse = 'لا تتوفر وسيلة لفك القفل من هنا. انتظر انتهاء المدة أو تواصل مع مدير النظام.';
    const user: any = username ? await this.users.findByUsername(String(username).trim()) : null;
    if (!user || user.isActive === false) throw new BadRequestException({ message: refuse, code: 'UNLOCK_UNAVAILABLE' });
    const totp = !!user.totpEnabled && !!user.totpSecret;
    const email = !!this.emailOf(user) && this.mailer.configured();
    const backup = totp && this.totp.backupCodesLeft(user) > 0;
    const any: VerifyMethod[] = [];
    if (totp) any.push('totp');
    if (email) any.push('email');
    if (backup) any.push('backup');
    if (!any.length) throw new BadRequestException({ message: refuse, code: 'UNLOCK_UNAVAILABLE' });
    const { token } = await this.challenges.create({ user, purpose: 'unlock', requirement: [any], client: { ...(client || {} as ClientContext), ipAddress: ip } });
    return {
      challenge: token,
      requirement: [any],
      methods: { totp, email: email ? maskEmail(this.emailOf(user)) : null, backup, approval: false },
      account: { name: user.name || '', username: user.username },
      maxAttempts: CHALLENGE_MAX_ATTEMPTS,
    };
  }

  /** Keeps the user's `loginBlock` (admin panel) in step with the active blocked sources. */
  async syncLoginBlock(userId: string, username: string) {
    if (!Types.ObjectId.isValid(userId)) return;
    try {
      const rows = await this.guard.activeForUser(userKeyOf(username));
      const hard = rows.find((r) => r.hard);
      const latest = rows.filter((r) => r.until).sort((a, b) => new Date(b.until as Date).getTime() - new Date(a.until as Date).getTime())[0];
      const pick = hard || latest;
      await this.settingsModel.db.collection('users').updateOne(
        { _id: new Types.ObjectId(userId) },
        { $set: { loginBlock: pick ? { hard: !!pick.hard, until: pick.until || null, ip: pick.ip, device: pick.device, at: new Date() } : null } },
      );
    } catch { /* display only */ }
  }

  /**
   * A source was locked (5 wrong passwords) or blocked (10 in a day) on a real account: the owner
   * is asked «هل هذا أنت؟» (in-app + push), and the owner and every admin with a verified email are
   * emailed. One alert per source and day.
   */
  async loginAttackAlert(user: any, info: { ip: string; client?: ClientContext; sourceId: string; userKey: string; hard: boolean; minutes: number }) {
    const userId = String(user._id);
    await this.syncLoginBlock(userId, user.username);
    const where = `${deviceLabel(info.client)} · IP ${info.ip || 'غير معروف'}`;
    const what = info.hard ? 'حُظرت المحاولات من هذا المصدر حتى يُلغى الحظر' : `أُوقفت المحاولات من هذا المصدر ${info.minutes} دقيقة`;
    this.audit.log({
      userId, username: user.username, violationType: 'login_source_locked' as any,
      action: `${what} بعد كلمات مرور خاطئة متكررة`, detail: where, ipAddress: info.ip, client: info.client,
    }).catch(() => undefined);
    const alert = await this.guard.createAlert({ userId, userKey: info.userKey, sourceId: info.sourceId, ip: info.ip, device: deviceLabel(info.client), kind: info.hard ? 'blocked' : 'locked' });
    if (!alert.created) return;
    this.presence.emitToUser(userId, 'auth:login-alert', { id: alert.id });
    try {
      await this.notifications?.enqueue('security', `login-alert:${alert.id}`, '', `login-alert:${alert.id}`, userId, undefined, {
        actionKey: 'login-alert', actorName: deviceLabel(info.client), status: 'pending',
      });
    } catch { /* best effort */ }
    const text = `محاولات دخول فاشلة متكررة على حسابك من ${where}. ${what}. حسابك لم يُقفل، ويمكنك الدخول من أجهزتك الموثوقة. إذا لم تكن أنت، غيّر كلمة المرور.`;
    try {
      await this.mentions.createMany([{ targetUserId: userId, targetUsername: user.username, targetName: user.name, fromUserId: 'system', fromName: 'نظام الأمان', txId: 'security', commentId: 0, commentText: text, read: false } as any]);
    } catch { /* best effort */ }
    const when = cairo(new Date());
    const body = (forOwner: boolean) => securityMailBody({
      title: forOwner ? 'محاولات دخول فاشلة على حسابك' : `محاولات دخول فاشلة على حساب ${user.username}`,
      lines: [
        `الحساب: ${user.username}`,
        `المصدر: ${where}`,
        `الوقت: ${when}`,
        `الإجراء: ${what}.`,
        forOwner ? 'حسابك لم يُقفل، ويمكنك الدخول من أجهزتك الموثوقة. إذا لم تكن أنت، غيّر كلمة المرور من «نسيت كلمة المرور».' : 'الحساب نفسه لم يُقفل. يمكن إلغاء الحظر من صفحة المستخدمين ← الحسابات المعطّلة والموقوفة.',
      ],
    });
    const owner = this.emailOf(user);
    if (owner) this.mailer.sendQuietly({ to: owner, subject: 'SOULIA — محاولات دخول فاشلة على حسابك', ...body(true) });
    try {
      const admins: any[] = await this.users.findAdmins();
      const sent = new Set(owner ? [owner] : []);
      for (const a of admins) {
        const to = this.emailOf(a);
        if (!to || sent.has(to)) continue;
        sent.add(to);
        this.mailer.sendQuietly({ to, subject: `SOULIA — محاولات دخول فاشلة على حساب ${user.username}`, ...body(false) });
      }
    } catch { /* best effort */ }
  }

  async pendingLoginAlerts(actor: Actor) {
    return { alerts: await this.guard.pendingAlerts(actor.id) };
  }

  /** «هذا أنا» lifts that source's lock; «لست أنا» blocks it and puts the account under attack for a day. */
  async decideLoginAlert(actor: Actor, id: string, decision: string) {
    if (decision !== 'me' && decision !== 'not-me') throw new BadRequestException('قرار غير معروف.');
    const row: any = await this.guard.decideAlert(actor.id, String(id || ''), decision);
    if (!row) throw new NotFoundException('التنبيه غير موجود أو سبق الرد عليه.');
    if (decision === 'me') await this.guard.clearSource(row.userKey, row.sourceId, row.ip);
    else await this.guard.markNotMe(row.userKey, row.sourceId);
    await this.syncLoginBlock(actor.id, row.userKey);
    this.audit.log({
      userId: actor.id, username: actor.name, violationType: decision === 'me' ? 'account_unlocked' : ('login_attack' as any),
      action: decision === 'me' ? `أكّد صاحب الحساب أن محاولات الدخول من ${row.ip} كانت منه` : `أفاد صاحب الحساب أن محاولات الدخول من ${row.ip} ليست منه — حُظر المصدر وطُلب التحقق من جميع الأجهزة 24 ساعة`,
      ipAddress: row.ip,
    }).catch(() => undefined);
    return { success: true, decision };
  }

  async loginAttempts(actor: Actor, q: { q?: string; username?: string; ip?: string; result?: string; page?: number; limit?: number }) {
    if (actor.role !== 'admin') throw new ForbiddenException('للمدير فقط');
    return this.guard.listAttempts(q);
  }

  // ─── Forced Google Authenticator setup inside a challenge ───────────────

  async setupInit(token: string) {
    const row = await this.live(token, 'login');
    if (!row.setupRequired) throw new BadRequestException('لا يلزم إعداد في هذه المحاولة');
    return this.totp.generateSetup(row.userId);
  }

  async setupConfirm(token: string, code: string, trustDevice: boolean, client?: ClientContext) {
    const row = await this.live(token, 'login');
    if (!row.setupRequired) throw new BadRequestException('لا يلزم إعداد في هذه المحاولة');
    let backupCodes: string[];
    try {
      ({ backupCodes } = await this.totp.confirmSetup(row.userId, code));
    } catch (e) {
      const left = await this.challenges.fail(row._id);
      if (left <= 0) throw new UnauthorizedException({ message: 'تم إيقاف محاولة تسجيل الدخول. سجّل الدخول مرة أخرى.', code: 'CHALLENGE_LOCKED' });
      throw e;
    }
    await this.challenges.setSetupDone(row._id);
    this.audit.log({ userId: row.userId, username: row.username, violationType: 'two_factor_changed' as any, action: 'تفعيل Google Authenticator أثناء تسجيل الدخول', ipAddress: row.client.ipAddress, client: row.client }).catch(() => undefined);
    const after = await this.challenges.markDone(row._id, 'totp');
    if (!after) throw this.challengeError({ ok: false, reason: 'locked', row });
    const res = await this.advance(after, 'totp', trustDevice, client);
    return { ...res, backupCodes };
  }

  // ─── Forgot password (admin accounts) ───────────────────────────────────

  async forgotStart(username: string, client?: ClientContext) {
    const name = String(username || '').trim();
    const user = name ? await this.users.findByUsername(name) : null;
    const refuse = 'لا يمكن إعادة تعيين كلمة المرور لهذا الحساب من هنا. تواصل مع مدير النظام.';
    if (!user || user.role !== 'admin' || user.isActive === false) throw new BadRequestException(refuse);
    const totp = !!user.totpEnabled && !!user.totpSecret;
    const email = !!this.emailOf(user) && this.mailer.configured();
    const backup = totp && this.totp.backupCodesLeft(user) > 0;
    const requirement = resetRequirement({ totp, email, backup });
    if (!requirement) throw new BadRequestException('لا توجد وسيلة تحقق مفعّلة لهذا الحساب. تواصل مع مدير آخر لتعيين كلمة مرور جديدة.');
    const { token } = await this.challenges.create({ user, purpose: 'reset', requirement, client });
    return {
      challenge: token,
      requirement,
      methods: { totp, email: email ? maskEmail(this.emailOf(user)) : null, backup, approval: false },
      account: { name: user.name || '', username: user.username },
      maxAttempts: CHALLENGE_MAX_ATTEMPTS,
    };
  }

  async resetPassword(token: string, newPassword: string, client?: ClientContext) {
    const row = await this.live(token, 'reset');
    if (!row.resetReadyAt) throw new BadRequestException({ message: 'أكمل خطوات التحقق أولًا.', code: 'VERIFY_FIRST' });
    const problem = passwordProblem(newPassword);
    if (problem) throw new BadRequestException(problem);
    // Must differ from the last 5 passwords (users.service passwordReused / setPassword).
    if (await this.users.passwordReused(row.userId, newPassword)) {
      throw new BadRequestException({ message: 'لا يمكن استخدام كلمة مرور من آخر 5 كلمات مرور استُخدمت لهذا الحساب.', code: 'PASSWORD_REUSED' });
    }
    if (!(await this.challenges.complete(row._id))) throw this.challengeError({ ok: false, reason: 'used', row });
    await this.users.setPassword(row.userId, newPassword);
    await this.users.resetLoginAttempts(row.userId);
    await this.users.setPasswordChangedAt(row.userId);
    const by = { id: row.userId, name: row.name || row.username };
    // Everything that was signed in with the old password ends.
    try { await this.sessions?.endAllForUser(row.userId, by, {}); } catch { /* sessions optional */ }
    this.presence.disconnectSessions((u) => u.userId === row.userId, 'تم تغيير كلمة المرور — سجّل الدخول من جديد');
    await this.devices.revokeAll(row.userId, by, 'password-reset');
    await this.challenges.closeAll(row.userId);
    this.audit.log({ userId: row.userId, username: row.username, violationType: 'password_reset' as any, action: 'تمت استعادة كلمة المرور وإنهاء كل الجلسات والأجهزة الموثوقة', detail: deviceLabel(row.client), ipAddress: client?.ipAddress || row.client.ipAddress, client: client || row.client }).catch(() => undefined);
    const user = await this.users.findById(row.userId);
    const to = this.emailOf(user);
    if (to) this.mailer.sendQuietly({ to, subject: 'SOULIA — تم تغيير كلمة المرور', ...securityMailBody({
      title: 'تم تغيير كلمة مرور حسابك',
      lines: [`الحساب: ${row.username}`, `الجهاز: ${deviceLabel(client || row.client)} · IP ${(client || row.client).ipAddress || 'غير معروف'}`, `الوقت: ${cairo(new Date())}`, 'أُنهيت كل الجلسات المفتوحة وأُلغيت الأجهزة الموثوقة.', 'إذا لم تكن أنت، تواصل مع مدير النظام فورًا.'],
    }) });
    return { success: true };
  }

  // ─── Confirm it is you before a sensitive change («تأكيد الهوية») ─────────

  /** Starts a confirmation for one sensitive setting. Admin accounts only. */
  async stepUpStart(actor: Actor, action: string, client?: ClientContext) {
    if (actor.role !== 'admin') throw new ForbiddenException('هذا الإجراء متاح لحسابات المديرين فقط.');
    if (!STEP_UP_ACTIONS.includes(action as StepUpAction)) throw new BadRequestException('إجراء غير معروف.');
    const user: any = await this.users.findById(actor.id);
    if (!user) throw new UnauthorizedException('الحساب غير موجود.');
    const email = !!this.emailOf(user) && this.mailer.configured();
    // Turning Google Authenticator off is confirmed by the OTHER factor — a code to the security email.
    // Changing the security email is confirmed by a code sent to the OLD address first (owner, Nov 27).
    const oldEmailFirst = action === 'security-email' && !!this.emailOf(user);
    const totp = action === 'totp-disable' || oldEmailFirst ? false : !!user.totpEnabled && !!user.totpSecret;
    const requirement = stepUpRequirement({ totp, email });
    if (!requirement) {
      throw new BadRequestException({
        message: 'لا توجد وسيلة تحقق مفعّلة لحسابك. فعّل Google Authenticator أو أضف بريد تحقق أولًا.',
        code: 'STEP_UP_UNAVAILABLE',
      });
    }
    const { token } = await this.challenges.create({ user, purpose: 'stepup', action, requirement, client });
    return {
      challenge: token,
      action,
      requirement,
      methods: { totp, email: email ? maskEmail(this.emailOf(user)) : null, approval: false, backup: false },
      account: { name: user.name || '', username: user.username },
      maxAttempts: CHALLENGE_MAX_ATTEMPTS,
    };
  }

  /** Does the account have a factor a step-up could use? */
  private async hasStepUpFactor(user: any): Promise<boolean> {
    return (!!user?.totpEnabled && !!user?.totpSecret) || (!!this.emailOf(user) && this.mailer.configured());
  }

  /**
   * Spends a finished confirmation. ⚠ It must belong to this account, name this exact setting, and
   * is single use — a confirmation for the email cannot change the PIN, and none can be replayed.
   */
  /** For other services (password-policy.service.ts): spends a finished confirmation for `action`. */
  async spendStepUp(token: string, actor: Actor, action: StepUpAction): Promise<void> {
    return this.consumeStepUp(token, actor, action);
  }

  private async consumeStepUp(token: string, actor: Actor, action: StepUpAction): Promise<void> {
    const required = new ForbiddenException({ message: 'أكّد هويتك أولًا برمز التحقق.', code: 'STEP_UP_REQUIRED' });
    if (!token) throw required;
    const st = await this.challenges.get(token, 'stepup');
    const row = st.row;
    if (!st.ok || !row || row.userId !== actor.id || row.action !== action || !row.resetReadyAt) throw required;
    if (!(await this.challenges.complete(row._id))) throw required;
  }

  // Wrong current-PIN attempts when changing the system PIN: 5 per account → a 15-minute pause.
  private readonly pinChecks = new Map<string, { fails: number; until: number }>();

  /**
   * Step 1 of «تغيير الرقم السري»: the CURRENT PIN (Nov 27, 2026). A stored PIN that is not 4 digits
   * (an old one) cannot be typed, so it is not asked for. ⚠ Answers 401 WITH a code: api() then keeps the
   * session (a bare 401 signs the page out).
   */
  async checkCurrentPin(actor: Actor, currentPin: string, client?: ClientContext): Promise<{ ok: true; required: boolean }> {
    if (actor.role !== 'admin') throw new ForbiddenException('هذا الإجراء متاح لحسابات المديرين فقط.');
    const settings: any = await this.settingsModel.findOne().lean();
    const stored = String(settings?.vaultPass ?? '');
    if (!/^\d{4}$/.test(stored)) return { ok: true, required: false };
    const now = Date.now();
    const st = this.pinChecks.get(actor.id) || { fails: 0, until: 0 };
    if (st.until > now) {
      throw new HttpException({ message: `تم إيقاف المحاولة مؤقتًا بعد عدة محاولات خاطئة. حاول بعد ${Math.ceil((st.until - now) / 60000)} دقيقة.`, code: 'CURRENT_PIN_PAUSED' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (normalizeDigits(currentPin) === stored) { this.pinChecks.delete(actor.id); return { ok: true, required: true }; }
    st.fails += 1;
    if (st.fails >= 5) { st.fails = 0; st.until = now + 15 * 60_000; }
    this.pinChecks.set(actor.id, st);
    this.audit.log({ userId: actor.id, username: actor.name, violationType: 'vault_violation', action: 'رقم سري حالي خاطئ عند محاولة تغيير الرقم السري للنظام', ipAddress: client?.ipAddress, client }).catch(() => undefined);
    throw new UnauthorizedException({
      message: st.until > now ? 'الرقم السري الحالي غير صحيح. تم إيقاف المحاولة مؤقتًا لمدة 15 دقيقة.' : `الرقم السري الحالي غير صحيح. تبقّى ${5 - st.fails} محاولات.`,
      code: 'CURRENT_PIN_WRONG',
    });
  }

  /** «الرقم السري للنظام» — 4 digits, changed only with the current PIN and a confirmation code. */
  async changeSystemPin(actor: Actor, newPin: string, stepUp: string, client?: ClientContext, currentPin = '') {
    if (actor.role !== 'admin') throw new ForbiddenException('هذا الإجراء متاح لحسابات المديرين فقط.');
    const pin = normalizeDigits(newPin);
    if (!/^\d{4}$/.test(pin) || String(newPin || '').trim().length !== 4) {
      throw new BadRequestException('يجب أن يتكون الرقم السري من 4 أرقام.');
    }
    // ⚠ Checked again here: step 1 of the dialog must not be skippable by calling this route directly.
    await this.checkCurrentPin(actor, currentPin, client);
    await this.consumeStepUp(stepUp, actor, 'system-pin');
    await this.settingsModel.updateOne({}, { $set: { vaultPass: pin } });
    this.audit.log({
      userId: actor.id, username: actor.name, violationType: 'system_pin_changed' as any,
      action: `تغيير الرقم السري للنظام بواسطة ${actor.name}`, ipAddress: client?.ipAddress, client,
    }).catch(() => undefined);
    // Every admin is told (in-app, and by email where an address is verified).
    try {
      const admins: any[] = await this.users.findAdmins();
      const when = cairo(new Date());
      const text = `تم تغيير الرقم السري للنظام بواسطة ${actor.name} (${when}). إذا لم يكن هذا التغيير متوقعًا، فراجع سجل الأمان.`;
      await this.mentions.createMany(admins.map((a) => ({ targetUserId: String(a._id), targetUsername: a.username, targetName: a.name, fromUserId: 'system', fromName: 'نظام الأمان', txId: 'security', commentId: 0, commentText: text, read: false } as any)));
      for (const a of admins) {
        const to = this.emailOf(a);
        if (to) this.mailer.sendQuietly({ to, subject: 'SOULIA — تم تغيير الرقم السري للنظام', ...securityMailBody({
          title: 'تم تغيير الرقم السري للنظام',
          lines: [`بواسطة: ${actor.name}`, `الجهاز: ${deviceLabel(client)} · IP ${client?.ipAddress || 'غير معروف'}`, `الوقت: ${when}`, 'إذا لم يكن هذا التغيير متوقعًا، فراجع سجل الأمان فورًا.'],
        }) });
      }
    } catch { /* the change is saved; notices are best effort */ }
    return { success: true };
  }

  // ─── Security email (admin only) ────────────────────────────────────────

  private async requireOwnPassword(actor: Actor, password: string) {
    const user = await this.users.findById(actor.id);
    if (!user) throw new UnauthorizedException('الحساب غير موجود');
    if (!password || !(await bcrypt.compare(String(password), user.password))) {
      this.audit.log({ userId: actor.id, username: user.username, violationType: 'otp_violation', action: 'كلمة مرور خاطئة عند تغيير إعدادات الأمان' }).catch(() => undefined);
      throw new UnauthorizedException({ message: 'كلمة المرور الحالية غير صحيحة.', code: 'PASSWORD_WRONG' });
    }
    return user;
  }

  /**
   * Adding or changing the security email: the current password, then — when the account already has
   * Google Authenticator or a verified email — a confirmation code from that existing factor, then a
   * code sent to the NEW address. The new address is used only once that code is entered.
   */
  async emailRequest(actor: Actor, email: string, password: string, stepUp = '') {
    if (actor.role !== 'admin') throw new ForbiddenException('بريد التحقق متاح لحسابات المديرين فقط.');
    const user = await this.requireOwnPassword(actor, password);
    const next = normalizeEmail(email);
    if (!isValidEmail(next)) throw new BadRequestException('عنوان البريد الإلكتروني غير صحيح.');
    if (next === this.emailOf(user)) throw new BadRequestException('هذا هو بريد التحقق الحالي.');
    if (!this.mailer.configured()) throw new ServiceUnavailableException({ message: 'إرسال البريد الإلكتروني غير متاح حاليًا.', code: 'SMTP_NOT_CONFIGURED' });
    const pending: any = (user as any).securityEmailPending;
    if (pending?.sentAt && Date.now() - new Date(pending.sentAt).getTime() < 60_000) {
      throw new HttpException({ message: 'يمكنك طلب رمز جديد بعد دقيقة.', code: 'EMAIL_RATE_LIMITED' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (await this.hasStepUpFactor(user)) await this.consumeStepUp(stepUp, actor, 'security-email');
    const code = randomCode6();
    const now = new Date();
    await this.users.setSecurityEmailPending(actor.id, {
      email: next, codeHash: codeHash(CODE_SECRET(), 'email:' + actor.id, code + ':' + next),
      expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS), attempts: 0, sentAt: now,
    });
    try {
      await this.mailer.send({ to: next, subject: `SOULIA — رمز تأكيد بريد التحقق: ${code}`, ...securityMailBody({
        title: 'تأكيد بريد التحقق لحسابك',
        code,
        lines: [`الحساب: ${user.username}`, 'أدخل هذا الرمز في الإعدادات ← الأمان لتأكيد أن هذا البريد لك.', 'بعد التأكيد تصلك عليه رموز تسجيل الدخول من الأجهزة الجديدة ورموز استعادة كلمة المرور.', 'إذا لم تطلب ذلك، تجاهل هذه الرسالة.'],
      }) });
    } catch {
      await this.users.setSecurityEmailPending(actor.id, null);
      throw new ServiceUnavailableException({ message: 'تعذّر إرسال البريد الإلكتروني. تأكد من العنوان أو حاول بعد قليل.', code: 'EMAIL_SEND_FAILED' });
    }
    return { sentTo: next, expiresInMin: Math.round(EMAIL_CODE_TTL_MS / 60000) };
  }

  async emailConfirm(actor: Actor, code: string) {
    if (actor.role !== 'admin') throw new ForbiddenException('بريد التحقق متاح لحسابات المديرين فقط');
    const user: any = await this.users.findById(actor.id);
    const pending = user?.securityEmailPending;
    if (!pending?.email) throw new BadRequestException('لا يوجد بريد بانتظار التأكيد');
    if (new Date(pending.expiresAt).getTime() <= Date.now()) {
      await this.users.setSecurityEmailPending(actor.id, null);
      throw new BadRequestException('انتهت صلاحية الرمز — اطلب رمزًا جديدًا');
    }
    const digits = normalizeDigits(code);
    const expected = codeHash(CODE_SECRET(), 'email:' + actor.id, digits + ':' + pending.email);
    if (digits.length !== 6 || !safeEqual(expected, pending.codeHash)) {
      const attempts = await this.users.bumpSecurityEmailAttempts(actor.id);
      if (attempts >= CHALLENGE_MAX_ATTEMPTS) {
        await this.users.setSecurityEmailPending(actor.id, null);
        throw new BadRequestException('أُلغي الطلب بعد 5 رموز خاطئة — اطلب رمزًا جديدًا');
      }
      throw new BadRequestException(`الرمز غير صحيح — تبقى ${CHALLENGE_MAX_ATTEMPTS - attempts}`);
    }
    const previous = this.emailOf(user);
    const ok = await this.users.confirmSecurityEmail(actor.id, pending.email, pending.codeHash);
    if (!ok) throw new BadRequestException('تغيّر الطلب أثناء التأكيد — أعد المحاولة');
    this.audit.log({ userId: actor.id, username: user.username, violationType: 'two_factor_changed' as any, action: previous ? 'تغيير بريد التحقق' : 'إضافة بريد التحقق', detail: maskEmail(pending.email) }).catch(() => undefined);
    if (previous && previous !== pending.email) {
      this.mailer.sendQuietly({ to: previous, subject: 'SOULIA — تغيّر بريد التحقق لحسابك', ...securityMailBody({
        title: 'تغيّر بريد التحقق لحسابك',
        lines: [`الحساب: ${user.username}`, `البريد الجديد: ${maskEmail(pending.email)}`, `الوقت: ${cairo(new Date())}`, 'لن تصل رموز التحقق إلى هذا العنوان بعد الآن. إذا لم تكن أنت، تواصل مع مدير النظام فورًا.'],
      }) });
    }
    return { success: true, securityEmail: pending.email };
  }

  async emailRemove(actor: Actor, password: string, stepUp = '') {
    if (actor.role !== 'admin') throw new ForbiddenException('بريد التحقق متاح لحسابات المديرين فقط.');
    const user: any = await this.requireOwnPassword(actor, password);
    const previous = this.emailOf(user);
    if (await this.hasStepUpFactor(user)) await this.consumeStepUp(stepUp, actor, 'security-email');
    await this.users.clearSecurityEmail(actor.id);
    this.audit.log({ userId: actor.id, username: user.username, violationType: 'two_factor_changed' as any, action: 'حذف بريد التحقق' }).catch(() => undefined);
    if (previous) this.mailer.sendQuietly({ to: previous, subject: 'SOULIA — حُذف بريد التحقق من حسابك', ...securityMailBody({
      title: 'حُذف بريد التحقق من حسابك', lines: [`الحساب: ${user.username}`, `الوقت: ${cairo(new Date())}`, 'إذا لم تكن أنت، تواصل مع مدير النظام فورًا.'],
    }) });
    return { success: true };
  }

  // ─── Google Authenticator (signed in) ───────────────────────────────────

  async totpConfirm(actor: Actor, code: string) {
    const { backupCodes } = await this.totp.confirmSetup(actor.id, code);
    this.audit.log({ userId: actor.id, username: actor.name, violationType: 'two_factor_changed' as any, action: 'تفعيل Google Authenticator' }).catch(() => undefined);
    return { success: true, backupCodes };
  }

  /**
   * Turning Google Authenticator off: the current password, and — when a security email is verified —
   * a code sent to that email (step-up 'totp-disable', Nov 27, 2026).
   */
  async totpDisable(actor: Actor, password: string, deviceToken: string, stepUp = '') {
    const user: any = await this.requireOwnPassword(actor, password);
    if (this.emailOf(user) && this.mailer.configured()) await this.consumeStepUp(stepUp, actor, 'totp-disable');
    await this.totp.disableTotp(actor.id);
    // A security downgrade: other trusted devices must verify again.
    const current = deviceToken ? await this.devices.findValid(actor.id, deviceToken) : null;
    await this.devices.revokeAll(actor.id, { id: actor.id, name: actor.name }, 'totp-disabled', current?._id);
    this.audit.log({ userId: actor.id, username: user.username, violationType: 'two_factor_changed' as any, action: 'تعطيل Google Authenticator' }).catch(() => undefined);
    const to = this.emailOf(user);
    if (to) this.mailer.sendQuietly({ to, subject: 'SOULIA — عُطّل Google Authenticator على حسابك', ...securityMailBody({ title: 'عُطّل Google Authenticator على حسابك', lines: [`الحساب: ${user.username}`, `الوقت: ${cairo(new Date())}`, 'إذا لم تكن أنت، غيّر كلمة المرور فورًا.'] }) });
    return { success: true };
  }

  async regenerateBackupCodes(actor: Actor, code: string) {
    if (!(await this.totp.verifyAndSpend(actor.id, code))) throw new UnauthorizedException({ message: 'رمز Google Authenticator غير صحيح', code: 'CODE_WRONG' });
    const backupCodes = await this.totp.regenerateBackupCodes(actor.id);
    this.audit.log({ userId: actor.id, username: actor.name, violationType: 'two_factor_changed' as any, action: 'إنشاء رموز احتياطية جديدة' }).catch(() => undefined);
    return { backupCodes };
  }

  // ─── Overview + trusted devices ─────────────────────────────────────────

  async securityOverview(actor: Actor, deviceToken: string) {
    const user: any = await this.users.findById(actor.id);
    if (!user) throw new UnauthorizedException('الحساب غير موجود');
    const current = deviceToken ? await this.devices.findValid(actor.id, deviceToken) : null;
    return {
      role: user.role,
      totpEnabled: !!user.totpEnabled,
      totpEnabledAt: user.totpEnabledAt || null,
      backupCodesLeft: this.totp.backupCodesLeft(user),
      securityEmail: user.role === 'admin' ? (user.securityEmail || '') : '',
      securityEmailVerifiedAt: user.securityEmailVerifiedAt || null,
      emailPending: user.securityEmailPending?.email && new Date(user.securityEmailPending.expiresAt).getTime() > Date.now() ? user.securityEmailPending.email : '',
      mailConfigured: this.mailer.configured(),
      global2fa: await this.totp.getGlobal2faStatus(),
      verificationRequired: needsSecondStep(user, await this.totp.getGlobal2faStatus()),
      trustDays: TRUST_DAYS,
      currentDeviceId: current?._id || null,
      devices: await this.devices.list(actor.id),
    };
  }

  async listDevices(actor: Actor, userId?: string) {
    const target = actor.role === 'admin' && userId ? userId : actor.id;
    return { userId: target, devices: await this.devices.list(target) };
  }

  async revokeDevice(actor: Actor, id: string, userId?: string) {
    const target = actor.role === 'admin' && userId ? userId : actor.id;
    const ok = await this.devices.revoke(id, target, { id: actor.id, name: actor.name });
    if (!ok) throw new NotFoundException('الجهاز غير موجود');
    return { success: true };
  }

  async revokeAllDevices(actor: Actor, userId: string | undefined, deviceToken: string) {
    const target = actor.role === 'admin' && userId ? userId : actor.id;
    const keep = target === actor.id && deviceToken ? await this.devices.findValid(actor.id, deviceToken) : null;
    const n = await this.devices.revokeAll(target, { id: actor.id, name: actor.name }, 'revoked-all', keep?._id);
    return { success: true, revoked: n };
  }

  /**
   * Another admin resets an account's 2FA (lost phone and email): Google Authenticator off,
   * backup codes and trusted devices gone, security email kept. Needs the system PIN. The account
   * sets up Google Authenticator again on its next sign-in when it has no other method.
   */
  async adminReset2fa(actor: Actor, userId: string, pin: string) {
    if (actor.role !== 'admin') throw new ForbiddenException('للمدير فقط');
    if (String(userId) === actor.id) throw new BadRequestException('لا يمكنك إعادة ضبط التحقق لحسابك من هنا');
    const settings: any = await this.settingsModel.findOne().lean();
    if (!settings?.vaultPass || !safeEqual(String(pin || ''), String(settings.vaultPass))) {
      throw new UnauthorizedException({ message: 'الرقم السري للنظام غير صحيح', code: 'PIN_WRONG' });
    }
    const target: any = await this.users.findById(userId);
    if (!target) throw new NotFoundException('المستخدم غير موجود');
    await this.totp.disableTotp(userId);
    await this.devices.revokeAll(userId, { id: actor.id, name: actor.name }, 'admin-reset-2fa');
    await this.challenges.closeAll(userId);
    this.audit.log({ userId, username: target.username, violationType: 'two_factor_changed' as any, action: `إعادة ضبط التحقق بخطوتين بواسطة ${actor.name}` }).catch(() => undefined);
    return { success: true };
  }
}
