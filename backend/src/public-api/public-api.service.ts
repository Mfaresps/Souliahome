import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ObjectId } from 'mongodb';
import { TransactionsService } from '../transactions/transactions.service';
import { FollowUpsService } from '../followups/followups.service';
import { PresenceGateway } from '../auth/presence.gateway';
import { confirmationBucket, ConfirmationBucket, FOLLOWUP_SETTLED_STATUSES } from '../shared/shopify-confirmation-bucket.util';
import { SHIP_ISSUE_ACTIVE_STATES } from '../shared/ship-issue-state.util';
import { ApiKeyDoc } from './api-keys.service';
import { complaintView, followupView, FOLLOWUP_OPEN_FILTER, mentionView, orderView, phoneFor, shippingView } from './public-api.view';

/**
 * Read side of the external API plus the one write (a follow-up note).
 * ⚠ Figures come from the functions the pages use (`getReports`, `getInventory`, the inventory
 * breakdown, the KPI-strip buckets) — never re-derived here.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function cairoToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d));
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}
/** UTC ms of a Cairo day's start. */
export function cairoDayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(Date.UTC(y, m - 1, d, 12))).find((x) => x.type === 'timeZoneName')?.value || 'GMT+2';
  const mm = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(off);
  const offsetMs = mm ? (mm[1] === '-' ? -1 : 1) * ((Number(mm[2]) * 60 + Number(mm[3] || 0)) * 60_000) : 2 * 3600_000;
  return Date.UTC(y, m - 1, d) - offsetMs;
}

