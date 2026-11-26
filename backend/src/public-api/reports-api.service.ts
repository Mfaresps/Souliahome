import { BadRequestException, Inject, Injectable, forwardRef } from '@nestjs/common';
import { TransactionsService } from '../transactions/transactions.service';
import { ExpensesService } from '../expenses/expenses.service';
import { inDateWindow } from '../shared/date-window.util';
import { ApiKeyDoc } from './api-keys.service';
import { addDays, cairoDayStart, cairoToday } from './public-api.service';

/**
 * The reports page (التقارير) for the external API — figures come from `getReports`, the same function
 * the page and its export call, with the expense total computed exactly as `TransactionsController.getReports`.
 *
 * Two sections (owner's decision, Nov 26):
 *   `reports`            sales, orders, average order, discounts, returns, cancellations, shipping charged,
 *                        customers, product units/sales, daily trend.
 *   `reports-financial`  gross/net profit, margins, expenses, purchases, cost per product, carrier cost,
 *                        frozen stock value. Sent ONLY when the key holds it.
 * ⚠ Build the answer field by field — never pass the report object through (it carries cost and profit).
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
type Period = { key: string; from: string; to: string; prevFrom: string; prevTo: string };

const n2 = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const change = (cur: number, prev: number) => (prev ? Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10 : cur ? null : 0);
const kpi = (cur: unknown, prev: unknown) => { const c = n2(cur), p = n2(prev); return { value: c, previous: p, changePct: change(c, p) }; };

@Injectable()
export class ReportsApiService {
  private cache = new Map<string, { at: number; p: Promise<any> }>();

  constructor(
    @Inject(forwardRef(() => TransactionsService)) private readonly transactions: TransactionsService,
    private readonly expenses: ExpensesService,
  ) {}

  /** today · yesterday · last-7 · last-30 · this-month (default) · last-month · this-year · or from/to (≤ 366 days). */
  period(q: any): Period {
    const today = cairoToday();
    const len = (a: string, b: string) => Math.round((cairoDayStart(b) - cairoDayStart(a)) / 864e5) + 1;
    const span = (key: string, from: string, to: string): Period => {
      const l = len(from, to);
      return { key, from, to, prevFrom: addDays(from, -l), prevTo: addDays(from, -1) };
    };
    if (q?.from || q?.to) {
      const from = String(q.from || ''), to = String(q.to || today);
      if (!DAY.test(from) || !DAY.test(to) || from > to) throw new BadRequestException({ code: 'BAD_DATE', message: 'from/to بصيغة YYYY-MM-DD و from قبل to' });
      if (len(from, to) > 366) throw new BadRequestException({ code: 'RANGE_TOO_LONG', message: 'أقصى مدة 366 يومًا' });
      return span('custom', from, to);
    }
    const key = String(q?.period || 'this-month');
    const [y, m] = today.split('-').map(Number);
    const monthStart = (yy: number, mm: number) => new Date(Date.UTC(yy, mm - 1, 1)).toISOString().slice(0, 10);
    const monthEnd = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
    switch (key) {
      case 'today': return span(key, today, today);
      case 'yesterday': { const d = addDays(today, -1); return span(key, d, d); }
      case 'last-7': return span(key, addDays(today, -6), today);
      case 'last-30': return span(key, addDays(today, -29), today);
      case 'this-month': {
        // A running month is compared with the same days of the previous month.
        const from = monthStart(y, m), pf = monthStart(y, m - 1), pl = monthEnd(y, m - 1);
        const pt = addDays(pf, Number(today.slice(8)) - 1);
        return { key, from, to: today, prevFrom: pf, prevTo: pt < pl ? pt : pl };
      }
      case 'last-month': return { key, from: monthStart(y, m - 1), to: monthEnd(y, m - 1), prevFrom: monthStart(y, m - 2), prevTo: monthEnd(y, m - 2) };
      case 'this-year': return { key, from: `${y}-01-01`, to: today, prevFrom: `${y - 1}-01-01`, prevTo: addDays(today.replace(/^\d{4}/, String(y - 1)), 0) };
      default: throw new BadRequestException({ code: 'BAD_FILTER', message: 'period: today | yesterday | last-7 | last-30 | this-month | last-month | this-year, or from/to' });
    }
  }

  /** Same expense rule as the reports controller: approved expenses dated in the window. */
  private async report(from: string, to: string): Promise<any> {
    const k = `${from}|${to}`;
    const hit = this.cache.get(k);
    const ttl = to < cairoToday() ? 10 * 60_000 : 30_000;
    if (hit && Date.now() - hit.at < ttl) return hit.p;
    const p = (async () => {
      const list: any[] = await this.expenses.findAll();
      const expenseTotal = list.filter((e) => inDateWindow(e.date, from, to) && e.status === 'معتمد').reduce((s, e) => s + (Number(e.amount) || 0), 0);
      return this.transactions.getReports(from, to, expenseTotal);
    })();
    this.cache.set(k, { at: Date.now(), p });
    p.catch(() => this.cache.delete(k));
    if (this.cache.size > 40) for (const [key, v] of this.cache) if (Date.now() - v.at > 10 * 60_000) this.cache.delete(key);
    return p;
  }

  async reports(q: any, key: ApiKeyDoc) {
    const fin = (key.scopes || []).includes('reports-financial');
    const p = this.period(q);
    const [r, prev] = await Promise.all([this.report(p.from, p.to), this.report(p.prevFrom, p.prevTo)]);
    const cx = r.cancellations || {}, cxp = prev.cancellations || {};
    const out: Record<string, unknown> = {
      period: { key: p.key, from: p.from, to: p.to },
      previousPeriod: { from: p.prevFrom, to: p.prevTo },
      currency: 'EGP',
      financialIncluded: fin,
      kpis: {
        netSales: kpi(r.totalSales, prev.totalSales),
        grossSales: kpi(r.grossSales, prev.grossSales),
        invoiceDiscounts: kpi(r.totalDiscounts, prev.totalDiscounts),
        orders: kpi(r.orderCount, prev.orderCount),
        averageOrder: kpi(r.avgOrderValue, prev.avgOrderValue),
        returns: kpi(r.totalReturns, prev.totalReturns),
        returnCount: kpi(r.returnCount, prev.returnCount),
        cancellations: kpi(cx.total, cxp.total),
        cancelledValue: kpi(cx.lostValue, cxp.lostValue),
        shippingCollected: kpi(r.shippingCollected, prev.shippingCollected),
        shippingDiscounts: kpi(r.shippingSubsidy, prev.shippingSubsidy),
        depositsCollected: kpi(r.totalDeposit, prev.totalDeposit),
        stillToCollect: kpi(r.totalRemaining, prev.totalRemaining),
      },
      definitions: {
        netSales: 'Products sold − invoice discounts − approved returns; cancelled orders excluded (the reports page figure).',
        averageOrder: '(products sold − invoice discounts) ÷ orders.',
        shippingDiscounts: 'Free/discounted shipping given to customers.',
        stillToCollect: 'Remaining amounts on the period\'s sales invoices.',
      },
      bestSellingProduct: r.bestSellingProduct ? { name: r.bestSellingProduct.name, units: r.bestSellingProduct.qty, sales: n2(r.bestSellingProduct.revenue) } : null,
      products: (r.productProfits || [])
        .map((x: any) => ({ name: x.name, units: Number(x.qty) || 0, sales: n2(x.rev), ...(fin ? { cost: n2(x.cost), profit: n2(x.profit), marginPct: x.rev ? Math.round((x.profit / x.rev) * 1000) / 10 : null } : {}) }))
        .sort((a: any, b: any) => b.sales - a.sales),
      topCustomers: (r.topCustomers || []).map((c: any) => ({ name: c.name, orders: c.orders, sales: n2(c.revenue) })),
      daily: (r.series || []).map((d: any) => ({ date: d.date, sales: n2(d.sales), orders: d.orders, ...(fin ? { purchases: n2(d.purchases) } : {}) })),
      orderArrivals: r.orderActivity || null,
      cancellations: {
        total: cx.total || 0, beforeEntry: cx.shopifyCount || 0, afterEntry: cx.transactionCount || 0,
        lostValue: n2(cx.lostValue), refunded: n2(cx.refunded), averageHoursToCancel: cx.avgHoursToCancel ?? null,
        reasons: cx.reasons || [], groups: cx.groups || [], products: cx.products || [],
      },
      // `stagnantStock` = { items (top 12 by frozen value), count, totalValue, neverSold } — value only with the financial section.
      stagnantStock: {
        count: r.stagnantStock?.count || 0,
        neverSold: r.stagnantStock?.neverSold || 0,
        ...(fin ? { totalValue: n2(r.stagnantStock?.totalValue) } : {}),
        items: (r.stagnantStock?.items || []).map((s: any) => ({ code: s.code, name: s.name, stock: s.stock, lastSale: s.lastSale || null, daysSinceSale: s.daysSinceSale ?? null, ...(fin ? { frozenValue: n2(s.frozenValue) } : {}) })),
      },
    };
    if (fin) {
      const sales = Number(r.totalSales) || 0;
      out.financial = {
        grossProfit: kpi(r.grossProfit, prev.grossProfit),
        netProfit: kpi(r.netProfit, prev.netProfit),
        grossMarginPct: sales ? Math.round(((Number(r.grossProfit) || 0) / sales) * 1000) / 10 : null,
        netMarginPct: sales ? Math.round(((Number(r.netProfit) || 0) / sales) * 1000) / 10 : null,
        expenses: kpi(r.expenseTotal, prev.expenseTotal),
        purchases: kpi(r.totalPurchases, prev.totalPurchases),
        grossPurchases: n2(r.grossPurchases),
        supplierReturns: n2(r.supplierReturnsTotal),
        carrierCost: n2(r.actualCarrierCost),
        shippingLoss: n2(r.totalShipLoss),
        shippingSaving: n2(r.totalShipSaving),
        shipping: r.shipping || null,
        definitions: {
          grossProfit: 'Sales after discounts and returns − cost of goods sold (frozen cost on each sale line) ± shipping differences.',
          netProfit: 'Gross profit − approved expenses of the period.',
          purchases: 'Purchase invoices − completed supplier returns.',
        },
      };
    }
    return out;
  }
}
