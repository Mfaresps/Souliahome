import { Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { TransactionsService } from '../transactions/transactions.service';
import { currentUnitCost } from '../shared/avg-cost.util';
import { dateOnly } from '../shared/date-window.util';
import {
  DEFAULT_LEAD_DAYS, HOLDING_PER_MONTH, METHODS, Method, ProductHistory, ProductInput, ProductPlan, REVIEW_DAYS,
  SERVICE_LEVEL, addDays, backtest, dayRange, inStockFlags, planProduct, rankPlans, simulate, SimResult,
} from './engine.util';

/**
 * SOULIA purchasing engine — data side. Reads only; writes nothing.
 *
 * Every input comes from the same places the pages read: stock flows are classified exactly like
 * `TransactionsService.getInventory` (purchase / customer return to stock / sale or supplier return),
 * manual adjustments from `inventorymovements`, needs-attention from the inventory breakdown, cost from
 * `currentUnitCost`. The rebuilt end-of-day balance must equal today's stock — the validation counts
 * every product where it does not.
 */

const CAIRO = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
export const cairoDay = (d: Date | string | number) => CAIRO.format(new Date(d));
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const nm = (x: any) => String(x || '').trim().toLowerCase();
const ms = (v: any) => new Date(v || 0).getTime() || 0;

export interface IncomingOrder { id: string; poNumber: string; supplier: string; status: string; expected: string; state: string; lateDays: number; ordered: number; received: number; remaining: number; refs: string[]; productIds: string[] }
export interface IncomingLine { counted: number; ontime: number; overdue: number; nodate: number; arrived: number; matched: number; nextDate: string }

export interface EngineRun {
  today: string; builtAt: string; historyFrom: string; historyDays: number;
  plans: ProductPlan[];
  leadTimes: { supplier: string; days: number; samples: number; source: 'measured' | 'overall' | 'default' }[];
  validation: Validation;
  params: { serviceLevel: number; holdingPerMonth: number; reviewDays: number; defaultLeadDays: number };
}

export interface Validation {
  simDays: number; products: number;
  current: SimResult; engine: SimResult; optimal: SimResult;
  accuracy: { method: Method; wape: number; products: number }[];
  chosenWape: number | null; currentBasisWape: number | null;
  checks: { balanceProducts: number; balanceMismatches: { code: string; rebuilt: number; system: number }[]; reportUnits30: number; ledgerUnits30: number };
  notes: string[];
}

@Injectable()
export class PurchasingEngineService {
  private readonly logger = new Logger(PurchasingEngineService.name);
  private cache = new Map<string, { at: number; p: Promise<any> }>();

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly transactions: TransactionsService,
  ) {}

  private cached<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.p;
    const p = fn();
    this.cache.set(key, { at: Date.now(), p });
    p.catch(() => this.cache.delete(key));
    return p;
  }

  // ── Incoming from open purchase orders ───────────────────────────────────────────────────────
  /**
   * Rules (owner, Nov 22–23, 2026):
   *  • Only open POs. A PO converted to an invoice (`linkedTransactionId`) is received and recorded. A
   *    cancelled PO is deleted (no cancelled/rejected status exists), so it never appears.
   *  • Partial receipts: orders are often received through a SEPARATE purchase invoice. Each unlinked
   *    invoice line is deducted from the OLDEST open PO of the same supplier, created before the
   *    invoice, holding that product — once, so goods are never counted twice (stock AND incoming) nor
   *    against two orders. 30 ordered, 10 invoiced → 20 incoming.
   *  • «مستلم» but not converted and not invoiced = arrived, not recorded: neither stock nor incoming.
   *  • Overdue = expected delivery date before today. Incoming is never sellable stock.
   * Also returns lead-time samples (PO created → receiving invoice), per supplier.
   */
  async incoming(today: string): Promise<{ perProduct: Map<string, IncomingLine>; orders: IncomingOrder[]; leadSamples: { supplierId: string; supplier: string; days: number }[] }> {
    return this.cached(`incoming|${today}`, 30_000, async () => {
      const db = this.connection.db!;
      const all: any[] = await db.collection('purchaseorders').find({}, {
        projection: { poNumber: 1, supplierId: 1, supplierName: 1, status: 1, expectedDeliveryDate: 1, createdAt: 1, linkedTransactionId: 1, items: 1 },
      }).toArray();
      const open = all.filter((p) => !p.linkedTransactionId);
      const linkedIds = all.filter((p) => p.linkedTransactionId).map((p) => String(p.linkedTransactionId));
      const linked = new Set(linkedIds);
      const prods: any[] = await db.collection('products').find({}, { projection: { code: 1 } }).toArray();
      const byCode = new Map(prods.map((p) => [String(p.code || '').trim(), String(p._id)]));
      const leadSamples: { supplierId: string; supplier: string; days: number }[] = [];

      // Lead time from converted orders: PO created → its invoice.
      const { Types } = require('mongoose');
      const linkedTx: any[] = linkedIds.length ? await db.collection('transactions').find(
        { _id: { $in: linkedIds.filter((x) => /^[a-f0-9]{24}$/i.test(x)).map((x) => new Types.ObjectId(x)) } }, { projection: { createdAt: 1, date: 1 } },
      ).toArray() : [];
      const txById = new Map(linkedTx.map((t) => [String(t._id), t]));
      for (const po of all.filter((p) => p.linkedTransactionId)) {
        const t = txById.get(String(po.linkedTransactionId));
        if (!t || !po.createdAt) continue;
        const days = Math.round((ms(t.createdAt) - ms(po.createdAt)) / 864e5);
        if (days >= 0 && days <= 120) leadSamples.push({ supplierId: String(po.supplierId || ''), supplier: String(po.supplierName || ''), days });
      }

      const oldest = open.reduce((m, p) => Math.min(m, ms(p.createdAt) || Date.now()), Date.now());
      const invoices: any[] = open.length ? (await db.collection('transactions').find(
        { type: 'مشتريات', cancelled: { $ne: true }, archived: { $ne: true }, createdAt: { $gte: new Date(oldest) } },
        { projection: { supplierId: 1, client: 1, supplier: 1, items: 1, createdAt: 1, ref: 1 } },
      ).toArray()).filter((t) => !linked.has(String(t._id))).sort((a, b) => ms(a.createdAt) - ms(b.createdAt)) : [];
      const sameSupplier = (t: any, p: any) => (t.supplierId && p.supplierId ? String(t.supplierId) === String(p.supplierId) : nm(t.client || t.supplier) === nm(p.supplierName));

      const lines = open.sort((a, b) => ms(a.createdAt) - ms(b.createdAt)).map((po) => {
        const q = new Map<string, number>();
        for (const it of po.items || []) {
          const code = String(it?.productCode || '').trim();
          const n = Number(it?.qty) || 0;
          if (code && n > 0 && byCode.has(code)) q.set(code, (q.get(code) || 0) + n);
        }
        return { po, ordered: new Map(q), remaining: q, received: new Map<string, number>(), refs: new Set<string>(), firstReceipt: 0 };
      });
      for (const t of invoices) {
        for (const it of t.items || []) {
          const code = String(it?.code || '').trim();
          let q = Number(it?.qty) || 0;
          for (const l of lines) {
            if (q <= 0) break;
            if (!sameSupplier(t, l.po) || ms(l.po.createdAt) > ms(t.createdAt)) continue;
            const left = l.remaining.get(code) || 0;
            if (left <= 0) continue;
            const take = Math.min(left, q);
            l.remaining.set(code, left - take);
            l.received.set(code, (l.received.get(code) || 0) + take);
            l.refs.add(String(t.ref || ''));
            if (!l.firstReceipt) l.firstReceipt = ms(t.createdAt);
            q -= take;
          }
        }
      }

      const perProduct = new Map<string, IncomingLine>();
      const line = (id: string) => perProduct.get(id) || (perProduct.set(id, { counted: 0, ontime: 0, overdue: 0, nodate: 0, arrived: 0, matched: 0, nextDate: '' }), perProduct.get(id)!);
      const orders: IncomingOrder[] = [];
      for (const l of lines) {
        const po = l.po;
        if (l.firstReceipt && po.createdAt) {
          const days = Math.round((l.firstReceipt - ms(po.createdAt)) / 864e5);
          if (days >= 0 && days <= 120) leadSamples.push({ supplierId: String(po.supplierId || ''), supplier: String(po.supplierName || ''), days });
        }
        const expected = String(po.expectedDeliveryDate || '').slice(0, 10);
        const arrived = po.status === 'مستلم';
        const state = arrived ? 'arrived' : !expected ? 'nodate' : expected < today ? 'overdue' : 'ontime';
        const lateDays = state === 'overdue' ? Math.round((Date.parse(today) - Date.parse(expected)) / 864e5) : 0;
        let ordered = 0, received = 0, remaining = 0;
        const ids: string[] = [];
        for (const [code, q] of l.ordered) {
          const id = byCode.get(code)!;
          const rem = l.remaining.get(code) || 0, got = l.received.get(code) || 0;
          ordered += q; received += got; remaining += rem;
          ids.push(id);
          const d = line(id);
          d.matched += got;
          if (rem <= 0) continue;
          if (arrived) { d.arrived += rem; continue; }
          d.counted += rem;
          (d as any)[state] += rem;
          if (expected && (!d.nextDate || expected < d.nextDate)) d.nextDate = expected;
        }
        if (!remaining && !received) continue;
        orders.push({ id: String(po._id), poNumber: String(po.poNumber || ''), supplier: String(po.supplierName || ''), status: String(po.status || ''), expected, state, lateDays, ordered, received, remaining, refs: [...l.refs].filter(Boolean), productIds: ids });
      }
      return { perProduct, orders, leadSamples };
    });
  }

  // ── The engine run ───────────────────────────────────────────────────────────────────────────
  async run(today: string): Promise<EngineRun> {
    return this.cached(`run|${today}`, 10 * 60_000, () => this.build(today));
  }

  private async build(today: string): Promise<EngineRun> {
    const t0 = Date.now();
    const db = this.connection.db!;
    const [inventory, breakdown, products, inc] = await Promise.all([
      this.transactions.getInventory(),
      this.transactions.getInventoryBreakdown(),
      db.collection('products').find({}, { projection: { code: 1, name: 1, isActive: 1, sellPrice: 1, buyPrice: 1, avgCost: 1, minStock: 1, openingBalance: 1, supplier: 1, supplierId: 1 } }).toArray(),
      this.incoming(today),
    ]);
    const prodById = new Map(products.map((p: any) => [String(p._id), p]));
    const codeToId = new Map(inventory.map((p) => [String(p.code || '').trim(), String(p._id)]));

    // ── Lead time per supplier (median of measured PO → invoice gaps) ──
    const bySupplier = new Map<string, { name: string; days: number[] }>();
    for (const s of inc.leadSamples) {
      const k = s.supplierId || nm(s.supplier);
      const e = bySupplier.get(k) || { name: s.supplier, days: [] };
      e.days.push(s.days); bySupplier.set(k, e);
    }
    const overall = median(inc.leadSamples.map((s) => s.days));
    const leadFor = (supplierId: string, supplierName: string): { days: number; source: 'measured' | 'overall' | 'default'; samples: number } => {
      const e = bySupplier.get(supplierId) || bySupplier.get(nm(supplierName));
      if (e && e.days.length) return { days: Math.max(1, Math.round(median(e.days)!)), source: 'measured', samples: e.days.length };
      if (overall !== null) return { days: Math.max(1, Math.round(overall)), source: 'overall', samples: inc.leadSamples.length };
      return { days: DEFAULT_LEAD_DAYS, source: 'default', samples: 0 };
    };

    // ── Daily flows, classified like getInventory ──
    const txs: any[] = await db.collection('transactions').find(
      { cancelled: { $ne: true }, archived: { $ne: true } },
      { projection: { type: 1, ref: 1, notes: 1, date: 1, items: 1 } },
    ).toArray();
    const isApprovedReturnNotes = (n: string) => String(n || '').includes('مرتجع معتمد (طلب كان معلقاً)') || String(n || '').startsWith('استبدال — مرتجع:');
    const firstDay = txs.reduce((m, t) => { const d = dateOnly(t.date); return d && d < m ? d : m; }, today);
    const historyFrom = firstDay < addDays(today, -400) ? addDays(today, -400) : firstDay;
    const days = dayRange(historyFrom, today);
    const idx = new Map(days.map((d, i) => [d, i]));
    const N = days.length;
    const flow = new Map<string, number[]>(), sold = new Map<string, number[]>(), lost = new Map<string, number[]>();
    const before = new Map<string, number>();
    const arr = (m: Map<string, number[]>, code: string) => m.get(code) || (m.set(code, new Array(N).fill(0)), m.get(code)!);
    for (const tx of txs) {
      const ref = String(tx.ref || '').trim();
      const purchase = tx.type === 'مشتريات' && !/-RET$/i.test(ref) && !isApprovedReturnNotes(tx.notes);
      const returned = !purchase && (tx.type === 'مرتجع مبيعات' || tx.type === 'مرتجع' || (tx.type === 'مشتريات' && (/-RET$/i.test(ref) || isApprovedReturnNotes(tx.notes))));
      const sale = !purchase && !returned && (tx.type === 'مبيعات' || tx.type === 'مرتجع مشتريات');
      if (!purchase && !returned && !sale) continue;
      const d = dateOnly(tx.date);
      const i = idx.get(d);
      for (const it of tx.items || []) {
        const code = String(it.code || '').trim();
        const q = Number(it.qty) || 0;
        const delta = purchase ? q : returned ? (String(it.condition || '').trim() === 'تالف' ? 0 : q) : -q;
        if (i === undefined) { before.set(code, (before.get(code) || 0) + (d && d < historyFrom ? delta : 0)); if (!d || d > today) arr(flow, code)[N - 1] += delta; continue; }
        arr(flow, code)[i] += delta;
        if (tx.type === 'مبيعات') arr(sold, code)[i] += q;
      }
    }
    const adj: any[] = await db.collection('inventorymovements').find({ sourceType: 'manual-adjustment' }, { projection: { productCode: 1, qtyDelta: 1, createdAt: 1 } }).toArray();
    for (const a of adj) {
      const code = String(a.productCode || '').trim();
      const d = a.createdAt ? cairoDay(a.createdAt) : today;
      const i = idx.get(d);
      if (i === undefined) { if (d < historyFrom) before.set(code, (before.get(code) || 0) + (Number(a.qtyDelta) || 0)); else arr(flow, code)[N - 1] += Number(a.qtyDelta) || 0; continue; }
      arr(flow, code)[i] += Number(a.qtyDelta) || 0;
    }

    // ── Lost demand (cancelled because out of stock), pending & cancelled units, offer share ──
    const cutoff90 = addDays(today, -89);
    const pending = new Map<string, number>(), cancelled90 = new Map<string, number>(), offer90 = new Map<string, number>(), lines90 = new Map<string, number>();
    const add = (m: Map<string, number>, k: string, q: number) => m.set(k, (m.get(k) || 0) + q);
    const cancelledTx: any[] = await db.collection('transactions').find({ type: 'مبيعات', cancelled: true }, { projection: { items: 1, cancelReasonCode: 1, cancelledAt: 1, date: 1 } }).toArray();
    const shop: any[] = await db.collection('shopifyorders').find({}, { projection: { items: 1, status: 1, cancelled: 1, cancelReasonCode: 1, cancelledAt: 1, shopifyCreatedAt: 1, createdAt: 1 } }).toArray();
    for (const t of cancelledTx) {
      const d = t.cancelledAt ? cairoDay(t.cancelledAt) : dateOnly(t.date);
      for (const it of t.items || []) {
        const code = String(it.code || '').trim(), q = Number(it.qty) || 0;
        if (d >= cutoff90) add(cancelled90, code, q);
        if (t.cancelReasonCode === 'out-of-stock' && idx.has(d)) arr(lost, code)[idx.get(d)!] += q;
      }
    }
    for (const o of shop) {
      for (const it of o.items || []) {
        const code = String(it.code || '').trim(), q = Number(it.qty) || 0;
        if (!code) continue;
        if (o.cancelled || o.status === 'rejected') {
          const d = o.cancelledAt ? cairoDay(o.cancelledAt) : cairoDay(o.shopifyCreatedAt || o.createdAt || Date.now());
          if (d >= cutoff90) add(cancelled90, code, q);
          if (o.cancelReasonCode === 'out-of-stock' && idx.has(d)) arr(lost, code)[idx.get(d)!] += q;
        } else if (o.status === 'pending') add(pending, code, q);
      }
    }
    const recentSales: any[] = await db.collection('transactions').find(
      { type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true }, date: { $gte: cutoff90 } }, { projection: { items: 1 } },
    ).toArray();
    for (const t of recentSales) for (const it of t.items || []) {
      const code = String(it.code || '').trim(), q = Number(it.qty) || 0;
      add(lines90, code, q);
      if (it.priceSource === 'offer') add(offer90, code, q);
    }

    // ── Per product ──
    const plans: ProductPlan[] = [];
    const histories = new Map<string, ProductHistory>();
    const inputs = new Map<string, ProductInput>();
    const mismatches: { code: string; rebuilt: number; system: number }[] = [];
    const bd: Record<string, any> = (breakdown as any) || {};
    for (const item of inventory) {
      const id = String(item._id), code = String(item.code || '').trim();
      const prod: any = prodById.get(id) || {};
      const f = flow.get(code) || new Array(N).fill(0);
      const balance: number[] = new Array(N);
      let b = (Number(item.openingBalance) || 0) + (before.get(code) || 0);
      for (let i = 0; i < N; i++) { b += f[i]; balance[i] = b; }
      if (Math.abs(b - item.current) > 0.001) mismatches.push({ code, rebuilt: b, system: item.current });
      const h: ProductHistory = { days, demand: sold.get(code) || new Array(N).fill(0), balance, lost: lost.get(code) || new Array(N).fill(0) };
      histories.set(id, h);
      let reserved = 0, damaged = 0, lostUnits = 0, inspection = 0;
      for (const w of Object.values<any>(bd[id]?.byWarehouse || {})) {
        reserved += Number(w.reserved) || 0; damaged += Number(w.damaged) || 0; lostUnits += Number(w.lost) || 0; inspection += Number(w.inspection) || 0;
      }
      const lead = leadFor(String(prod.supplierId || ''), String(prod.supplier || ''));
      const input: ProductInput = {
        id, code, name: item.name, active: item.isActive !== false,
        ready: Math.max(0, item.current - damaged - lostUnits - inspection), incoming: inc.perProduct.get(id)?.counted || 0,
        reserved, damaged: damaged + inspection, lost: lostUnits, minStock: Number(item.minStock) || 0,
        unitCost: Number(currentUnitCost(prod)) || 0, price: Number(item.sellPrice) || 0,
        supplier: String(prod.supplier || ''), leadDays: lead.days,
        leadSource: lead.source === 'measured' ? `measured:${lead.samples}` : lead.source,
        pendingUnits: pending.get(code) || 0, cancelledUnits90: cancelled90.get(code) || 0,
        offerShare90: (lines90.get(code) || 0) > 0 ? (offer90.get(code) || 0) / (lines90.get(code) || 1) : 0,
      };
      inputs.set(id, input);
      plans.push(planProduct(input, h, today));
    }

    // ── Validation: accuracy, simulation, report cross-check ──
    const SIM = Math.min(91, Math.max(0, N - 56));
    const sum = (a: SimResult, b: SimResult): SimResult => {
      const o: any = {};
      for (const k of Object.keys(a)) o[k] = (a as any)[k] + (b as any)[k];
      return o;
    };
    const zero: SimResult = { demand: 0, served: 0, lostUnits: 0, stockoutDays: 0, avgStockValue: 0, endExcessValue: 0, purchasedValue: 0, orders: 0, marginEarned: 0, holdingCost: 0 };
    let cur = { ...zero }, eng = { ...zero }, opt = { ...zero }, simProducts = 0;
    const acc = new Map<Method, { abs: number; act: number; n: number }>();
    let chosenAbs = 0, chosenAct = 0;
    for (const p of plans) {
      const h = histories.get(p.id)!;
      const input = inputs.get(p.id)!;
      const flags = inStockFlags(h);
      let recent = 0;
      for (let i = Math.max(0, N - SIM); i < N; i++) recent += h.demand[i];
      if (!input.active || recent === 0 || SIM < 28) continue;
      simProducts++;
      cur = sum(cur, simulate('current', input, h, SIM));
      eng = sum(eng, simulate('engine', input, h, SIM));
      opt = sum(opt, simulate('optimal', input, h, SIM));
      const H = Math.max(1, input.leadDays) + REVIEW_DAYS;
      const scores = backtest(h, flags, H);
      // WAPE over all products (weighted by each product's actual demand), not a mean of ratios.
      for (const m of METHODS) {
        const sc = scores.find((s) => s.method === m);
        if (!sc) continue;
        const e = acc.get(m) || { abs: 0, act: 0, n: 0 };
        e.abs += sc.abs; e.act += sc.act; e.n++;
        acc.set(m, e);
        if (p.method === m) { chosenAbs += sc.abs; chosenAct += sc.act; }
      }
    }
    const accuracy = [...acc.entries()].map(([method, e]) => ({ method, wape: e.act > 0 ? e.abs / e.act : 0, products: e.n })).sort((a, b) => a.wape - b.wape);

    // Report cross-check: units sold in the last 30 days, ledger vs the sales report.
    const from30 = addDays(today, -29);
    let ledger30 = 0;
    for (const h of histories.values()) for (let i = Math.max(0, N - 30); i < N; i++) ledger30 += h.demand[i];
    let report30 = 0;
    try {
      const rep: any = await this.transactions.getReports(from30, today, 0);
      report30 = (rep.productProfits || []).reduce((s: number, x: any) => s + (Number(x.qty) || 0), 0);
    } catch (e: any) { this.logger.warn(`[engine] report check failed: ${e?.message || e}`); }

    const leadTimes = [...bySupplier.values()].map((e) => ({ supplier: e.name, days: Math.max(1, Math.round(median(e.days)!)), samples: e.days.length, source: 'measured' as const }));
    if (overall !== null) leadTimes.push({ supplier: '*', days: Math.max(1, Math.round(overall)), samples: inc.leadSamples.length, source: 'overall' as any });
    else leadTimes.push({ supplier: '*', days: DEFAULT_LEAD_DAYS, samples: 0, source: 'default' as any });

    const notes: string[] = [];
    if (N < 365) notes.push(`history:${N}`);
    this.logger.log(`[engine] ${plans.length} products, ${N} days, ${simProducts} simulated in ${Date.now() - t0}ms`);
    return {
      today, builtAt: new Date().toISOString(), historyFrom, historyDays: N,
      plans: rankPlans(plans), leadTimes,
      validation: {
        simDays: SIM, products: simProducts, current: cur, engine: eng, optimal: opt, accuracy,
        chosenWape: chosenAct > 0 ? chosenAbs / chosenAct : null,
        currentBasisWape: accuracy.find((a) => a.method === 'ma30')?.wape ?? null,
        checks: { balanceProducts: inventory.length, balanceMismatches: mismatches, reportUnits30: report30, ledgerUnits30: ledger30 },
        notes,
      },
      params: { serviceLevel: SERVICE_LEVEL, holdingPerMonth: HOLDING_PER_MONTH, reviewDays: REVIEW_DAYS, defaultLeadDays: DEFAULT_LEAD_DAYS },
    };
  }
}