function dayRange(q: any, defaultDays: number, maxDays = 31): { from: string; to: string; fromMs: number; toMs: number } {
  const today = cairoToday();
  const to = q?.to ? String(q.to) : q?.date ? String(q.date) : today;
  const from = q?.from ? String(q.from) : q?.date ? String(q.date) : addDays(to, -(defaultDays - 1));
  if (!DAY.test(from) || !DAY.test(to)) throw new BadRequestException({ code: 'BAD_DATE', message: 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD' });
  if (from > to) throw new BadRequestException({ code: 'BAD_DATE', message: 'from يجب أن يكون قبل to' });
  if (addDays(from, maxDays - 1) < to) throw new BadRequestException({ code: 'RANGE_TOO_LONG', message: `أقصى مدة ${maxDays} يومًا في الطلب الواحد` });
  return { from, to, fromMs: cairoDayStart(from), toMs: cairoDayStart(addDays(to, 1)) };
}

function paging(q: any, max = 100) {
  const limit = Math.min(max, Math.max(1, Math.round(Number(q?.limit) || 50)));
  const page = Math.max(1, Math.round(Number(q?.page) || 1));
  return { limit, page, skip: (page - 1) * limit };
}

const ORDER_PROJECTION = {
  ref: 1, shopifyId: 1, client: 1, phone: 1, total: 1, itemsTotal: 1, shipCost: 1, discount: 1, notes: 1, status: 1, cancelled: 1,
  cancelReason: 1, shopifyCreatedAt: 1, createdAt: 1, items: 1, tags: 1, shippingAddress: 1, shippingCity: 1, shippingGov: 1,
  assignedToName: 1, depositAmount: 1, shipWithoutDeposit: 1, 'depositReceipts.status': 1, 'depositReceipts.amount': 1,
};
const TX_PROJECTION = {
  ref: 1, type: 1, shopifyOrderId: 1, client: 1, phone: 1, total: 1, deposit: 1, remaining: 1, shipCost: 1, discount: 1, notes: 1, cancelled: 1,
  cancelReason: 1, date: 1, transactionDate: 1, createdAt: 1, items: 1, tags: 1, shippingAddress: 1, shippingCity: 1, shippingGov: 1,
  pickupStatus: 1, shipCo: 1, bostaTrackingNumber: 1, bostaStatus: 1, bostaStatusLabel: 1, bostaIsDelayed: 1, shippedAt: 1, deliveredAt: 1,
  bostaLastSync: 1, shipIssueState: 1, shipIssueOpenedAt: 1, shipIssueTrigger: 1, bostaLastTrackingUpdate: 1, bostaDeliveryException: 1,
  bostaTrackingEvents: 1, failedDelivery: 1, archived: 1,
};

@Injectable()
export class PublicApiService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(forwardRef(() => TransactionsService)) private readonly transactions: TransactionsService,
    private readonly followups: FollowUpsService,
    private readonly presence: PresenceGateway,
  ) {}

  private get db() { return this.connection.db!; }

  // ── Orders ────────────────────────────────────────────────────────────────────────────────────
  async listOrders(q: any, key: ApiKeyDoc) {
    const range = dayRange(q, 7);
    const { limit, page, skip } = paging(q);
    const candidates: any[] = await this.db.collection('shopifyorders').find(
      { createdAt: { $gte: new Date(range.fromMs - 3 * 864e5), $lt: new Date(range.toMs + 3 * 864e5) } },
      { projection: ORDER_PROJECTION },
    ).toArray();
    let orders = candidates.filter((o) => {
      const ms = new Date(o.shopifyCreatedAt || o.createdAt || 0).getTime();
      return ms >= range.fromMs && ms < range.toMs;
    });
    const status = String(q?.status || '');
    if (status === 'pending') orders = orders.filter((o) => o.status === 'pending' && !o.cancelled);
    else if (status === 'approved') orders = orders.filter((o) => o.status === 'approved' && !o.cancelled);
    else if (status === 'cancelled') orders = orders.filter((o) => o.cancelled || o.status === 'rejected');
    else if (status) throw new BadRequestException({ code: 'BAD_FILTER', message: 'status: pending | approved | cancelled' });

    const [fuByOrder, txByShopify] = await Promise.all([this.followupsFor(orders), this.salesFor(orders)]);
    const withShipping = (key.scopes || []).includes('shipping');
    let rows = orders.map((o) => {
      const fus = fuByOrder.get(String(o._id)) || [];
      const openFu = fus.some((f) => !f.cancelled && !FOLLOWUP_SETTLED_STATUSES.includes(f.status));
      const bucket = confirmationBucket(o, openFu);
      return { o, tx: txByShopify.get(String(o.shopifyId)), fus, bucket, openFu };
    });

    const conf = String(q?.confirmation || '');
    const CONF: Record<string, (b: ConfirmationBucket) => boolean> = {
      deposit: (b) => b === 'deposit', nodep: (b) => b === 'nodep', confirmed: (b) => b === 'deposit' || b === 'nodep',
      followup: (b) => b === 'followup', open: (b) => b === 'open', pending: (b) => b === 'followup' || b === 'open', cancelled: (b) => b === 'cancelled',
    };
    if (conf) {
      if (!CONF[conf]) throw new BadRequestException({ code: 'BAD_FILTER', message: 'confirmation: deposit | nodep | confirmed | followup | open | pending | cancelled' });
      rows = rows.filter((r) => CONF[conf](r.bucket));
    }
    const fu = String(q?.followup || '');
    if (fu === 'none') rows = rows.filter((r) => !r.fus.length);
    else if (fu === 'open') rows = rows.filter((r) => r.openFu);
    else if (fu === 'any') rows = rows.filter((r) => r.fus.length);
    else if (fu === 'no-open') rows = rows.filter((r) => !r.openFu);
    else if (fu) throw new BadRequestException({ code: 'BAD_FILTER', message: 'followup: none | open | no-open | any' });
    if (q?.shipping === 'problem') {
      if (!withShipping) throw new ForbiddenException({ code: 'SCOPE_NOT_ALLOWED', message: 'فلتر الشحن يحتاج صلاحية «shipping»' });
      rows = rows.filter((r) => r.tx && SHIP_ISSUE_ACTIVE_STATES.includes(String(r.tx.shipIssueState || '')));
    }

    rows.sort((a, b) => new Date(b.o.shopifyCreatedAt || b.o.createdAt).getTime() - new Date(a.o.shopifyCreatedAt || a.o.createdAt).getTime());
    return {
      from: range.from, to: range.to, total: rows.length, page, limit,
      items: rows.slice(skip, skip + limit).map((r) => orderView({ shop: r.o, tx: r.tx, followups: r.fus, bucket: r.bucket, phoneMode: key.phoneAccess || 'detail', isDetail: false, withShipping })),
    };
  }

  private async followupsFor(orders: any[]): Promise<Map<string, any[]>> {
    const ids = orders.map((o) => String(o._id));
    const refs = orders.map((o) => String(o.ref || '')).filter(Boolean);
    const map = new Map<string, any[]>();
    if (!orders.length) return map;
    const fus: any[] = await this.db.collection('followups').find(
      { $or: [{ shopifyOrderId: { $in: ids } }, { orderRef: { $in: refs } }] },
      { projection: { comments: { $slice: -1 }, ticketNo: 1, status: 1, cancelled: 1, reason: 1, reasonOther: 1, responsibleName: 1, deferredUntil: 1, createdAt: 1, shopifyOrderId: 1, orderRef: 1 } },
    ).sort({ createdAt: -1 }).toArray();
    const byRef = new Map(orders.map((o) => [String(o.ref || ''), String(o._id)]));
    for (const f of fus) {
      const id = ids.includes(String(f.shopifyOrderId)) ? String(f.shopifyOrderId) : byRef.get(String(f.orderRef || ''));
      if (!id) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id)!.push(f);
    }
    return map;
  }

  private async salesFor(orders: any[]): Promise<Map<string, any>> {
    const sids = orders.map((o) => String(o.shopifyId || '')).filter(Boolean);
    const map = new Map<string, any>();
    if (!sids.length) return map;
    const txs: any[] = await this.db.collection('transactions').find({ type: 'مبيعات', shopifyOrderId: { $in: sids } }, { projection: TX_PROJECTION }).toArray();
    for (const t of txs) {
      const prev = map.get(String(t.shopifyOrderId));
      if (!prev || (prev.cancelled && !t.cancelled)) map.set(String(t.shopifyOrderId), t);
    }
    return map;
  }

  /** One order by its number: the Shopify record, the sale, or both. */
  private async findOrder(refRaw: string) {
    const ref = String(refRaw || '').replace(/^#/, '').trim();
    if (!ref || ref.length > 40) throw new BadRequestException({ code: 'BAD_REF', message: 'رقم الأوردر غير صالح' });
    const shop: any = await this.db.collection('shopifyorders').findOne({ ref }, { projection: ORDER_PROJECTION, sort: { createdAt: -1 } });
    let tx: any = shop?.shopifyId
      ? await this.db.collection('transactions').findOne({ type: 'مبيعات', shopifyOrderId: String(shop.shopifyId) }, { projection: TX_PROJECTION, sort: { cancelled: 1, createdAt: -1 } })
      : null;
    if (!tx) tx = await this.db.collection('transactions').findOne({ type: 'مبيعات', ref }, { projection: TX_PROJECTION, sort: { cancelled: 1, createdAt: -1 } });
    if (!shop && !tx) throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: `لا يوجد أوردر برقم ${ref}` });
    const or: any[] = [{ orderRef: ref }];
    if (shop) or.push({ shopifyOrderId: String(shop._id) });
    if (tx) or.push({ transactionId: String(tx._id) });
    const fus: any[] = await this.db.collection('followups').find({ $or: or }).sort({ createdAt: -1 }).toArray();
    return { ref, shop, tx, fus };
  }

  async orderDetail(ref: string, key: ApiKeyDoc) {
    const { shop, tx, fus } = await this.findOrder(ref);
    const openFu = fus.some((f) => !f.cancelled && !FOLLOWUP_SETTLED_STATUSES.includes(f.status));
    const bucket = shop ? confirmationBucket(shop, openFu) : null;
    return orderView({ shop, tx, followups: fus, bucket, phoneMode: key.phoneAccess || 'detail', isDetail: true, withShipping: (key.scopes || []).includes('shipping') });
  }

  async orderFollowups(ref: string, key: ApiKeyDoc) {
    const { ref: r, fus } = await this.findOrder(ref);
    return { orderRef: r, items: fus.map((f) => followupView(f, key.phoneAccess || 'detail', true)) };
  }

  // ── Shipping ──────────────────────────────────────────────────────────────────────────────────
  async orderShipping(ref: string) {
    const { ref: r, tx } = await this.findOrder(ref);
    if (!tx) return { orderRef: r, recorded: false, shipping: null };
    return { orderRef: r, recorded: true, cancelled: !!tx.cancelled, shipping: shippingView(tx, true) };
  }

  async shippingProblems(q: any, key: ApiKeyDoc) {
    const { limit, page, skip } = paging(q);
    const filter: any = { type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true }, shipIssueState: { $in: SHIP_ISSUE_ACTIVE_STATES } };
    if (q?.state) {
      if (!SHIP_ISSUE_ACTIVE_STATES.includes(String(q.state))) throw new BadRequestException({ code: 'BAD_FILTER', message: 'state: attempt | open | awaiting' });
      filter.shipIssueState = String(q.state);
    }
    const [rows, total] = await Promise.all([
      this.db.collection('transactions').find(filter, { projection: TX_PROJECTION }).sort({ shipIssueOpenedAt: -1 }).skip(skip).limit(limit).toArray(),
      this.db.collection('transactions').countDocuments(filter),
    ]);
    return {
      total, page, limit,
      items: rows.map((t: any) => ({ orderRef: t.ref, client: t.client || '', phone: phoneFor(t.phone, key.phoneAccess || 'detail', false), shipping: shippingView(t, false) })),
    };
  }

  // ── Follow-ups ────────────────────────────────────────────────────────────────────────────────
  async listFollowups(q: any, key: ApiKeyDoc) {
    const { limit, page, skip } = paging(q);
    const filter: any = {};
    const st = String(q?.status || 'open');
    if (st === 'open') Object.assign(filter, FOLLOWUP_OPEN_FILTER);
    else if (st === 'closed') filter.$or = [{ cancelled: true }, { status: { $in: FOLLOWUP_SETTLED_STATUSES } }];
    else if (st !== 'all') throw new BadRequestException({ code: 'BAD_FILTER', message: 'status: open | closed | all' });
    if (q?.from || q?.to) {
      const range = dayRange(q, 7, 92);
      filter.createdAt = { $gte: new Date(range.fromMs), $lt: new Date(range.toMs) };
    }
    if (q?.updatedSince) {
      const d = new Date(String(q.updatedSince));
      if (Number.isNaN(d.getTime())) throw new BadRequestException({ code: 'BAD_DATE', message: 'updatedSince غير صالح' });
      filter.updatedAt = { $gt: d };
    }
    if (q?.orderRef) filter.orderRef = String(q.orderRef).replace(/^#/, '');
    if (q?.responsible) filter.responsibleName = String(q.responsible);
    const [rows, total] = await Promise.all([
      this.db.collection('followups').find(filter, { projection: { comments: { $slice: -1 }, ticketNo: 1, status: 1, cancelled: 1, reason: 1, reasonOther: 1, responsibleName: 1, deferredUntil: 1, createdAt: 1, updatedAt: 1, orderRef: 1, clientName: 1, clientPhone: 1, autoSource: 1, resolution: 1, closedAt: 1 } })
        .sort({ updatedAt: -1 }).skip(skip).limit(limit).toArray(),
      this.db.collection('followups').countDocuments(filter),
    ]);
    return { total, page, limit, items: rows.map((f) => ({ ...followupView(f, key.phoneAccess || 'detail', false), updatedAt: f.updatedAt ? new Date(f.updatedAt).toISOString() : null })) };
  }

  async followupDetail(id: string, key: ApiKeyDoc) {
    if (!ObjectId.isValid(id)) throw new NotFoundException({ code: 'FOLLOWUP_NOT_FOUND', message: 'المتابعة غير موجودة' });
    const f = await this.db.collection('followups').findOne({ _id: new ObjectId(id) });
    if (!f) throw new NotFoundException({ code: 'FOLLOWUP_NOT_FOUND', message: 'المتابعة غير موجودة' });
    return followupView(f, key.phoneAccess || 'detail', true);
  }

  /** The only write: a note on a follow-up thread, posted as the key's account. */
  async addNote(followupId: string, body: any, key: ApiKeyDoc) {
    if (!ObjectId.isValid(followupId)) throw new NotFoundException({ code: 'FOLLOWUP_NOT_FOUND', message: 'المتابعة غير موجودة' });
    const text = String(body?.text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f‪-‮⁦-⁩]/g, '').trim();
    if (!text) throw new BadRequestException({ code: 'TEXT_REQUIRED', message: 'نص الملاحظة مطلوب' });
    if (text.length > 2000) throw new BadRequestException({ code: 'TEXT_TOO_LONG', message: 'أقصى طول للملاحظة 2000 حرف' });
    const author = String(body?.author ?? '').replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, '').trim().slice(0, 60);
    const requestId = body?.requestId === undefined ? undefined : String(body.requestId);
    if (requestId !== undefined && !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw new BadRequestException({ code: 'BAD_REQUEST_ID', message: 'requestId: 8–64 حرفًا (حروف/أرقام/-/_)' });
    if (!key.linkedUserId) throw new ForbiddenException({ code: 'NO_LINKED_USER', message: 'المفتاح غير مربوط بحساب مستخدم' });
    const authorName = author && author !== key.linkedUserName ? `${key.linkedUserName} — ${author}` : key.linkedUserName;
    let doc: any;
    try {
      doc = await this.followups.addComment(followupId, key.linkedUserId, authorName, text, requestId ? 'api-' + requestId : undefined);
    } catch (e: any) {
      if (e instanceof HttpException && e.getStatus() === 403) throw new ForbiddenException({ code: 'FOLLOWUP_CLOSED', message: e.message });
      throw e;
    }
    if (!doc) throw new NotFoundException({ code: 'FOLLOWUP_NOT_FOUND', message: 'المتابعة غير موجودة' });
    try { this.presence.emitEvent('followup:changed', { action: 'update', id: followupId }); } catch { /* best effort */ }
    const comments: any[] = Array.isArray(doc.comments) ? doc.comments : [];
    const mine = [...comments].reverse().find((c) => c.authorId === key.linkedUserId && c.text === text);
    return { ok: true, followupId, orderRef: doc.orderRef || '', note: mine ? { id: String(mine._id), author: mine.authorName, text: mine.text, at: mine.createdAt ? new Date(mine.createdAt).toISOString() : null } : null };
  }

  async addNoteToOrder(ref: string, body: any, key: ApiKeyDoc) {
    const { ref: r, fus } = await this.findOrder(ref);
    const open = fus.find((f) => !f.cancelled && !FOLLOWUP_SETTLED_STATUSES.includes(f.status) && !f.orderOutcome);
    if (!open) throw new NotFoundException({ code: 'NO_OPEN_FOLLOWUP', message: `لا توجد متابعة مفتوحة على الأوردر ${r}` });
    return this.addNote(String(open._id), body, key);
  }

  // ── Mentions ──────────────────────────────────────────────────────────────────────────────────
  private mentionFilter(key: ApiKeyDoc) {
    if (!key.linkedUserId) throw new ForbiddenException({ code: 'NO_LINKED_USER', message: 'المفتاح غير مربوط بحساب مستخدم' });
    return { targetUserId: key.linkedUserId };
  }

  async listMentions(q: any, key: ApiKeyDoc) {
    const filter: any = this.mentionFilter(key);
    if (q?.since) {
      const d = new Date(String(q.since));
      if (Number.isNaN(d.getTime())) throw new BadRequestException({ code: 'BAD_DATE', message: 'since غير صالح' });
      filter.createdAt = { $gt: d };
    }
    if (q?.unread === '1' || q?.unread === 'true') filter.read = false;
    const limit = Math.min(100, Math.max(1, Number(q?.limit) || 50));
    const rows = await this.db.collection('mentions').find(filter).sort({ createdAt: q?.since ? 1 : -1 }).limit(limit).toArray();
    const items = [];
    for (const m of rows) items.push(await mentionView(this.db, m));
    return { items, next: rows.length ? new Date((rows[rows.length - 1] as any).createdAt).toISOString() : null };
  }

  async markMentionRead(id: string, key: ApiKeyDoc) {
    if (!ObjectId.isValid(id)) throw new NotFoundException({ code: 'MENTION_NOT_FOUND', message: 'الإشعار غير موجود' });
    const res = await this.db.collection('mentions').updateOne({ _id: new ObjectId(id), ...this.mentionFilter(key) }, { $set: { read: true } });
    if (!res.matchedCount) throw new NotFoundException({ code: 'MENTION_NOT_FOUND', message: 'الإشعار غير موجود' });
    return { ok: true };
  }

  // ── Complaints ────────────────────────────────────────────────────────────────────────────────
  async listComplaints(q: any, key: ApiKeyDoc) {
    const { limit, page, skip } = paging(q);
    const filter: any = {};
    if (q?.categoryGroup) filter.categoryGroup = String(q.categoryGroup);
    if (q?.category) filter.category = String(q.category);
    if (q?.status) filter.status = String(q.status);
    if (q?.orderRef) filter.transactionRef = String(q.orderRef).replace(/^#/, '');
    if (q?.from || q?.to) {
      const range = dayRange(q, 30, 92);
      filter.createdAt = { $gte: new Date(range.fromMs), $lt: new Date(range.toMs) };
    }
    const [rows, total, groups] = await Promise.all([
      this.db.collection('complaints').find(filter, { projection: { attachments: 0, items: 0, workflow: 0, surveyToken: 0, surveySlug: 0 } }).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray(),
      this.db.collection('complaints').countDocuments(filter),
      this.db.collection('complaints').aggregate([{ $group: { _id: { g: '$categoryGroup', c: '$category' }, n: { $sum: 1 } } }]).toArray(),
    ]);
    return {
      total, page, limit,
      categories: groups.map((g: any) => ({ categoryGroup: g._id?.g || '', category: g._id?.c || '', count: g.n })),
      items: rows.map((c) => complaintView(c, key.phoneAccess || 'detail', false)),
    };
  }

  async complaintDetail(id: string, key: ApiKeyDoc) {
    const filter: any = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { complaintNo: String(id) };
    const c = await this.db.collection('complaints').findOne(filter, { projection: { attachments: 0, workflow: 0, surveyToken: 0, surveySlug: 0 } });
    if (!c) throw new NotFoundException({ code: 'COMPLAINT_NOT_FOUND', message: 'الشكوى غير موجودة' });
    return complaintView(c, key.phoneAccess || 'detail', true);
  }

  // ── Inventory ─────────────────────────────────────────────────────────────────────────────────
  async inventory(q: any) {
    const [inv, breakdown] = await Promise.all([this.transactions.getInventory(), this.transactions.getInventoryBreakdown()]);
    const term = String(q?.q || '').trim().toLowerCase();
    const rows = inv.map((p: any) => {
      const b: any = (breakdown as any)[String(p._id)] || { byWarehouse: {}, incoming: 0 };
      let reserved = 0, attention = 0;
      for (const w of Object.values(b.byWarehouse || {}) as any[]) {
        reserved += Number(w.reserved) || 0;
        attention += (Number(w.damaged) || 0) + (Number(w.lost) || 0) + (Number(w.inspection) || 0);
      }
      const balance = Number(p.current) || 0;
      const ready = Math.max(0, balance - attention);
      const state = balance < 0 ? 'negative' : ready <= 0 ? 'out' : ready <= (Number(p.minStock) || 0) ? 'low' : 'ok';
      return {
        code: p.code || '', name: p.name || '',
        readyToSell: ready, reserved, needsAttention: attention, inStock: balance + reserved, balance,
        incoming: Number(b.incoming) || 0, minStock: Number(p.minStock) || 0, state,
      };
    }).filter((r) => (!term || r.code.toLowerCase().includes(term) || r.name.toLowerCase().includes(term))
      && (!q?.state || r.state === String(q.state)));
    rows.sort((a, b) => b.readyToSell - a.readyToSell);
    const { limit, page, skip } = paging(q, 500);
    return { total: rows.length, page, limit, items: rows.slice(skip, skip + limit) };
  }

  // ── Daily sales report ────────────────────────────────────────────────────────────────────────
  async dailyReport(q: any) {
    const date = q?.date ? String(q.date) : cairoToday();
    if (!DAY.test(date)) throw new BadRequestException({ code: 'BAD_DATE', message: 'date بصيغة YYYY-MM-DD' });
    const r: any = await this.transactions.getReports(date, date, 0);
    const fromMs = cairoDayStart(date), toMs = cairoDayStart(addDays(date, 1));
    const candidates: any[] = await this.db.collection('shopifyorders').find(
      { createdAt: { $gte: new Date(fromMs - 3 * 864e5) } },
      { projection: { status: 1, cancelled: 1, shopifyCreatedAt: 1, createdAt: 1, depositAmount: 1, shipWithoutDeposit: 1, 'depositReceipts.status': 1, 'depositReceipts.amount': 1 } },
    ).toArray();
    const orders = candidates.filter((o) => { const ms = new Date(o.shopifyCreatedAt || o.createdAt || 0).getTime(); return ms >= fromMs && ms < toMs; });
    const ids = orders.map((o) => String(o._id));
    const fus: any[] = ids.length ? await this.db.collection('followups').find({ shopifyOrderId: { $in: ids }, ...FOLLOWUP_OPEN_FILTER }, { projection: { shopifyOrderId: 1 } }).toArray() : [];
    const openFu = new Set(fus.map((f) => String(f.shopifyOrderId)));
    const c: Record<ConfirmationBucket, number> = { deposit: 0, nodep: 0, followup: 0, open: 0, cancelled: 0 };
    for (const o of orders) c[confirmationBucket(o, openFu.has(String(o._id)))]++;
    const confirmed = c.deposit + c.nodep;
    const n = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
    return {
      date,
      sales: {
        netSales: n(r.totalSales), grossSales: n(r.grossSales), discounts: n(r.totalDiscounts),
        returns: n(r.totalReturns), returnCount: Number(r.returnCount) || 0,
        orders: Number(r.orderCount) || 0, averageOrder: n(r.avgOrderValue), shippingCollected: n(r.shippingCollected),
      },
      shopifyIntake: {
        received: orders.length, confirmed, confirmedWithDeposit: c.deposit, confirmedWithoutDeposit: c.nodep,
        inFollowUp: c.followup, noActionYet: c.open, cancelled: c.cancelled,
        confirmationRate: orders.length ? Math.round((confirmed / orders.length) * 1000) / 10 : null,
      },
    };
  }
}
