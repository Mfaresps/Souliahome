import { AbuseGuardService } from '../abuse-guard/abuse-guard.service';
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { MentionsService } from '../mentions/mentions.service';
import { UsersService } from '../users/users.service';
import { SecurityAuditService } from '../security-audit/security-audit.service';
import { PresenceGateway } from '../auth/presence.gateway';

/**
 * Protection against bulk browsing (Nov 25, 2026).
 *
 * · Depth: without the browse permission (or a manager-approved grant) the transactions log shows
 *   its first `MOVEMENTS_FREE_PAGES` pages and the client list its first page.
 * · Grant: an employee asks («طلب صلاحية التصفح»); every admin is notified; an admin approves for
 *   1 / 8 / 24 hours or rejects. The grant ends by itself (`expiresAt`).
 * · Paging watch: more than `PAGE_LIMIT_PER_HOUR` page turns past page 1 in an hour pauses that
 *   employee's paging for `PAUSE_MINUTES`, logs a security event and notifies the admins once.
 *   In memory (one API process) — a restart forgets the counters, which errs on the side of access.
 * · Phones in LISTS are masked for anyone without `customers-phone-view`; a single record (invoice,
 *   client profile) still shows the full number.
 */
export type BrowseScope = 'movements' | 'clients' | 'inventory-log';
export const BROWSE_SCOPES: BrowseScope[] = ['movements', 'clients', 'inventory-log'];
export const BROWSE_PERMS: Record<BrowseScope, string> = { movements: 'movements-browse', clients: 'clients-browse', 'inventory-log': 'inventory-log-browse' };
export const MOVEMENTS_FREE_PAGES = 5;
/** Rows per page without browsing access — the free pages are counted in pages of this size,
 *  or a larger page size would reach more rows (5 × 100). ⚠ Mirrors MOV_FREE_PAGE_SIZE in index.html. */
export const MOVEMENTS_FREE_PAGE_SIZE = 20;
export const PAGE_LIMIT_PER_HOUR = 30;
export const PAUSE_MINUTES = 15;
export const GRANT_HOURS = [1, 8, 24];
export const MIN_SEARCH_CHARS = 3;
const COLLECTION = 'browseaccessrequests';
const SENDER = 'نظام طلبات التصفح';
const SCOPE_AR: Record<BrowseScope, string> = { movements: 'سجل المعاملات', clients: 'قائمة العملاء', 'inventory-log': 'سجل حركة المخزون' };

export type BrowseUser = { userId?: string; sub?: string; role?: string; perms?: string[]; name?: string; username?: string } | undefined;
const uid = (u: BrowseUser) => String(u?.userId || u?.sub || '');

/** 01012345678 → 010•••••678 (keeps the first 3 and the last 3 digits). */
export function maskPhone(value: unknown): string {
  const s = String(value ?? '');
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return s ? '•••' : '';
  return digits.slice(0, 3) + '•'.repeat(Math.max(3, digits.length - 6)) + digits.slice(-3);
}
export function canSeePhones(user: BrowseUser): boolean {
  return user?.role === 'admin' || !!user?.perms?.includes('customers-phone-view');
}
const PHONE_KEYS = ['phone', 'phone2', 'shippingPhone', 'customerPhone'];
/** Masks phone fields on list rows (and a `phones` array) for a user without phone visibility. */
export function maskRowPhones<T>(rows: T[], user: BrowseUser): T[] {
  if (canSeePhones(user) || !Array.isArray(rows)) return rows;
  return rows.map((row: any) => {
    if (!row || typeof row !== 'object') return row;
    const o = typeof row.toObject === 'function' ? row.toObject() : { ...row };
    for (const k of PHONE_KEYS) if (o[k]) o[k] = maskPhone(o[k]);
    if (Array.isArray(o.phones)) o.phones = o.phones.map(maskPhone);
    o.phoneMasked = true;
    return o;
  });
}

