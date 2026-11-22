import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection, Types } from 'mongoose';
import { TransactionsService } from '../transactions/transactions.service';
import { ExpensesService } from '../expenses/expenses.service';
import { SupplierLedgerService } from '../supplier-ledger/supplier-ledger.service';
import { SettingsService } from '../settings/settings.service';
import { inDateWindow, dateWindowQuery } from '../shared/date-window.util';
import { currentUnitCost } from '../shared/avg-cost.util';
import { Cron } from '@nestjs/schedule';
import { PurchasingEngineService } from '../purchasing-engine/purchasing-engine.service';
import { METHOD_LABEL } from '../purchasing-engine/engine.util';
import {
  Period, Understood, addDays, cairoToday, normalizeQuestion, previousPeriod, understand, subjectOf,
} from './assistant-intent.util';

/**
 * «مساعد SOULIA» — answers a typed question from the SAME functions the pages use.
 *
 * Rules (do not loosen):
 *  • Read only. Nothing here writes business data; the only write is the question log.
 *  • Every figure comes from an existing report (`getReports`, `getInventory`, the inventory
 *    breakdown, supplier ledger balances, settings vault balances). Never re-derive a total here —
 *    two formulas for one figure is how the chat and the page start to disagree.
 *  • Permissions are checked per answer with the asker's own role/perms, mirroring the page that
 *    shows the figure. A refused topic says so; it never answers "0".
 */

export interface AssistantUser { userId?: string; username?: string; name?: string; role?: string; perms?: string[] }
type Lang = 'ar' | 'en';
type Fmt = 'money' | 'int' | 'pct' | 'dec';
/** A line in a list of findings — alerts, reasons a figure changed. */
type Tone = 'bad' | 'warn' | 'good' | 'up' | 'down' | 'neutral';
interface Point { t: string; sub?: string; tone?: Tone; link?: Link }
type Seg = string | { v: number; f: Fmt; cite?: number } | { b: string };
type Cell = string | number | { v: number; f: Fmt } | { t: string; link?: Link; sub?: string; tone?: string };
/** Where a source or a table cell leads. `tab`/`from`/`to`/`period`/`filter` reopen the page in the state the answer used. */
interface Link { kind: 'page' | 'order' | 'supplier' | 'product' | 'shopify' | 'po'; page?: string; id?: string; tab?: string; from?: string; to?: string; period?: string; filter?: string }
interface Source { n: number; title: string; detail: string; link?: Link }

