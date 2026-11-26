import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleInit, forwardRef } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ObjectId } from 'mongodb';
import { TransactionsService } from '../transactions/transactions.service';
import { ReportsExportService } from '../transactions/reports-export.service';
import { PurchasingEngineService } from '../purchasing-engine/purchasing-engine.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { MentionsService } from '../mentions/mentions.service';
import { DemandPlanningService } from '../demand-planning/demand-planning.service';
import { PresenceGateway } from '../auth/presence.gateway';
import { ApiKeyDoc } from './api-keys.service';
import { abcClass, PRIORITY_RANK, suggestPurchase, SuggestionLine } from './purchase-suggestion.util';
import { addDays, cairoDayStart, cairoToday } from './public-api.service';

/**
 * Products, monthly sales ranking, purchase suggestions and purchase-order DRAFTS for the external API.
 *
 * ⚠ A draft (`apipurchasedrafts`, raw) is NOT a purchase order: nothing reads it as incoming stock.
 * It becomes a real PO («معلق», `PurchaseOrdersService.create`) only when an admin approves it.
 * ⚠ No purchase price or cost leaves through the API (owner's decision): suggestions, drafts and
 * the PDF carry quantities only. The approved PO itself is priced inside SOULIA as usual.
 */
const SENDER = 'نظام أوامر الشراء الآلية';
const LATE_HOURS = 48;
const MAX_LINES = 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;

type DraftLine = { productId: string; code: string; name: string; qty: number; suggestedQty: number | null; note: string };
type Draft = {
  _id: ObjectId; draftNo: string; seq: number; keyId: string; keyName: string; requestId: string;
  supplierId: string; supplierName: string; lines: DraftLine[]; expectedDeliveryDate: string; notes: string;
  status: 'pending' | 'approving' | 'approved' | 'rejected'; createdAt: Date;
  decidedAt?: Date; decidedBy?: string; rejectReason?: string; poId?: string; poNumber?: string;
  history: { at: Date; by: string; action: string; detail?: string }[];
};

const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u202A-\u202E\u2066-\u2069]/g, '').trim().slice(0, max);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

@Injectable()
export class PurchasingApiService implements OnModuleInit {
  private readonly logger = new Logger(PurchasingApiService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Inject(forwardRef(() => TransactionsService)) private readonly transactions: TransactionsService,
    private readonly engine: PurchasingEngineService,
    private readonly pdf: ReportsExportService,
    private readonly purchaseOrders: PurchaseOrdersService,
    private readonly mentions: MentionsService,
    private readonly presence: PresenceGateway,
    @Inject(forwardRef(() => DemandPlanningService)) private readonly demand: DemandPlanningService,
  ) {}

  private get db() { return this.connection.db!; }
  private get drafts() { return this.db.collection<Draft>('apipurchasedrafts'); }

