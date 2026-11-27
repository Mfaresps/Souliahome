import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger,
  NotFoundException, ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { SecurityAuditService } from '../security-audit/security-audit.service';
import { MAIL_SUBJECT, SecurityMailerService, securityMailBody } from './security-mailer.service';
import { PresenceGateway } from './presence.gateway';
import { codeHash, maskEmail, normalizeDigits, randomCode6, safeEqual } from './auth-security.util';
import {
  ACCOUNT_EMAIL_CODE_TTL_MS, ACCOUNT_EMAIL_INVITE_TTL_MS, ACCOUNT_EMAIL_MAX_ATTEMPTS,
  accountEmailRequired, accountEmailScope, accountEmailSendCheck, accountEmailView, cleanAccountEmail, verifiedEmailOf,
} from './account-email.util';

type Actor = { id: string; name: string; role: string };

const CODE_SECRET = () => String(process.env.JWT_SECRET || 'soulia');
const FROM_NAME = 'SOULIA';
const FOOTER = 'SOULIA — رسالة آلية من النظام، يُرجى عدم الرد عليها.';

const cairo = (d: Date) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  timeZone: 'Africa/Cairo', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(d);

const minutesText = (ms: number) => {
  const m = Math.round(ms / 60000);
  if (m >= 120 && m % 60 === 0) return `${m / 60} ساعة`;
  return m <= 10 ? `${m} دقائق` : `${m} دقيقة`;
};

/**
 * The account email of employees (Nov 27, 2026) — rules in account-email.util.ts.
 *
 * ⚠ The only writer of `user.email`: an address is linked by `confirmAccountEmail`, i.e. after its
 * owner entered the code sent to it. An admin can REQUEST an address for an employee (the code goes
 * to that address); only the employee can confirm it.
 */
@Injectable()
export class AccountEmailService {
  private readonly logger = new Logger(AccountEmailService.name);

  constructor(
    private readonly users: UsersService,
    private readonly mailer: SecurityMailerService,
    private readonly audit: SecurityAuditService,
    private readonly presence: PresenceGateway,
  ) {}

  private async load(id: string): Promise<any> {
    const user: any = await this.users.findById(id);
    if (!user) throw new NotFoundException('الحساب غير موجود');
    return user;
  }

  private mailReady() {
    if (!this.mailer.configured()) {
      throw new ServiceUnavailableException({ message: 'إرسال البريد الإلكتروني غير متاح حاليًا. تواصل مع مدير النظام.', code: 'SMTP_NOT_CONFIGURED' });
    }
  }

  private async assertFree(email: string, userId: string) {
    if (await this.users.emailTakenBy(email, userId)) {
      throw new ConflictException({ message: 'هذا البريد الإلكتروني مرتبط بحساب آخر في النظام.', code: 'EMAIL_TAKEN' });
    }
  }