export interface AssistantAnswer {
  id: string | null;
  intent: string;
  status: 'answered' | 'denied' | 'unknown' | 'ambiguous' | 'notfound' | 'empty';
  understood: string[];
  steps: string[];
  lead: Seg[];
  kpis?: { label: string; v: number | null; f: Fmt; cite?: number; delta?: number | null; text?: string }[];
  table?: { cols: { label: string; num?: boolean }[]; rows: Cell[][] };
  pointsTitle?: string;
  points?: Point[];
  /** Reorder plan grouped by urgency (rendered as product cards). */
  plan?: { groups: { key: string; title: string; tone: string; rows: any[] }[] };
  /** Buttons under the answer. `createPo` opens the purchase-order dialog with these lines (nothing is created by the answer itself). */
  actions?: { kind: 'createPo'; label: string; lines: { productId: string; sku: string; name: string; qty: number; incoming?: number; ready?: number; unitPrice?: number; supplierId: string; supplier: string }[] }[];
  note?: string;
  options?: string[];
  sources: Source[];
  ms?: number;
}

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REPORT_PERMS = ['reports', 'reports-kpis', 'reports-charts'];
const LOG_COLLECTION = 'assistantquestions';
const MAX_QUESTION = 300;

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly transactions: TransactionsService,
    private readonly expenses: ExpensesService,
    private readonly ledger: SupplierLedgerService,
    private readonly settings: SettingsService,
    private readonly engine: PurchasingEngineService,
  ) {}

  // ── Entry ─────────────────────────────────────────────────────────────────────────────────────
  async ask(user: AssistantUser, body: { question?: string; lang?: string }): Promise<AssistantAnswer> {
    const started = Date.now();
    const question = String(body?.question || '').replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, ' ').trim().slice(0, MAX_QUESTION);
    if (!question) throw new BadRequestException('اكتب سؤالًا');
    const lang: Lang = body?.lang === 'en' ? 'en' : 'ar';
    const L = (ar: string, en: string) => (lang === 'en' ? en : ar);
    const today = cairoToday();
    const u = understand(question, today);

    let answer: Omit<AssistantAnswer, 'id' | 'ms'>;
    try {
      answer = await this.route(u, user, L, lang, today);
    } catch (e: any) {
      this.logger.error(`[assistant] ${u.intent} failed: ${e?.message || e}`);
      answer = {
        intent: u.intent, status: 'empty', understood: [], steps: [],
        lead: [L('تعذّر قراءة البيانات الآن. حاول مرة أخرى بعد قليل.', 'The data could not be read right now. Try again shortly.')],
        sources: [],
      };
    }
    const id = await this.log(user, question, u, answer.status);
    return { ...answer, id, ms: Date.now() - started };
  }

  private async route(u: Understood, user: AssistantUser, L: (a: string, e: string) => string, lang: Lang, today: string): Promise<any> {
    switch (u.intent) {
      // «مبيعات النهارده / امبارح» = the day's incoming Shopify orders (owner, Nov 22, 2026);
      // longer periods are net sales from the reports page.
      case 'sales': return (u.period?.key === 'today' || u.period?.key === 'yesterday')
        ? this.intake(u, user, L, lang) : this.sales(u, user, L, lang, today);
      case 'profit': return this.profit(u, user, L, lang);
      case 'top': return this.top(u, user, L, lang);
      case 'best': return this.best(u, user, L, lang, today);
      case 'stock': return this.stock(u, user, L);
      case 'product': return this.product(u, user, L);
      case 'order': return this.order(u, user, L, lang);
      case 'supplier': return this.supplier(u, user, L);
      case 'cancel': return this.cancel(u, user, L, lang);
      case 'returns': return this.returns(u, user, L, lang);
      case 'vault': return this.vault(u, user, L);
      case 'shopify': return this.shopify(u, user, L);
      case 'smartplan': return this.smartPlan(u, user, L, lang, today);
      case 'engine': return this.engineReport(u, user, L, lang, today);
      case 'explain': return this.explainProduct(u, user, L, lang, today);
      case 'compare': return this.compare(u, user, L, lang, today);
      case 'purchases': return this.purchases(u, user, L, lang);
      case 'alerts': return this.alerts(u, user, L, lang, today);
      case 'daily': return this.daily(u, user, L, lang, today);
      case 'reorder': return this.reorder(u, user, L, lang, today);
      case 'velocity': return this.velocity(u, user, L, lang, today);
      case 'help': return this.help(L);
      case 'clarify': return this.clarify(u, L);
      default: return this.unknown(u, L);
    }
  }

  // ── Permissions ───────────────────────────────────────────────────────────────────────────────
  private can(user: AssistantUser, perms: string[] | 'admin'): boolean {
    if (user?.role === 'admin') return true;
    if (perms === 'admin') return false;
    const own = user?.perms || [];
    return perms.some((p) => own.includes(p));
  }

  private denied(intent: string, what: string, L: (a: string, e: string) => string, topic: string) {
    return {
      intent, status: 'denied' as const,
      understood: [topic],
      steps: [L(`فهمت السؤال: ${topic}`, `Understood: ${topic}`), L('التحقق من الصلاحية: غير مسموح', 'Permission check: not allowed')],
      lead: [L(`${what} غير متاحة بصلاحياتك. اطلبها من المدير إذا احتجتها.`, `${what} is not available with your permissions. Ask an admin if you need it.`)],
      sources: [],
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────────────────────
  private rangeLabel(from: string, to: string, lang: Lang): string {
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, tdd] = to.split('-').map(Number);
    const M = lang === 'en' ? MONTHS_EN : MONTHS_AR;
    if (from === to) return `${fd} ${M[fm - 1]} ${fy}`;
    if (fy === ty && fm === tm) return `${fd}–${tdd} ${M[fm - 1]} ${fy}`;
    if (fy === ty) return `${fd} ${M[fm - 1]} – ${tdd} ${M[tm - 1]} ${fy}`;
    return `${fd} ${M[fm - 1]} ${fy} – ${tdd} ${M[tm - 1]} ${ty}`;
  }

  private periodLabel(p: Period, L: (a: string, e: string) => string, lang: Lang): string {
    const M = lang === 'en' ? MONTHS_EN : MONTHS_AR;
    switch (p.key) {
      case 'today': return L('اليوم', 'Today');
      case 'yesterday': return L('أمس', 'Yesterday');
      case 'last7': return L('آخر 7 أيام', 'Last 7 days');
      case 'week': return L('هذا الأسبوع', 'This week');
      case 'lastWeek': return L('الأسبوع الماضي', 'Last week');
      case 'lastMonth': return L(`الشهر الماضي (${M[p.month!]})`, `Last month (${M[p.month!]})`);
      case 'namedMonth': return `${M[p.month!]} ${p.year}`;
      default: return L('هذا الشهر', 'This month');
    }
  }

  /** «في هذا الشهر» but «اليوم» / «أمس» — never «في اليوم». */
  private inP(p: Period, label: string, L: (a: string, e: string) => string): string {
    if (p.key === 'today') return L('اليوم', 'today');
    if (p.key === 'yesterday') return L('أمس', 'yesterday');
    return L(`في ${label}`, `in ${label}`);
  }
  private noneIn(what: string, p: Period, label: string, L: (a: string, e: string) => string): string {
    return `${what} ${this.inP(p, label, L)}.`;
  }

  /**
   * Report results kept for a short time — the "best month" answer reads six monthly reports.
   * Closed periods change only through a back-dated edit, so they live 10 minutes; a period that
   * includes today lives 30 seconds. (read-cache.util's cache is cleared by every POST, including
   * the question itself, so it cannot serve here.)
   */
  private readonly reportCache = new Map<string, { at: number; ttl: number; p: Promise<any> }>();
  private report(from: string, to: string): Promise<any> {
    const key = `${from}|${to}`;
    const now = Date.now();
    const hit = this.reportCache.get(key);
    if (hit && now - hit.at < hit.ttl) return hit.p;
    const ttl = to < cairoToday() ? 10 * 60_000 : 30_000;
    const p = this.reportUncached(from, to);
    this.reportCache.set(key, { at: now, ttl, p });
    p.catch(() => this.reportCache.delete(key));
    if (this.reportCache.size > 60) { for (const [k, v] of this.reportCache) if (now - v.at >= v.ttl) this.reportCache.delete(k); }
    return p;
  }

  private async reportUncached(from: string, to: string): Promise<any> {
    const expenses = await this.expenses.findAll();
    const expenseTotal = expenses
      .filter((e: any) => inDateWindow(e.date, from, to) && e.status === 'معتمد')
      .reduce((s: number, e: any) => s + (Number(e.amount) || 0), 0);
    return this.transactions.getReports(from, to, expenseTotal);
  }

  private reportSource(n: number, title: string, p: { from: string; to: string }, lang: Lang, tab = 'kpis'): Source {
    return { n, title, detail: this.rangeLabel(p.from, p.to, lang), link: { kind: 'page', page: 'reports', tab, from: p.from, to: p.to } };
  }

  // ── Sales ─────────────────────────────────────────────────────────────────────────────────────
  private async sales(u: Understood, user: AssistantUser, L: any, lang: Lang, today: string) {
    const topic = L('المبيعات', 'Sales');
    if (!this.can(user, REPORT_PERMS)) return this.denied('sales', L('أرقام المبيعات', 'Sales figures'), L, topic);
    const p = u.period!;
    const label = this.periodLabel(p, L, lang);
    const prev = previousPeriod(p);
    const [r, rp] = await Promise.all([this.report(p.from, p.to), this.report(prev.from, prev.to)]);
    const net = Number(r.totalSales) || 0;
    const orders = Number(r.orderCount) || 0;
    const prevNet = Number(rp.totalSales) || 0;
    const delta = prevNet > 0 ? ((net - prevNet) / prevNet) * 100 : null;
    const running = p.to === today;
    const points = orders && prevNet > 0 ? this.explainChange(r, rp, L) : [];
    return {
      intent: 'sales', status: orders ? 'answered' as const : 'empty' as const,
      understood: [topic, label + (p.assumed ? L(' (افتراضي)', ' (assumed)') : '')],
      steps: [
        L('فهمت السؤال: صافي المبيعات', 'Understood: net sales'),
        L(`الفترة: ${label} (${this.rangeLabel(p.from, p.to, lang)})`, `Period: ${label} (${this.rangeLabel(p.from, p.to, lang)})`),
        L('قرأت تقرير المبيعات للفترة وللفترة السابقة', 'Read the sales report for the period and the one before'),
        L('التحقق من الصلاحية: مسموح', 'Permission check: allowed'),
      ],
      lead: orders ? [
        L(`صافي المبيعات ${p.key === 'today' ? 'اليوم حتى الآن' : this.inP(p, label, L)}: `, `Net sales ${p.key === 'today' ? 'today so far' : this.inP(p, label, L)}: `),
        { v: net, f: 'money', cite: 1 }, L(' من ', ' from '), { v: orders, f: 'int', cite: 1 }, L(' أوردر.', ' orders.'),
      ] : [this.noneIn(L('لا توجد مبيعات', 'No sales'), p, label, L)],
      kpis: orders ? [
        { label: L('صافي المبيعات', 'Net sales'), v: net, f: 'money' as Fmt, cite: 1 },
        { label: L('الأوردرات', 'Orders'), v: orders, f: 'int' as Fmt },
        { label: L('متوسط الأوردر', 'Average order'), v: Number(r.avgOrderValue) || 0, f: 'money' as Fmt },
        { label: running ? L('مقارنة بنفس الأيام قبلها', 'vs. same days before') : L('مقارنة بالفترة السابقة', 'vs. previous period'), v: delta, f: 'pct' as Fmt, delta, cite: 2 },
      ] : undefined,
      pointsTitle: points.length ? L(`لماذا ${delta !== null && delta < 0 ? 'انخفضت' : 'تغيّرت'} مقارنة بالفترة السابقة`, 'Why it changed vs. the previous period') : undefined,
      points: points.length ? points : undefined,
      note: orders ? L(
        `بعد خصومات الفواتير (${Math.round(r.totalDiscounts || 0).toLocaleString('en-US')}) والمرتجعات (${Math.round(r.totalReturns || 0).toLocaleString('en-US')}). الأوردرات الملغاة غير محسوبة.`,
        `After invoice discounts (${Math.round(r.totalDiscounts || 0).toLocaleString('en-US')}) and returns (${Math.round(r.totalReturns || 0).toLocaleString('en-US')}). Cancelled orders are excluded.`,
      ) : undefined,
      sources: [
        this.reportSource(1, L('تقرير المبيعات', 'Sales report'), p, lang),
        this.reportSource(2, L('تقرير المبيعات · الفترة السابقة', 'Sales report · previous period'), prev, lang),
      ],
    };
  }

  // ── Today's incoming orders (Shopify) ─────────────────────────────────────────────────────────
  /** UTC ms range of one Cairo calendar day. */
  private cairoDayMs(day: string): [number, number] {
    const [y, m, d] = day.split('-').map(Number);
    const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Cairo', timeZoneName: 'shortOffset' })
      .formatToParts(new Date(Date.UTC(y, m - 1, d, 12))).find((x) => x.type === 'timeZoneName')?.value || 'GMT+2';
    const mm = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(off);
    const offsetMs = mm ? (mm[1] === '-' ? -1 : 1) * ((Number(mm[2]) * 60 + Number(mm[3] || 0)) * 60_000) : 2 * 3600_000;
    const start = Date.UTC(y, m - 1, d) - offsetMs;
    return [start, start + 864e5];
  }

  /** One Cairo day's incoming Shopify orders, bucketed like the KPI strip (see `intake`). */
  private async intakeCounts(day: string) {
    const [from, to] = this.cairoDayMs(day);
    const db = this.connection.db!;
    const candidates: any[] = await db.collection('shopifyorders').find(
      { createdAt: { $gte: new Date(from - 3 * 864e5) } },
      { projection: { ref: 1, client: 1, total: 1, status: 1, cancelled: 1, shopifyCreatedAt: 1, createdAt: 1, depositReceipts: 1, depositAmount: 1, shipWithoutDeposit: 1 } },
    ).toArray();
    const orders = candidates.filter((o) => { const ms = new Date(o.shopifyCreatedAt || o.createdAt || 0).getTime(); return ms >= from && ms < to; });
    const ids = orders.map((o) => String(o._id));
    const SETTLED = ['تم حل المشكلة', 'تمت المتابعة', 'تمت عملية التأكيد', 'العميل ألغى الطلب'];
    const fus: any[] = ids.length ? await db.collection('followups').find(
      { shopifyOrderId: { $in: ids }, cancelled: { $ne: true }, status: { $nin: SETTLED } }, { projection: { shopifyOrderId: 1 } },
    ).toArray() : [];
    const openFu = new Set(fus.map((f) => String(f.shopifyOrderId)));
    const bucket = (o: any) => {
      if (o.cancelled || o.status === 'rejected') return 'cancelled';
      const rec = Array.isArray(o.depositReceipts) ? o.depositReceipts : [];
      const approved = rec.filter((r: any) => r.status === 'معتمد').reduce((x: number, r: any) => x + (Number(r.amount) || 0), 0);
      const legacy = o.status === 'approved' && !rec.length ? Number(o.depositAmount) || 0 : 0;
      if (approved + legacy > 0) return 'deposit';
      if (o.shipWithoutDeposit === true || o.status === 'approved') return 'nodep';
      if (openFu.has(String(o._id))) return 'followup';
      return 'open';
    };
    const c: Record<string, number> = { deposit: 0, nodep: 0, followup: 0, open: 0, cancelled: 0 };
    const val = { confirmed: 0, pending: 0 };
    const pendingRows: { o: any; b: string }[] = [];
    for (const o of orders) {
      const b = bucket(o); c[b]++;
      const t = Number(o.total) || 0;
      if (b === 'deposit' || b === 'nodep') val.confirmed += t;
      else if (b !== 'cancelled') { val.pending += t; pendingRows.push({ o, b }); }
    }
    const received = orders.length;
    const confirmed = c.deposit + c.nodep;
    const pending = c.followup + c.open;
    return { c, val, pendingRows, received, confirmed, pending, rate: received ? (confirmed / received) * 100 : null };
  }

  /**
   * Buckets mirror the Shopify KPI strip (shopify-kpis.js `_spkBucket`) — ⚠ keep them in step:
   * cancelled (cancelled or rejected) → confirmed with a deposit (approved receipts, or a legacy
   * deposit on an approved order) → confirmed without one (shipWithoutDeposit or approved) →
   * follow-up (an open follow-up) → open. «معلق» = follow-up + open.
   */
  private async intake(u: Understood, user: AssistantUser, L: any, lang: Lang) {
    const p = u.period!;
    const label = this.periodLabel(p, L, lang);
    const topic = L('أوردرات شوبيفاي الواردة', 'Incoming Shopify orders');
    if (!this.can(user, ['shopify-orders', ...REPORT_PERMS])) return this.denied('sales', L('أوردرات شوبيفاي', 'Shopify orders'), L, topic);
    const { c, val, pendingRows, received, confirmed, pending, rate } = await this.intakeCounts(p.from);
    const range = this.rangeLabel(p.from, p.to, lang);
    const src: Source = { n: 1, title: L('صفحة شوبيفاي ← مؤشرات الفترة', 'Shopify page → period KPIs'), detail: range, link: { kind: 'page', page: 'shopify-orders', period: p.key } };
    const steps = [
      L('فهمت السؤال: أوردرات شوبيفاي الواردة في اليوم', 'Understood: Shopify orders received that day'),
      L(`عددت الأوردرات بتاريخ وصولها (${range})`, `Counted orders by arrival time (${range})`),
      L('صنّفتها كما في مؤشرات صفحة شوبيفاي: ملغي، مؤكد بعربون أو بدونه، متابعة، لم يُتخذ إجراء', 'Grouped as on the Shopify KPI strip: cancelled, confirmed with or without a deposit, follow-up, no action'),
    ];
    if (!received) {
      return { intent: 'sales', status: 'empty' as const, understood: [topic, label], steps: steps.slice(0, 2),
        lead: [L(`لم يصل أي أوردر من شوبيفاي ${this.inP(p, label, L)}.`, `No Shopify orders arrived ${this.inP(p, label, L)}.`)],
        options: [L('مبيعات الشهر ده', 'Sales this month'), L('أوردرات شوبيفاي المعلقة', 'Pending Shopify orders')], sources: [src] };
    }
    const stateOf = (b: string) => (b === 'followup' ? { t: L('متابعة', 'Follow-up'), tone: 'warn' } : { t: L('لم يُتخذ إجراء', 'No action yet'), tone: 'warn' });
    return {
      intent: 'sales', status: 'answered' as const,
      understood: [topic, label],
      steps,
      lead: [L(`وصل ${this.inP(p, label, L)} `, `${p.key === 'today' ? 'Today' : 'Yesterday'}, `), { v: received, f: 'int', cite: 1 },
        L(' أوردر من شوبيفاي: ', ' Shopify orders arrived: '), { v: confirmed, f: 'int' }, L(' مؤكد، ', ' confirmed, '),
        { v: pending, f: 'int' }, L(' معلق، ', ' pending, '), { v: c.cancelled, f: 'int' }, L(' ملغي.', ' cancelled.')],
      kpis: [
        { label: L('الواردة', 'Received'), v: received, f: 'int' as Fmt, cite: 1 },
        { label: L('مؤكد', 'Confirmed'), v: confirmed, f: 'int' as Fmt },
        { label: L('معلق', 'Pending'), v: pending, f: 'int' as Fmt },
        { label: L('ملغي', 'Cancelled'), v: c.cancelled, f: 'int' as Fmt },
        { label: L('نسبة التأكيد', 'Confirmation rate'), v: rate, f: 'pct' as Fmt },
        { label: L('قيمة المؤكد', 'Confirmed value'), v: val.confirmed, f: 'money' as Fmt },
      ],
      table: pendingRows.length ? {
        cols: [{ label: L('المعلق', 'Pending') }, { label: L('العميل', 'Customer') }, { label: L('الحالة', 'State') }, { label: L('الإجمالي', 'Total'), num: true }],
        rows: pendingRows.slice(0, 8).map(({ o, b }) => [{ t: '#' + String(o.ref || ''), link: { kind: 'shopify' as const, id: String(o._id) } }, String(o.client || '—'), stateOf(b), { v: Number(o.total) || 0, f: 'money' as Fmt }]),
      } : undefined,
      note: L(
        `المؤكد: ${c.deposit} بعربون · ${c.nodep} بدون عربون. المعلق: ${c.followup} في متابعة · ${c.open} لم يُتخذ فيها إجراء، بقيمة ${Math.round(val.pending).toLocaleString('en-US')} جنيه.${pendingRows.length > 8 ? ` يُعرض 8 من ${pendingRows.length}.` : ''}`,
        `Confirmed: ${c.deposit} with a deposit · ${c.nodep} without. Pending: ${c.followup} in follow-up · ${c.open} with no action, worth EGP ${Math.round(val.pending).toLocaleString('en-US')}.${pendingRows.length > 8 ? ` Showing 8 of ${pendingRows.length}.` : ''}`),
      options: [L('مبيعات الشهر ده', 'Sales this month'), L('أوردرات شوبيفاي المعلقة', 'Pending Shopify orders')],
      sources: [src],
    };
  }

  /**
   * Why net sales moved between two report periods, in the reader's terms:
   * fewer/more orders vs. a smaller/larger average order (net sales = orders × average order), more
   * returns or discounts, and the products whose sales moved most (by name, from `productProfits`).
   */
  private explainChange(r: any, rp: any, L: (a: string, e: string) => string): Point[] {
    const pts: Point[] = [];
    const f = (n: number) => Math.round(n).toLocaleString('en-US');
    const pc = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : 0);
    const o = Number(r.orderCount) || 0, po = Number(rp.orderCount) || 0;
    const a = Number(r.avgOrderValue) || 0, pa = Number(rp.avgOrderValue) || 0;
    const od = pc(o, po), ad = pc(a, pa);
    if (Math.abs(od) >= 3) pts.push({ tone: od >= 0 ? 'up' : 'down', t: L(`عدد الأوردرات ${od >= 0 ? 'زاد' : 'قلّ'} ${Math.abs(od).toFixed(0)}% (${po} ← ${o})`, `Orders ${od >= 0 ? 'up' : 'down'} ${Math.abs(od).toFixed(0)}% (${po} → ${o})`) });
    if (Math.abs(ad) >= 3) pts.push({ tone: ad >= 0 ? 'up' : 'down', t: L(`متوسط الأوردر ${ad >= 0 ? 'ارتفع' : 'انخفض'} ${Math.abs(ad).toFixed(0)}% (${f(pa)} ← ${f(a)} جنيه)`, `Average order ${ad >= 0 ? 'up' : 'down'} ${Math.abs(ad).toFixed(0)}% (EGP ${f(pa)} → ${f(a)})`) });
    const ret = Number(r.totalReturns) || 0, pret = Number(rp.totalReturns) || 0;
    if (ret - pret >= 1000) pts.push({ tone: 'down', t: L(`المرتجعات زادت ${f(ret - pret)} جنيه (${f(pret)} ← ${f(ret)})`, `Returns grew by EGP ${f(ret - pret)} (${f(pret)} → ${f(ret)})`) });
    const dis = Number(r.totalDiscounts) || 0, pdis = Number(rp.totalDiscounts) || 0;
    if (dis - pdis >= 1000) pts.push({ tone: 'down', t: L(`الخصومات زادت ${f(dis - pdis)} جنيه`, `Discounts grew by EGP ${f(dis - pdis)}`) });
    const rev = new Map<string, number>(), prevRev = new Map<string, number>();
    for (const x of r.productProfits || []) rev.set(String(x.name), Number(x.rev) || 0);
    for (const x of rp.productProfits || []) prevRev.set(String(x.name), Number(x.rev) || 0);
    const moves = [...new Set([...rev.keys(), ...prevRev.keys()])].map((n) => ({ n, d: (rev.get(n) || 0) - (prevRev.get(n) || 0) }))
      .filter((m) => Math.abs(m.d) >= 500).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 3);
    for (const m of moves) pts.push({ tone: m.d >= 0 ? 'up' : 'down', t: L(`${m.n}: ${m.d >= 0 ? '+' : '−'}${f(Math.abs(m.d))} جنيه`, `${m.n}: ${m.d >= 0 ? '+' : '−'}EGP ${f(Math.abs(m.d))}`), sub: L('مبيعات المنتج قبل خصم الفاتورة', 'product sales before invoice discount') });
    return pts;
  }

  // ── Comparing two named periods ───────────────────────────────────────────────────────────────
  private async compare(u: Understood, user: AssistantUser, L: any, lang: Lang, today: string) {
    const isProfit = u.metric === 'profit';
    const topic = L('مقارنة', 'Comparison');
    if (isProfit ? !this.can(user, 'admin') : !this.can(user, REPORT_PERMS)) return this.denied('compare', isProfit ? L('الأرباح', 'Profit figures') : L('تقارير المبيعات', 'Sales reports'), L, topic);
    const a = u.period!, b = u.period2!;
    const la = this.periodLabel(a, L, lang), lb = this.periodLabel(b, L, lang);
    const [ra, rb] = await Promise.all([this.report(a.from, a.to), this.report(b.from, b.to)]);
    const metric = (r: any) => (isProfit ? Number(r.netProfit) || 0 : Number(r.totalSales) || 0);
    const va = metric(ra), vb = metric(rb);
    const d = va > 0 ? ((vb - va) / va) * 100 : null;
    const partial = [a, b].filter((p) => p.to === today).map((p) => this.periodLabel(p, L, lang));
    const change = (x: number, y: number) => (x > 0 ? { t: `${y >= x ? '+' : '−'}${Math.abs(((y - x) / x) * 100).toFixed(0)}%`, tone: y >= x ? 'good' : 'bad' } : '—');
    const row = (label: string, x: number, y: number, f: Fmt) => [label, { v: x, f }, { v: y, f }, change(x, y)];
    const rows: any[] = [];
    rows.push(row(L('صافي المبيعات', 'Net sales'), Number(ra.totalSales) || 0, Number(rb.totalSales) || 0, 'money'));
    rows.push(row(L('الأوردرات', 'Orders'), Number(ra.orderCount) || 0, Number(rb.orderCount) || 0, 'int'));
    rows.push(row(L('متوسط الأوردر', 'Average order'), Number(ra.avgOrderValue) || 0, Number(rb.avgOrderValue) || 0, 'money'));
    rows.push(row(L('المرتجعات', 'Returns'), Number(ra.totalReturns) || 0, Number(rb.totalReturns) || 0, 'money'));
    if (this.can(user, 'admin')) rows.push(row(L('صافي الربح', 'Net profit'), Number(ra.netProfit) || 0, Number(rb.netProfit) || 0, 'money'));
    const points = va > 0 ? this.explainChange(rb, ra, L) : [];
    const lead: Seg[] = [];
    lead.push(isProfit ? L(`صافي الربح في ${lb}: `, `Net profit in ${lb}: `) : L(`صافي المبيعات في ${lb}: `, `Net sales in ${lb}: `));
    lead.push({ v: vb, f: 'money', cite: 2 }, L(' مقابل ', ' vs '), { v: va, f: 'money', cite: 1 }, L(` في ${la}`, ` in ${la}`));
    if (d !== null) lead.push(` (${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(0)}%)`);
    lead.push('.');
    return {
      intent: 'compare', status: 'answered' as const, understood: [topic, la, lb],
      steps: [L(`قرأت تقرير ${la} وتقرير ${lb}`, `Read the ${la} and ${lb} reports`), L('قارنت كل رقم بنظيره، والنسبة من الأولى إلى الثانية', 'Compared each figure; the change runs from the first to the second')],
      lead,
      table: { cols: [{ label: '' }, { label: la, num: true }, { label: lb, num: true }, { label: L('التغير', 'Change'), num: true }], rows },
      pointsTitle: points.length ? L(`ما الذي تغيّر من ${la} إلى ${lb}`, `What changed from ${la} to ${lb}`) : undefined,
      points: points.length ? points : undefined,
      note: partial.length ? L(`${partial.join(' و')} لم ينتهِ بعد، فالمقارنة غير مكتملة.`, `${partial.join(' and ')} is not over yet, so the comparison is incomplete.`) : undefined,
      sources: [this.reportSource(1, L(`تقرير ${la}`, `${la} report`), a, lang), this.reportSource(2, L(`تقرير ${lb}`, `${lb} report`), b, lang)],
    };
  }

  // ── Latest purchase invoices ──────────────────────────────────────────────────────────────────
  private async purchases(_u: Understood, user: AssistantUser, L: any, lang: Lang) {
    const topic = L('فواتير الشراء', 'Purchase invoices');
    if (!this.can(user, ['purchase-view', 'purchase-create', 'purchase-edit-price'])) return this.denied('purchases', L('فواتير الشراء', 'Purchase invoices'), L, topic);
    // Amounts follow the purchase screens: admins and purchase-price editors see them.
    const seeMoney = this.can(user, ['purchase-edit-price']);
    const list: any[] = await this.connection.db!.collection('transactions').find(
      { type: 'مشتريات', cancelled: { $ne: true }, archived: { $ne: true } },
      { projection: { ref: 1, client: 1, supplier: 1, date: 1, createdAt: 1, total: 1, remaining: 1, items: 1 } },
    ).sort({ createdAt: -1 }).limit(5).toArray();
    if (!list.length) return { intent: 'purchases', status: 'empty' as const, understood: [topic], steps: [], lead: [L('لا توجد فواتير شراء.', 'No purchase invoices.')], sources: [] };
    const last = list[0];
    const dayOf = (t: any) => String(t.date || '').slice(0, 10) || (t.createdAt ? new Date(t.createdAt).toISOString().slice(0, 10) : '');
    const day = dayOf(last);
    const who = String(last.supplier || last.client || '—');
    const pieces = (last.items || []).reduce((x: number, i: any) => x + (Number(i.qty) || 0), 0);
    const lead: Seg[] = [L('آخر فاتورة شراء: ', 'Latest purchase invoice: '), { b: '#' + String(last.ref || '') }, L(' من ', ' from '), { b: who }];
    if (day) lead.push(` · ${this.rangeLabel(day, day, lang)}`);
    lead.push(L(` · ${(last.items || []).length} صنف، ${pieces} قطعة`, ` · ${(last.items || []).length} lines, ${pieces} pieces`));
    if (seeMoney) lead.push(L(' · الإجمالي ', ' · total '), { v: Number(last.total) || 0, f: 'money', cite: 1 });
    lead.push('.');
    const cols: any[] = [{ label: L('الفاتورة', 'Invoice') }, { label: L('المورد', 'Supplier') }, { label: L('التاريخ', 'Date') }];
    if (seeMoney) cols.push({ label: L('الإجمالي', 'Total'), num: true }, { label: L('المتبقي', 'Remaining'), num: true });
    return {
      intent: 'purchases', status: 'answered' as const, understood: [topic, L('الأحدث', 'Latest')],
      steps: [L('قرأت آخر فواتير الشراء المسجّلة (غير الملغاة) بترتيب إدخالها', 'Read the latest recorded purchase invoices (not cancelled), newest first')],
      lead,
      table: {
        cols,
        rows: list.map((t) => {
          const d2 = dayOf(t);
          const r: any[] = [{ t: '#' + String(t.ref || ''), link: { kind: 'order' as const, id: String(t._id) } }, String(t.supplier || t.client || '—'), d2 ? this.rangeLabel(d2, d2, lang) : '—'];
          if (seeMoney) r.push({ v: Number(t.total) || 0, f: 'money' as Fmt }, { v: Number(t.remaining) || 0, f: 'money' as Fmt });
          return r;
        }),
      },
      sources: [{ n: 1, title: L('صفحة الفاتورة', 'Invoice page'), detail: '#' + String(last.ref || ''), link: { kind: 'order', id: String(last._id) } }],
    };
  }

  // ── Profit ────────────────────────────────────────────────────────────────────────────────────
  private async profit(u: Understood, user: AssistantUser, L: any, lang: Lang) {
    const topic = L('الأرباح', 'Profit');
    if (!this.can(user, 'admin')) return this.denied('profit', L('الأرباح', 'Profit figures'), L, topic);
    const p = u.period!;
    const label = this.periodLabel(p, L, lang);
    const r = await this.report(p.from, p.to);
    const net = Number(r.totalSales) || 0, gp = Number(r.grossProfit) || 0, np = Number(r.netProfit) || 0, exp = Number(r.expenseTotal) || 0;
    const margin = net > 0 ? (np / net) * 100 : null;
    return {
      intent: 'profit', status: net ? 'answered' as const : 'empty' as const,
      understood: [topic, label],
      steps: [
        L('فهمت السؤال: صافي الربح', 'Understood: net profit'),
        L(`الفترة: ${label} (${this.rangeLabel(p.from, p.to, lang)})`, `Period: ${label} (${this.rangeLabel(p.from, p.to, lang)})`),
        L('قرأت تقرير الأرباح والمصاريف المعتمدة', 'Read the profit report and approved expenses'),
        L('التحقق من الصلاحية: مدير', 'Permission check: admin'),
      ],
      lead: [L(`صافي الربح ${this.inP(p, label, L)}: `, `Net profit ${this.inP(p, label, L)}: `), { v: np, f: 'money', cite: 1 },
        ...(margin !== null ? [L('، بهامش ', ', a margin of '), { v: margin, f: 'pct' as Fmt }, L(' من صافي المبيعات.', ' of net sales.')] : ['.'])],
      table: {
        cols: [{ label: L('البند', 'Line') }, { label: L('المبلغ', 'Amount'), num: true }],
        rows: [
          [L('صافي المبيعات', 'Net sales'), { v: net, f: 'money' }],
          [L('− تكلفة البضاعة والشحن', '− Cost of goods & shipping'), { v: net - gp, f: 'money' }],
          [{ t: L('= إجمالي الربح', '= Gross profit'), tone: 'strong' }, { v: gp, f: 'money' }],
          [L('− المصاريف المعتمدة', '− Approved expenses'), { v: exp, f: 'money' }],
          [{ t: L('= صافي الربح', '= Net profit'), tone: 'strong' }, { v: np, f: 'money' }],
        ],
      },
      note: L('التكلفة هي التكلفة المحفوظة على كل سطر بيع وقت البيع، كما في صفحة التقارير.', 'Cost is the cost saved on each sale line at the time of sale, as on the reports page.'),
      sources: [this.reportSource(1, L('تقرير الأرباح', 'Profit report'), p, lang)],
    };
  }

  // ── Top products ──────────────────────────────────────────────────────────────────────────────
  private async top(u: Understood, user: AssistantUser, L: any, lang: Lang) {
    const topic = L('أكثر المنتجات مبيعًا', 'Best-selling products');
    if (!this.can(user, REPORT_PERMS)) return this.denied('top', L('تقارير المبيعات', 'Sales reports'), L, topic);
    const p = u.period!;
    const label = this.periodLabel(p, L, lang);
    const r = await this.report(p.from, p.to);
    const rows = [...(r.productProfits || [])].sort((a: any, b: any) => (b.qty || 0) - (a.qty || 0)).slice(0, 5);
    return {
      intent: 'top', status: rows.length ? 'answered' as const : 'empty' as const,
      understood: [topic, label],
      steps: [L('فهمت السؤال: ترتيب المنتجات بعدد القطع المباعة', 'Understood: products ranked by pieces sold'),
        L(`الفترة: ${label}`, `Period: ${label}`), L('قرأت تقرير المبيعات ← المنتجات', 'Read the sales report → products')],
      lead: rows.length ? [L(`أكثر ${rows.length} منتجات مبيعًا ${this.inP(p, label, L)}:`, `Top ${rows.length} products ${this.inP(p, label, L)}:`)] : [this.noneIn(L('لا توجد مبيعات', 'No sales'), p, label, L)],
      table: rows.length ? {
        cols: [{ label: '#' }, { label: L('المنتج', 'Product') }, { label: L('قطع', 'Pieces'), num: true }, { label: L('المبيعات', 'Sales'), num: true }],
        rows: rows.map((x: any, i: number) => [String(i + 1), String(x.name || ''), { v: x.qty || 0, f: 'int' as Fmt }, { v: x.rev || 0, f: 'money' as Fmt }]),
      } : undefined,
      sources: [this.reportSource(1, L('تقرير المبيعات ← المنتجات', 'Sales report → products'), p, lang)],
    };
  }

  // ── Best / worst month or day ────────────────────────────────────────────────────────────────
  private async best(u: Understood, user: AssistantUser, L: any, lang: Lang, today: string) {
    const worst = !!u.worst;
    const isProfit = u.metric === 'profit';
    const word = worst ? L('أضعف', 'Weakest') : L('أفضل', 'Best');
    const unitW = u.unit === 'month' ? L('شهر', 'month') : L('يوم', 'day');
    const topic = `${word} ${unitW}`;
    if (isProfit ? !this.can(user, 'admin') : !this.can(user, REPORT_PERMS)) {
      return this.denied('best', isProfit ? L('الأرباح', 'Profit figures') : L('تقارير المبيعات', 'Sales reports'), L, topic);
    }
    const M = lang === 'en' ? MONTHS_EN : MONTHS_AR;
    const [ty, tm] = today.split('-').map(Number);
    let list: { label: string; v: number; orders: number; partial: boolean }[] = [];
    let from = '';
    // Each month through its own report, so a month's figure equals that month on the reports page
    // (net of returns). Last 6 months — one report per month.
    if (u.unit === 'month') {
      const months: { y: number; m: number }[] = [];
      for (let k = 5; k >= 0; k--) { const d = new Date(Date.UTC(ty, tm - 1 - k, 1)); months.push({ y: d.getUTCFullYear(), m: d.getUTCMonth() }); }
      const key = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, '0')}`;
      from = `${key(months[0].y, months[0].m)}-01`;
      for (const { y, m } of months) {
        const eFull = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
        const r = await this.report(`${key(y, m)}-01`, eFull > today ? today : eFull);
        const orders = Number(r.orderCount) || 0;
        if (!orders) continue;
        list.push({ label: `${M[m]} ${y}`, v: isProfit ? Number(r.netProfit) || 0 : Number(r.totalSales) || 0, orders, partial: eFull > today });
      }
    } else {
      // Days: the last 90 complete days from the report's own daily series (sales only).
      from = addDays(today, -90);
      const r = await this.report(from, addDays(today, -1));
      list = (r.series || []).filter((d: any) => (d.orders || 0) > 0).map((d: any) => {
        const [y, m, dd] = String(d.date).split('-').map(Number);
        return { label: `${dd} ${M[m - 1]} ${y}`, v: Number(d.sales) || 0, orders: Number(d.orders) || 0, partial: false };
      });
    }
    if (!list.length) {
      return { intent: 'best', status: 'empty' as const, understood: [topic], steps: [], lead: [L('لا توجد مبيعات كافية للمقارنة.', 'Not enough sales to compare.')], sources: [] };
    }
    list.sort((a, b) => (worst ? a.v - b.v : b.v - a.v));
    const top = list[0];
    const shown = u.unit === 'month' ? list : list.slice(0, 7);
    const metricName = isProfit && u.unit === 'month' ? L('صافي الربح', 'Net profit') : u.unit === 'day' ? L('المبيعات', 'Sales') : L('صافي المبيعات', 'Net sales');
    const note = u.unit === 'month'
      ? L('آخر 6 أشهر، كل شهر من تقريره، والشهر الحالي غير مكتمل.', 'Last 6 months, each from its own report; the current month is not complete.')
      : (isProfit ? L('ترتيب الأيام بالمبيعات فقط؛ الربح اليومي غير متاح. ', 'Days are ranked by sales only; daily profit is not available. ') : '')
        + L('آخر 90 يومًا مكتملًا دون اليوم الحالي، من الرسم اليومي في التقارير (بعد الخصم وقبل خصم المرتجعات).', 'Last 90 complete days, today excluded, from the daily chart on the reports page (after discounts, before returns).');
    return {
      intent: 'best', status: 'answered' as const,
      understood: [topic, isProfit && u.unit === 'month' ? L('الربح', 'Profit') : L('المبيعات', 'Sales')],
      steps: [L(`فهمت السؤال: ترتيب ${u.unit === 'month' ? 'الشهور' : 'الأيام'} ${worst ? 'من الأضعف' : 'من الأفضل'}`, `Understood: ${u.unit === 'month' ? 'months' : 'days'} ranked ${worst ? 'weakest first' : 'best first'}`),
        L(u.unit === 'month' ? 'قرأت تقرير كل شهر من آخر 6 أشهر' : 'قرأت السلسلة اليومية من تقرير المبيعات', u.unit === 'month' ? 'Read each month\'s report for the last 6 months' : 'Read the daily series of the sales report')],
      lead: [`${word} ${unitW}: `, { b: top.label }, L(` بـ${metricName} `, ` with ${metricName.toLowerCase()} `), { v: top.v, f: 'money', cite: 1 }, L(' من ', ' from '), { v: top.orders, f: 'int' }, L(' أوردر.', ' orders.')],
      table: {
        cols: [{ label: '#' }, { label: u.unit === 'month' ? L('الشهر', 'Month') : L('اليوم', 'Day') }, { label: L('أوردرات', 'Orders'), num: true }, { label: metricName, num: true }],
        rows: shown.map((x, i) => [String(i + 1), x.partial ? { t: x.label, sub: L('حتى الآن', 'so far'), tone: i === 0 ? 'strong' : undefined } : (i === 0 ? { t: x.label, tone: 'strong' } : x.label),
          { v: x.orders, f: 'int' as Fmt }, { v: x.v, f: 'money' as Fmt }]),
      },
      note,
      sources: [this.reportSource(1, L('تقرير المبيعات', 'Sales report'), { from, to: today }, lang)],
    };
  }

  // ── Stock ─────────────────────────────────────────────────────────────────────────────────────
  /** Ready to sell = balance − needs attention (damaged + lost + inspection), like the inventory page. */
  private async stockRows() {
    const [inv, breakdown] = await Promise.all([this.transactions.getInventory(), this.transactions.getInventoryBreakdown()]);
    const bd: Record<string, any> = (breakdown as any) || {};
    return inv.filter((p) => p.isActive !== false).map((p) => {
      const b = bd[String(p._id)] || {};
      let reserved = 0, attention = 0;
      for (const w of Object.values<any>(b.byWarehouse || {})) {
        reserved += Number(w.reserved) || 0;
        attention += (Number(w.damaged) || 0) + (Number(w.lost) || 0) + (Number(w.inspection) || 0);
      }
      const balance = Number(p.current) || 0;
      return { id: String(p._id), code: p.code, name: p.name, balance, reserved, attention, incoming: Number(b.incoming) || 0,
        ready: Math.max(0, balance - attention), min: Number(p.minStock) || 0, price: Number(p.sellPrice) || 0, sold: Number(p.sales) || 0 };
    });
  }

  private canStock(user: AssistantUser) { return this.can(user, ['inventory', 'products', 'transaction', 'shopify-orders', 'pickup-orders']); }

  private async stock(u: Understood, user: AssistantUser, L: any) {
    const out = u.stockMode === 'out';
    const topic = out ? L('نفد من المخزون', 'Out of stock') : L('قارب على النفاد', 'Running low');
    if (!this.canStock(user)) return this.denied('stock', L('المخزون', 'Stock'), L, topic);
    const rows = await this.stockRows();
    const list = (out ? rows.filter((r) => r.ready <= 0) : rows.filter((r) => r.ready <= r.min && r.min > 0))
      .sort((a, b) => (a.min ? a.ready / a.min : a.ready) - (b.min ? b.ready / b.min : b.ready)).slice(0, 15);
    const noPo = list.filter((r) => !r.incoming).length;
    const total = out ? rows.filter((r) => r.ready <= 0).length : rows.filter((r) => r.ready <= r.min && r.min > 0).length;
    return {
      intent: 'stock', status: 'answered' as const,
      understood: [L('المخزون', 'Stock'), topic],
      steps: [L(`فهمت السؤال: ${topic}`, `Understood: ${topic.toLowerCase()}`),
        L('قرأت رصيد كل منتج والمحجوز والوارد', 'Read each product\'s balance, reserved and incoming'),
        L('الصالح للبيع = الرصيد − القطع التي تحتاج مراجعة', 'Ready to sell = balance − pieces needing attention')],
      lead: total
        ? (out ? [{ v: total, f: 'int', cite: 1 }, L(' منتج لا يوجد منه شيء صالح للبيع.', ' active products have nothing ready to sell.')]
          : [{ v: total, f: 'int', cite: 1 }, L(' منتج عند الحد الأدنى أو أقل', ' products at or below their minimum'),
            ...(noPo ? [L('، منها ', ', '), { v: noPo, f: 'int' as Fmt }, L(' بدون أمر شراء.', ' with no purchase order.')] : ['.'])])
        : [out ? L('لا يوجد منتج نافد. كل المنتجات النشطة لها رصيد صالح للبيع.', 'Nothing is out of stock.') : L('لا يوجد منتج تحت الحد الأدنى.', 'No product is below its minimum.')],
      table: list.length ? {
        cols: [{ label: L('المنتج', 'Product') }, { label: L('صالح للبيع', 'Ready'), num: true }, { label: L('الحد الأدنى', 'Minimum'), num: true },
          { label: L('محجوز', 'Reserved'), num: true }, { label: L('وارد', 'Incoming'), num: true }],
        rows: list.map((r) => [{ t: r.name, sub: r.code, link: { kind: 'product' as const, id: r.id } },
          { t: String(r.ready), tone: r.ready <= 0 ? 'bad' : undefined }, { v: r.min, f: 'int' as Fmt }, { v: r.reserved, f: 'int' as Fmt },
          r.incoming ? { t: '+' + r.incoming, tone: 'good' } : { t: L('لا يوجد', 'None'), tone: 'warn' }]),
      } : undefined,
      note: total > list.length ? L(`تُعرض ${list.length} من ${total}.`, `Showing ${list.length} of ${total}.`) : undefined,
      sources: [{ n: 1, title: L('المخزن ← يحتاج طلب شراء', 'Inventory → needs reorder'), detail: L('الآن', 'Now'), link: { kind: 'page', page: 'inventory', filter: 'reorder' } }],
    };
  }

  private async product(u: Understood, user: AssistantUser, L: any) {
    const topic = L('رصيد منتج', 'Product stock');
    const rows = await this.stockRows();
    const found = this.findProducts(rows, u.subject || '');
    if (found.length > 1) {
      if (!this.canStock(user)) return this.denied('product', L('المخزون', 'Stock'), L, topic);
      return {
        intent: 'product', status: 'answered' as const, understood: [topic, u.subject || ''],
        steps: [L(`بحثت عن «${u.subject}» فوجدت ${found.length} منتجات بهذا الاسم`, `Searched "${u.subject}": ${found.length} products match`)],
        lead: [L('يوجد ', ''), { v: found.length, f: 'int' as Fmt }, L(` منتجات باسم «${u.subject}»:`, ` products match "${u.subject}":`)],
        table: {
          cols: [{ label: L('المنتج', 'Product') }, { label: L('صالح للبيع', 'Ready'), num: true }, { label: L('محجوز', 'Reserved'), num: true }, { label: L('وارد', 'Incoming'), num: true }],
          rows: found.map((r: any) => [{ t: r.name, sub: r.code, link: { kind: 'product' as const, id: r.id } }, { t: String(r.ready), tone: r.ready <= 0 ? 'bad' : undefined }, { v: r.reserved, f: 'int' as Fmt }, { v: r.incoming, f: 'int' as Fmt }]),
        },
        sources: [{ n: 1, title: L('المخزن', 'Inventory'), detail: L('الآن', 'Now'), link: { kind: 'page', page: 'inventory' } }],
      };
    }
    const best: any = found[0] || null;
    const score = best ? 2 : 0;
    const words = [0, 0];
    // A single weak word is not a product match — fall back to "not understood" instead of guessing.
    if (!best || score < Math.min(2, words.length)) {
      if (!u.explicit) return this.unknown(u, L);
      return {
        intent: 'product', status: 'notfound' as const, understood: [topic, u.subject || ''],
        steps: [L(`بحثت عن «${u.subject}» في أسماء المنتجات وأكوادها`, `Searched "${u.subject}" in product names and codes`)],
        lead: [L('لم أجد منتجًا يطابق ', 'No product matches '), { b: String(u.subject || '') }, L('. اكتب اسم المنتج أو كوده كما في صفحة الأصناف.', '. Type the product name or code as it appears on the products page.')],
        sources: [],
      };
    }
    if (!this.canStock(user)) return this.denied('product', L('المخزون', 'Stock'), L, topic);
    return {
      intent: 'product', status: 'answered' as const,
      understood: [topic, best.code],
      steps: [L(`فهمت السؤال: رصيد «${best.name}»`, `Understood: stock of "${best.name}"`), L('قرأت رصيد المنتج والمحجوز والوارد', 'Read the product balance, reserved and incoming')],
      lead: [{ b: best.name }, L(': صالح للبيع ', ': ready to sell '), { v: best.ready, f: 'int', cite: 1 }, L(' قطعة.', ' pieces.')],
      kpis: [
        { label: L('صالح للبيع', 'Ready to sell'), v: best.ready, f: 'int' as Fmt, cite: 1 },
        { label: L('محجوز لطلبات', 'Reserved for orders'), v: best.reserved, f: 'int' as Fmt },
        { label: L('يحتاج مراجعة', 'Needs attention'), v: best.attention, f: 'int' as Fmt },
        { label: L('وارد', 'Incoming'), v: best.incoming, f: 'int' as Fmt },
      ],
      note: L(`الحد الأدنى ${best.min}. سعر البيع ${Math.round(best.price).toLocaleString('en-US')} جنيه.`, `Minimum ${best.min}. Sell price EGP ${Math.round(best.price).toLocaleString('en-US')}.`),
      sources: [{ n: 1, title: L('صفحة المنتج', 'Product page'), detail: best.code, link: { kind: 'product', id: best.id } }],
    };
  }

  // ── Order ─────────────────────────────────────────────────────────────────────────────────────
  private async order(u: Understood, user: AssistantUser, L: any, lang: Lang) {
    const topic = L('أوردر', 'Order');
    const ref = String(u.ref);
    if (!this.can(user, ['movements', 'transaction', 'shopify-orders', 'pickup-orders'])) return this.denied('order', L('بيانات الأوردرات', 'Order details'), L, topic);
    const db = this.connection.db!;
    const tx: any = await db.collection('transactions').findOne(
      { ref, type: { $in: ['مبيعات', 'مشتريات'] } },
      { projection: { ref: 1, type: 1, client: 1, supplier: 1, total: 1, deposit: 1, remaining: 1, cancelled: 1, cancelReason: 1, pickupStatus: 1, bostaStatus: 1, bostaTrackingNumber: 1, deliveredAt: 1, date: 1, items: 1, shipCo: 1 } },
    );
    if (tx && tx.type === 'مشتريات' && !this.can(user, ['purchase-view'])) return this.denied('order', L('فواتير الشراء', 'Purchase invoices'), L, topic);
    if (tx) {
      const state = tx.cancelled ? [L('ملغي', 'Cancelled'), 'bad']
        : tx.deliveredAt || tx.pickupStatus === 'Delivered' ? [L('تم التسليم', 'Delivered'), 'good']
          : tx.pickupStatus === 'Shipped' || tx.pickupStatus === 'Picked-Up' ? [L('مع شركة الشحن', 'With the carrier'), 'info']
            : tx.pickupStatus === 'Ready' ? [L('جاهز للشحن', 'Ready to ship'), 'info']
              : tx.pickupStatus === 'Preparing' ? [L('قيد التجهيز', 'Preparing'), 'warn']
                : [L('مسجّل', 'Recorded'), 'neutral'];
      const items = (tx.items || []).slice(0, 6).map((i: any) => `${i.name} × ${i.qty}`).join(L('، ', ', '));
      const date = String(tx.date || '').slice(0, 10);
      return {
        intent: 'order', status: 'answered' as const,
        understood: [topic, '#' + ref],
        steps: [L(`فهمت السؤال: حالة الأوردر #${ref}`, `Understood: status of order #${ref}`), L('قرأت الفاتورة من سجل المعاملات', 'Read the invoice from the transactions log')],
        lead: [L('أوردر ', 'Order '), { b: '#' + ref }, L(' لـ ', ' for '), { b: String(tx.client || tx.supplier || '—') }, ` · ${state[0]}`],
        kpis: [
          { label: L('الإجمالي', 'Total'), v: Number(tx.total) || 0, f: 'money' as Fmt, cite: 1 },
          { label: L('المدفوع', 'Paid'), v: Number(tx.deposit) || 0, f: 'money' as Fmt },
          { label: L('المتبقي', 'Remaining'), v: tx.cancelled ? null : Number(tx.remaining) || 0, f: 'money' as Fmt, text: tx.cancelled ? '—' : undefined },
        ],
        note: [date && this.rangeLabel(date, date, lang), tx.shipCo && L(`الشحن: ${tx.shipCo}`, `Carrier: ${tx.shipCo}`),
          tx.bostaTrackingNumber && L(`رقم التتبع ${tx.bostaTrackingNumber}`, `Tracking ${tx.bostaTrackingNumber}`),
          tx.cancelled && tx.cancelReason && L(`سبب الإلغاء: ${tx.cancelReason}`, `Cancel reason: ${tx.cancelReason}`),
          items && L(`الأصناف: ${items}`, `Items: ${items}`)].filter(Boolean).join(' · '),
        sources: [{ n: 1, title: L('صفحة الأوردر', 'Order page'), detail: '#' + ref, link: { kind: 'order', id: String(tx._id) } }],
      };
    }
    const so: any = await db.collection('shopifyorders').findOne({ ref }, { projection: { ref: 1, client: 1, total: 1, status: 1, cancelled: 1, shopifyCreatedAt: 1 } });
    if (so) {
      const st = so.cancelled ? L('ملغي في شوبيفاي', 'Cancelled in Shopify') : L('لم يُؤكد بعد في شوبيفاي', 'Not confirmed yet in Shopify');
      return {
        intent: 'order', status: 'answered' as const,
        understood: [topic, '#' + ref],
        steps: [L(`فهمت السؤال: حالة الأوردر #${ref}`, `Understood: status of order #${ref}`), L('لم يُسجّل كفاتورة بعد؛ قرأته من أوردرات شوبيفاي', 'Not an invoice yet; read from Shopify orders')],
        lead: [L('أوردر ', 'Order '), { b: '#' + ref }, L(' لـ ', ' for '), { b: String(so.client || '—') }, ` · ${st}`],
        kpis: [{ label: L('الإجمالي', 'Total'), v: Number(so.total) || 0, f: 'money' as Fmt, cite: 1 }],
        sources: [{ n: 1, title: L('صفحة شوبيفاي', 'Shopify page'), detail: '#' + ref, link: { kind: 'shopify', id: String(so._id) } }],
      };
    }
    return {
      intent: 'order', status: 'notfound' as const, understood: [topic, '#' + ref],
      steps: [L(`بحثت عن #${ref} في سجل المعاملات وأوردرات شوبيفاي`, `Searched #${ref} in transactions and Shopify orders`)],
      lead: [L('لم أجد أوردرًا برقم ', 'No order found with number '), { b: '#' + ref }, L('. تأكد من الرقم.', '. Check the number.')],
      sources: [],
    };
  }

  // ── Suppliers ─────────────────────────────────────────────────────────────────────────────────
  private async supplier(u: Understood, user: AssistantUser, L: any) {
    const topic = L('الموردون', 'Suppliers');
    if (!this.can(user, ['suppliers', 'suppliers-tab-ledger'])) return this.denied('supplier', L('أرصدة الموردين', 'Supplier balances'), L, topic);
    const [balances, sups] = await Promise.all([
      this.ledger.getAllBalances(),
      this.connection.db!.collection('suppliers').find({}, { projection: { name: 1 } }).toArray(),
    ]);
    const rows = sups.map((s: any) => ({ id: String(s._id), name: String(s.name || ''), ...(balances[String(s._id)] || { balance: 0, debt: 0, credit: 0 }) }));
    const words = normalizeQuestion(u.subject || '').trim().split(' ').filter((w) => w.length > 2);
    const match = words.length
      ? rows.map((r) => ({ r, s: words.filter((w) => normalizeQuestion(r.name).includes(w)).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0]?.r
      : null;
    if (match) {
      return {
        intent: 'supplier', status: 'answered' as const,
        understood: [L('مورد', 'Supplier'), match.name],
        steps: [L(`فهمت السؤال: رصيد المورد «${match.name}»`, `Understood: balance of "${match.name}"`), L('قرأت آخر رصيد في سجل المديونية', 'Read the latest debt-ledger balance')],
        lead: match.debt > 0
          ? [L('علينا لـ ', 'We owe '), { b: match.name }, L(' مبلغ ', ' '), { v: match.debt, f: 'money', cite: 1 }, '.']
          : match.credit > 0
            ? [L('لا يوجد علينا شيء لـ ', 'We owe nothing to '), { b: match.name }, L('، ولنا عنده رصيد ', '; we hold a credit of '), { v: match.credit, f: 'money', cite: 1 }, '.']
            : [L('لا يوجد علينا شيء لـ ', 'We owe nothing to '), { b: match.name }, '.'],
        sources: [{ n: 1, title: L('ملف المورد ← سجل المديونية', 'Supplier profile → debt ledger'), detail: match.name, link: { kind: 'supplier', id: match.id } }],
      };
    }
    const owing = rows.filter((r) => r.debt > 0).sort((a, b) => b.debt - a.debt);
    const total = owing.reduce((s, r) => s + r.debt, 0);
    return {
      intent: 'supplier', status: 'answered' as const,
      understood: [topic, L('كل الموردين', 'All suppliers')],
      steps: [L('فهمت السؤال: المستحق لكل الموردين', 'Understood: amount owed to all suppliers'), L('قرأت آخر رصيد لكل مورد في سجل المديونية', 'Read each supplier\'s latest ledger balance')],
      lead: [L('إجمالي المستحق للموردين: ', 'Total owed to suppliers: '), { v: total, f: 'money', cite: 1 }, L(' لـ ', ' across '), { v: owing.length, f: 'int' }, L(' مورد.', ' suppliers.')],
      table: owing.length ? {
        cols: [{ label: L('المورد', 'Supplier') }, { label: L('علينا', 'We owe'), num: true }],
        rows: owing.slice(0, 10).map((r) => [{ t: r.name, link: { kind: 'supplier' as const, id: r.id } }, { v: r.debt, f: 'money' as Fmt }]),
      } : undefined,
      sources: [{ n: 1, title: L('الموردون ← أرصدة المديونية', 'Suppliers → balances'), detail: L('الآن', 'Now'), link: { kind: 'page', page: 'suppliers' } }],
    };
  }

  // ── Cancellations / returns ─────────────────────────────────────────────────────────────────
  private async cancel(u: Understood, user: AssistantUser, L: any, lang: Lang) {
    const topic = L('الإلغاءات', 'Cancellations');
    if (!this.can(user, ['reports', 'reports-cancellations'])) return this.denied('cancel', L('تقرير الإلغاءات', 'The cancellations report'), L, topic);
    const p = u.period!;
    const label = this.periodLabel(p, L, lang);
    const c = (await this.report(p.from, p.to)).cancellations || {};
    const reasons = (c.reasons || []).slice(0, 6);
    const total = Number(c.total) || 0;
    return {
      intent: 'cancel', status: 'answered' as const,
      understood: [topic, label],
      steps: [L('فهمت السؤال: أسباب الإلغاء', 'Understood: cancellation reasons'), L(`الفترة: ${label}`, `Period: ${label}`), L('قرأت تقرير الإلغاءات', 'Read the cancellations report')],
      lead: total
        ? [L('أُلغي ', ''), { v: total, f: 'int', cite: 1 }, L(` أوردر ${this.inP(p, label, L)}`, ` orders cancelled ${this.inP(p, label, L)}`), ...(reasons[0] ? [L('، أكثر سبب: ', '; top reason: '), { b: String(reasons[0].label) }] : []), '.']
        : [this.noneIn(L('لا توجد إلغاءات', 'No cancellations'), p, label, L)],
      kpis: total ? [
        { label: L('قبل التسجيل (شوبيفاي)', 'Before entry (Shopify)'), v: Number(c.shopifyCount) || 0, f: 'int' as Fmt },
        { label: L('بعد التسجيل', 'After entry'), v: Number(c.transactionCount) || 0, f: 'int' as Fmt },
        { label: L('قيمة مفقودة', 'Lost value'), v: Number(c.lostValue) || 0, f: 'money' as Fmt },
      ] : undefined,
      table: reasons.length ? {
        cols: [{ label: L('السبب', 'Reason') }, { label: L('العدد', 'Count'), num: true }, { label: L('النسبة', 'Share'), num: true }],
        rows: reasons.map((r: any) => [String(r.label), { v: r.count || 0, f: 'int' as Fmt }, { v: r.share || 0, f: 'pct' as Fmt }]),
      } : undefined,
      sources: [this.reportSource(1, L('التقارير ← الإلغاءات', 'Reports → cancellations'), p, lang, 'cancellations')],
    };
  }

  private async returns(u: Understood, user: AssistantUser, L: any, lang: Lang) {
    const topic = L('المرتجعات', 'Returns');
    if (!this.can(user, REPORT_PERMS)) return this.denied('returns', L('تقارير المبيعات', 'Sales reports'), L, topic);
    const p = u.period!;
    const label = this.periodLabel(p, L, lang);
    const r = await this.report(p.from, p.to);
    const n = Number(r.returnCount) || 0;
    return {
      intent: 'returns', status: 'answered' as const,
      understood: [topic, label],
      steps: [L('فهمت السؤال: المرتجعات المعتمدة', 'Understood: approved returns'), L(`الفترة: ${label}`, `Period: ${label}`), L('قرأت تقرير المبيعات', 'Read the sales report')],
      lead: n ? [L(`المرتجعات ${this.inP(p, label, L)}: `, `Returns ${this.inP(p, label, L)}: `), { v: n, f: 'int', cite: 1 }, L(' مرتجع بقيمة ', ' worth '), { v: Number(r.totalReturns) || 0, f: 'money', cite: 1 }, '.']
        : [this.noneIn(L('لا توجد مرتجعات معتمدة', 'No approved returns'), p, label, L)],
      note: n ? L('تُخصم من صافي المبيعات.', 'They are deducted from net sales.') : undefined,
      sources: [this.reportSource(1, L('التقارير ← المرتجعات', 'Reports → returns'), p, lang)],
    };
  }

  // ── Vault / Shopify ───────────────────────────────────────────────────────────────────────────
  private async vault(_u: Understood, user: AssistantUser, L: any) {
    const topic = L('الخزنة', 'Vault');
    if (!this.can(user, 'admin')) return this.denied('vault', L('أرصدة الخزنة', 'Vault balances'), L, topic);
    const s: any = await this.settings.getSettings();
    const segs = [[L('كاش', 'Cash'), s.vaultCash], [L('فودافون كاش', 'Vodafone Cash'), s.vaultVodafone], ['Instapay', s.vaultInstapay], [L('تحويل بنكي', 'Bank'), s.vaultBank]];
    const total = segs.reduce((x, r) => x + (Number(r[1]) || 0), 0);
    return {
      intent: 'vault', status: 'answered' as const,
      understood: [topic, L('الآن', 'Now')],
      steps: [L('فهمت السؤال: رصيد الخزنة', 'Understood: vault balance'), L('قرأت أرصدة الخزن الأربع', 'Read the four vault balances'), L('التحقق من الصلاحية: مدير', 'Permission check: admin')],
      lead: [L('إجمالي رصيد الخزنة الآن: ', 'Total vault balance now: '), { v: total, f: 'money', cite: 1 }, '.'],
      kpis: segs.map((r) => ({ label: String(r[0]), v: Number(r[1]) || 0, f: 'money' as Fmt })),
      sources: [{ n: 1, title: L('الخزنة', 'Vault'), detail: L('الآن', 'Now'), link: { kind: 'page', page: 'vault' } }],
    };
  }

  private async shopify(_u: Understood, user: AssistantUser, L: any) {
    const topic = L('أوردرات شوبيفاي المعلقة', 'Pending Shopify orders');
    if (!this.can(user, ['shopify-orders'])) return this.denied('shopify', L('أوردرات شوبيفاي', 'Shopify orders'), L, topic);
    const col = this.connection.db!.collection('shopifyorders');
    const filter = { status: 'pending', cancelled: { $ne: true } };
    const [count, oldest] = await Promise.all([
      col.countDocuments(filter),
      col.find(filter, { projection: { ref: 1, shopifyCreatedAt: 1, createdAt: 1 } }).sort({ createdAt: 1 }).limit(1).toArray(),
    ]);
    const o: any = oldest[0];
    const ageDays = o ? Math.floor((Date.now() - new Date(o.shopifyCreatedAt || o.createdAt || Date.now()).getTime()) / 864e5) : 0;
    return {
      intent: 'shopify', status: 'answered' as const,
      understood: [topic],
      steps: [L('فهمت السؤال: أوردرات شوبيفاي التي لم تُؤكد', 'Understood: Shopify orders not confirmed yet'), L('عددت الأوردرات المعلقة غير الملغاة', 'Counted pending orders that are not cancelled')],
      lead: count ? [L('في شوبيفاي ', 'Shopify has '), { v: count, f: 'int', cite: 1 }, L(' أوردر لم يُؤكد بعد', ' orders not confirmed yet'),
        ...(o ? [L('، أقدمها ', '; the oldest is '), { b: '#' + o.ref }, L(` منذ ${ageDays} يوم.`, `, ${ageDays} days old.`)] : ['.'])]
        : [L('لا توجد أوردرات معلقة في شوبيفاي.', 'No pending Shopify orders.')],
      sources: [{ n: 1, title: L('صفحة شوبيفاي', 'Shopify page'), detail: L('المعلقة', 'Pending'), link: { kind: 'page', page: 'shopify-orders' } }],
    };
  }

  // ── Sales speed (units per day) ───────────────────────────────────────────────────────────────
  /**
   * Units sold per product over a window — the same sales the reports count (type مبيعات, not
   * cancelled, not archived, business date in the window). Matched to the product by line
   * productId, else by code. A NEW metric (speed), not a second copy of a report total.
   */
  private async unitsSold(from: string, to: string): Promise<Map<string, number>> {
    return this.cached(`units|${from}|${to}`, to < cairoToday() ? 10 * 60_000 : 60_000, async () => {
      const rows = await this.connection.db!.collection('transactions').aggregate([
        { $match: { type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true }, date: dateWindowQuery(from, to) } },
        { $unwind: '$items' },
        { $group: { _id: { pid: '$items.productId', code: '$items.code' }, qty: { $sum: { $convert: { input: '$items.qty', to: 'double', onError: 0, onNull: 0 } } } } },
      ]).toArray();
      const out = new Map<string, number>();
      for (const r of rows) {
        const k = r._id?.pid ? 'id:' + String(r._id.pid) : r._id?.code ? 'code:' + String(r._id.code) : '';
        if (k) out.set(k, (out.get(k) || 0) + (Number(r.qty) || 0));
      }
      return out;
    });
  }

  private readonly genericCache = new Map<string, { at: number; ttl: number; p: Promise<any> }>();
  private cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.genericCache.get(key);
    if (hit && now - hit.at < hit.ttl) return hit.p;
    const p = fn();
    this.genericCache.set(key, { at: now, ttl, p });
    p.catch(() => this.genericCache.delete(key));
    if (this.genericCache.size > 80) for (const [k, v] of this.genericCache) if (now - v.at >= v.ttl) this.genericCache.delete(k);
    return p;
  }

  /** Every active product with its 30-day speed and how many days its ready stock lasts at that speed. */
  private async velocityRows(today: string) {
    const DAYS = 30;
    const [rows, sold] = await Promise.all([this.stockRows(), this.unitsSold(addDays(today, -(DAYS - 1)), today)]);
    return rows.map((r) => {
      const qty = (sold.get('id:' + r.id) || 0) + (r.code ? sold.get('code:' + r.code) || 0 : 0);
      const rate = qty / DAYS;
      const days = rate > 0 ? r.ready / rate : null;
      return { ...r, sold30: qty, rate, days, outOn: days !== null && days < 3650 ? addDays(today, Math.floor(days)) : null };
    });
  }

  /**
   * Products named by the question. A code match wins outright; otherwise every product with the best
   * word score is returned, so «oriva» gives all Oriva products instead of guessing one.
   */
  private findProducts<T extends { name: string; code: string }>(rows: T[], text: string): T[] {
    const words = normalizeQuestion(text).trim().split(' ').filter((w) => w.length > 1);
    if (!words.length) return [];
    const byCode = rows.filter((r) => r.code && words.includes(normalizeQuestion(r.code).trim()));
    if (byCode.length) return byCode.slice(0, 8);
    // The full name typed exactly wins outright («Riva Tissue» is not «Oriva …»).
    const phrase = words.join(' ');
    const exact = rows.filter((r) => normalizeQuestion(r.name).trim() === phrase);
    if (exact.length) return exact.slice(0, 8);
    const long = words.filter((w) => w.length > 2);
    let best = 0;
    const scored = rows.map((r) => {
      const hay = normalizeQuestion(`${r.name} ${r.code}`);
      const tokens = new Set(hay.trim().split(' '));
      // A whole word counts 1, a word found only inside another word («riva» in «oriva») 0.5.
      const sc = long.reduce((x, w) => x + (tokens.has(w) ? 1 : hay.includes(w) ? 0.5 : 0), 0);
      if (sc > best) best = sc;
      return { r, sc };
    });
    // Every meaningful word, or two of them for a long phrase — one stray word is not a match.
    if (!best || best < Math.min(long.length, 2) * 0.5 + (long.length > 1 ? 0.5 : 0)) return [];
    return scored.filter((x) => x.sc === best).map((x) => x.r).slice(0, 8);
  }

  private matchProduct<T extends { name: string; code: string }>(rows: T[], text: string): T | null {
    const words = normalizeQuestion(text).trim().split(' ').filter((w) => w.length > 2);
    let best: T | null = null, score = 0;
    for (const r of rows) {
      const hay = normalizeQuestion(`${r.name} ${r.code}`);
      let s = words.filter((w) => hay.includes(w)).length;
      if (r.code && words.includes(normalizeQuestion(r.code).trim())) s += 3;
      if (s > score) { score = s; best = r; }
    }
    return score >= 2 ? best : null;
  }

  private async velocity(u: Understood, user: AssistantUser, L: any, lang: Lang, today: string) {
    const topic = L('سرعة البيع', 'Sales speed');
    if (!this.canStock(user)) return this.denied('velocity', L('المخزون', 'Stock'), L, topic);
    const rows = await this.velocityRows(today);
    const src: Source = { n: 1, title: L('المبيعات آخر 30 يومًا + المخزن', 'Sales, last 30 days + inventory'), detail: this.rangeLabel(addDays(today, -29), today, lang), link: { kind: 'page', page: 'inventory', filter: 'reorder' } };
    const steps = [L('قسمت القطع المباعة في آخر 30 يومًا على 30 لمعرفة البيع اليومي', 'Divided pieces sold in the last 30 days by 30 to get the daily rate'),
      L('الأيام المتبقية = الصالح للبيع ÷ البيع اليومي', 'Days left = ready to sell ÷ daily rate')];
    const VELOCITY_WORDS = ['اسرع', 'المنتجات', 'منتجات', 'بيعا', 'بيع', 'البيع', 'سرعه', 'معدل', 'النفاد', 'بسرعه', 'بتتباع', 'بيتباع', 'velocity', 'fastest', 'selling', 'products', 'fast'];
    const subj = subjectOf(normalizeQuestion(u.text)).split(' ').filter((w) => !VELOCITY_WORDS.includes(w)).join(' ');
    const hits = subj ? this.findProducts(rows, subj) : [];
    const one = hits.length === 1 ? hits[0] : null;
    if (hits.length > 1) {
      return {
        intent: 'velocity', status: 'answered' as const, understood: [topic, subj], steps,
        lead: [L('مبيعات المنتجات المطابقة لـ ', 'Sales of the products matching '), { b: subj }, L(' في آخر 30 يومًا:', ' in the last 30 days:')],
        table: {
          cols: [{ label: L('المنتج', 'Product') }, { label: L('مباع', 'Sold'), num: true }, { label: L('يوميًا', 'Per day'), num: true }, { label: L('يكفي', 'Lasts'), num: true }],
          rows: hits.map((r) => [{ t: r.name, sub: r.code, link: { kind: 'product' as const, id: r.id } }, { v: r.sold30, f: 'int' as Fmt }, { v: r.rate, f: 'dec' as Fmt },
            r.days === null ? '—' : { t: L(`${Math.floor(r.days)} يوم`, `${Math.floor(r.days)} d`), tone: r.days <= 7 ? 'bad' : r.days <= 14 ? 'warn' : undefined }]),
        },
        sources: [src],
      };
    }
    const dateLbl = (d: string | null) => (d ? this.rangeLabel(d, d, lang) : '—');
    if (one) {
      return {
        intent: 'velocity', status: 'answered' as const, understood: [topic, one.code], steps,
        lead: one.rate > 0
          ? [{ b: one.name }, L(': يُباع منه نحو ', ': sells about '), { v: one.rate, f: 'dec' as Fmt, cite: 1 }, L(' قطعة يوميًا، والصالح للبيع ', ' a day; the ready stock of '), { v: one.ready, f: 'int' as Fmt },
            ...(one.days !== null ? [L(' يكفي نحو ', ' lasts about '), { v: Math.floor(one.days), f: 'int' as Fmt }, L(` يومًا (حتى ${dateLbl(one.outOn)}).`, ` days (until ${dateLbl(one.outOn)}).`)] : ['.'])]
          : [{ b: one.name }, L(': لم يُبع منه شيء في آخر 30 يومًا.', ': nothing sold in the last 30 days.')],
        kpis: [
          { label: L('مباع آخر 30 يومًا', 'Sold, 30 days'), v: one.sold30, f: 'int' as Fmt },
          { label: L('البيع اليومي', 'Per day'), v: one.rate, f: 'dec' as Fmt },
          { label: L('صالح للبيع', 'Ready'), v: one.ready, f: 'int' as Fmt },
          { label: L('وارد', 'Incoming'), v: one.incoming, f: 'int' as Fmt },
        ],
        sources: [{ ...src, title: L('صفحة المنتج', 'Product page'), detail: one.code, link: { kind: 'product', id: one.id } }],
      };
    }
    const fast = rows.filter((r) => r.rate > 0).sort((a, b) => b.rate - a.rate).slice(0, 10);
    const soon = fast.filter((r) => r.days !== null && r.days <= 14).length;
    return {
      intent: 'velocity', status: fast.length ? 'answered' as const : 'empty' as const, understood: [topic, L('آخر 30 يومًا', 'Last 30 days')], steps,
      lead: fast.length ? [L('أسرع ', 'The '), { v: fast.length, f: 'int' as Fmt, cite: 1 }, L(' منتجات بيعًا في آخر 30 يومًا', ' fastest-selling products in the last 30 days'),
        ...(soon ? [L('؛ منها ', '; '), { v: soon, f: 'int' as Fmt }, L(' ينفد خلال أسبوعين بهذه السرعة.', ' run out within two weeks at this pace.')] : ['.'])]
        : [L('لا توجد مبيعات في آخر 30 يومًا.', 'No sales in the last 30 days.')],
      table: fast.length ? {
        cols: [{ label: L('المنتج', 'Product') }, { label: L('يوميًا', 'Per day'), num: true }, { label: L('صالح', 'Ready'), num: true }, { label: L('يكفي', 'Lasts'), num: true }],
        rows: fast.map((r) => [{ t: r.name, sub: r.code, link: { kind: 'product' as const, id: r.id } }, { v: r.rate, f: 'dec' as Fmt }, { v: r.ready, f: 'int' as Fmt },
          r.days === null ? '—' : { t: L(`${Math.floor(r.days)} يوم`, `${Math.floor(r.days)} d`), tone: r.days <= 7 ? 'bad' : r.days <= 14 ? 'warn' : undefined }]),
      } : undefined,
      sources: [src],
    };
  }

  // ── Incoming from purchase orders (for the reorder analysis) ──────────────────────────────────
  /**
   * What is still on its way, per product and per purchase order. Rules (owner, Nov 22, 2026):
   *  • Only open orders: a PO converted to an invoice (`linkedTransactionId`) is received and recorded —
   *    its pieces are in stock, never incoming. A cancelled PO is deleted (the schema has no
   *    cancelled/rejected status), so it never appears.
   *  • Partial receipts: orders are often received through a SEPARATE purchase invoice (not converted).
   *    Each unlinked purchase invoice line is matched to the OLDEST open order of the same supplier,
   *    created before the invoice, holding that product, and deducted from it — each invoice piece is used
   *    once, so the same goods are never counted twice (in stock AND incoming) nor against two orders.
   *    30 ordered, 10 invoiced → 20 incoming. Local data, Nov 22: PO-2026-013 matched invoice #900024
   *    on 19 of 31 lines with equal quantities.
   *  • «مستلم» but not converted and not covered by an invoice = arrived, NOT recorded: counted neither
   *    as stock nor as incoming, listed so someone records it.
   *  • Overdue = expected delivery date before today. Incoming is never treated as sellable stock.
   */
  /** Incoming from open purchase orders — one implementation, in the purchasing engine service. */
  private async incomingDetail(today: string) {
    return this.engine.incoming(today);
  }

  // ── Purchasing engine (separate service: purchasing-engine/) ─────────────────────────────────
  private canPlan(user: AssistantUser) { return this.can(user, ['purchase-create', 'purchase-view', 'inventory']); }

  private engineRow(p: any, L: any, lang: Lang, seeCost: boolean) {
    const day = (d: string | null) => (d ? this.rangeLabel(d, d, lang) : '—');
    const ml = (m: string | null) => (m ? (METHOD_LABEL as any)[m][lang === 'en' ? 1 : 0] : L('لا يوجد', 'none'));
    const conf: Record<string, [string, string]> = { high: ['عالية', 'high'], medium: ['متوسطة', 'medium'], low: ['منخفضة', 'low'], none: ['لا توجد', 'none'] };
    const f1 = (n: number | null) => (n === null || n === undefined ? '—' : n > 0 && n < 1 ? n.toFixed(2) : (Math.round(n * 10) / 10).toString());
    return {
      id: p.id, name: p.name, code: p.code, buy: p.qty, ready: p.ready, incoming: p.incoming, rate: p.rate,
      now: p.daysNow === null ? null : Math.floor(p.daysNow), after: p.daysAfterIncoming === null ? null : Math.floor(p.daysAfterIncoming),
      shortfall: Math.max(0, Math.ceil(p.rate * p.horizon - p.position)), late: 0, arrived: 0, matched: 0,
      why: (lang === 'en' ? p.reasonsEn : p.reasons)[0] || '',
      details: [
        [L('التنبؤ اليومي', 'Daily forecast'), `${f1(p.rate)} · ${ml(p.method)}`],
        [L('ثقة التنبؤ', 'Forecast confidence'), `${conf[p.confidence][lang === 'en' ? 1 : 0]}${p.methodWape !== null ? ` · ${L('خطأ', 'error')} ${Math.round(p.methodWape * 100)}%` : ''}`],
        [L('مدة التوريد', 'Lead time'), `${p.leadDays} ${L('يوم', 'd')} · ${String(p.leadSource).startsWith('measured') ? L(`مقاسة من ${String(p.leadSource).split(':')[1]} أوامر`, `measured from ${String(p.leadSource).split(':')[1]} orders`) : p.leadSource === 'overall' ? L('متوسط كل الموردين', 'all-supplier median') : L('افتراضية', 'default')}`],
        [L('مخزون الأمان', 'Safety stock'), f1(p.safety)],
        [L('مستوى إعادة الطلب', 'Reorder level'), f1(p.rop)],
        [L('الطلب حتى', 'Order up to'), f1(p.orderUpTo)],
        [L('المخزون + الوارد', 'Stock + incoming'), f1(p.position)],
        [L('يكفي بعد الشراء', 'Cover after purchase'), p.daysAfterPurchase === null ? '—' : `${Math.floor(p.daysAfterPurchase)} ${L('يوم', 'd')}`],
        [L('تاريخ النفاد المتوقع', 'Expected stockout'), day(p.stockoutDate)],
        [L('احتمال النفاد لو تأخر الشراء', 'Stockout risk if delayed'), `${Math.round(p.pStockout * 100)}%`],
        [L('المورد', 'Supplier'), p.supplier || L('بدون مورد أساسي', 'no primary supplier')],
        ...(seeCost ? [[L('التكلفة التقديرية', 'Estimated cost'), `${Math.round(p.cost).toLocaleString('en-US')} ${L('جنيه', 'EGP')}`], [L('الربح المعرّض للخطر', 'Margin at risk'), `${Math.round(p.marginAtRisk).toLocaleString('en-US')} ${L('جنيه', 'EGP')}`]] : []),
        ...(p.trendPct !== null ? [[L('اتجاه الطلب (30 مقابل 90 يومًا)', 'Demand trend (30 vs 90 days)'), `${p.trendPct >= 0 ? '+' : '−'}${Math.abs(Math.round(p.trendPct))}%`]] : []),
        ...(p.pendingUnits ? [[L('في أوردرات شوبيفاي غير المؤكدة', 'In unconfirmed Shopify orders'), String(p.pendingUnits)]] : []),
        ...(p.offerShare90 > 0.2 ? [[L('بِيع بسعر عرض (90 يومًا)', 'Sold at an offer price (90 days)'), `${Math.round(p.offerShare90 * 100)}%`]] : []),
      ],
    };
  }

  private async smartPlan(_u: Understood, user: AssistantUser, L: any, lang: Lang, today: string) {
    const topic = L('خطة الشراء الذكية', 'Smart purchase plan');
    if (!this.canPlan(user)) return this.denied('smartplan', L('خطة الشراء', 'The purchase plan'), L, topic);
    const run = await this.engine.run(today);
    const seeCost = this.can(user, ['purchase-edit-price', 'purchase-create']);
    const buy = run.plans.filter((p) => p.qty > 0);
    const urgent = buy.filter((p) => p.priority === 'urgent'), order = buy.filter((p) => p.priority === 'order');
    const watch = run.plans.filter((p) => p.priority === 'watch');
    const pieces = buy.reduce((s, p) => s + p.qty, 0), cost = buy.reduce((s, p) => s + p.cost, 0);
    const ex = run.plans.filter((p) => p.priority === 'excluded' || p.priority === 'ok');
    const count = (pred: (p: any) => boolean) => ex.filter(pred).length;
    const points: Point[] = [];
    const nOk = count((p) => p.priority === 'ok'), nNoDemand = count((p) => /90/.test(p.reasons[0] || '')), nInactive = count((p) => !p.active), nNoData = count((p) => /كافية/.test(p.reasons[0] || ''));
    if (nOk) points.push({ tone: 'good', t: L(`${nOk} منتج لا يحتاج شراء: مخزونه والوارد فوق مستوى إعادة الطلب`, `${nOk} products need nothing: stock plus incoming is above the reorder level`) });
    if (nNoDemand) points.push({ tone: 'neutral', t: L(`${nNoDemand} منتج لا طلب عليه في آخر 90 يومًا — لا يُقترح شراؤه`, `${nNoDemand} products had no demand in 90 days — not suggested`) });
    if (nNoData) points.push({ tone: 'neutral', t: L(`${nNoData} منتج بيانات بيعه غير كافية للتنبؤ`, `${nNoData} products lack enough sales history to forecast`) });
    if (nInactive) points.push({ tone: 'neutral', t: L(`${nInactive} منتج غير نشط`, `${nInactive} inactive products`) });
    let actions: any[] | undefined;
    if (buy.length && this.can(user, ['purchase-create'])) {
      const prods: any[] = await this.connection.db!.collection('products').find({}, { projection: { supplier: 1, supplierId: 1 } }).toArray();
      const sup = new Map(prods.map((x) => [String(x._id), { id: String(x.supplierId || ''), name: String(x.supplier || '') }]));
      actions = [{ kind: 'createPo', label: L('إنشاء أمر شراء', 'Create purchase order'),
        lines: buy.map((p) => ({ productId: p.id, sku: p.code, name: p.name, qty: p.qty, incoming: p.incoming, ready: p.ready, ...(seeCost && p.unitCost > 0 ? { unitPrice: Math.round(p.unitCost * 100) / 100 } : {}), supplierId: sup.get(p.id)?.id || '', supplier: sup.get(p.id)?.name || '' })) }];
    }
    const groups = [
      { key: 'urgent', tone: 'bad', title: L('عاجل — ينفد قبل أن يصل طلب جديد', 'Urgent — runs out before a new order can arrive'), rows: urgent.map((p) => this.engineRow(p, L, lang, seeCost)) },
      { key: 'order', tone: 'warn', title: L('اطلب الآن — وصل إلى مستوى إعادة الطلب', 'Order now — at the reorder level'), rows: order.map((p) => this.engineRow(p, L, lang, seeCost)) },
      { key: 'watch', tone: 'neutral', title: L('راقب — يقترب من مستوى إعادة الطلب خلال أسبوع', 'Watch — near the reorder level within a week'), rows: watch.slice(0, 8).map((p) => this.engineRow(p, L, lang, seeCost)) },
    ].filter((g) => g.rows.length);
    return {
      intent: 'smartplan', status: 'answered' as const, understood: [topic],
      steps: [
        L(`سجل طلب يومي لكل منتج منذ ${this.rangeLabel(run.historyFrom, run.historyFrom, lang)}، مع استبعاد أيام النفاد من حساب الطلب`, `Daily demand ledger per product since ${this.rangeLabel(run.historyFrom, run.historyFrom, lang)}, excluding out-of-stock days from demand`),
        L('لكل منتج: اختبار 8 طرق تنبؤ على تاريخه واختيار الأدق', 'Per product: 8 forecasting methods backtested on its history; the most accurate one is used'),
        L(`مستوى خدمة 95%: مخزون الأمان يغطي مدة التوريد المقاسة لكل مورد + أسبوع المراجعة`, 'Service level 95%: safety stock covers each supplier\'s measured lead time + the weekly review'),
        L('الأولوية = الربح المحمي لكل جنيه شراء بعد خصم تكلفة التخزين (2% شهريًا)', 'Priority = margin protected per EGP purchased, net of holding cost (2% a month)'),
      ],
      lead: buy.length
        ? [L('خطة الشراء الذكية: ', 'Smart plan: '), { v: buy.length, f: 'int' as Fmt, cite: 1 }, L(' منتج يحتاج شراء الآن', ' products to buy now'),
          ...(urgent.length ? [L('، منها ', ', '), { v: urgent.length, f: 'int' as Fmt }, L(' عاجل', ' urgent')] : []), L('، بإجمالي ', ', '), { v: pieces, f: 'int' as Fmt }, L(' قطعة.', ' pieces.')]
        : [L('خطة الشراء الذكية: لا يحتاج أي منتج إلى شراء الآن.', 'Smart plan: nothing needs buying now.')],
      kpis: [
        { label: L('عاجل', 'Urgent'), v: urgent.length, f: 'int' as Fmt },
        { label: L('اطلب الآن', 'Order now'), v: order.length, f: 'int' as Fmt },
        { label: L('راقب', 'Watch'), v: watch.length, f: 'int' as Fmt },
        ...(seeCost ? [{ label: L('التكلفة التقديرية', 'Estimated cost'), v: cost, f: 'money' as Fmt }] : []),
      ],
      plan: groups.length ? { groups } : undefined,
      actions,
      pointsTitle: points.length ? L('ما لم يُقترح ولماذا', 'What is not suggested, and why') : undefined,
      points: points.length ? points : undefined,
      note: L('هذه خطة المحرك الجديد، ولم تحل محل اقتراح الـ44 يومًا بعد. اسأل «تقرير محرك الشراء» لمقارنته بالمعادلة الحالية على الأشهر الماضية، أو «ليه مقترح/مش مقترح شراء …» لشرح منتج.',
        'This is the new engine\'s plan; it has not replaced the 44-day suggestion. Ask «purchasing engine report» to compare it with the current rule over past months, or «why is … (not) suggested» for one product.'),
      options: [L('تقرير محرك الشراء', 'Purchasing engine report'), L('اقترح كميات الشراء', 'Suggest reorder quantities')],
      sources: [{ n: 1, title: L('محرك الشراء', 'Purchasing engine'), detail: this.rangeLabel(run.historyFrom, today, lang), link: { kind: 'page', page: 'inventory', filter: 'reorder' } }],
    };
  }

  private async engineReport(_u: Understood, user: AssistantUser, L: any, lang: Lang, today: string) {
    const topic = L('تقرير محرك الشراء', 'Purchasing engine report');
    if (!this.canPlan(user)) return this.denied('engine', L('تقرير محرك الشراء', 'The engine report'), L, topic);
    const run = await this.engine.run(today);
    const v = run.validation;
    const seeMoney = this.can(user, 'admin') || this.can(user, ['purchase-edit-price']);
    const fill = (s: any) => (s.demand > 0 ? (s.served / s.demand) * 100 : 0);
    const net = (s: any) => s.marginEarned - s.holdingCost;
    const perStock = (s: any) => (s.avgStockValue > 0 ? net(s) / s.avgStockValue : 0);
    const k = (n: number) => `${Math.round(n / 1000).toLocaleString('en-US')} ${L('ألف', 'k')}`;
    const rows: any[] = [
      [L('نسبة تلبية الطلب', 'Demand served'), ...[v.current, v.engine, v.optimal].map((s) => ({ v: fill(s), f: 'pct' as Fmt }))],
      [L('قطع ضائعة بسبب النفاد', 'Units lost to stockouts'), ...[v.current, v.engine, v.optimal].map((s) => ({ v: s.lostUnits, f: 'int' as Fmt }))],
      [L('أيام نفاد (مجموع المنتجات)', 'Stockout days (all products)'), ...[v.current, v.engine, v.optimal].map((s) => ({ v: s.stockoutDays, f: 'int' as Fmt }))],
    ];
    if (seeMoney) rows.push(
      [L('متوسط قيمة المخزون', 'Average stock value'), ...[v.current, v.engine, v.optimal].map((s) => k(s.avgStockValue))],
      [L('مخزون زائد في النهاية (> 90 يومًا)', 'Excess stock at the end (> 90 days)'), ...[v.current, v.engine, v.optimal].map((s) => k(s.endExcessValue))],
      [L('قيمة المشتريات', 'Purchases'), ...[v.current, v.engine, v.optimal].map((s) => k(s.purchasedValue))],
      [L('صافي الربح (الهامش − التخزين)', 'Net contribution (margin − holding)'), ...[v.current, v.engine, v.optimal].map((s) => k(net(s)))],
      [L('الربح لكل جنيه مخزون', 'Contribution per EGP of stock'), ...[v.current, v.engine, v.optimal].map((s) => ({ v: perStock(s), f: 'dec' as Fmt }))],
    );
    const best = [['current', net(v.current)], ['engine', net(v.engine)], ['optimal', net(v.optimal)]].sort((a: any, b: any) => b[1] - a[1])[0][0];
    const verdict = best === 'current'
      ? L('المعادلة الحالية حققت أعلى ربح في المحاكاة، لكن المحرك احتاج رأس مال أقل بكثير وكان تنبؤه أدق. التوصية: إبقاء المعادلة الحالية للكميات، واستخدام المحرك للأولويات والتنبؤ والشرح، وإعادة المقارنة بعد تراكم بيانات أكثر.',
        'The current rule earned the most in the simulation, but the engine needed far less capital and forecast better. Recommendation: keep the current rule for quantities, use the engine for priorities, forecasts and explanations, and re-run the comparison as more data accumulates.')
      : L('المحرك حقق ربحًا أعلى من المعادلة الحالية في المحاكاة. القرار باعتماده لك؛ لن يُستبدل الاقتراح الحالي تلقائيًا.',
        'The engine earned more than the current rule in the simulation. Adopting it is your call; the current suggestion is not replaced automatically.');
    const ml = (m: string) => (METHOD_LABEL as any)[m][lang === 'en' ? 1 : 0];
    const points: Point[] = [];
    if (v.chosenWape !== null && v.currentBasisWape !== null) points.push({ tone: v.chosenWape < v.currentBasisWape ? 'good' : 'warn', t: L(`دقة التنبؤ: خطأ المحرك ${Math.round(v.chosenWape * 100)}% مقابل ${Math.round(v.currentBasisWape * 100)}% لمتوسط 30 يومًا (أساس المعادلة الحالية)`, `Forecast error: engine ${Math.round(v.chosenWape * 100)}% vs ${Math.round(v.currentBasisWape * 100)}% for the 30-day average (basis of the current rule)`), sub: L(`الطرق الأدق إجمالًا: ${v.accuracy.slice(0, 3).map((a) => `${ml(a.method)} ${Math.round(a.wape * 100)}%`).join('، ')}`, `Most accurate overall: ${v.accuracy.slice(0, 3).map((a) => `${ml(a.method)} ${Math.round(a.wape * 100)}%`).join(', ')}`) });
    const mm = v.checks.balanceMismatches.length;
    points.push({ tone: mm ? 'warn' : 'good', t: L(`مطابقة المخزون: الرصيد المُعاد بناؤه يومًا بيوم يطابق رصيد النظام في ${v.checks.balanceProducts - mm} من ${v.checks.balanceProducts} منتج`, `Stock check: the day-by-day rebuilt balance equals the system balance for ${v.checks.balanceProducts - mm} of ${v.checks.balanceProducts} products`) });
    points.push({ tone: v.checks.reportUnits30 === v.checks.ledgerUnits30 ? 'good' : 'warn', t: L(`مطابقة المبيعات: قطع آخر 30 يومًا ${v.checks.ledgerUnits30} في سجل الطلب و${v.checks.reportUnits30} في تقرير المبيعات`, `Sales check: last 30 days ${v.checks.ledgerUnits30} pieces in the demand ledger, ${v.checks.reportUnits30} in the sales report`) });
    const leads = run.leadTimes.filter((x) => x.supplier !== '*');
    if (leads.length) points.push({ tone: 'neutral', t: L(`مدة التوريد المقاسة: ${leads.map((x) => `${x.supplier} ${x.days} يوم (${x.samples} أوامر)`).join('، ')}`, `Measured lead time: ${leads.map((x) => `${x.supplier} ${x.days} d (${x.samples} orders)`).join(', ')}`), sub: L('من تاريخ أمر الشراء حتى فاتورة استلامه؛ باقي الموردين يأخذون المتوسط العام', 'From the PO date to its receiving invoice; other suppliers use the overall median') });
    points.push({ tone: 'warn', t: L(`حدود البيانات: ${run.historyDays} يومًا فقط من التاريخ`, `Data limits: only ${run.historyDays} days of history`), sub: L('لا تكفي لقياس الموسمية (تحتاج سنة على الأقل). اختيار أفضل طريقة تم على نفس فترة الاختبار، فالدقة الفعلية قد تكون أقل قليلًا. في أيام النفاد الفعلية قُدّر الطلب بمتوسط 30 يومًا. لا توجد إلغاءات مسجّلة بسبب «الصنف غير متوفر»، فالطلب الضائع منها صفر.', 'Not enough to measure seasonality (needs a year). The best method was picked on the same test period, so true accuracy may be slightly lower. On real out-of-stock days demand was imputed at the 30-day rate. No cancellations are recorded as «out of stock», so lost demand from them is zero.') });
    return {
      intent: 'engine', status: 'answered' as const, understood: [topic],
      steps: [
        L(`محاكاة آخر ${v.simDays} يومًا لـ${v.products} منتجًا: كل أسبوع يقرّر كل نظام بما كان معروفًا وقتها فقط، والطلب يصل بعد مدة التوريد`, `Replayed the last ${v.simDays} days for ${v.products} products: each week every policy decides with only what was known then; orders arrive after the lead time`),
        L('المحرك الأمثل يحدد مستوى الخدمة لكل منتج من هامشه مقابل تكلفة تخزينه', 'The optimal engine sets each product\'s service level from its margin vs its holding cost'),
      ],
      lead: [verdict],
      table: { cols: [{ label: '' }, { label: L('المعادلة الحالية', 'Current rule'), num: true }, { label: L('المحرك 95%', 'Engine 95%'), num: true }, { label: L('المحرك الأمثل', 'Engine optimal'), num: true }], rows },
      pointsTitle: L('التحقق وحدود النتائج', 'Checks and limits'),
      points,
      options: [L('خطة الشراء الذكية', 'Smart purchase plan')],
      sources: [{ n: 1, title: L('محرك الشراء', 'Purchasing engine'), detail: this.rangeLabel(run.historyFrom, today, lang), link: { kind: 'page', page: 'reports', tab: 'kpis', from: addDays(today, -v.simDays + 1), to: today } }],
    };
  }

  private async explainProduct(u: Understood, user: AssistantUser, L: any, lang: Lang, today: string) {
    const topic = L('شرح قرار الشراء', 'Purchase decision explained');
    if (!this.canPlan(user)) return this.denied('explain', L('خطة الشراء', 'The purchase plan'), L, topic);
    const run = await this.engine.run(today);
    const found = this.findProducts(run.plans, u.subject || '');
    if (!found.length) return this.unknown(u, L);
    if (found.length > 1) {
      return { intent: 'explain', status: 'ambiguous' as const, understood: [topic, u.subject || ''], steps: [],
        lead: [L('أي منتج تقصد؟', 'Which product do you mean?')],
        options: found.slice(0, 6).map((p: any) => L(`ليه مقترح شراء ${p.name}`, `Why is ${p.name} suggested`)), sources: [] };
    }
    const p: any = found[0];
    const seeCost = this.can(user, ['purchase-edit-price', 'purchase-create']);
    const row = this.engineRow(p, L, lang, seeCost);
    const prioText: Record<string, [string, string]> = { urgent: ['مقترح شراؤه — عاجل', 'Suggested — urgent'], order: ['مقترح شراؤه الآن', 'Suggested now'], watch: ['غير مقترح الآن — تحت المراقبة', 'Not now — watch'], ok: ['غير مقترح — لا يحتاج شراء', 'Not suggested — no need'], excluded: ['مستبعد من الخطة', 'Excluded from the plan'] };
    const reasons = lang === 'en' ? p.reasonsEn : p.reasons;
    const points: Point[] = reasons.map((r: string) => ({ tone: p.qty > 0 ? 'warn' : 'neutral', t: r }));
    if (p.qty > 0) {
      points.push({ tone: 'neutral', t: L(`الكمية: مستوى «الطلب حتى» ${Math.round(p.orderUpTo)} − المخزون والوارد ${Math.round(p.position)} = ${p.qty}`, `Quantity: order-up-to ${Math.round(p.orderUpTo)} − stock and incoming ${Math.round(p.position)} = ${p.qty}`),
        sub: L(`«الطلب حتى» = تنبؤ ${p.horizon} يومًا (مدة التوريد + أسبوع) + مخزون أمان ${Math.round(p.safety)} + أسبوع إضافي`, `Order-up-to = ${p.horizon}-day forecast (lead time + a week) + safety stock ${Math.round(p.safety)} + one more week`) });
      points.push({ tone: 'bad', t: L(`لو تأخر الشراء: احتمال النفاد قبل وصول الطلب ${Math.round(p.pStockout * 100)}%`, `If purchasing waits: ${Math.round(p.pStockout * 100)}% chance of running out before an order arrives`),
        sub: seeCost && p.marginAtRisk > 0 ? L(`ربح معرّض للخطر نحو ${Math.round(p.marginAtRisk).toLocaleString('en-US')} جنيه`, `About EGP ${Math.round(p.marginAtRisk).toLocaleString('en-US')} of margin at risk`) : undefined });
    }
    if (p.alt && p.alt.length > 1) points.push({ tone: 'neutral', t: L(`طرق التنبؤ المختبرة: ${p.alt.map((a: any) => `${(METHOD_LABEL as any)[a.method][0]} ${Math.round(a.wape * 100)}%`).join('، ')}`, `Methods tested: ${p.alt.map((a: any) => `${(METHOD_LABEL as any)[a.method][1]} ${Math.round(a.wape * 100)}%`).join(', ')}`), sub: L('النسبة = متوسط الخطأ في الاختبار على التاريخ؛ تُختار الأقل', 'Percent = average error in the backtest; the lowest is used') });
    return {
      intent: 'explain', status: 'answered' as const, understood: [topic, p.code],
      steps: [L('قرأت خطة المحرك لهذا المنتج: التنبؤ ومخزون الأمان ومستوى إعادة الطلب', 'Read the engine plan for this product: forecast, safety stock, reorder level')],
      lead: [{ b: p.name }, ': ', prioText[p.priority][lang === 'en' ? 1 : 0], ...(p.qty > 0 ? [L(' · اشترِ ', ' · buy '), { v: p.qty, f: 'int' as Fmt }] : []), '.'],
      plan: { groups: [{ key: 'one', tone: p.priority === 'urgent' ? 'bad' : p.priority === 'order' ? 'warn' : 'neutral', title: L('بيانات القرار', 'Decision data'), rows: [row] }] },
      pointsTitle: L('لماذا', 'Why'),
      points,
      sources: [{ n: 1, title: L('صفحة المنتج', 'Product page'), detail: p.code, link: { kind: 'product', id: p.id } }],
    };
  }

  // ── Reorder suggestions ───────────────────────────────────────────────────────────────────────
  /** Lead time (days until a purchase arrives) and cover (days a reorder should last) — stated in every answer. */
  private static readonly LEAD_DAYS = 14;
  private static readonly COVER_DAYS = 30;

  /**
   * The reorder plan. Incoming (open purchase orders not received yet — the inventory page's «وارد») is
   * deducted, so a product already on order is not suggested again; `covered` lists the products that
   * WOULD need buying but whose incoming already covers them, so the answer can say so.
   */
  private async reorderPlan(today: string) {
    const [rows, inc] = await Promise.all([this.velocityRows(today), this.incomingDetail(today)]);
    const horizon = AssistantService.LEAD_DAYS + AssistantService.COVER_DAYS;
    const all = rows.map((r) => {
      const d = inc.perProduct.get(r.id);
      const incoming = d ? d.counted : 0;            // confirmed incoming only (see incomingDetail)
      const target = Math.max(r.rate * horizon, r.min);
      const relevant = r.rate > 0 || r.ready < r.min;
      // ⚠ The suggestion formula is unchanged: target − ready − incoming.
      const gross = relevant ? Math.ceil(target - r.ready) : 0;
      const need = relevant ? Math.ceil(target - r.ready - incoming) : 0;
      return {
        ...r, incoming, gross: Math.max(0, gross), need: Math.max(0, need),
        daysAfter: r.rate > 0 ? (r.ready + incoming) / r.rate : null,
        shortfall: r.rate > 0 ? Math.max(0, Math.ceil(r.rate * horizon - r.ready - incoming)) : 0,
        incOverdue: d ? d.overdue : 0, incNoDate: d ? d.nodate : 0, arrived: d ? d.arrived : 0, matched: d ? d.matched : 0, nextDate: d ? d.nextDate : '',
      };
    });
    const list = all.filter((r) => r.need > 0).sort((a, b) => (a.days ?? 9999) - (b.days ?? 9999) || b.shortfall - a.shortfall || b.rate - a.rate);
    const covered = all.filter((r) => r.gross > 0 && r.need <= 0 && r.incoming > 0);
    return { list, covered, orders: inc.orders };
  }

  private async reorderRows(today: string) {
    return (await this.reorderPlan(today)).list;
  }

  private async reorder(_u: Understood, user: AssistantUser, L: any, lang: Lang, today: string) {
    const topic = L('اقتراح كميات الشراء', 'Reorder suggestions');
    if (!this.canStock(user)) return this.denied('reorder', L('المخزون', 'Stock'), L, topic);
    const { list, covered, orders } = await this.reorderPlan(today);
    const seeCost = this.can(user, ['purchase-edit-price', 'purchase-create']);
    const incomingUsed = list.reduce((x, r) => x + Math.min(r.incoming, r.gross), 0) + covered.reduce((x, r) => x + Math.min(r.incoming, r.gross), 0);
    const prodById = new Map((await this.transactions.getInventory()).map((p) => [String(p._id), p]));
    const costOf = (id: string) => Number(currentUnitCost(prodById.get(id) as any)) || 0;
    const incomingPoints = this.incomingPoints(orders, new Set([...list, ...covered].map((r) => r.id)), L, lang);
    const pieces = list.reduce((s, r) => s + r.need, 0);
    const cost = list.reduce((s, r) => s + r.need * costOf(r.id), 0);
    const urgent = list.filter((r) => r.days !== null && r.days <= AssistantService.LEAD_DAYS).length;
    // Purchase-order button: each line carries its primary supplier so the dialog can pre-select one
    // supplier and its lines (a purchase order has one supplier). Same create route as the demand analysis.
    let actions: any[] | undefined;
    if (list.length && this.can(user, ['purchase-create'])) {
      const prods: any[] = await this.connection.db!.collection('products').find({}, { projection: { supplier: 1, supplierId: 1 } }).toArray();
      const sup = new Map(prods.map((x) => [String(x._id), { id: String(x.supplierId || ''), name: String(x.supplier || '') }]));
      actions = [{
        kind: 'createPo', label: L('إنشاء أمر شراء', 'Create purchase order'),
        lines: list.map((r) => ({ productId: r.id, sku: r.code, name: r.name, qty: r.need, incoming: r.incoming, ready: r.ready, ...(seeCost && costOf(r.id) > 0 ? { unitPrice: Math.round(costOf(r.id) * 100) / 100 } : {}),
          supplierId: sup.get(r.id)?.id || '', supplier: sup.get(r.id)?.name || '' })),
      }];
    }
    return {
      intent: 'reorder', status: list.length ? 'answered' as const : 'empty' as const,
      understood: [topic],
      steps: [
        L('البيع اليومي = المباع في آخر 30 يومًا ÷ 30', 'Daily rate = pieces sold in the last 30 days ÷ 30'),
        L(`المطلوب = البيع اليومي × ${AssistantService.LEAD_DAYS + AssistantService.COVER_DAYS} يومًا (${AssistantService.LEAD_DAYS} للتوريد + ${AssistantService.COVER_DAYS} تغطية)، ولا يقل عن الحد الأدنى`,
          `Target = daily rate × ${AssistantService.LEAD_DAYS + AssistantService.COVER_DAYS} days (${AssistantService.LEAD_DAYS} lead + ${AssistantService.COVER_DAYS} cover), never below the minimum`),
        L('الكمية المقترحة = المطلوب − الصالح للبيع − الوارد من أوامر الشراء', 'Suggested = target − ready − incoming from purchase orders'),
      ],
      lead: list.length
        ? [L('يُقترح شراء ', 'Suggested: '), { v: pieces, f: 'int' as Fmt, cite: 1 }, L(' قطعة من ', ' pieces of '), { v: list.length, f: 'int' as Fmt }, L(' منتج', ' products'),
          ...(urgent ? [L('؛ ', '; '), { v: urgent, f: 'int' as Fmt }, L(' منها ينفد قبل وصول طلب جديد (14 يومًا).', ' run out before a new order could arrive (14 days).')] : ['.']),
          ...(incomingUsed ? [L(' خُصم ', ' Deducted '), { v: incomingUsed, f: 'int' as Fmt }, L(' قطعة واردة من أوامر شراء مفتوحة', ' incoming pieces from open purchase orders'),
            ...(covered.length ? [L('، و', ', and '), { v: covered.length, f: 'int' as Fmt }, L(' منتج لم يُقترح لأن الوارد يغطيه.', ' products are left out because their incoming covers them.')] : ['.'])] : [])]
        : [L('لا يحتاج أي منتج إلى شراء الآن بحسب سرعة البيع والمخزون والوارد', 'Nothing needs reordering now, given sales speed, stock and incoming'),
          ...(covered.length ? [L('؛ ', '; '), { v: covered.length, f: 'int' as Fmt }, L(' منتج يغطيه الوارد من أوامر الشراء المفتوحة.', ' products are covered by open purchase orders.')] : ['.'])],
      kpis: list.length ? [
        { label: L('منتجات', 'Products'), v: list.length, f: 'int' as Fmt },
        { label: L('قطع مقترحة', 'Suggested pieces'), v: pieces, f: 'int' as Fmt },
        { label: L('عاجل', 'Urgent'), v: urgent, f: 'int' as Fmt },
        ...(seeCost ? [{ label: L('التكلفة التقديرية', 'Estimated cost'), v: cost, f: 'money' as Fmt }] : []),
      ] : undefined,
      plan: list.length ? { groups: this.planGroups(list, L, lang) } : undefined,
      pointsTitle: incomingPoints.length ? L('الوارد من أوامر الشراء المفتوحة', 'Incoming from open purchase orders') : undefined,
      points: incomingPoints.length ? incomingPoints : undefined,
      actions,
      note: list.length ? L('«الآن» من الصالح للبيع فقط؛ «بعد الوارد» يضيف أوامر الشراء المفتوحة المؤكدة، ولا يُعدّ الوارد متاحًا للبيع قبل استلامه وتسجيله. «العجز» = طلب 44 يومًا − الصالح − الوارد. «اشترِ» بنفس المعادلة ويحترم الحد الأدنى. اقتراح فقط حتى تضغط «إنشاء أمر شراء».',
        '«Now» counts ready stock only; «after incoming» adds confirmed open purchase orders — incoming is never sellable before it is received and recorded. «Shortfall» = 44 days of demand − ready − incoming. «Buy» uses the same formula and respects the minimum. A suggestion until you press «Create purchase order».') : undefined,
      sources: [{ n: 1, title: L('المخزن ← يحتاج طلب شراء', 'Inventory → needs reorder'), detail: L('الآن', 'Now'), link: { kind: 'page', page: 'inventory', filter: 'reorder' } }],
    };
  }

  /** Suggested products grouped by urgency, most urgent first; each row is drawn as a card. */
  private planGroups(list: any[], L: any, _lang: Lang) {
    const lead = AssistantService.LEAD_DAYS;
    const row = (r: any) => ({
      id: r.id, name: r.name, code: r.code, buy: r.need, ready: r.ready, incoming: r.incoming, rate: r.rate,
      now: r.days === null ? null : Math.floor(r.days), after: r.daysAfter === null ? null : Math.floor(r.daysAfter),
      shortfall: r.shortfall, late: r.incOverdue, nodate: r.incNoDate, arrived: r.arrived, matched: r.matched, nextDate: r.nextDate, min: r.min,
    });
    const urgent = list.filter((r) => r.days !== null && r.days <= lead);
    const soon = list.filter((r) => r.days !== null && r.days > lead && r.days <= 30);
    const rest = list.filter((r) => r.days === null || r.days > 30);
    return [
      { key: 'urgent', tone: 'bad', title: L(`عاجل — ينفد قبل وصول طلب جديد (${lead} يومًا)`, `Urgent — runs out before a new order could arrive (${lead} days)`), rows: urgent.map(row) },
      { key: 'soon', tone: 'warn', title: L('قريبًا — ينفد خلال 30 يومًا', 'Soon — runs out within 30 days'), rows: soon.map(row) },
      { key: 'rest', tone: 'neutral', title: L('تكملة للحد الأدنى أو لتغطية 44 يومًا', 'Top up to the minimum or to 44 days of cover'), rows: rest.map(row) },
    ].filter((g) => g.rows.length);
  }

  /** Open purchase orders behind the suggestion: overdue first, then the ones needing action, then by date. */
  private incomingPoints(orders: any[], ids: Set<string>, L: any, lang: Lang): Point[] {
    const rank: Record<string, number> = { overdue: 0, arrived: 1, nodate: 2, ontime: 3 };
    const rel = orders.filter((o) => o.state === 'arrived' || o.received > 0 || o.productIds.some((id: string) => ids.has(id)))
      .sort((a, b) => (rank[a.state] - rank[b.state]) || String(a.expected).localeCompare(String(b.expected)))
      .slice(0, 8);
    const day = (d: string) => (d ? this.rangeLabel(d, d, lang) : '');
    return rel.map((o) => {
      const head = o.received
        ? L(`${o.poNumber} · ${o.supplier} · المتبقي ${o.remaining} من ${o.ordered} قطعة`, `${o.poNumber} · ${o.supplier} · ${o.remaining} of ${o.ordered} pcs left`)
        : L(`${o.poNumber} · ${o.supplier} · ${o.remaining} قطعة`, `${o.poNumber} · ${o.supplier} · ${o.remaining} pcs`);
      let tone: Tone = 'good';
      const parts: string[] = [];
      if (o.remaining > 0) {
        if (o.state === 'arrived') { tone = 'warn'; parts.push(L('وصل (مستلم) ولم تُسجَّل فاتورته — لا يُحسب في المخزون ولا في الوارد حتى يُسجَّل', 'Arrived but not recorded — counted neither as stock nor as incoming until recorded')); }
        else if (o.state === 'overdue') { tone = 'bad'; parts.push(L(`متأخر ${o.lateDays} يوم — كان متوقعًا ${day(o.expected)}`, `${o.lateDays} days late — expected ${day(o.expected)}`)); }
        else if (o.state === 'nodate') { tone = 'warn'; parts.push(L('بدون موعد استلام', 'No expected delivery date')); }
        else parts.push(L(`متوقع ${day(o.expected)}`, `Expected ${day(o.expected)}`));
      } else parts.push(L('استُلم بالكامل', 'Fully received'));
      if (o.received) {
        if (tone === 'good') tone = 'warn';
        const refs = o.refs.map((r: string) => '#' + r).join(L('، ', ', '));
        parts.push(L(`استُلم ${o.received} قطعة بفاتورة ${refs} غير مربوطة بالأمر — اربط الأمر أو أغلقه`, `${o.received} pcs received by invoice ${refs}, not linked to the order — link or close the order`));
      }
      if (o.remaining > 0 && o.state !== 'arrived') parts.push(L(`الحالة: ${o.status}`, `status: ${o.status}`));
      return { t: head, sub: parts.join(' · '), tone, link: { kind: 'po' as const, id: o.id } };
    });
  }

  // ── Alerts ────────────────────────────────────────────────────────────────────────────────────
  /**
   * Problems worth a manager's attention, each measured against the four weeks before:
   * sales drop, more cancellations, more returns, Shopify orders waiting > 48h, products that run
   * out within 7 days at their speed, products out of stock that were selling, negative balances.
   * Only the checks the asker may see are run.
   */
  private async alertPoints(user: AssistantUser, L: any, lang: Lang, today: string): Promise<{ points: Point[]; sources: Source[]; checked: number }> {
    const points: Point[] = [];
    const sources: Source[] = [];
    let checked = 0;
    const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
    const wkFrom = addDays(today, -7), wkTo = addDays(today, -1);
    const baseFrom = addDays(today, -35), baseTo = addDays(today, -8);
    if (this.can(user, REPORT_PERMS)) {
      checked += 3;
      const [w, b] = await Promise.all([this.report(wkFrom, wkTo), this.report(baseFrom, baseTo)]);
      sources.push(this.reportSource(sources.length + 1, L('تقرير آخر 7 أيام', 'Last 7 days report'), { from: wkFrom, to: wkTo }, lang));
      const sales = Number(w.totalSales) || 0, avgSales = (Number(b.totalSales) || 0) / 4;
      const sd = pct(sales, avgSales);
      if (sd !== null && sd <= -20) points.push({ tone: sd <= -35 ? 'bad' : 'warn', t: L(`المبيعات أقل بـ${Math.abs(sd)}% من متوسط الأسابيع الأربعة السابقة`, `Sales are ${Math.abs(sd)}% below the average of the previous four weeks`), sub: L(`آخر 7 أيام ${Math.round(sales).toLocaleString('en-US')} مقابل متوسط ${Math.round(avgSales).toLocaleString('en-US')} جنيه`, `Last 7 days EGP ${Math.round(sales).toLocaleString('en-US')} vs average ${Math.round(avgSales).toLocaleString('en-US')}`), link: { kind: 'page', page: 'reports', tab: 'kpis', from: wkFrom, to: wkTo } });
      else if (sd !== null && sd >= 15) points.push({ tone: 'good', t: L(`المبيعات أعلى بـ${sd}% من متوسط الأسابيع الأربعة السابقة`, `Sales are ${sd}% above the previous four weeks' average`), link: { kind: 'page', page: 'reports', tab: 'kpis', from: wkFrom, to: wkTo } });
      const cw = Number(w.cancellations?.total) || 0, cb = (Number(b.cancellations?.total) || 0) / 4;
      if (cw >= 3 && cw >= cb * 1.3 && cw - cb >= 3) {
        const top = (w.cancellations?.reasons || [])[0];
        points.push({ tone: cw >= cb * 1.6 ? 'bad' : 'warn', t: L(`الإلغاءات ارتفعت: ${cw} في آخر 7 أيام مقابل ${cb.toFixed(1)} أسبوعيًا`, `Cancellations rose: ${cw} in the last 7 days vs ${cb.toFixed(1)} a week`), sub: top ? L(`أكثر سبب: ${top.label}`, `Top reason: ${top.label}`) : undefined, link: { kind: 'page', page: 'reports', tab: 'cancellations', from: wkFrom, to: wkTo } });
      }
      const rw = Number(w.returnCount) || 0, rb = (Number(b.returnCount) || 0) / 4;
      if (rw >= 2 && rw >= rb * 1.5 && rw - rb >= 2) points.push({ tone: 'warn', t: L(`المرتجعات زادت: ${rw} في آخر 7 أيام مقابل ${rb.toFixed(1)} أسبوعيًا`, `Returns rose: ${rw} in the last 7 days vs ${rb.toFixed(1)} a week`), sub: L(`بقيمة ${Math.round(Number(w.totalReturns) || 0).toLocaleString('en-US')} جنيه`, `Worth EGP ${Math.round(Number(w.totalReturns) || 0).toLocaleString('en-US')}`), link: { kind: 'page', page: 'reports', tab: 'kpis', from: wkFrom, to: wkTo } });
    }
    if (this.can(user, ['shopify-orders'])) {
      checked++;
      const col = this.connection.db!.collection('shopifyorders');
      const cutoff = Date.now() - 48 * 3600_000;
      const waiting: any[] = await col.find({ status: 'pending', cancelled: { $ne: true }, createdAt: { $lte: new Date(cutoff + 864e5) } }, { projection: { ref: 1, shopifyCreatedAt: 1, createdAt: 1 } }).toArray();
      const old = waiting.filter((o) => new Date(o.shopifyCreatedAt || o.createdAt || 0).getTime() <= cutoff);
      if (old.length) points.push({ tone: old.length >= 10 ? 'bad' : 'warn', t: L(`${old.length} أوردر في شوبيفاي ينتظر التأكيد أكثر من يومين`, `${old.length} Shopify orders have waited over two days for confirmation`), link: { kind: 'page', page: 'shopify-orders' } });
    }
    if (this.canStock(user)) {
      checked += 3;
      const rows = await this.velocityRows(today);
      sources.push({ n: sources.length + 1, title: L('المخزن والمبيعات آخر 30 يومًا', 'Inventory and sales, last 30 days'), detail: L('الآن', 'Now'), link: { kind: 'page', page: 'inventory', filter: 'reorder' } });
      const soon = rows.filter((r) => r.rate > 0 && r.ready > 0 && r.days !== null && r.days <= 7 && r.incoming < r.rate * 7).sort((a, b) => (a.days || 0) - (b.days || 0));
      if (soon.length) points.push({ tone: 'bad', t: L(`${soon.length} منتج ينفد خلال 7 أيام بسرعة بيعه الحالية`, `${soon.length} products run out within 7 days at their current pace`), sub: soon.slice(0, 3).map((r) => `${r.name} (${Math.floor(r.days || 0)} ${L('يوم', 'd')})`).join(L('، ', ', ')), link: { kind: 'page', page: 'inventory', filter: 'reorder' } });
      const outSelling = rows.filter((r) => r.ready <= 0 && r.sold30 > 0).sort((a, b) => b.sold30 - a.sold30);
      if (outSelling.length) points.push({ tone: 'bad', t: L(`${outSelling.length} منتج نفد وكان يُباع في آخر 30 يومًا`, `${outSelling.length} products are out of stock but were selling in the last 30 days`), sub: outSelling.slice(0, 3).map((r) => `${r.name} (${r.sold30})`).join(L('، ', ', ')), link: { kind: 'page', page: 'inventory', filter: 'reorder' } });
      const negative = rows.filter((r) => r.balance < 0);
      if (negative.length) points.push({ tone: 'warn', t: L(`${negative.length} منتج رصيده سالب ويحتاج جردًا`, `${negative.length} products have a negative balance and need a stock count`), link: { kind: 'page', page: 'inventory', filter: 'negative' } });
    }
    const order = { bad: 0, warn: 1, good: 2 } as Record<string, number>;
    points.sort((a, b) => (order[a.tone || 'warn'] ?? 1) - (order[b.tone || 'warn'] ?? 1));
    return { points, sources, checked };
  }

  private async alerts(_u: Understood, user: AssistantUser, L: any, lang: Lang, today: string) {
    const topic = L('التنبيهات', 'Alerts');
    const { points, sources, checked } = await this.alertPoints(user, L, lang, today);
    if (!checked) return this.denied('alerts', L('التنبيهات', 'Alerts'), L, topic);
    const problems = points.filter((p) => p.tone === 'bad' || p.tone === 'warn').length;
    return {
      intent: 'alerts', status: 'answered' as const, understood: [topic, L('آخر 7 أيام', 'Last 7 days')],
      steps: [L('قارنت آخر 7 أيام بمتوسط الأسابيع الأربعة السابقة: المبيعات والإلغاءات والمرتجعات', 'Compared the last 7 days with the previous four weeks: sales, cancellations, returns'),
        L('فحصت أوردرات شوبيفاي المنتظرة والمخزون بسرعة البيع', 'Checked waiting Shopify orders and stock against sales speed')],
      lead: problems ? [{ v: problems, f: 'int' as Fmt, cite: 1 }, L(' أمور تحتاج انتباهك:', ' things need your attention:')]
        : [L('لا توجد مشكلة واضحة الآن. المبيعات والإلغاءات والمرتجعات والمخزون في حدودها المعتادة.', 'No clear problem right now. Sales, cancellations, returns and stock are within their usual range.')],
      points,
      sources,
    };
  }

  // ── Daily report ──────────────────────────────────────────────────────────────────────────────
  private async daily(_u: Understood, user: AssistantUser, L: any, lang: Lang, today: string) {
    const topic = L('التقرير اليومي', 'Daily report');
    const canRep = this.can(user, REPORT_PERMS), canShop = this.can(user, ['shopify-orders', ...REPORT_PERMS]), canInv = this.canStock(user);
    if (!canRep && !canShop && !canInv) return this.denied('daily', L('التقرير اليومي', 'The daily report'), L, topic);
    const y = addDays(today, -1);
    const kpis: any[] = [];
    const sources: Source[] = [];
    const lead: Seg[] = [];
    if (canRep) {
      const [ry, rb] = await Promise.all([this.report(y, y), this.report(addDays(today, -29), addDays(today, -2))]);
      const ySales = Number(ry.totalSales) || 0, avg = (Number(rb.totalSales) || 0) / 28;
      const d = avg > 0 ? ((ySales - avg) / avg) * 100 : null;
      kpis.push({ label: L('مبيعات أمس', 'Sales yesterday'), v: ySales, f: 'money', cite: 1 }, { label: L('مقارنة بمتوسط اليوم', 'vs. daily average'), v: d, f: 'pct', delta: d });
      sources.push(this.reportSource(1, L('تقرير مبيعات أمس', 'Yesterday\'s sales report'), { from: y, to: y }, lang));
      lead.push(L('أمس: صافي المبيعات ', 'Yesterday: net sales '), { v: ySales, f: 'money', cite: 1 }, L(' من ', ' from '), { v: Number(ry.orderCount) || 0, f: 'int' }, L(' أوردر', ' orders'));
      if (d !== null) lead.push(L(` (${d >= 0 ? 'أعلى' : 'أقل'} من متوسط اليوم بـ${Math.abs(d).toFixed(0)}%)`, ` (${Math.abs(d).toFixed(0)}% ${d >= 0 ? 'above' : 'below'} the daily average)`));
      lead.push('. ');
    }
    if (canShop) {
      const t = await this.intakeCounts(today);
      const n = sources.length + 1;
      sources.push({ n, title: L('شوبيفاي ← اليوم', 'Shopify → today'), detail: this.rangeLabel(today, today, lang), link: { kind: 'page', page: 'shopify-orders', period: 'today' } });
      kpis.push({ label: L('أوردرات اليوم', 'Orders today'), v: t.received, f: 'int', cite: n }, { label: L('مؤكد · معلق · ملغي', 'Confirmed · pending · cancelled'), v: null, f: 'int', text: `${t.confirmed} · ${t.pending} · ${t.c.cancelled}` });
      lead.push(L('اليوم حتى الآن: ', 'Today so far: '), { v: t.received, f: 'int', cite: n }, L(' أوردر من شوبيفاي، ', ' Shopify orders, '), { v: t.confirmed, f: 'int' }, L(' مؤكد و', ' confirmed and '), { v: t.pending, f: 'int' }, L(' معلق.', ' pending.'));
    }
    const al = await this.alertPoints(user, L, lang, today);
    for (const s of al.sources) sources.push({ ...s, n: sources.length + 1 });
    const problems = al.points.filter((p) => p.tone === 'bad' || p.tone === 'warn');
    kpis.push({ label: L('تنبيهات', 'Alerts'), v: problems.length, f: 'int' });
    let table;
    if (canInv) {
      const re = (await this.reorderRows(today)).filter((r) => r.days !== null && r.days <= AssistantService.LEAD_DAYS).slice(0, 5);
      if (re.length) table = {
        cols: [{ label: L('يحتاج شراء الآن', 'Reorder now') }, { label: L('يكفي', 'Lasts'), num: true }, { label: L('اشترِ', 'Buy'), num: true }],
        rows: re.map((r) => [{ t: r.name, sub: r.code, link: { kind: 'product' as const, id: r.id } }, { t: L(`${Math.floor(r.days || 0)} يوم`, `${Math.floor(r.days || 0)} d`), tone: (r.days || 0) <= 7 ? 'bad' : 'warn' }, { t: String(r.need), tone: 'strong' }]),
      };
    }
    return {
      intent: 'daily', status: 'answered' as const, understood: [topic, this.rangeLabel(today, today, lang)],
      steps: [L('مبيعات أمس من تقرير المبيعات، مقارنة بمتوسط آخر 28 يومًا', 'Yesterday\'s sales from the sales report, vs the last 28 days\' average'),
        L('أوردرات اليوم من شوبيفاي كما في مؤشرات الصفحة', 'Today\'s Shopify orders as on the page KPIs'),
        L('التنبيهات واقتراحات الشراء من المخزون وسرعة البيع', 'Alerts and reorder suggestions from stock and sales speed')],
      lead: lead.length ? lead : [L('ملخص اليوم:', 'Today\'s summary:')],
      kpis,
      pointsTitle: al.points.length ? (problems.length ? L('يحتاج انتباهك', 'Needs your attention') : L('ملاحظات', 'Notes')) : undefined,
      points: al.points.length ? al.points : [{ tone: 'good', t: L('لا توجد مشكلة واضحة اليوم.', 'No clear problem today.') }],
      table,
      options: [L('اقترح كميات الشراء', 'Suggest reorder quantities'), L('أسرع المنتجات بيعًا', 'Fastest-selling products'), L('مبيعات هذا الأسبوع', 'Sales this week')],
      sources,
    };
  }

  /**
   * The morning report, built once a day at 08:30 Cairo and kept (raw `assistantdailyreports`), so the
   * header can show a counter without recomputing on every page. Built on demand if the cron missed it.
   */
  @Cron('0 30 8 * * *', { name: 'assistant-daily-report', timeZone: 'Africa/Cairo' })
  async dailyCron() {
    try { await this.buildDailySnapshot(true); } catch (e: any) { this.logger.warn(`[assistant] daily report failed: ${e?.message || e}`); }
  }

  private snapshotTask: Promise<any> | null = null;
  async buildDailySnapshot(force = false) {
    const day = cairoToday();
    const col = this.connection.db!.collection('assistantdailyreports');
    if (!force) { const have = await col.findOne({ day }); if (have) return have; }
    if (this.snapshotTask) return this.snapshotTask;
    this.snapshotTask = (async () => {
      const admin: AssistantUser = { role: 'admin', name: 'system' };
      const ar = (a: string, _e: string) => a, en = (_a: string, e: string) => e;
      const [arA, enA] = [await this.daily({ text: '', intent: 'daily' }, admin, ar, 'ar', day), await this.daily({ text: '', intent: 'daily' }, admin, en, 'en', day)];
      const pts = ((arA as any).points || []) as Point[];
      const doc = { day, at: new Date(), bad: pts.filter((p) => p.tone === 'bad').length, warn: pts.filter((p) => p.tone === 'warn').length, ar: arA, en: enA };
      await col.updateOne({ day }, { $set: doc }, { upsert: true });
      return doc;
    })().finally(() => { this.snapshotTask = null; });
    return this.snapshotTask;
  }

  /** Header counter for admins: today's morning report — its alert counts and when it was built. */
  async dailyStatus() {
    const doc: any = await this.buildDailySnapshot(false);
    return { day: doc.day, at: doc.at, bad: doc.bad || 0, warn: doc.warn || 0 };
  }

  // ── Not answered ──────────────────────────────────────────────────────────────────────────────
  private help(L: any) {
    return {
      intent: 'help', status: 'answered' as const, understood: [L('مساعدة', 'Help')], steps: [],
      lead: [L('أستطيع الإجابة عن: المبيعات والأرباح لأي فترة، أفضل شهر أو يوم، أكثر المنتجات مبيعًا، النواقص ورصيد أي منتج، حالة أوردر برقمه، أرصدة الموردين، الإلغاءات والمرتجعات، الخزنة، وأوردرات شوبيفاي المعلقة.',
        'I can answer: sales and profit for any period, best month or day, best-selling products, low stock and any product\'s stock, an order by its number, supplier balances, cancellations and returns, the vault, and pending Shopify orders.')],
      options: SUGGESTIONS(L), sources: [],
    };
  }

  private clarify(u: Understood, L: any) {
    return {
      intent: 'clarify', status: 'ambiguous' as const, understood: [L('يحتاج توضيح', 'Needs clarifying')],
      steps: [L('السؤال يحتمل أكثر من معنى، فلم أختر واحدًا', 'The question has more than one meaning, so none was picked')],
      lead: [L('سؤالك يحتمل أكثر من معنى. تقصد أيّها؟', 'Your question can mean more than one thing. Which one?')],
      options: [L('أفضل شهر في المبيعات', 'Best month for sales'), L('أفضل يوم في المبيعات', 'Best day for sales'), L('أكثر المنتجات مبيعًا هذا الشهر', 'Best-selling products this month')],
      sources: [],
    };
  }

  private unknown(_u: Understood, L: any) {
    return {
      intent: 'unknown', status: 'unknown' as const, understood: [], steps: [L('لم أتعرف على موضوع السؤال', 'The topic was not recognised')],
      lead: [L('لم أفهم السؤال بعد. سجّلته لنضيف هذه الصيغة. جرّب صيغة مثل:', 'I did not understand that yet. It was logged so this wording can be added. Try:')],
      options: SUGGESTIONS(L).slice(0, 4), sources: [],
    };
  }

  // ── Question log ──────────────────────────────────────────────────────────────────────────────
  private async log(user: AssistantUser, question: string, u: Understood, status: string): Promise<string | null> {
    try {
      const r = await this.connection.db!.collection(LOG_COLLECTION).insertOne({
        question, normalized: u.text, intent: u.intent, status, wrong: false,
        topic: u.intent === 'sales' && (u.period?.key === 'today' || u.period?.key === 'yesterday') ? 'intake' : u.intent,
        userId: String(user?.userId || ''), userName: String(user?.name || user?.username || ''), createdAt: new Date(),
      });
      return String(r.insertedId);
    } catch (e: any) {
      this.logger.warn(`[assistant] log failed: ${e?.message || e}`);
      return null;
    }
  }

  /** «ليس هذا ما أقصده» — only the asker can flag their own question. */
  async markWrong(user: AssistantUser, id: string) {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('معرّف غير صالح');
    const r = await this.connection.db!.collection(LOG_COLLECTION).updateOne(
      { _id: new Types.ObjectId(id), userId: String(user?.userId || '') },
      { $set: { wrong: true, wrongAt: new Date() } },
    );
    return { ok: r.matchedCount === 1 };
  }

  /**
   * Topics people ask most (answered questions, last 60 days), most asked first. Keyed by topic, not
   * wording, so the suggestions keep their clean wording while their ORDER follows real demand.
   * «sales» asked for today/yesterday is the incoming-orders answer, so it is counted as `intake`.
   */
  async popular(): Promise<{ topics: { key: string; count: number }[] }> {
    const since = new Date(Date.now() - 60 * 864e5);
    const rows = await this.connection.db!.collection(LOG_COLLECTION).aggregate([
      { $match: { createdAt: { $gte: since }, status: { $in: ['answered', 'empty'] } } },
      { $group: { _id: '$topic', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]).toArray();
    return { topics: rows.filter((r) => r._id).map((r) => ({ key: String(r._id), count: r.count })) };
  }

  /** Admin review: questions not understood, ambiguous or flagged, grouped by wording, most asked first. */
  async review(days = 30) {
    const since = new Date(Date.now() - Math.min(Math.max(days, 1), 180) * 864e5);
    const col = this.connection.db!.collection(LOG_COLLECTION);
    const [groups, totals] = await Promise.all([
      col.aggregate([
        { $match: { createdAt: { $gte: since }, $or: [{ status: { $in: ['unknown', 'ambiguous'] } }, { wrong: true }] } },
        { $group: { _id: '$normalized', question: { $last: '$question' }, count: { $sum: 1 }, wrong: { $max: '$wrong' }, status: { $last: '$status' }, intent: { $last: '$intent' }, lastAt: { $max: '$createdAt' }, users: { $addToSet: '$userName' } } },
        { $sort: { count: -1, lastAt: -1 } },
        { $limit: 100 },
      ]).toArray(),
      col.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: null, total: { $sum: 1 }, answered: { $sum: { $cond: [{ $eq: ['$status', 'answered'] }, 1, 0] } }, wrong: { $sum: { $cond: ['$wrong', 1, 0] } } } },
      ]).toArray(),
    ]);
    return { days, totals: totals[0] || { total: 0, answered: 0, wrong: 0 }, items: groups };
  }

  onModuleInit() {
    this.connection.db?.collection(LOG_COLLECTION).createIndex({ createdAt: -1 }).catch(() => undefined);
  }
}

export function SUGGESTIONS(L: (a: string, e: string) => string): string[] {
  return [
    L('مبيعات النهارده', 'Sales today'),
    L('الربح الشهر ده', 'Profit this month'),
    L('المنتجات اللي قربت تخلص', 'Products running low'),
    L('أفضل شهر بعنا فيه', 'Best month for sales'),
    L('علينا كام للموردين', 'How much we owe suppliers'),
    L('ليه الأوردرات بتتلغي الشهر ده', 'Why orders were cancelled this month'),
    L('أوردرات شوبيفاي المعلقة', 'Pending Shopify orders'),
  ];
}