  async onModuleInit() {
    try {
      await this.drafts.createIndex({ seq: 1 }, { unique: true });
      await this.drafts.createIndex({ keyId: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string', $gt: '' } } });
      await this.drafts.createIndex({ status: 1, createdAt: -1 });
    } catch (e: any) { this.logger.warn(`Draft indexes: ${e.message}`); }
  }

  // ── Products: active / inactive ───────────────────────────────────────────────────────────────
  async products(q: any) {
    const status = String(q?.status || 'all');
    if (!['all', 'active', 'inactive'].includes(status)) throw new BadRequestException({ code: 'BAD_FILTER', message: 'status: active | inactive | all' });
    const [rows, inventory, breakdown, cats] = await Promise.all([
      this.db.collection('products').find({}, { projection: { code: 1, name: 1, isActive: 1, categoryId: 1, collectionId: 1, minStock: 1, supplier: 1, createdAt: 1, updatedAt: 1 } }).toArray(),
      this.transactions.getInventory(),
      this.transactions.getInventoryBreakdown(),
      this.db.collection('categories').find({}, { projection: { name: 1 } }).toArray().catch(() => [] as any[]),
    ]);
    const catName = new Map(cats.map((c: any) => [String(c._id), c.name]));
    const inv = new Map(inventory.map((i: any) => [String(i._id), i]));
    const term = String(q?.q || '').trim().toLowerCase();
    const list = rows.map((p: any) => {
      const id = String(p._id);
      const it: any = inv.get(id) || {};
      let attention = 0;
      for (const w of Object.values<any>((breakdown as any)?.[id]?.byWarehouse || {})) attention += (Number(w.damaged) || 0) + (Number(w.lost) || 0) + (Number(w.inspection) || 0);
      const balance = Number(it.current) || 0;
      return {
        code: p.code || '', name: p.name || '', active: p.isActive !== false,
        category: catName.get(String(p.categoryId || '')) || '', supplier: p.supplier || '',
        readyToSell: Math.max(0, balance - attention), balance, minStock: Number(p.minStock) || 0,
        createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
      };
    }).filter((r) => (status === 'all' || (status === 'active') === r.active)
      && (!term || r.code.toLowerCase().includes(term) || r.name.toLowerCase().includes(term)));
    list.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
    const limit = Math.min(500, Math.max(1, Number(q?.limit) || 200));
    const page = Math.max(1, Number(q?.page) || 1);
    return {
      total: list.length, active: list.filter((r) => r.active).length, inactive: list.filter((r) => !r.active).length,
      page, limit, items: list.slice((page - 1) * limit, page * limit),
    };
  }

  // ── Sales by product in a period (default: this month), with the previous period beside it ──
  private period(q: any): { from: string; to: string; label: string; prevFrom: string; prevTo: string } {
    const today = cairoToday();
    if (q?.from || q?.to) {
      const from = String(q.from || ''), to = String(q.to || today);
      if (!DAY.test(from) || !DAY.test(to) || from > to) throw new BadRequestException({ code: 'BAD_DATE', message: 'from/to بصيغة YYYY-MM-DD و from قبل to' });
      const len = Math.round((cairoDayStart(to) - cairoDayStart(from)) / 864e5) + 1;
      if (len > 366) throw new BadRequestException({ code: 'RANGE_TOO_LONG', message: 'أقصى مدة 366 يومًا' });
      return { from, to, label: `${from}..${to}`, prevFrom: addDays(from, -len), prevTo: addDays(from, -1) };
    }
    const month = String(q?.month || today.slice(0, 7));
    if (!MONTH.test(month)) throw new BadRequestException({ code: 'BAD_DATE', message: 'month بصيغة YYYY-MM' });
    const [y, m] = month.split('-').map(Number);
    const from = `${month}-01`;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const to = last > today && from <= today ? today : last;
    const pm = new Date(Date.UTC(y, m - 2, 1));
    const prevFrom = pm.toISOString().slice(0, 10);
    const prevLast = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
    // A running month is compared with the same days of the previous month.
    const days = Number(to.slice(8)) ;
    const prevTo = to === last ? prevLast : (addDays(prevFrom, days - 1) < prevLast ? addDays(prevFrom, days - 1) : prevLast);
    return { from, to, label: month, prevFrom, prevTo };
  }

  async salesByProduct(q: any) {
    const p = this.period(q);
    const [cur, prev, products] = await Promise.all([
      this.transactions.getReports(p.from, p.to, 0) as Promise<any>,
      this.transactions.getReports(p.prevFrom, p.prevTo, 0) as Promise<any>,
      this.db.collection('products').find({}, { projection: { code: 1, name: 1, isActive: 1 } }).toArray(),
    ]);
    // ⚠ Same figures as the reports page: `productProfits` (units + sales after the invoice discount),
    // keyed by the sold line's product NAME. Cost and profit are dropped here.
    const byName = (r: any) => new Map<string, { qty: number; rev: number }>((r?.productProfits || []).map((x: any) => [String(x.name || '').trim(), { qty: Number(x.qty) || 0, rev: Number(x.rev) || 0 }]));
    const curMap = byName(cur), prevMap = byName(prev);
    const known = new Set<string>();
    const includeInactive = q?.includeInactive === '1' || q?.includeInactive === 'true';
    const rows: { code: string; name: string; active: boolean; units: number; netSales: number; previousUnits: number }[] = [];
    for (const pr of products as any[]) {
      const name = String(pr.name || '').trim();
      known.add(name);
      const c = curMap.get(name), v = prevMap.get(name);
      const active = pr.isActive !== false;
      if (!active && !includeInactive && !(c && c.qty > 0)) continue;
      rows.push({ code: pr.code || '', name, active, units: c?.qty || 0, netSales: Math.round((c?.rev || 0) * 100) / 100, previousUnits: v?.qty || 0 });
    }
    // Sold lines whose product no longer exists (deleted / renamed) still count in the totals.
    for (const [name, c] of curMap) if (!known.has(name) && c.qty > 0) rows.push({ code: '', name, active: false, units: c.qty, netSales: Math.round(c.rev * 100) / 100, previousUnits: prevMap.get(name)?.qty || 0 });
    const ranked = abcClass(rows).map((r) => ({
      ...r,
      changePct: r.previousUnits > 0 ? Math.round(((r.units - r.previousUnits) / r.previousUnits) * 1000) / 10 : r.units > 0 ? null : 0,
      status: r.units === 0 ? 'not-selling' : r.class === 'A' ? 'top' : r.class === 'B' ? 'steady' : 'slow',
    }));
    const totalUnits = rows.reduce((s, r) => s + r.units, 0);
    return {
      period: { from: p.from, to: p.to, label: p.label }, previousPeriod: { from: p.prevFrom, to: p.prevTo },
      summary: {
        totalUnits, previousUnits: rows.reduce((s, r) => s + r.previousUnits, 0),
        netSales: Math.round(rows.reduce((s, r) => s + r.netSales, 0) * 100) / 100,
        productsSold: rows.filter((r) => r.units > 0).length, productsNotSold: rows.filter((r) => r.units === 0).length,
        classA: ranked.filter((r) => r.class === 'A').length, classB: ranked.filter((r) => r.class === 'B').length, classC: ranked.filter((r) => r.class === 'C').length,
      },
      method: 'ABC by units: A = products making the first 80% of units, B = next 15%, C = the rest that sold, D = none sold. Units and sales = the reports page (cancelled orders excluded, returns not subtracted per product).',
      items: ranked,
    };
  }

  // ── Purchase suggestions (engine + pending/late orders) ───────────────────────────────────────
  private async pendingOrderUnits(): Promise<Map<string, { units: number; lateUnits: number; lateOrders: number }>> {
    const orders: any[] = await this.db.collection('shopifyorders').find(
      { status: 'pending', cancelled: { $ne: true } }, { projection: { items: 1, shopifyCreatedAt: 1, createdAt: 1 } },
    ).toArray();
    const lateBefore = Date.now() - LATE_HOURS * 3600_000;
    const map = new Map<string, { units: number; lateUnits: number; lateOrders: number }>();
    for (const o of orders) {
      const late = new Date(o.shopifyCreatedAt || o.createdAt || Date.now()).getTime() < lateBefore;
      const seen = new Set<string>();
      for (const it of o.items || []) {
        const code = String(it.code || '').trim();
        if (!code) continue;
        const q = Number(it.qty) || 0;
        const e = map.get(code) || { units: 0, lateUnits: 0, lateOrders: 0 };
        e.units += q;
        if (late) { e.lateUnits += q; if (!seen.has(code)) { e.lateOrders++; seen.add(code); } }
        map.set(code, e);
      }
    }
    return map;
  }

  async suggestions(q: any) {
    const today = cairoToday();
    const [run, pend, prods, sups] = await Promise.all([
      this.engine.run(today),
      this.pendingOrderUnits(),
      this.db.collection('products').find({}, { projection: { code: 1, supplierId: 1, supplier: 1 } }).toArray(),
      this.db.collection('suppliers').find({}, { projection: { name: 1 } }).toArray(),
    ]);
    // Many products carry the supplier by name only (supplierId ''); match the name like the ledger does.
    const norm = (s: unknown) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const supplierByName = new Map((sups as any[]).map((s) => [norm(s.name), String(s._id)]));
    const supplierIdByCode = new Map((prods as any[]).map((p) => [String(p.code || '').trim(), String(p.supplierId || '') || supplierByName.get(norm(p.supplier)) || '']));
    let lines: (SuggestionLine & { supplierId: string; score: number })[] = run.plans.map((p) => {
      const e = pend.get(p.code) || { units: 0, lateUnits: 0, lateOrders: 0 };
      return { ...suggestPurchase(p, { pendingUnits: e.units, lateUnits: e.lateUnits, lateOrders: e.lateOrders }, today), supplierId: supplierIdByCode.get(p.code) || '', score: p.score };
    });
    const show = String(q?.show || 'needed');
    if (show === 'needed') lines = lines.filter((l) => l.suggestedQty > 0);
    else if (show === 'watch') lines = lines.filter((l) => l.suggestedQty > 0 || l.priority === 'watch');
    else if (show !== 'all') throw new BadRequestException({ code: 'BAD_FILTER', message: 'show: needed | watch | all' });
    if (q?.supplierId) lines = lines.filter((l) => l.supplierId === String(q.supplierId));
    if (q?.code) lines = lines.filter((l) => l.code === String(q.code));
    lines.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.score - a.score || b.suggestedQty - a.suggestedQty);
    const groups = new Map<string, { supplierId: string; supplier: string; lines: number; units: number }>();
    for (const l of lines) if (l.suggestedQty > 0) {
      const k = l.supplierId || 'none:' + l.supplier;
      const g = groups.get(k) || { supplierId: l.supplierId, supplier: l.supplier || '', lines: 0, units: 0 };
      g.lines++; g.units += l.suggestedQty; groups.set(k, g);
    }
    return {
      asOf: run.builtAt, today,
      method: {
        summary: 'Purchasing engine (backtested forecast, 95% service, lead time per supplier) + units owed to unconfirmed orders.',
        formula: [
          'available = ready to sell − units on unconfirmed (pending) orders',
          'position = available + incoming (open purchase orders)',
          'demand over horizon = forecast daily demand × (lead time + 7-day review)',
          'reorder level = demand over horizon + safety stock (95% service)',
          'order-up-to = reorder level + 7 days of demand, never below the minimum stock',
          'if position ≤ reorder level or position < minimum: suggested = ⌈order-up-to − position⌉',
        ],
        lateOrderHours: LATE_HOURS,
        notes: 'Out-of-stock days are not counted as zero demand; cancellations for "out of stock" count as lost demand. The forecast method per product is the one with the lowest backtest error.',
      },
      bySupplier: [...groups.values()].sort((a, b) => b.units - a.units),
      total: lines.length,
      items: lines.map(({ score, ...l }) => l),
    };
  }

  // ── Drafts ────────────────────────────────────────────────────────────────────────────────────
  private present(d: Draft, withHistory = false) {
    return {
      id: String(d._id), draftNo: d.draftNo, status: d.status === 'approving' ? 'pending' : d.status,
      supplierId: d.supplierId, supplier: d.supplierName, expectedDeliveryDate: d.expectedDeliveryDate || null, notes: d.notes || '',
      lines: d.lines.map((l) => ({ code: l.code, name: l.name, qty: l.qty, suggestedQty: l.suggestedQty, note: l.note || '' })),
      totalUnits: d.lines.reduce((s, l) => s + l.qty, 0),
      createdAt: d.createdAt, createdBy: d.keyName,
      decidedAt: d.decidedAt || null, decidedBy: d.decidedBy || '', rejectReason: d.rejectReason || '',
      purchaseOrder: d.poNumber ? { id: d.poId, poNumber: d.poNumber } : null,
      ...(withHistory ? { history: d.history || [] } : {}),
    };
  }

  async createDraft(body: any, key: ApiKeyDoc) {
    const requestId = body?.requestId === undefined ? '' : String(body.requestId);
    if (requestId && !/^[A-Za-z0-9_-]{8,64}$/.test(requestId)) throw new BadRequestException({ code: 'BAD_REQUEST_ID', message: 'requestId: 8–64 حرفًا (حروف/أرقام/-/_)' });
    if (requestId) {
      const prev = await this.drafts.findOne({ keyId: String(key._id), requestId });
      if (prev) return { draft: this.present(prev), duplicate: true };
    }
    const supplierId = String(body?.supplierId || '');
    if (!ObjectId.isValid(supplierId)) throw new BadRequestException({ code: 'SUPPLIER_REQUIRED', message: 'supplierId مطلوب (من /purchasing/suggestions)' });
    const supplier: any = await this.db.collection('suppliers').findOne({ _id: new ObjectId(supplierId) }, { projection: { name: 1 } });
    if (!supplier) throw new NotFoundException({ code: 'SUPPLIER_NOT_FOUND', message: 'المورد غير موجود' });
    const raw = Array.isArray(body?.lines) ? body.lines : [];
    if (!raw.length) throw new BadRequestException({ code: 'LINES_REQUIRED', message: 'أضف صنفًا واحدًا على الأقل' });
    if (raw.length > MAX_LINES) throw new BadRequestException({ code: 'TOO_MANY_LINES', message: `أقصى ${MAX_LINES} صنف` });
    const codes = raw.map((l: any) => clean(l?.code, 60));
    if (new Set(codes).size !== codes.length) throw new BadRequestException({ code: 'DUPLICATE_LINE', message: 'كل صنف مرة واحدة فقط' });
    const products: any[] = await this.db.collection('products').find({ code: { $in: codes } }, { projection: { code: 1, name: 1, isActive: 1 } }).toArray();
    const byCode = new Map(products.map((p) => [String(p.code), p]));
    let suggested = new Map<string, number>();
    try {
      const s = await this.suggestions({ show: 'all' });
      suggested = new Map(s.items.map((l) => [l.code, l.suggestedQty]));
    } catch (e: any) { this.logger.warn(`Suggestion snapshot failed: ${e.message}`); }
    const lines: DraftLine[] = raw.map((l: any, i: number) => {
      const p = byCode.get(codes[i]);
      if (!p) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND', message: `لا يوجد منتج بالكود ${codes[i]}`, line: i });
      if (p.isActive === false) throw new BadRequestException({ code: 'PRODUCT_INACTIVE', message: `المنتج ${codes[i]} غير نشط`, line: i });
      const qty = Number(l?.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 100000) throw new BadRequestException({ code: 'BAD_QTY', message: `الكمية في السطر ${i + 1} يجب أن تكون عددًا صحيحًا من 1 إلى 100000`, line: i });
      return { productId: String(p._id), code: String(p.code), name: String(p.name || ''), qty, suggestedQty: suggested.has(String(p.code)) ? suggested.get(String(p.code))! : null, note: clean(l?.note, 200) };
    });
    const expected = body?.expectedDeliveryDate ? String(body.expectedDeliveryDate) : '';
    if (expected && !DAY.test(expected)) throw new BadRequestException({ code: 'BAD_DATE', message: 'expectedDeliveryDate بصيغة YYYY-MM-DD' });
    const now = new Date();
    for (let attempt = 0; attempt < 10; attempt++) {
      const last = await this.drafts.find({}, { projection: { seq: 1 } }).sort({ seq: -1 }).limit(1).next();
      const seq = (last?.seq || 0) + 1;
      const doc: Omit<Draft, '_id'> = {
        draftNo: 'APO-' + String(seq).padStart(4, '0'), seq, keyId: String(key._id), keyName: key.name, requestId,
        supplierId, supplierName: String(supplier.name || ''), lines, expectedDeliveryDate: expected, notes: clean(body?.notes, 1000),
        status: 'pending', createdAt: now, history: [{ at: now, by: key.name, action: 'created', detail: `${lines.length} lines` }],
      };
      try {
        const res = await this.drafts.insertOne(doc as any);
        const saved = (await this.drafts.findOne({ _id: res.insertedId }))!;
        this.notifyAdmins(`🧾 طلب أمر شراء جديد من ${key.name}\nالرقم: ${saved.draftNo}\nالمورد: ${saved.supplierName}\n${lines.length} صنف · ${lines.reduce((s, l) => s + l.qty, 0)} قطعة\nبانتظار موافقتك من الإعدادات ← التكاملات ← API.`, 'api-po:' + String(saved._id)).catch(() => undefined);
        try { this.presence.emitEvent('api-po:changed', { id: String(saved._id) }); } catch { /* best effort */ }
        return { draft: this.present(saved), duplicate: false };
      } catch (e: any) {
        if (e?.code !== 11000) throw e;
        if (requestId) {
          const prev = await this.drafts.findOne({ keyId: String(key._id), requestId });
          if (prev) return { draft: this.present(prev), duplicate: true };
        }
      }
    }
    throw new ConflictException({ code: 'BUSY', message: 'تعذّر حجز رقم للطلب، أعد المحاولة' });
  }

  async listDrafts(q: any, keyId?: string) {
    const filter: any = {};
    if (keyId) filter.keyId = keyId;
    const st = String(q?.status || '');
    if (st === 'pending') filter.status = { $in: ['pending', 'approving'] };
    else if (st === 'approved' || st === 'rejected') filter.status = st;
    else if (st) throw new BadRequestException({ code: 'BAD_FILTER', message: 'status: pending | approved | rejected' });
    const limit = Math.min(100, Math.max(1, Number(q?.limit) || 50));
    const rows = await this.drafts.find(filter).sort({ createdAt: -1 }).limit(limit).toArray();
    return { items: rows.map((d) => this.present(d)) };
  }

  private async loadDraft(id: string, keyId?: string): Promise<Draft> {
    const filter: any = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { draftNo: String(id).toUpperCase() };
    if (keyId) filter.keyId = keyId;
    const d = await this.drafts.findOne(filter);
    if (!d) throw new NotFoundException({ code: 'DRAFT_NOT_FOUND', message: 'طلب أمر الشراء غير موجود' });
    return d;
  }

  async getDraft(id: string, keyId?: string) { return this.present(await this.loadDraft(id, keyId), true); }

  /** Admin: turns a draft into a real PO («معلق»). Quantities may be adjusted; 0 drops a line. */
  async approveDraft(id: string, body: any, actor: { name: string }) {
    const d = await this.loadDraft(id);
    if (d.status !== 'pending') throw new ConflictException({ code: 'DRAFT_DECIDED', message: 'تم البت في هذا الطلب بالفعل' });
    const overrides = new Map<string, number>();
    for (const l of Array.isArray(body?.lines) ? body.lines : []) {
      const q = Number(l?.qty);
      if (!Number.isInteger(q) || q < 0 || q > 100000) throw new BadRequestException('كمية غير صالحة');
      overrides.set(String(l?.code || ''), q);
    }
    const lines = d.lines.map((l) => ({ ...l, qty: overrides.has(l.code) ? overrides.get(l.code)! : l.qty })).filter((l) => l.qty > 0);
    if (!lines.length) throw new BadRequestException('لا يوجد صنف بكمية أكبر من صفر');
    // Atomic claim: two admins approving at once create one PO.
    const claimed = await this.drafts.findOneAndUpdate({ _id: d._id, status: 'pending' }, { $set: { status: 'approving' } }, { returnDocument: 'after' });
    if (!claimed) throw new ConflictException({ code: 'DRAFT_DECIDED', message: 'تم البت في هذا الطلب بالفعل' });
    try {
      // Unit price = this supplier's price on the product, else the card price — as inside SOULIA.
      const ids = lines.map((l) => l.productId);
      const [ps, prods] = await Promise.all([
        this.db.collection('productsuppliers').find({ productId: { $in: ids }, supplierId: d.supplierId, active: { $ne: false } }, { projection: { productId: 1, price: 1 } }).toArray(),
        this.db.collection('products').find({ _id: { $in: ids.filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x)) } }, { projection: { buyPrice: 1, imageUrl: 1 } }).toArray(),
      ]);
      const supPrice = new Map((ps as any[]).filter((r) => typeof r.price === 'number').map((r) => [String(r.productId), Number(r.price)]));
      const prod = new Map((prods as any[]).map((p) => [String(p._id), p]));
      const po: any = await this.purchaseOrders.create({
        supplierId: d.supplierId, supplierName: d.supplierName, expectedDeliveryDate: d.expectedDeliveryDate || '',
        notes: [`من طلب API ${d.draftNo} (${d.keyName})`, d.notes].filter(Boolean).join(' — '),
        items: lines.map((l) => ({ productCode: l.code, productName: l.name, productImage: prod.get(l.productId)?.imageUrl || '', qty: l.qty, unitPrice: supPrice.get(l.productId) ?? (Number(prod.get(l.productId)?.buyPrice) || 0) })),
        createdBy: actor.name,
      } as never);
      const changed = lines.length !== d.lines.length || lines.some((l, i) => l.qty !== d.lines.find((x) => x.code === l.code)?.qty) ? ' (عُدّلت الكميات)' : '';
      await this.drafts.updateOne({ _id: d._id }, {
        $set: { status: 'approved', decidedAt: new Date(), decidedBy: actor.name, poId: String(po._id), poNumber: po.poNumber, lines },
        $push: { history: { at: new Date(), by: actor.name, action: 'approved', detail: po.poNumber + changed } },
      } as any);
      try { this.presence.emitEvent('api-po:changed', { id: String(d._id) }); } catch { /* best effort */ }
      return this.present(await this.loadDraft(id), true);
    } catch (e) {
      await this.drafts.updateOne({ _id: d._id, status: 'approving' }, { $set: { status: 'pending' } }).catch(() => undefined);
      throw e;
    }
  }

  async rejectDraft(id: string, reason: unknown, actor: { name: string }) {
    const why = clean(reason, 300);
    if (why.length < 3) throw new BadRequestException('اكتب سبب الرفض');
    const res = await this.drafts.findOneAndUpdate({ _id: (await this.loadDraft(id))._id, status: 'pending' }, {
      $set: { status: 'rejected', decidedAt: new Date(), decidedBy: actor.name, rejectReason: why },
      $push: { history: { at: new Date(), by: actor.name, action: 'rejected', detail: why } },
    } as any, { returnDocument: 'after' });
    if (!res) throw new ConflictException({ code: 'DRAFT_DECIDED', message: 'تم البت في هذا الطلب بالفعل' });
    try { this.presence.emitEvent('api-po:changed', { id }); } catch { /* best effort */ }
    return this.present(res, true);
  }

  // ── Stock analysis of pending Shopify orders (the Shopify page's «تحليل احتياج المخزون») ─────
  /**
   * Runs the SAME `DemandPlanningService.analyzeShopify` as the page (never logged: `persistLog:false`),
   * over every pending order by default, or the orders named by `refs`. Oldest order first claims the
   * stock; an order is ready only if every product is covered. Cost and prices are removed.
   */
  async orderAnalysis(q: any, key: ApiKeyDoc) {
    const filter: any = { status: 'pending', cancelled: { $ne: true } };
    const refs = String(q?.refs || '').split(',').map((s) => s.replace(/^#/, '').trim()).filter(Boolean);
    if (refs.length > 200) throw new BadRequestException({ code: 'TOO_MANY_LINES', message: 'أقصى 200 أوردر' });
    if (refs.length) filter.ref = { $in: refs };
    const orders: any[] = await this.db.collection('shopifyorders').find(filter, { projection: { _id: 1, ref: 1 } }).toArray();
    if (!orders.length) return { ordersCount: 0, queueSize: 0, summary: null, orders: [], products: [], unlinkedOrders: [], note: refs.length ? 'None of these orders is pending.' : 'No pending orders.' };
    const a: any = await this.demand.analyzeShopify({ orderIds: orders.map((o) => String(o._id)), persistLog: false } as any);
    const BLOCK: Record<string, [string, string]> = {
      'cancel-request': ['عليه طلب إلغاء بانتظار القرار', 'A cancel request awaits a decision'],
      'edit-pending': ['عليه تعديل بانتظار الموافقة', 'An edit awaits approval'],
      'item-conflict': ['تعارض في الأصناف مع Shopify', 'Items conflict with Shopify'],
      'deposit-review': ['إيصال عربون بانتظار المراجعة', 'A deposit receipt awaits review'],
      'deposit-booking': ['عربون لم يُسجَّل في الخزنة بعد', 'A deposit is not booked in the vault yet'],
      'deposit-over': ['العربون أكبر من إجمالي الأوردر', 'The deposit exceeds the order total'],
      'divergence': ['الإجمالي مختلف عن Shopify ويحتاج تأكيدًا', 'The total differs from Shopify and needs acknowledging'],
      'dup-ref': ['رقم الأوردر مستخدم في معاملة أخرى', 'The order number is used by another transaction'],
    };
    const STATE: Record<string, [string, string]> = { ready: ['جاهز للشحن', 'Ready to ship'], short: ['ينقصه مخزون', 'Short of stock'], unlinked: ['صنف غير مربوط بمنتج', 'A line is not linked to a product'] };
    const plan: any[] = a.orderPlan || [];
    const mode = key.phoneAccess || 'detail';
    const phone = (p: unknown) => { const s = String(p ?? ''); return !s ? '' : mode === 'full' ? s : s.replace(/\D/g, '').length >= 7 ? s.replace(/\D/g, '').replace(/^(\d{3})(\d+)(\d{3})$/, (_m, x, mid, z) => x + '•'.repeat(Math.max(3, mid.length)) + z) : '•••'; };
    return {
      generatedAt: a.generatedAt,
      ordersCount: a.ordersCount, queueSize: a.queueSize ?? null,
      rule: 'Oldest order first claims the stock; an order counts as ready only when every product in it is covered, otherwise it takes nothing. Sellable = stock balance − damaged/lost/awaiting inspection; confirmed orders are already out of the balance.',
      summary: {
        ready: plan.filter((o) => o.state === 'ready' && !(o.blocks || []).length).length,
        readyButBlocked: plan.filter((o) => o.state === 'ready' && (o.blocks || []).length).length,
        short: plan.filter((o) => o.state === 'short').length,
        unlinked: (a.unlinkedOrders || []).length,
        products: a.totalSkus, productsShort: a.shortageSkus, productsLow: a.lowSkus,
        unitsRequired: a.totalRequiredQty, unitsShort: a.totalShortageQty, unitsToBuy: a.totalSuggestedPurchaseQty,
      },
      orders: plan.map((o) => ({
        ref: o.ref, client: o.client, date: o.date, position: o.position,
        state: o.state, stateLabel: { ar: STATE[o.state]?.[0] || o.state, en: STATE[o.state]?.[1] || o.state },
        orderTotal: o.orderTotal, deposit: o.deposit,
        blocks: (o.blocks || []).map((b: string) => ({ code: b, ar: BLOCK[b]?.[0] || b, en: BLOCK[b]?.[1] || b })),
        divergence: o.divergence ? { shopifyTotal: o.divergence.shopifyTotal, systemTotal: o.divergence.erpTotal, diff: o.divergence.diff, changes: o.divergence.changes } : null,
        items: (o.items || []).map((i: any) => ({ code: i.sku, name: i.name, qty: i.qty, missing: i.missing, freeAtTurn: i.freeAtTurn })),
      })),
      products: (a.lines || []).map((l: any) => ({
        code: l.sku, name: l.name, supplier: l.supplier, status: l.status, statusLabel: l.statusAr,
        required: l.required, onHand: l.onHand, reservedForConfirmedOrders: l.reservedConfirmed, needsAttention: l.notSellable,
        sellable: l.sellable, claimedByOlderOrders: l.reservedOlder, freeToUse: l.freeToUse, shortage: l.shortage,
        minStock: l.safetyStock, toBuyForTheseOrders: l.suggestedPurchase, ordersCount: l.ordersCount,
        orders: (l.affectedOrders || []).map((o: any) => ({ ref: o.ref, client: o.client, phone: phone(o.phone), date: o.date, qty: o.qty })),
      })),
      unlinkedOrders: (a.unlinkedOrders || []).map((o: any) => ({ ref: o.ref, client: o.client, date: o.date, items: o.items })),
      unknownProducts: a.unknownSkus || [],
      notes: 'toBuyForTheseOrders = shortage + minimum stock (the page\'s figure for these orders). For a forward-looking quantity per product use /purchasing/suggestions.',
    };
  }

  async pendingCount() { return this.drafts.countDocuments({ status: { $in: ['pending', 'approving'] } }); }

  // ── PDF (quantities only) ─────────────────────────────────────────────────────────────────────
  async draftPdf(id: string, keyId?: string): Promise<{ file: Buffer; name: string }> {
    const d = await this.loadDraft(id, keyId);
    const approved = d.status === 'approved' && d.poNumber;
    const title = approved ? `أمر شراء ${d.poNumber}` : d.status === 'rejected' ? `طلب أمر شراء مرفوض ${d.draftNo}` : `طلب أمر شراء ${d.draftNo} — بانتظار الموافقة`;
    const statusAr = approved ? 'معتمد' : d.status === 'rejected' ? 'مرفوض' : 'بانتظار موافقة الإدارة';
    const fmt = (v: any) => (v ? new Intl.DateTimeFormat('ar-EG-u-nu-latn', { timeZone: 'Africa/Cairo', dateStyle: 'medium' }).format(new Date(v)) : '—');
    const rows = d.lines.map((l, i) => `<tr><td class="n">${i + 1}</td><td class="c">${esc(l.code)}</td><td>${esc(l.name)}${l.note ? `<small>${esc(l.note)}</small>` : ''}</td><td class="n q">${l.qty}</td><td class="n">${l.suggestedQty ?? '—'}</td></tr>`).join('');
    const units = d.lines.reduce((s, l) => s + l.qty, 0);
    const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&display=swap">
<style>
@page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;font-family:Cairo,'DejaVu Sans',sans-serif;color:#14201a;font-size:12px}
.page{padding:14mm 13mm}.top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #14532d;padding-bottom:10px}
.brand{font-size:22px;font-weight:700;color:#14532d;letter-spacing:.5px}.t{font-size:17px;font-weight:700;margin:0}.st{display:inline-block;margin-top:4px;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;background:${approved ? '#dcfce7;color:#166534' : d.status === 'rejected' ? '#fee2e2;color:#991b1b' : '#fef3c7;color:#92400e'}}
.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 16px;margin:14px 0;font-size:11.5px}.meta div span{display:block;color:#5b6b62;font-size:10.5px}.meta b{font-weight:600}
table{width:100%;border-collapse:collapse;margin-top:6px}thead{display:table-header-group}th{background:#f1f5f2;font-weight:600;font-size:11px;text-align:right;padding:7px 8px;border-bottom:1px solid #cfd8d2}
td{padding:7px 8px;border-bottom:1px solid #e3e8e5;vertical-align:top}tr{page-break-inside:avoid}td small{display:block;color:#5b6b62;font-size:10px}
.n{text-align:center;font-variant-numeric:tabular-nums;unicode-bidi:isolate}.c{unicode-bidi:isolate;direction:ltr;text-align:right;font-family:'DejaVu Sans Mono',monospace;font-size:11px}.q{font-weight:700;font-size:13px}
tfoot td{font-weight:700;border-top:2px solid #14532d;border-bottom:none}.note{margin-top:14px;padding:9px 11px;background:#f8faf9;border:1px solid #e3e8e5;border-radius:8px;font-size:11px}
.foot{margin-top:26px;font-size:10px;color:#5b6b62;display:flex;justify-content:space-between}
</style></head><body><div class="page">
<div class="top"><div><p class="t">${esc(title)}</p><span class="st">${esc(statusAr)}</span></div><div class="brand">SOULIA</div></div>
<div class="meta">
<div><span>المورد</span><b>${esc(d.supplierName)}</b></div>
<div><span>تاريخ الطلب</span><b>${esc(fmt(d.createdAt))}</b></div>
<div><span>التسليم المتوقع</span><b>${esc(d.expectedDeliveryDate ? fmt(d.expectedDeliveryDate + 'T12:00:00Z') : '—')}</b></div>
<div><span>رقم الطلب</span><b dir="ltr">${esc(d.draftNo)}</b></div>
<div><span>أمر الشراء</span><b dir="ltr">${esc(d.poNumber || '—')}</b></div>
<div><span>${approved || d.status === 'rejected' ? 'قرار الإدارة' : 'أُنشئ بواسطة'}</span><b>${approved || d.status === 'rejected' ? `<bdi>${esc(d.decidedBy || '')}</bdi> · <bdi dir="ltr">${esc(fmt(d.decidedAt))}</bdi>` : `<bdi>${esc(d.keyName)}</bdi>`}</b></div>
</div>
<table><thead><tr><th class="n">#</th><th>الكود</th><th>الصنف</th><th class="n">الكمية المطلوبة</th><th class="n">الكمية المقترحة</th></tr></thead>
<tbody>${rows}</tbody><tfoot><tr><td></td><td></td><td>الإجمالي · ${d.lines.length} صنف</td><td class="n q">${units}</td><td></td></tr></tfoot></table>
${d.notes ? `<div class="note"><b>ملاحظات:</b> ${esc(d.notes)}</div>` : ''}
${d.status === 'rejected' ? `<div class="note"><b>سبب الرفض:</b> ${esc(d.rejectReason)}</div>` : ''}
<div class="foot"><span>الكميات فقط — الأسعار تُحدد داخل SOULIA عند اعتماد أمر الشراء.</span><span>«الكمية المقترحة» = اقتراح محرك الشراء وقت إنشاء الطلب.</span></div>
</div></body></html>`;
    const file = await this.pdf.htmlToPdf(html);
    return { file, name: `${approved ? d.poNumber : d.draftNo}.pdf` };
  }

  private async notifyAdmins(text: string, ref: string) {
    const admins: any[] = await this.db.collection('users').find({ role: 'admin', isActive: { $ne: false } }, { projection: { username: 1, name: 1 } }).toArray();
    if (!admins.length) return;
    const saved: any[] = await this.mentions.createMany(admins.map((a) => ({
      targetUserId: String(a._id), targetUsername: String(a.username || '').toLowerCase(), targetName: a.name || '',
      fromUserId: 'system', fromName: SENDER, txId: ref, txRef: '', commentId: 0, commentText: text,
    })) as any) as any[];
    try {
      for (const m of saved) this.presence.emitToUser(String(m.targetUserId), 'mention:new', {
        id: String(m._id), _id: String(m._id), targetUserId: m.targetUserId, fromUserId: m.fromUserId, fromName: m.fromName,
        txId: m.txId, txRef: m.txRef, commentId: m.commentId, commentText: m.commentText, read: false, ts: new Date().toISOString(),
      });
    } catch { /* best effort */ }
  }
}
