import { HttpException, HttpStatus, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { createHash } from 'crypto';
import { User, UserDocument } from '../users/schemas/user.schema';
import { MentionsService } from '../mentions/mentions.service';
import { UsersService } from '../users/users.service';
import { SecurityAuditService } from '../security-audit/security-audit.service';
import { PresenceGateway } from '../auth/presence.gateway';

/**
 * Protection against tampering by signed-in employees (Nov 25, 2026). Admins are never counted.
 *
 * STRICT — temporary suspension (30 min → 2 h → until an admin lifts it; level forgotten after 7 days):
 *   forbidden  10 refused WRITE requests (403) in 10 min — read refusals never count
 *   repeat     the same write with the same body 6× in 10 s → refused (429); refused 3× in 10 min → suspend
 *   flood      150 writes in a minute
 *   forged     a body carrying permission / role / suspension fields — alert at once, 3× in a day → suspend
 *   uploads    > 20 uploads in 10 min → refused + warning; > 40 → suspend; 6 rejected files in 10 min → suspend
 *   comments   same text within 2 min, > 5 on one record in 10 min, > 8 in 5 min → refused; 5 refusals in 10 min → suspend
 * NOTIFY ONLY — admins told at once, the employee warned, nothing blocked:
 *   mass-cancel (> 5 deletes/cancels/rejects in 10 min) · prices (> 15 sale-price edits) · stock
 *   (> 10 negative adjustments) · reversals (> 5 undo/reverse in 10 min) · codes (> 8 code
 *   requests in 10 min) · browse-repeat (3 paging pauses in a day) · night (a write 00:00–07:00
 *   Cairo, once a day) · deposit (every deposit undo / receipt reject / withdraw)
 * Counters live in memory (one API process): a restart forgets them, which errs on the side of access.
 * A suspension is stored on the user (`suspendedUntil`) and enforced by JwtStrategy on every request.
 */
export const SUSPEND_STEPS_MIN = [30, 120];
const FOREVER = new Date('2100-01-01T00:00:00Z');
const SENDER = 'نظام حماية النظام';
const SENSITIVE_KEYS = ['perms', 'roleId', 'isAdmin', 'suspendedUntil', 'suspensionLevel', 'loginLockedUntil', 'lockedBy', 'onboardingPending'];
const EXEMPT = /\/(auth|presence|mentions|notifications|push|browse-access|drafts|assistant|abuse-guard)(\/|$)|update-last-seen|set-status|movements-page|summary-page|startup-overview|\/scans?(\/|$)|prep-check|heartbeat|\/read$|preferences|\/validate$|identify-lines/;
const UPLOAD = /upload|invoice-images|deposit-receipts\/upload|\/images?(\/|$)|\/photos?(\/|$)/;
const REVERSAL = /\/undo(\/|$)|reverse-collect|\/reverse(\/|$)|return-to-preparing|undo-delivered/;
const DESTRUCTIVE = /\/cancel(\/|$)|\/reject(\/|$)|\/remove(\/|$)|bulk-delete|batch-delete|\/delete(\/|$)/;
const DEPOSIT = /deposit-receipts\/[^/]+\/(reject|withdraw|refund|cancel)|deposit-requests\/[^/]+\/(reject|withdraw)|deposit-receipts\/.*(reject|withdraw)/;
const OTP_REQUEST = /discount-otp\/[a-z-]*request$|\/request-edit$/;
/** Adding a comment: invoices, pickup cards, Shopify orders (whole list) and follow-ups (`text`). */
const COMMENT_ROUTE = /\/(transactions(\/pickup-orders)?|shopify\/orders|followups)\/[^/]+\/comments$/;

export const PATTERN_AR: Record<string, string> = {
  forbidden: 'محاولات متكررة لتنفيذ ما لا يُسمح له به',
  repeat: 'ضغط متكرر على نفس الإجراء',
  flood: 'عدد كبير جدًا من العمليات في دقيقة واحدة',
  forged: 'إرسال بيانات تلاعب (صلاحيات أو أدوار)',
  uploads: 'رفع عدد كبير من الصور',
  comments: 'تعليقات مكررة أو كثيفة',
  'mass-cancel': 'حذف أو إلغاء جماعي',
  prices: 'تعديل جماعي لأسعار البيع',
  stock: 'تسويات مخزون سالبة متكررة',
  reversals: 'تراجعات متكررة',
  codes: 'طلبات أكواد متكررة',
  'browse-repeat': 'تصفح جماعي متكرر',
  night: 'عمل خارج ساعات العمل',
  deposit: 'حذف أو رفض عربون',
};

type U = { userId?: string; sub?: string; role?: string; name?: string; username?: string } | undefined;
const uid = (u: U) => String(u?.userId || u?.sub || '');

@Injectable()
export class AbuseGuardService implements OnModuleInit {
  /** For the global exception filter, which is not created by DI (main.ts). */
  static instance: AbuseGuardService | null = null;
  private readonly logger = new Logger(AbuseGuardService.name);
  private readonly windows = new Map<string, number[]>();
  private readonly notified = new Map<string, number>();
  private readonly lengths = new Map<string, number>();
  private readonly texts = new Map<string, Array<{ text: string; at: number }>>();

  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @Optional() private readonly mentions?: MentionsService,
    @Optional() private readonly usersService?: UsersService,
    @Optional() private readonly audit?: SecurityAuditService,
    @Optional() private readonly presence?: PresenceGateway,
  ) {}

  onModuleInit() { AbuseGuardService.instance = this; }

  /** Counts an event in a sliding window and returns how many fall inside it. */
  private hit(key: string, windowMs: number): number {
    const now = Date.now();
    const list = (this.windows.get(key) || []).filter(t => now - t < windowMs);
    list.push(now);
    this.windows.set(key, list);
    if (this.windows.size > 20000) this.windows.clear(); // memory guard
    return list.length;
  }

  /** Called before every write handler (interceptor). May throw 429; may suspend. */
  async beforeWrite(req: any): Promise<void> {
    const user: U = req?.user;
    const id = uid(user);
    if (!id || user?.role === 'admin') return;
    const method = String(req.method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
    const path = String(req.path || req.url || '').split('?')[0];
    if (EXEMPT.test(path)) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // forged fields — never sent by an employee's screens
    const forged = SENSITIVE_KEYS.filter(k => Object.prototype.hasOwnProperty.call(body, k));
    if (forged.length) {
      const n = this.hit('fg:' + id, 24 * 3600_000);
      if (n >= 3) await this.suspend(user, 'forged', `${path} — ${forged.join(', ')}`);
      else await this.notify(user, 'forged', `${path} — الحقول: ${forged.join(', ')}`, true);
    }

    // flood
    if (this.hit('w:' + id, 60_000) >= 150) await this.suspend(user, 'flood', `${path}`);

    // comments: duplicate text, density on one record, overall rate (strict: refused; insisting → suspended)
    if (method === 'POST' && COMMENT_ROUTE.test(path)) await this.checkComment(user, id, path, body);

    // repeated identical write (double/triple click)
    const isUpload = UPLOAD.test(path);
    if (!isUpload) {
      const sig = createHash('sha1').update(method + ' ' + path + ' ' + JSON.stringify(body)).digest('hex');
      if (this.hit('r:' + id + ':' + sig, 10_000) >= 6) {
        const blocks = this.hit('rb:' + id, 10 * 60_000);
        if (blocks >= 3) await this.suspend(user, 'repeat', path);
        this.warnUser(id, 'تم إيقاف الطلب المكرر — لا تضغط على نفس الزر أكثر من مرة. التكرار يؤدي إلى إيقاف الحساب مؤقتًا.');
        throw new HttpException({ statusCode: 429, code: 'ACTION_REPEATED', message: 'هذا الإجراء أُرسل عدة مرات متتالية — انتظر لحظات ثم حاول مرة واحدة.' }, HttpStatus.TOO_MANY_REQUESTS);
      }
    }

    // uploads
    if (isUpload) {
      const n = this.hit('up:' + id, 10 * 60_000);
      if (n > 40) await this.suspend(user, 'uploads', `${n} صورة خلال 10 دقائق`);
      if (n > 20) {
        if (n === 21) await this.notify(user, 'uploads', `${n} صورة خلال 10 دقائق — أوقف الرفع مؤقتًا`, true);
        throw new HttpException({ statusCode: 429, code: 'UPLOAD_LIMIT', message: 'تم الوصول إلى الحد الأقصى لرفع الصور (20 صورة خلال 10 دقائق). انتظر قليلًا ثم أكمل.' }, HttpStatus.TOO_MANY_REQUESTS);
      }
    }

    // notify-only patterns
    if (DEPOSIT.test(path) || (/\/payments\/[^/]+\/undo$/.test(path) && /deposit/i.test(String(body?.kind || body?.type || '')))) {
      await this.notify(user, 'deposit', path, true, 'deposit:' + id + ':' + path, 60_000);
    }
    if (REVERSAL.test(path)) { if (this.hit('rev:' + id, 10 * 60_000) > 5) await this.notify(user, 'reversals', path, true); }
    else if (method === 'DELETE' || DESTRUCTIVE.test(path)) { if (this.hit('del:' + id, 10 * 60_000) > 5) await this.notify(user, 'mass-cancel', path, true); }
    if ((/^\/(api\/)?products\/[^/]+$/.test(path) && method === 'PUT' && body.sellPrice !== undefined) || (/products\/bulk-update$/.test(path) && body.sellPrice !== undefined)) {
      if (this.hit('pr:' + id, 10 * 60_000) > 15) await this.notify(user, 'prices', path, true);
    }
    if (/inventory-movements\/adjust$/.test(path) && Number(body.qty ?? body.quantity) < 0) {
      if (this.hit('adj:' + id, 10 * 60_000) > 10) await this.notify(user, 'stock', path, true);
    }
    if (OTP_REQUEST.test(path)) { if (this.hit('otp:' + id, 10 * 60_000) > 8) await this.notify(user, 'codes', path, true); }
    const cairoHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    if (cairoHour < 7) await this.notify(user, 'night', `${path} — الساعة ${cairoHour}`, false, 'night:' + id, 20 * 3600_000);
  }

  /**
   * A NEW comment only (an edit or delete re-sends the whole list without growing it, and is skipped):
   *   same text by the same employee within 2 min → refused (COMMENT_DUPLICATE)
   *   > 5 comments on one record in 10 min       → refused (COMMENT_DENSITY)
   *   > 8 comments in 5 min                      → refused (COMMENT_LIMIT), admins told once
   *   5 refusals in 10 min                       → suspension
   */
  private async checkComment(user: U, id: string, path: string, body: any): Promise<void> {
    const target = path.replace(/\/comments$/, '');
    let text = '';
    if (Array.isArray(body?.comments)) {
      const list = body.comments;
      const key = 'cl:' + id + ':' + target;
      const prev = this.lengths.get(key);
      this.lengths.set(key, list.length);
      if (this.lengths.size > 20000) this.lengths.clear();
      if (prev !== undefined && list.length <= prev) return; // edit / delete, not a new comment
      text = String(list[list.length - 1]?.text || '');
    } else {
      text = String(body?.text || '');
    }
    const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const refuse = async (codeName: string, message: string) => {
      if (this.hit('cb:' + id, 10 * 60_000) >= 5) await this.suspend(user, 'comments', `${path} — ${codeName}`);
      throw new HttpException({ statusCode: 429, code: codeName, message }, HttpStatus.TOO_MANY_REQUESTS);
    };
    if (norm) {
      const recent = (this.texts.get(id) || []).filter(t => Date.now() - t.at < 2 * 60_000);
      if (recent.some(t => t.text === norm)) {
        this.warnUser(id, 'هذا التعليق أُرسل قبل قليل — لا تكرر نفس التعليق.');
        await refuse('COMMENT_DUPLICATE', 'هذا التعليق مكرر — أُضيف التعليق نفسه قبل قليل.');
      }
      recent.push({ text: norm, at: Date.now() });
      this.texts.set(id, recent.slice(-20));
    }
    if (this.hit('ct:' + id + ':' + target, 10 * 60_000) > 5) {
      this.warnUser(id, 'تعليقات كثيرة على السجل نفسه — اجمع ملاحظاتك في تعليق واحد.');
      await refuse('COMMENT_DENSITY', 'تعليقات كثيرة على هذه المتابعة أو هذا الطلب خلال وقت قصير — انتظر قليلًا ثم أكمل.');
    }
    const n = this.hit('cr:' + id, 5 * 60_000);
    if (n > 8) {
      if (n === 9) await this.notify(user, 'comments', `${n} تعليقات خلال 5 دقائق — آخرها على ${target}`, true);
      await refuse('COMMENT_LIMIT', 'تم الوصول إلى الحد الأقصى للتعليقات (8 تعليقات خلال 5 دقائق). انتظر قليلًا ثم أكمل.');
    }
  }

  /** Called by the global exception filter for every error response. */
  onHttpError(req: any, status: number): void {
    const user: U = req?.user;
    const id = uid(user);
    if (!id || user?.role === 'admin') return;
    // Held by «أضف بريدك الإلكتروني» (AccountEmailGateInterceptor): the page refuses itself, not the employee.
    if (req?._accountEmailHeld) return;
    const path = String(req?.path || req?.url || '').split('?')[0];
    // Only WRITE attempts count: screens fetch some data an account may not read and then hide it,
    // so read refusals happen during honest work and must never suspend anyone.
    const method = String(req?.method || '').toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || EXEMPT.test(path)) return;
    if (status === 403) {
      const n = this.hit('f:' + id, 10 * 60_000);
      if (n >= 10) this.suspend(user, 'forbidden', `${n} طلبًا مرفوضًا، آخرها ${path}`).catch(() => undefined);
    } else if ([400, 413, 415].includes(status) && UPLOAD.test(path)) {
      const n = this.hit('upr:' + id, 10 * 60_000);
      if (n >= 6) this.suspend(user, 'uploads', `${n} ملفات مرفوضة خلال 10 دقائق`).catch(() => undefined);
      else if (n === 3) this.notify(user, 'uploads', `${n} ملفات مرفوضة متتالية`, true).catch(() => undefined);
    }
  }

  /** BrowseAccessService tells us about each paging pause. */
  async onBrowsePause(user: U): Promise<void> {
    const id = uid(user);
    if (!id) return;
    if (this.hit('bp:' + id, 24 * 3600_000) >= 3) await this.notify(user, 'browse-repeat', 'أُوقف التقليب 3 مرات اليوم', true);
  }

  async suspend(user: U, pattern: string, detail: string): Promise<never> {
    const id = uid(user);
    const doc: any = await this.users.findById(id).select('suspendedAt suspensionLevel').lean().exec();
    const recent = doc?.suspendedAt && Date.now() - new Date(doc.suspendedAt).getTime() < 7 * 24 * 3600_000;
    const level = (recent ? Number(doc?.suspensionLevel || 0) : 0) + 1;
    const until = level > SUSPEND_STEPS_MIN.length ? FOREVER : new Date(Date.now() + SUSPEND_STEPS_MIN[level - 1] * 60_000);
    const reason = PATTERN_AR[pattern] || pattern;
    await this.users.updateOne({ _id: id }, { $set: { suspendedUntil: until, suspendedAt: new Date(), suspensionLevel: level, suspensionReason: reason, suspensionDetail: String(detail).slice(0, 300) } }).exec();
    for (const k of [...this.windows.keys()]) if (k.includes(':' + id)) this.windows.delete(k);
    const forever = until.getTime() >= FOREVER.getTime();
    const durationAr = forever ? 'حتى يرفعه المدير' : `حتى ${until.toLocaleTimeString('ar-EG-u-nu-latn', { timeZone: 'Africa/Cairo', hour: '2-digit', minute: '2-digit' })}`;
    this.audit?.log({ userId: id, username: user?.username || '', violationType: 'account_suspended' as any, action: `إيقاف مؤقت: ${reason}`, detail: `${detail} — ${durationAr}` }).catch(() => undefined);
    await this.notifyAdmins(`⛔ إيقاف حساب موظف مؤقتًا\nالموظف: ${user?.name || user?.username || '—'}\nالسبب: ${reason}\nالتفاصيل: ${detail}\nالمدة: ${durationAr}\nلرفع الإيقاف: المستخدمون ← الأمان ← فك الإيقاف`, 'suspend:' + id).catch(() => undefined);
    const payload = suspensionPayload({ suspendedUntil: until, suspensionReason: reason });
    try { this.presence?.emitToUser(id, 'account:suspended', payload); } catch { /* best effort */ }
    throw new HttpException(payload, 423);
  }

  /** Admins told + (optionally) the employee warned. Throttled per user + pattern (10 min by default). */
  async notify(user: U, pattern: string, detail: string, warnEmployee: boolean, key?: string, throttleMs = 10 * 60_000): Promise<void> {
    const id = uid(user);
    const k = key || pattern + ':' + id;
    const last = this.notified.get(k) || 0;
    if (Date.now() - last < throttleMs) return;
    this.notified.set(k, Date.now());
    const label = PATTERN_AR[pattern] || pattern;
    this.audit?.log({ userId: id, username: user?.username || '', violationType: 'abuse_alert' as any, action: label, detail: String(detail).slice(0, 300) }).catch(() => undefined);
    await this.notifyAdmins(`⚠️ تنبيه نشاط مشبوه\nالموظف: ${user?.name || user?.username || '—'}\nالنوع: ${label}\nالتفاصيل: ${detail}`, 'alert:' + id).catch(() => undefined);
    if (warnEmployee) this.warnUser(id, `تنبيه: رُصد ${label}. أُبلغ المدير — يُرجى الالتزام بإجراءات العمل.`);
  }

  private warnUser(id: string, message: string) {
    try { this.presence?.emitToUser(id, 'abuse:warning', { message }); } catch { /* best effort */ }
  }

  onLifted(userId: string) {
    for (const k of [...this.windows.keys()]) if (k.includes(':' + userId)) this.windows.delete(k);
    try { this.presence?.emitToUser(String(userId), 'account:restored', {}); } catch { /* best effort */ }
  }

  private async notifyAdmins(text: string, ref: string) {
    if (!this.mentions || !this.usersService) return;
    const admins = (await this.usersService.findAll()).filter((u: any) => u.role === 'admin' && u.isActive !== false);
    if (!admins.length) return;
    const rows = admins.map((a: any) => ({ targetUserId: String(a._id), targetUsername: String(a.username || '').toLowerCase(), targetName: a.name || '',
      fromUserId: 'system', fromName: SENDER, txId: ref, txRef: '', commentId: 0, commentText: text }));
    const saved: any[] = await this.mentions.createMany(rows) as any[];
    try {
      for (const m of saved) this.presence?.emitToUser(String(m.targetUserId), 'mention:new', { id: String(m._id), _id: String(m._id), targetUserId: m.targetUserId,
        fromUserId: m.fromUserId, fromName: m.fromName, txId: m.txId, txRef: m.txRef, commentId: m.commentId, commentText: m.commentText, read: false, ts: new Date().toISOString() });
    } catch { /* best effort */ }
  }
}

/** What a suspended account is told (423 body and the socket event). */
export function suspensionPayload(user: { suspendedUntil?: Date | string | null; suspensionReason?: string }) {
  const until = user.suspendedUntil ? new Date(user.suspendedUntil) : null;
  const forever = !!until && until.getTime() >= FOREVER.getTime();
  return {
    statusCode: 423, code: 'ACCOUNT_SUSPENDED', reason: user.suspensionReason || '', until: forever ? null : until?.toISOString() || null, untilLifted: forever,
    message: `تم إيقاف حسابك مؤقتًا بسبب: ${user.suspensionReason || 'نشاط غير معتاد'}. ${forever ? 'يرفع المدير الإيقاف.' : 'ينتهي الإيقاف تلقائيًا.'} تواصل مع المدير إذا كان ذلك خطأ.`,
  };
}