  private async rateCheck(user: any, now: Date) {
    const r = accountEmailSendCheck(user.emailCodeSends, now);
    if (!r.ok) {
      throw new HttpException({
        message: r.waitSec > 90 ? `تجاوزت عدد الرموز المسموح به. حاول بعد ${Math.ceil(r.waitSec / 60)} دقيقة.` : `يمكنك طلب رمز جديد بعد ${r.waitSec} ثانية.`,
        code: 'EMAIL_RATE_LIMITED', waitSec: r.waitSec,
      }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return r.recent;
  }

  /** Writes the pending request, sends the code; on a failed send the request is dropped. */
  private async sendCode(user: any, email: string, opts: { by: Actor | null; now: Date; recent: Date[]; keepOnFailure?: boolean }) {
    const id = String(user._id);
    const code = randomCode6();
    const ttl = opts.by ? ACCOUNT_EMAIL_INVITE_TTL_MS : ACCOUNT_EMAIL_CODE_TTL_MS;
    const requestedBy = opts.by ? { id: opts.by.id, name: opts.by.name } : null;
    const pending = {
      email,
      codeHash: codeHash(CODE_SECRET(), accountEmailScope(id), code + ':' + email),
      expiresAt: new Date(opts.now.getTime() + ttl),
      attempts: 0,
      sentAt: opts.now,
      requestedBy,
      requestedAt: opts.now,
    };
    await this.users.setAccountEmailPending(id, pending, [...opts.recent, opts.now]);
    const lines = opts.by
      ? [
        `الحساب: ${user.username}`,
        'أضاف مدير النظام هذا البريد إلى حسابك. أدخل الرمز في نافذة «تأكيد البريد الإلكتروني» بعد تسجيل الدخول.',
        `الرمز صالح لمدة ${minutesText(ttl)} ويُستخدم مرة واحدة.`,
        'إذا لم تكن تتوقع هذه الرسالة، فتجاهلها.',
      ]
      : [
        `الحساب: ${user.username}`,
        `أدخل الرمز في نافذة التأكيد. صالح لمدة ${minutesText(ttl)} ويُستخدم مرة واحدة.`,
        'إذا لم تطلب ذلك، فتجاهل هذه الرسالة.',
      ];
    try {
      await this.mailer.send({
        to: email, fromName: FROM_NAME,
        subject: MAIL_SUBJECT.emailCode,
        ...securityMailBody({ title: MAIL_SUBJECT.emailCode, code, lines, footer: FOOTER }),
      });
    } catch {
      // The address stays remembered (no live code) when an admin typed it; the employee asks for a code later.
      await this.users.setAccountEmailPending(id, opts.keepOnFailure ? { ...pending, codeHash: '', expiresAt: opts.now } : null);
      throw new ServiceUnavailableException({ message: 'تعذّر إرسال رسالة التأكيد. تأكد من صحة العنوان أو حاول بعد قليل.', code: 'EMAIL_SEND_FAILED' });
    }
    return { sentTo: email, expiresInMin: Math.round(ttl / 60000), resendIn: 60 };
  }

  private changed(userId: string) {
    try { this.presence.emitToAdmins('users:email-changed', { userId }); } catch { /* best effort */ }
    try { this.presence.emitToUser(userId, 'account-email:changed', { userId }); } catch { /* best effort */ }
  }

  // ─── Own account ─────────────────────────────────────────────────────────

  async state(actor: Actor) {
    const user = await this.load(actor.id);
    const admin = user.role === 'admin';
    return {
      ...accountEmailView(user),
      admin,
      securityEmail: admin && user.securityEmailVerifiedAt ? String(user.securityEmail || '') : '',
      required: accountEmailRequired(user, this.mailer.configured()),
      mailConfigured: this.mailer.configured(),
    };
  }

  /**
   * The employee adds or changes their address. Changing a VERIFIED address needs the current password;
   * the first address is added right after signing in, with the password just typed.
   */
  async requestOwn(actor: Actor, rawEmail: string, password = '') {
    const user = await this.load(actor.id);
    if (user.role === 'admin') {
      throw new ForbiddenException({ message: 'يستخدم حساب المدير «بريد الأمان» من الإعدادات ← الأمان.', code: 'ADMIN_USES_SECURITY_EMAIL' });
    }
    const { email, problem } = cleanAccountEmail(rawEmail);
    if (problem) throw new BadRequestException({ message: problem, code: 'EMAIL_INVALID' });
    const current = verifiedEmailOf(user);
    if (email === current) throw new BadRequestException({ message: 'هذا هو بريدك الإلكتروني الحالي.', code: 'EMAIL_SAME' });
    if (current) {
      if (!password || !(await bcrypt.compare(String(password), user.password))) {
        this.audit.log({ userId: actor.id, username: user.username, violationType: 'otp_violation', action: 'كلمة مرور خاطئة عند تغيير البريد الإلكتروني' }).catch(() => undefined);
        throw new UnauthorizedException({ message: 'كلمة المرور الحالية غير صحيحة.', code: 'PASSWORD_WRONG' });
      }
    }
    this.mailReady();
    await this.assertFree(email, actor.id);
    const now = new Date();
    const recent = await this.rateCheck(user, now);
    const res = await this.sendCode(user, email, { by: null, now, recent });
    return { ...res, state: await this.state(actor) };
  }

  /** A new code to the address already waiting (own or admin-requested). */
  async resendOwn(actor: Actor) {
    const user = await this.load(actor.id);
    const p = user.emailPending;
    if (!p?.email) throw new BadRequestException({ message: 'لا يوجد بريد بانتظار التأكيد.', code: 'NO_PENDING' });
    this.mailReady();
    await this.assertFree(p.email, actor.id);
    const now = new Date();
    const recent = await this.rateCheck(user, now);
    // A resend is the employee's own action: the code lives the short time.
    const res = await this.sendCode(user, p.email, { by: null, now, recent, keepOnFailure: true });
    return { ...res, state: await this.state(actor) };
  }

  async confirmOwn(actor: Actor, code: string) {
    const user = await this.load(actor.id);
    const p = user.emailPending;
    if (!p?.email) throw new BadRequestException({ message: 'لا يوجد بريد بانتظار التأكيد.', code: 'NO_PENDING' });
    if (!p.codeHash || new Date(p.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException({ message: 'انتهت صلاحية الرمز. اطلب رمزًا جديدًا.', code: 'CODE_EXPIRED' });
    }
    const digits = normalizeDigits(code);
    const expected = codeHash(CODE_SECRET(), accountEmailScope(actor.id), digits + ':' + p.email);
    if (digits.length !== 6 || !safeEqual(expected, p.codeHash)) {
      const attempts = await this.users.bumpAccountEmailAttempts(actor.id);
      if (attempts >= ACCOUNT_EMAIL_MAX_ATTEMPTS) {
        await this.users.expireAccountEmailCode(actor.id);
        throw new BadRequestException({ message: 'أُوقف هذا الرمز بعد 5 محاولات خاطئة. اطلب رمزًا جديدًا.', code: 'CODE_LOCKED' });
      }
      const left = ACCOUNT_EMAIL_MAX_ATTEMPTS - attempts;
      throw new BadRequestException({ message: `الرمز غير صحيح. تبقّت ${left} ${left === 1 ? 'محاولة' : 'محاولات'}.`, code: 'CODE_WRONG', attemptsLeft: left });
    }
    await this.assertFree(p.email, actor.id);
    const previous = verifiedEmailOf(user);
    const ok = await this.users.confirmAccountEmail(actor.id, p.email, p.codeHash);
    if (!ok) throw new BadRequestException({ message: 'تغيّر الطلب أثناء التأكيد. أعد المحاولة.', code: 'PENDING_CHANGED' });
    const now = new Date();
    this.audit.log({
      userId: actor.id, username: user.username, violationType: 'account_email_changed' as any,
      action: previous ? 'تغيير البريد الإلكتروني للحساب' : 'تأكيد البريد الإلكتروني للحساب',
      detail: maskEmail(p.email) + (p.requestedBy ? ` · طلبه ${p.requestedBy.name}` : ''),
    }).catch(() => undefined);
    this.mailer.sendQuietly({
      to: p.email, fromName: FROM_NAME, subject: MAIL_SUBJECT.emailConfirmed,
      ...securityMailBody({ title: 'تم تأكيد البريد الإلكتروني', footer: FOOTER, lines: [
        `الحساب: ${user.username}`,
        `رُبط هذا البريد بحسابك في ${cairo(now)}.`,
        'إذا لم تكن أنت، فتواصل مع مدير النظام فورًا.',
      ] }),
    });
    if (previous && previous !== p.email) {
      this.mailer.sendQuietly({
        to: previous, fromName: FROM_NAME, subject: MAIL_SUBJECT.emailChanged,
        ...securityMailBody({ title: 'تم تغيير البريد الإلكتروني', footer: FOOTER, lines: [
          `الحساب: ${user.username}`,
          `البريد الجديد: ${maskEmail(p.email)}`,
          'إذا لم تكن أنت، فتواصل مع مدير النظام فورًا.',
        ] }),
      });
    }
    this.changed(actor.id);
    return { success: true, email: p.email, state: await this.state(actor) };
  }

  /** Drops a request that is still waiting (the verified address, if any, stays). */
  async cancelOwn(actor: Actor) {
    await this.users.setAccountEmailPending(actor.id, null);
    this.changed(actor.id);
    return { success: true, state: await this.state(actor) };
  }

  // ─── An admin, for an employee ───────────────────────────────────────────

  /** The admin types an address; the code goes to it and the EMPLOYEE confirms it (48 hours). */
  async requestForUser(admin: Actor, userId: string, rawEmail: string) {
    if (admin.role !== 'admin') throw new ForbiddenException('هذا الإجراء متاح لمدير النظام فقط.');
    const user = await this.load(userId);
    if (user.role === 'admin') {
      throw new BadRequestException({ message: 'يضيف المدير «بريد الأمان» لحسابه بنفسه من الإعدادات ← الأمان.', code: 'ADMIN_ACCOUNT' });
    }
    const { email, problem } = cleanAccountEmail(rawEmail);
    if (problem) throw new BadRequestException({ message: problem, code: 'EMAIL_INVALID' });
    if (email === verifiedEmailOf(user)) throw new BadRequestException({ message: 'هذا هو البريد المؤكَّد الحالي لهذا الحساب.', code: 'EMAIL_SAME' });
    this.mailReady();
    await this.assertFree(email, userId);
    const now = new Date();
    const recent = await this.rateCheck(user, now);
    const res = await this.sendCode(user, email, { by: admin, now, recent, keepOnFailure: true });
    this.audit.log({
      userId, username: user.username, violationType: 'account_email_changed' as any,
      action: `طلب ربط بريد إلكتروني بواسطة المدير ${admin.name}`, detail: maskEmail(email),
    }).catch(() => undefined);
    this.changed(userId);
    return res;
  }

  async cancelForUser(admin: Actor, userId: string) {
    if (admin.role !== 'admin') throw new ForbiddenException('هذا الإجراء متاح لمدير النظام فقط.');
    await this.load(userId);
    await this.users.setAccountEmailPending(userId, null);
    this.changed(userId);
    return { success: true };
  }

  /** New account with an address: never fails the creation — the result says whether the code went out. */
  async inviteNewAccount(admin: Actor, userId: string, rawEmail: string): Promise<{ sent: boolean; sentTo?: string; message?: string }> {
    if (!String(rawEmail || '').trim()) return { sent: false };
    if (!this.mailer.configured()) {
      // Remember the address (no code yet): it is confirmed once mail can be sent.
      const { email, problem } = cleanAccountEmail(rawEmail);
      if (!problem) {
        const now = new Date();
        await this.users.setAccountEmailPending(userId, { email, codeHash: '', expiresAt: now, attempts: 0, sentAt: now, requestedBy: { id: admin.id, name: admin.name }, requestedAt: now });
      }
      return { sent: false, message: problem || 'إرسال البريد الإلكتروني غير متاح حاليًا؛ حُفظ العنوان بانتظار التأكيد.' };
    }
    try {
      const r = await this.requestForUser(admin, userId, rawEmail);
      return { sent: true, sentTo: r.sentTo };
    } catch (e: any) {
      const body = typeof e?.getResponse === 'function' ? e.getResponse() : null;
      const message = (body && typeof body === 'object' ? body.message : null) || e?.message || 'تعذّر إرسال رسالة التأكيد.';
      this.logger.warn(`new account email invite failed: ${message}`);
      return { sent: false, message: String(message) };
    }
  }
}
