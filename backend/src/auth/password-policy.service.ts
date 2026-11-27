import {
  BadRequestException, ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException,
  Optional, UnauthorizedException, forwardRef,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { MentionsService } from '../mentions/mentions.service';
import { SecurityAuditService } from '../security-audit/security-audit.service';
import type { ClientContext } from '../shared/client-context.util';
import { AuthChallengeService } from './auth-challenge.service';
import { TrustedDevicesService } from './trusted-devices.service';
import { SecurityMailerService, securityMailBody } from './security-mailer.service';
import { PresenceGateway } from './presence.gateway';
import { UserSessionsService } from './user-sessions.service';
import { SignInVerificationService } from './sign-in-verification.service';
import { deviceLabel, generateStrongPassword, normalizeEmail, passwordProblem } from './auth-security.util';

type Actor = { id: string; name: string; role: string; sid: string };

/** The owner account («المدير الرئيسي») — the same rule the users page uses. */
const OWNER_USERNAME = 'admin';
const CHECK_LIMIT = 5;
const CHECK_PAUSE_MS = 15 * 60_000;
const STAFF_REQUEST_GAP_MS = 30 * 60_000;

const cairo = (d: Date) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  timeZone: 'Africa/Cairo', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(d);

/**
 * Password policy (owner's rules, Nov 27, 2026).
 * - Admins change their OWN password: current password → new password twice (8+, not one of the
 *   last 5) → a code (Google Authenticator or the security email). Staff never change their own.
 * - Staff passwords are set only by an admin allowed to (the owner, or an admin the owner allowed),
 *   after a code; a generated one (14 characters) is returned ONCE and never stored in clear.
 * - A staff member who forgot their password sends a request from the sign-in page; admins are told.
 * - After any change: every session and trusted device of that account ends, the audit log records
 *   who / whom / when / device / IP, and an admin account gets an alert email.
 */
@Injectable()
export class PasswordPolicyService {
  private readonly checks = new Map<string, { fails: number; until: number }>();

  constructor(
    private readonly users: UsersService,
    private readonly verification: SignInVerificationService,
    private readonly challenges: AuthChallengeService,
    private readonly devices: TrustedDevicesService,
    private readonly mailer: SecurityMailerService,
    private readonly presence: PresenceGateway,
    private readonly audit: SecurityAuditService,
    @Inject(forwardRef(() => MentionsService)) private readonly mentions: MentionsService,
    @Optional() private readonly sessions?: UserSessionsService,
  ) {}

  private emailOf(user: any): string {
    if (user?.role !== 'admin' || !user?.securityEmail || !user?.securityEmailVerifiedAt) return '';
    return normalizeEmail(user.securityEmail);
  }

  private isOwner(user: any): boolean {
    return String(user?.username || '') === OWNER_USERNAME;
  }

  /** May this admin reset staff passwords? The owner always; another admin only if the owner allowed it. */
  async canResetStaff(actor: Actor): Promise<boolean> {
    if (actor.role !== 'admin') return false;
    const me: any = await this.users.findById(actor.id);
    return !!me && me.isActive !== false && (this.isOwner(me) || !!me.canResetStaffPasswords);
  }

  // ─── Own password (admins) ───────────────────────────────────────────────

  /** Step 1: the current password. 5 wrong → a 15-minute pause. ⚠ Coded 401 = the page keeps the session. */
  async checkCurrent(actor: Actor, current: string, client?: ClientContext): Promise<{ ok: true }> {
    if (actor.role !== 'admin') {
      throw new ForbiddenException({ message: 'يُغيّر مدير النظام كلمات مرور الموظفين. تواصل معه إذا أردت تغيير كلمة مرورك.', code: 'STAFF_CANNOT_CHANGE' });
    }
    const now = Date.now();
    const st = this.checks.get(actor.id) || { fails: 0, until: 0 };
    if (st.until > now) {
      throw new HttpException({ message: `تم إيقاف المحاولة مؤقتًا بعد عدة محاولات خاطئة. حاول بعد ${Math.ceil((st.until - now) / 60000)} دقيقة.`, code: 'CURRENT_PASSWORD_PAUSED' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const user: any = await this.users.findById(actor.id);
    if (!user) throw new NotFoundException('الحساب غير موجود.');
    if (await bcrypt.compare(String(current || ''), String(user.password || ''))) { this.checks.delete(actor.id); return { ok: true }; }
    st.fails += 1;
    if (st.fails >= CHECK_LIMIT) { st.fails = 0; st.until = now + CHECK_PAUSE_MS; }
    this.checks.set(actor.id, st);
    this.audit.log({ userId: actor.id, username: user.username, violationType: 'failed_login', action: 'كلمة مرور حالية خاطئة عند محاولة تغيير كلمة المرور', ipAddress: client?.ipAddress, client }).catch(() => undefined);
    throw new UnauthorizedException({
      message: st.until > now ? 'كلمة المرور الحالية غير صحيحة. تم إيقاف المحاولة مؤقتًا لمدة 15 دقيقة.' : `كلمة المرور الحالية غير صحيحة. تبقّى ${CHECK_LIMIT - st.fails} محاولات.`,
      code: 'CURRENT_PASSWORD_WRONG',
    });
  }

  /** Step 2 (before asking for a code): strong enough and not one of the last 5. */
  async validateNew(userId: string, next: string): Promise<{ ok: true }> {
    const problem = passwordProblem(next);
    if (problem) throw new BadRequestException({ message: problem, code: 'PASSWORD_WEAK' });
    if (await this.users.passwordReused(userId, next)) {
      throw new BadRequestException({ message: 'لا يمكن استخدام كلمة مرور من آخر 5 كلمات مرور استُخدمت لهذا الحساب.', code: 'PASSWORD_REUSED' });
    }
    return { ok: true };
  }

  async changeOwn(actor: Actor, current: string, next: string, stepUp: string, client?: ClientContext) {
    await this.checkCurrent(actor, current, client);
    await this.validateNew(actor.id, next);
    await this.verification.spendStepUp(stepUp, actor, 'password-change');
    await this.users.setPassword(actor.id, next);
    const user: any = await this.users.findById(actor.id);
    await this.afterChange(user, actor, client, 'تغيير كلمة المرور بواسطة صاحب الحساب');
    return { success: true, signedOut: true };
  }

  // ─── Staff passwords (admins allowed to) ─────────────────────────────────

  private async staffTarget(actor: Actor, targetId: string) {
    if (!(await this.canResetStaff(actor))) {
      throw new ForbiddenException({ message: 'إعادة تعيين كلمات مرور الموظفين متاحة للمدير الرئيسي، أو لمدير منحه هذه الصلاحية.', code: 'STAFF_RESET_NOT_ALLOWED' });
    }
    const target: any = await this.users.findById(String(targetId || ''));
    if (!target) throw new NotFoundException('المستخدم غير موجود.');
    if (String(target._id) === actor.id) throw new BadRequestException('لتغيير كلمة مرورك استخدم «تغيير كلمة المرور».');
    if (target.role === 'admin') throw new ForbiddenException('كلمة مرور المدير يغيّرها صاحب الحساب نفسه أو عبر «نسيت كلمة المرور».');
    return target;
  }

  /** Before asking for the code: is this target allowed, and is a typed password acceptable? */
  async validateStaff(actor: Actor, targetId: string, password?: string) {
    const target = await this.staffTarget(actor, targetId);
    if (password) await this.validateNew(String(target._id), password);
    return { ok: true };
  }

  async resetStaff(actor: Actor, targetId: string, body: { password?: string; generate?: boolean }, stepUp: string, client?: ClientContext) {
    const target = await this.staffTarget(actor, targetId);
    const generated = !!body.generate || !body.password;
    const next = generated ? generateStrongPassword(14) : String(body.password);
    if (!generated) await this.validateNew(String(target._id), next);
    await this.verification.spendStepUp(stepUp, actor, 'staff-password');
    await this.users.setPassword(String(target._id), next);
    await this.afterChange(target, actor, client, `إعادة تعيين كلمة المرور بواسطة ${actor.name}`);
    // ⚠ The generated password is returned ONCE, in this reply only. It is never stored or logged.
    return { success: true, generated, password: generated ? next : undefined };
  }

  /** The owner allows (or stops) another admin resetting staff passwords. */
  async setResetRight(actor: Actor, targetId: string, allowed: boolean) {
    const me: any = await this.users.findById(actor.id);
    if (!this.isOwner(me)) throw new ForbiddenException('هذه الصلاحية يمنحها المدير الرئيسي فقط.');
    const target: any = await this.users.findById(String(targetId || ''));
    if (!target || target.role !== 'admin' || this.isOwner(target)) throw new BadRequestException('تُمنح هذه الصلاحية لحسابات المديرين فقط.');
    await this.users.setResetRight(String(target._id), !!allowed);
    this.audit.log({ userId: String(target._id), username: target.username, violationType: 'two_factor_changed' as any, action: `${allowed ? 'منح' : 'إيقاف'} صلاحية إعادة تعيين كلمات مرور الموظفين بواسطة ${actor.name}` }).catch(() => undefined);
    return { success: true, allowed: !!allowed };
  }

  // ─── Forgot password: staff send a request ───────────────────────────────

  /**
   * Returns null for an active admin (the admin recovery flow handles it). Anyone else gets the same
   * answer whether or not the name exists, so the sign-in page reveals no accounts.
   */
  async staffRequest(username: string, client?: ClientContext): Promise<{ requestSent: true } | null> {
    const name = String(username || '').trim();
    const user: any = name ? await this.users.findByUsername(name) : null;
    if (user && user.role === 'admin' && user.isActive !== false) return null;
    if (user && user.isActive !== false) {
      const last = user.passwordResetRequestedAt ? new Date(user.passwordResetRequestedAt).getTime() : 0;
      if (Date.now() - last > STAFF_REQUEST_GAP_MS) {
        await this.users.markPasswordResetRequested(String(user._id));
        const where = `${deviceLabel(client)} · IP ${client?.ipAddress || 'غير معروف'}`;
        this.audit.log({ userId: String(user._id), username: user.username, violationType: 'password_reset' as any, action: 'طلب إعادة تعيين كلمة المرور من صفحة تسجيل الدخول', detail: where, ipAddress: client?.ipAddress, client }).catch(() => undefined);
        try {
          const admins: any[] = (await this.users.findAdmins()).filter((a: any) => this.isOwner(a) || a.canResetStaffPasswords);
          await this.mentions.createMany(admins.map((a) => ({
            // ⚠ txId is required by the mention schema (without it the row is dropped). The page routes
            // `pw-request:<userId>` to the reset window for that employee.
            targetUserId: String(a._id), targetUsername: String(a.username || '').toLowerCase(), targetName: a.name, fromUserId: 'system', fromName: 'نظام الأمان',
            txId: 'pw-request:' + String(user._id), txRef: '', commentId: 0,
            commentText: `طلب ${user.name || user.username} (@${user.username}) إعادة تعيين كلمة المرور من صفحة تسجيل الدخول (${where} · ${cairo(new Date())}). يمكنك تعيين كلمة مرور جديدة من صفحة المستخدمين.`,
            read: false,
          } as any)));
        } catch { /* best effort */ }
      }
    }
    return { requestSent: true };
  }

  // ─── After every change ──────────────────────────────────────────────────

  private async afterChange(target: any, actor: Actor, client: ClientContext | undefined, what: string) {
    const id = String(target._id);
    const by = { id: actor.id, name: actor.name };
    try { await this.sessions?.endAllForUser(id, by, {}); } catch { /* sessions optional */ }
    this.presence.disconnectSessions((u) => u.userId === id, 'تم تغيير كلمة المرور — سجّل الدخول من جديد');
    try { await this.devices.revokeAll(id, by, 'password-change'); } catch { /* best effort */ }
    try { await this.challenges.closeAll(id); } catch { /* best effort */ }
    const where = `${deviceLabel(client)} · IP ${client?.ipAddress || 'غير معروف'}`;
    // ⚠ Never the password: only who, whom, when and from where.
    this.audit.log({
      userId: id, username: target.username, violationType: 'password_reset' as any,
      action: `${what} — أُنهيت كل الجلسات والأجهزة الموثوقة`, detail: `بواسطة: ${actor.name} · ${where}`,
      ipAddress: client?.ipAddress, client,
    }).catch(() => undefined);
    const to = this.emailOf(target);
    if (to) this.mailer.sendQuietly({ to, subject: 'SOULIA — تم تغيير كلمة المرور', ...securityMailBody({
      title: 'تم تغيير كلمة مرور حسابك',
      lines: [`الحساب: ${target.username}`, `بواسطة: ${actor.name}`, `الجهاز: ${where}`, `الوقت: ${cairo(new Date())}`, 'أُنهيت كل الجلسات المفتوحة وأُلغيت الأجهزة الموثوقة.', 'إذا لم تكن أنت، تواصل مع مدير النظام فورًا.'],
    }) });
  }
}