@Injectable()
export class BrowseAccessService {
  private readonly logger = new Logger(BrowseAccessService.name);
  private readonly hits = new Map<string, number[]>();
  private readonly paused = new Map<string, number>();
  private readonly grantCache = new Map<string, { until: number; at: number }>();

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Optional() private readonly mentions?: MentionsService,
    @Optional() private readonly users?: UsersService,
    @Optional() private readonly audit?: SecurityAuditService,
    @Optional() private readonly presence?: PresenceGateway,
  ) {}

  private get col() { return this.connection.collection(COLLECTION); }

  /** Active manager-approved grant (cached 20 s). */
  private async grantUntil(userId: string, scope: BrowseScope): Promise<number> {
    const key = userId + '|' + scope;
    const hit = this.grantCache.get(key);
    if (hit && Date.now() - hit.at < 20000) return hit.until;
    const doc: any = await this.col.findOne({ userId, scope, status: 'approved', expiresAt: { $gt: new Date() } }, { sort: { expiresAt: -1 } });
    const until = doc ? new Date(doc.expiresAt).getTime() : 0;
    this.grantCache.set(key, { until, at: Date.now() });
    return until;
  }

  /** Permission or an approved, unexpired grant. */
  async canBrowse(user: BrowseUser, scope: BrowseScope): Promise<boolean> {
    if (!user) return false;
    if (user.role === 'admin' || user.perms?.includes(BROWSE_PERMS[scope])) return true;
    const id = uid(user);
    return !!id && (await this.grantUntil(id, scope)) > Date.now();
  }

  /** Counts a page turn past page 1 by someone browsing without full access; pauses bulk paging. */
  async trackPaging(user: BrowseUser, scope: BrowseScope): Promise<void> {
    const id = uid(user);
    if (!id || user?.role === 'admin') return;
    const now = Date.now();
    const pausedUntil = this.paused.get(id) || 0;
    if (pausedUntil > now) throw this.pausedError(pausedUntil);
    const list = (this.hits.get(id) || []).filter(t => now - t < 3600_000);
    list.push(now);
    this.hits.set(id, list);
    if (list.length > PAGE_LIMIT_PER_HOUR) {
      const until = now + PAUSE_MINUTES * 60_000;
      this.paused.set(id, until);
      this.hits.set(id, []);
      const name = user?.name || user?.username || 'موظف';
      this.audit?.log({ userId: id, username: user?.username || '', violationType: 'bulk_browsing' as any,
        action: `تقليب ${list.length} صفحة خلال ساعة في ${SCOPE_AR[scope]}`, detail: `أُوقف التصفح ${PAUSE_MINUTES} دقيقة` }).catch(() => undefined);
      this.notifyAdmins(`⚠️ تصفح جماعي مشتبه به\nالموظف: ${name}\nالصفحة: ${SCOPE_AR[scope]}\nقلّب ${list.length} صفحة خلال ساعة — أُوقف تقليب الصفحات ${PAUSE_MINUTES} دقيقة.`, 'pause:' + id + ':' + now).catch(() => undefined);
      AbuseGuardService.instance?.onBrowsePause(user).catch(() => undefined);
      throw this.pausedError(until);
    }
  }

  private pausedError(until: number) {
    const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    return new HttpException({ statusCode: 429, code: 'BROWSE_PAUSED', minutes,
      message: `تم إيقاف تقليب الصفحات مؤقتًا بسبب كثرتها في وقت قصير. حاول بعد ${minutes} دقيقة، أو اطلب صلاحية التصفح من المدير.` }, HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Employee asks for full browsing. One open request per scope. */
  async request(user: BrowseUser, rawScope: string, reason: string) {
    const scope = BROWSE_SCOPES.includes(rawScope as BrowseScope) ? rawScope as BrowseScope : null;
    if (!scope) throw new BadRequestException('نوع الصفحة غير معروف');
    const id = uid(user);
    if (!id) throw new ForbiddenException('تعذّر تحديد المستخدم');
    if (await this.canBrowse(user, scope)) return { status: 'approved', alreadyAllowed: true };
    const open: any = await this.col.findOne({ userId: id, scope, status: 'pending' });
    if (open) return this.present(open);
    const doc = { _id: new Types.ObjectId(), userId: id, userName: user?.name || user?.username || '', username: user?.username || '',
      scope, reason: String(reason || '').trim().slice(0, 300), status: 'pending', createdAt: new Date() };
    await this.col.insertOne(doc as any);
    await this.notifyAdmins(
      `طلب صلاحية تصفح ${SCOPE_AR[scope]}\nالموظف: ${doc.userName || '—'}` + (doc.reason ? `\nالسبب: ${doc.reason}` : '') + '\nللموافقة: صفحة الموافقات ← طلبات تصفح البيانات',
      String(doc._id)).catch(() => undefined);
    return this.present(doc);
  }

  async mine(user: BrowseUser) {
    const id = uid(user);
    const out: Record<string, any> = {};
    for (const scope of BROWSE_SCOPES) {
      const allowed = user?.role === 'admin' || !!user?.perms?.includes(BROWSE_PERMS[scope]);
      const until = id ? await this.grantUntil(id, scope) : 0;
      const pending: any = id ? await this.col.findOne({ userId: id, scope, status: 'pending' }) : null;
      out[scope] = { permission: allowed, grantUntil: until > Date.now() ? new Date(until).toISOString() : null, pending: !!pending,
        freePages: scope === 'clients' ? 1 : MOVEMENTS_FREE_PAGES };
    }
    return out;
  }

  async pending() {
    const rows = await this.col.find({ status: 'pending' }).sort({ createdAt: -1 }).limit(100).toArray();
    return rows.map(r => this.present(r));
  }

  async decide(requestId: string, admin: BrowseUser, approve: boolean, hours?: number) {
    if (!Types.ObjectId.isValid(requestId)) throw new NotFoundException('الطلب غير موجود');
    const h = approve ? (GRANT_HOURS.includes(Number(hours)) ? Number(hours) : 1) : 0;
    const now = new Date();
    const update: any = approve
      ? { status: 'approved', decidedAt: now, decidedBy: admin?.name || admin?.username || 'المدير', hours: h, expiresAt: new Date(now.getTime() + h * 3600_000) }
      : { status: 'rejected', decidedAt: now, decidedBy: admin?.name || admin?.username || 'المدير' };
    const res: any = await this.col.findOneAndUpdate({ _id: new Types.ObjectId(requestId), status: 'pending' }, { $set: update }, { returnDocument: 'after' });
    const doc = res && (res.value !== undefined ? res.value : res);
    if (!doc) throw new BadRequestException('الطلب لم يعد معلقًا');
    this.grantCache.delete(doc.userId + '|' + doc.scope);
    const text = approve
      ? `تمت الموافقة على طلب تصفح ${SCOPE_AR[doc.scope as BrowseScope]} لمدة ${h === 1 ? 'ساعة' : h <= 10 ? h + ' ساعات' : h + ' ساعة'}\nبواسطة: ${update.decidedBy}`
      : `رُفض طلب تصفح ${SCOPE_AR[doc.scope as BrowseScope]}\nبواسطة: ${update.decidedBy}`;
    await this.notify([{ _id: doc.userId, username: doc.username, name: doc.userName }], text, String(doc._id)).catch(() => undefined);
    return this.present(doc);
  }

  private present(r: any) {
    return { id: String(r._id), userId: r.userId, userName: r.userName, scope: r.scope, scopeLabel: SCOPE_AR[r.scope as BrowseScope] || r.scope,
      reason: r.reason || '', status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt || null, decidedBy: r.decidedBy || '' };
  }

  private async notifyAdmins(text: string, ref: string) {
    const users = (await this.users?.findAll()) || [];
    await this.notify(users.filter((u: any) => u.role === 'admin' && u.isActive !== false), text, ref);
  }

  private async notify(targets: any[], text: string, ref: string) {
    if (!this.mentions || !targets.length) return;
    const rows = targets.map((a: any) => ({
      targetUserId: String(a._id), targetUsername: String(a.username || '').toLowerCase(), targetName: a.name || '',
      fromUserId: 'system', fromName: SENDER, txId: ref, txRef: '', commentId: 0, commentText: text,
    }));
    const saved: any[] = await this.mentions.createMany(rows) as any[];
    try {
      for (const m of saved) this.presence?.emitToUser(String(m.targetUserId), 'mention:new', {
        id: String(m._id), _id: String(m._id), targetUserId: m.targetUserId, fromUserId: m.fromUserId, fromName: m.fromName,
        txId: m.txId, txRef: m.txRef, commentId: m.commentId, commentText: m.commentText, read: false, ts: new Date().toISOString(),
      });
    } catch { /* best effort */ }
  }
}
