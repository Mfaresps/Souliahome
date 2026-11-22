/**
 * SOULIA purchasing engine — the maths. Pure: no database, no clock (every function takes `today`).
 *
 * Pipeline per product: daily demand ledger → stock balance rebuilt day by day (to know the days the
 * product could NOT sell) → candidate forecasts → rolling-origin backtest picks the method with the
 * lowest error → safety stock from that method's own forecast errors → (s, S) periodic-review policy
 * → priority from protected contribution margin net of holding cost.
 *
 * Owner's parameters (Nov 23, 2026): 95% service level, no budget cap (rank by priority), holding
 * cost 2% of unit cost per month, lead time per supplier measured from PO date → receiving invoice.
 * Recommendations only: nothing here creates a purchase order.
 */

export const SERVICE_LEVEL = 0.95;
export const Z = 1.6449;                 // standard normal quantile for 95%
export const HOLDING_PER_MONTH = 0.02;   // of unit cost
export const REVIEW_DAYS = 7;            // a purchasing decision is reviewed weekly
export const DEFAULT_LEAD_DAYS = 14;

// ── Calendar ────────────────────────────────────────────────────────────────────────────────────
const parse = (d: string) => { const [y, m, x] = d.split('-').map(Number); return Date.UTC(y, m - 1, x); };
export const addDays = (d: string, n: number) => new Date(parse(d) + n * 864e5).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((parse(b) - parse(a)) / 864e5);
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ── Normal distribution helpers ─────────────────────────────────────────────────────────────────
export function phi(z: number) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }
export function Phi(z: number) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
/** Expected shortage per cycle, in units of σ: E[(Z − z)+]. */
export function lossFn(z: number) { return phi(z) - z * (1 - Phi(z)); }

// ── Per-product history ─────────────────────────────────────────────────────────────────────────
export interface ProductHistory {
  days: string[];
  /** Units sold that day (confirmed sales, by business date). */
  demand: number[];
  /** Sellable balance at the END of the day, rebuilt from the same flows as the inventory page. */
  balance: number[];
  /** Units lost to «الصنف غير متوفر» cancellations that day (lost demand). */
  lost: number[];
}

/**
 * A day counts as «in stock» when the product could be sold: it started the day with stock, or it
 * sold that day anyway. Out-of-stock days are censored — their zero sales say nothing about demand.
 */
export function inStockFlags(h: ProductHistory): boolean[] {
  return h.days.map((_, i) => (i === 0 ? h.balance[0] + h.demand[0] > 0 : h.balance[i - 1] > 0) || h.demand[i] > 0);
}

/** Mean daily demand over the last `n` in-stock days up to index `end` (inclusive). Lost demand counts. */
export function inStockRate(h: ProductHistory, flags: boolean[], end: number, n: number): number | null {
  let sum = 0, cnt = 0;
  for (let i = end; i >= 0 && i > end - n; i--) {
    if (!flags[i]) { sum += h.lost[i]; continue; }
    sum += h.demand[i] + h.lost[i]; cnt++;
  }
  if (cnt < Math.min(5, n)) return null;
  return sum / cnt;
}

/** Weekly demand ending at `end`, scaled for out-of-stock days; null when fewer than 4 in-stock days. */
export function weeklySeries(h: ProductHistory, flags: boolean[], end: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let e = end; e - 6 >= 0; e -= 7) {
    let sum = 0, cnt = 0;
    for (let i = e - 6; i <= e; i++) { sum += h.demand[i] + h.lost[i]; if (flags[i]) cnt++; }
    out.unshift(cnt >= 4 ? (sum * 7) / cnt : null);
  }
  return out;
}

// ── Forecast methods (each returns a DAILY rate at index `end`) ─────────────────────────────────
export type Method = 'ma7' | 'ma30' | 'ma60' | 'ma90' | 'wma30' | 'ses' | 'holt' | 'croston';
export const METHODS: Method[] = ['ma7', 'ma30', 'ma60', 'ma90', 'wma30', 'ses', 'holt', 'croston'];
export const METHOD_LABEL: Record<Method, [string, string]> = {
  ma7: ['متوسط آخر 7 أيام', '7-day average'],
  ma30: ['متوسط آخر 30 يومًا', '30-day average'],
  ma60: ['متوسط آخر 60 يومًا', '60-day average'],
  ma90: ['متوسط آخر 90 يومًا', '90-day average'],
  wma30: ['متوسط مرجّح لآخر 30 يومًا', 'Weighted 30-day average'],
  ses: ['تسوية أُسّية', 'Exponential smoothing'],
  holt: ['تسوية أُسّية مع الاتجاه', 'Exponential smoothing with trend'],
  croston: ['طريقة الطلب المتقطع (Croston)', 'Intermittent demand (Croston/SBA)'],
};

export function forecast(method: Method, h: ProductHistory, flags: boolean[], end: number): number | null {
  switch (method) {
    case 'ma7': return inStockRate(h, flags, end, 7);
    case 'ma30': return inStockRate(h, flags, end, 30);
    case 'ma60': return inStockRate(h, flags, end, 60);
    case 'ma90': return inStockRate(h, flags, end, 90);
    case 'wma30': {
      let sum = 0, w = 0;
      for (let k = 0; k < 30 && end - k >= 0; k++) {
        const i = end - k;
        if (!flags[i]) continue;
        const wt = 30 - k;
        sum += (h.demand[i] + h.lost[i]) * wt; w += wt;
      }
      return w > 0 ? sum / w : null;
    }
    case 'ses': {
      const ws = weeklySeries(h, flags, end).filter((x): x is number => x !== null);
      if (ws.length < 4) return null;
      let level = ws[0];
      for (const x of ws.slice(1)) level = 0.3 * x + 0.7 * level;
      return Math.max(0, level) / 7;
    }
    case 'holt': {
      const ws = weeklySeries(h, flags, end).filter((x): x is number => x !== null);
      if (ws.length < 6) return null;
      let level = ws[0], trend = ws[1] - ws[0];
      for (const x of ws.slice(1)) {
        const prev = level;
        level = 0.3 * x + 0.7 * (level + trend);
        trend = 0.1 * (level - prev) + 0.9 * trend;
      }
      // Rate over the next ~2 weeks, never negative; a damped trend avoids running away on short history.
      return Math.max(0, level + trend * 0.8) / 7;
    }
    case 'croston': {
      const ws = weeklySeries(h, flags, end).filter((x): x is number => x !== null);
      if (ws.length < 4) return null;
      const a = 0.15;
      let z: number | null = null, p: number | null = null, gap = 1;
      for (const x of ws) {
        if (x > 0) {
          z = z === null ? x : a * x + (1 - a) * z;
          p = p === null ? gap : a * gap + (1 - a) * p;
          gap = 1;
        } else gap++;
      }
      if (z === null || p === null) return 0;
      return ((1 - a / 2) * z) / p / 7;     // SBA bias correction
    }
  }
}

// ── Backtest: rolling origin, horizon = lead time + review period ──────────────────────────────
export interface MethodScore { method: Method; wape: number; bias: number; n: number; errors: number[]; abs: number; act: number }

export function backtest(h: ProductHistory, flags: boolean[], horizon: number, end = h.days.length - 1): MethodScore[] {
  const scores: MethodScore[] = [];
  const first = 56; // eight weeks of history before the first origin
  for (const method of METHODS) {
    let absErr = 0, sumAct = 0, sumErr = 0, n = 0;
    const errors: number[] = [];
    for (let o = first; o + horizon <= end; o += 7) {
      let act = 0, inDays = 0;
      for (let i = o + 1; i <= o + horizon; i++) { act += h.demand[i] + h.lost[i]; if (flags[i]) inDays++; }
      if (inDays < horizon / 2) continue;                     // mostly out of stock: the actual is unknown
      act = (act * horizon) / inDays;
      const f = forecast(method, h, flags, o);
      if (f === null) continue;
      const fc = f * horizon;
      absErr += Math.abs(fc - act); sumErr += fc - act; sumAct += act; n++;
      errors.push(act - fc);
    }
    if (n) scores.push({ method, wape: sumAct > 0 ? absErr / sumAct : (absErr > 0 ? Infinity : 0), bias: sumAct > 0 ? sumErr / sumAct : 0, n, errors, abs: absErr, act: sumAct });
  }
  return scores.sort((a, b) => a.wape - b.wape || METHODS.indexOf(a.method) - METHODS.indexOf(b.method));
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

// ── Safety stock and the (R, s, S) policy ───────────────────────────────────────────────────────
/** Smallest k with P(Poisson(mu) ≤ k) ≥ p — slow sellers move in whole pieces, not a bell curve. */
/** Inverse standard normal (Acklam). */
export function invNorm(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const lo = 0.02425, hi = 1 - lo;
  if (p < lo) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > hi) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * Margin-optimal service level (newsvendor critical ratio): a missed sale costs the unit margin; an extra
 * unit costs holding (2%/month of cost) for as long as it takes to sell — at least one cycle, at most
 * 180 days. Kept between 80% and 99.5%.
 */
export function optimalService(unitMargin: number, unitCost: number, rate: number, horizon: number): number {
  if (unitMargin <= 0) return 0.8;
  const daysToSell = Math.min(180, Math.max(horizon, rate > 0 ? 1 / rate : 180));
  const over = unitCost * HOLDING_PER_MONTH * (daysToSell / 30);
  const cr = unitMargin / (unitMargin + over);
  return Math.min(0.995, Math.max(0.8, cr));
}

export function poissonQuantile(mu: number, p = SERVICE_LEVEL): number {
  if (mu <= 0) return 0;
  let k = 0, term = Math.exp(-mu), cdf = term;
  while (cdf < p && k < 10000) { k++; term *= mu / k; cdf += term; }
  return k;
}
export function quantile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/**
 * Periodic review: the order placed at a review must last until the NEXT order arrives, i.e. lead time +
 * review period (H). Safety stock covers the 95th percentile of demand over H, taking the largest of:
 * the normal approximation (z·σ of the backtest errors), the empirical 95th percentile of those errors
 * (forecasts that ran short in the past), and the Poisson 95th percentile (whole-piece slow sellers).
 *   s (reorder level) = expected demand over H + safety
 *   S (order up to)   = s + one review period of demand (cycle stock), never below the minimum stock
 */
export function policyLevels(rate: number, sigmaH: number, errors: number[], L: number, minStock: number, service = SERVICE_LEVEL) {
  const H = L + REVIEW_DAYS;
  const mu = rate * H;
  const z = invNorm(service);
  const safety = Math.max(z * sigmaH, errors.length >= 8 ? quantile(errors, service) : 0, poissonQuantile(mu, service) - mu, 0);
  const reorder = mu + safety;
  const orderUpTo = Math.max(reorder + rate * REVIEW_DAYS, minStock);
  return { H, mu, safety, reorder, orderUpTo };
}

// ── Forecast + policy for one product ───────────────────────────────────────────────────────────
export interface ProductInput {
  id: string; code: string; name: string; active: boolean;
  ready: number; incoming: number; reserved: number; damaged: number; lost: number; minStock: number;
  unitCost: number; price: number; supplier: string; leadDays: number; leadSource: string;
  pendingUnits: number; cancelledUnits90: number; offerShare90: number;
}

export type Priority = 'urgent' | 'order' | 'watch' | 'ok' | 'excluded';

export interface ProductPlan extends ProductInput {
  method: Method | null; methodWape: number | null; confidence: 'high' | 'medium' | 'low' | 'none';
  rate: number; rate7: number | null; rate30: number | null; rate60: number | null; rate90: number | null;
  trendPct: number | null; cv: number | null; sold90: number; lostDemand90: number; stockoutDays90: number;
  horizon: number; sigmaH: number; safety: number; rop: number; orderUpTo: number; position: number;
  qty: number; cost: number; margin: number;
  daysNow: number | null; daysAfterIncoming: number | null; daysAfterPurchase: number | null;
  stockoutDate: string | null; pStockout: number; expectedLostIfWait: number; marginAtRisk: number;
  holdingCost: number; score: number; priority: Priority; reasons: string[]; reasonsEn: string[];
  alt: { method: Method; wape: number }[];
}

export function planProduct(p: ProductInput, h: ProductHistory, today: string): ProductPlan {
  const flags = inStockFlags(h);
  const end = h.days.length - 1;
  const L = Math.max(1, p.leadDays);
  const H = L + REVIEW_DAYS;
  const scores = backtest(h, flags, H);
  const best = scores[0];
  const r = (m: Method) => forecast(m, h, flags, end);
  const rate7 = r('ma7'), rate30 = r('ma30'), rate60 = r('ma60'), rate90 = r('ma90');

  let sold90 = 0, lost90 = 0, out90 = 0;
  for (let i = Math.max(0, end - 89); i <= end; i++) { sold90 += h.demand[i]; lost90 += h.lost[i]; if (!flags[i]) out90++; }

  let method: Method | null = null, rate = 0, confidence: ProductPlan['confidence'] = 'none', sigmaH = 0;
  if (best && best.n >= 4 && isFinite(best.wape)) {
    method = best.method;
    rate = Math.max(0, r(best.method) ?? 0);
    confidence = best.wape <= 0.35 && best.n >= 10 ? 'high' : best.wape <= 0.6 ? 'medium' : 'low';
    sigmaH = stdev(best.errors);
  } else {
    // Too little history for a backtest: fall back to the longest in-stock average, clearly marked.
    rate = Math.max(0, rate90 ?? rate60 ?? rate30 ?? 0);
    method = rate90 !== null ? 'ma90' : rate60 !== null ? 'ma60' : rate30 !== null ? 'ma30' : null;
    confidence = method ? 'low' : 'none';
  }
  // Never below Poisson noise: a product that sells a few pieces still needs a buffer.
  sigmaH = Math.max(sigmaH, Math.sqrt(rate * H));

  const ws = weeklySeries(h, flags, end).filter((x): x is number => x !== null).slice(-13);
  const meanW = ws.length ? ws.reduce((s, x) => s + x, 0) / ws.length : 0;
  const cv = ws.length >= 4 && meanW > 0 ? stdev(ws) / meanW : null;
  const trendPct = rate30 !== null && rate90 !== null && rate90 > 0 ? ((rate30 - rate90) / rate90) * 100 : null;

  const lv = policyLevels(rate, sigmaH, best && method === best.method ? best.errors : [], L, p.minStock);
  const safety = lv.safety;
  const position = p.ready + p.incoming;                 // incoming is ordered stock, never sellable stock
  const sigmaL = sigmaH * Math.sqrt(L / H);
  const rop = lv.reorder;
  const orderUpTo = lv.orderUpTo;
  const margin = p.price - p.unitCost;

  // Risk if nothing is ordered now.
  const muL = rate * L;
  const pStockout = rate > 0 ? 1 - Phi((position - muL) / Math.max(sigmaL, 1e-9)) : 0;
  const expectedLostIfWait = rate > 0 ? sigmaH * lossFn((position - rate * H) / Math.max(sigmaH, 1e-9)) : 0;

  let qty = 0;
  const reasons: string[] = [], reasonsEn: string[] = [];
  let priority: Priority = 'ok';
  const excluded = (ar: string, en: string) => { priority = 'excluded'; reasons.push(ar); reasonsEn.push(en); };
  if (!p.active) excluded('المنتج غير نشط', 'The product is inactive');
  else if (sold90 + lost90 === 0 && p.ready >= p.minStock) excluded('لا طلب عليه في آخر 90 يومًا', 'No demand in the last 90 days');
  else if (method === null && p.ready >= p.minStock) excluded('لا توجد بيانات بيع كافية للتنبؤ', 'Not enough sales history to forecast');
  else {
    if (position <= rop || position < p.minStock) qty = Math.max(0, Math.ceil(orderUpTo - position));
    if (qty > 0) {
      priority = position < muL ? 'urgent' : 'order';
      if (position < muL) { reasons.push(`المخزون والوارد (${fmt(position)}) أقل من طلب مدة التوريد (${fmt(muL)})، فسينفد قبل وصول أي طلب جديد`); reasonsEn.push(`Stock plus incoming (${fmt(position)}) is below demand during the lead time (${fmt(muL)}); it runs out before a new order can arrive`); }
      else { reasons.push(`المخزون والوارد (${fmt(position)}) وصلا إلى نقطة إعادة الطلب (${fmt(rop)})`); reasonsEn.push(`Stock plus incoming (${fmt(position)}) reached the reorder point (${fmt(rop)})`); }
      if (position < p.minStock && position > rop) { reasons.push(`أقل من الحد الأدنى المسجّل (${p.minStock})`); reasonsEn.push(`Below the recorded minimum (${p.minStock})`); }
      if (margin <= 0) { reasons.push('تنبيه: الهامش صفر أو سالب بسعر البيع الحالي'); reasonsEn.push('Warning: margin is zero or negative at the current price'); }
    } else if (position <= rop + rate * REVIEW_DAYS) {
      priority = 'watch';
      reasons.push(`لم يصل بعد إلى نقطة إعادة الطلب (${fmt(rop)})، لكنه يقترب منها خلال أسبوع`); reasonsEn.push(`Not at the reorder point (${fmt(rop)}) yet, but close within a week`);
    } else {
      reasons.push(`المخزون والوارد (${fmt(position)}) فوق نقطة إعادة الطلب (${fmt(rop)})`); reasonsEn.push(`Stock plus incoming (${fmt(position)}) is above the reorder point (${fmt(rop)})`);
    }
  }

  const cost = qty * p.unitCost;
  const marginAtRisk = Math.max(0, expectedLostIfWait) * Math.max(0, margin);
  // Holding cost of the order while it sells down (average half the order + safety stock over its cover).
  const coverDays = rate > 0 ? (qty / rate) : 0;
  const holdingCost = p.unitCost * HOLDING_PER_MONTH * ((qty / 2 + safety) * Math.min(coverDays, 180)) / 30;
  // Priority score: contribution margin protected per EGP invested, net of holding cost.
  const score = cost > 0 ? (marginAtRisk - holdingCost) / cost : 0;

  const days = (stock: number) => (rate > 0 ? stock / rate : null);
  const daysNow = days(p.ready);
  return {
    ...p, method, methodWape: best && isFinite(best.wape) ? best.wape : null, confidence,
    rate, rate7, rate30, rate60, rate90, trendPct, cv, sold90, lostDemand90: lost90, stockoutDays90: out90,
    horizon: H, sigmaH, safety, rop, orderUpTo, position, qty, cost, margin,
    daysNow, daysAfterIncoming: days(position), daysAfterPurchase: qty > 0 ? days(position + qty) : null,
    stockoutDate: daysNow !== null && daysNow < 3650 ? addDays(today, Math.floor(daysNow)) : null,
    pStockout, expectedLostIfWait, marginAtRisk, holdingCost, score, priority, reasons, reasonsEn,
    alt: scores.slice(0, 4).filter((s) => isFinite(s.wape)).map((s) => ({ method: s.method, wape: s.wape })),
  };
}

function fmt(n: number) { return (Math.round(n * 10) / 10).toString(); }

/** Order the plan: urgent first, then by margin protected per EGP; then the rest. */
export function rankPlans(plans: ProductPlan[]): ProductPlan[] {
  const rank: Record<Priority, number> = { urgent: 0, order: 1, watch: 2, ok: 3, excluded: 4 };
  return [...plans].sort((a, b) => rank[a.priority] - rank[b.priority] || b.score - a.score || (a.daysNow ?? 9e9) - (b.daysNow ?? 9e9));
}

// ── The current rule (for comparison): 44-day cover from the 30-day average ───────────────────
export function currentRuleQty(rate30: number, ready: number, incoming: number, minStock: number): number {
  const target = Math.max(rate30 * 44, minStock);
  return Math.max(0, Math.ceil(target - ready - incoming));
}

// ── Simulation over history: current rule vs engine ─────────────────────────────────────────────
export interface SimResult {
  demand: number; served: number; lostUnits: number; stockoutDays: number;
  avgStockValue: number; endExcessValue: number; purchasedValue: number; orders: number;
  marginEarned: number; holdingCost: number;
}

/**
 * Replays the last `days` days for one product. Every 7 days the policy looks ONLY at data up to that
 * day, orders, and the order arrives after the lead time. Demand = actual sales; on days the product was
 * really out of stock, demand is imputed at the 30-day in-stock rate known at that time (otherwise a
 * policy that keeps stock would be credited with sales that history could not show).
 */
export function simulate(policy: 'current' | 'engine' | 'optimal', p: ProductInput, h: ProductHistory, days: number): SimResult {
  const flags = inStockFlags(h);
  const end = h.days.length - 1;
  const start = Math.max(56, end - days + 1);
  const L = Math.max(1, p.leadDays), H = L + REVIEW_DAYS;
  let onHand = Math.max(0, h.balance[start - 1] ?? 0);
  const pipeline: { day: number; qty: number }[] = [];
  const res: SimResult = { demand: 0, served: 0, lostUnits: 0, stockoutDays: 0, avgStockValue: 0, endExcessValue: 0, purchasedValue: 0, orders: 0, marginEarned: 0, holdingCost: 0 };
  const margin = Math.max(0, p.price - p.unitCost);
  let n = 0;
  for (let i = start; i <= end; i++) {
    for (const o of pipeline.filter((x) => x.day === i)) onHand += o.qty;
    if ((i - start) % REVIEW_DAYS === 0) {
      const incoming = pipeline.filter((x) => x.day > i).reduce((s, x) => s + x.qty, 0);
      let q = 0;
      if (policy === 'current') {
        q = currentRuleQty(inStockRate(h, flags, i - 1, 30) ?? 0, onHand, incoming, p.minStock);
      } else {
        const all = backtest(h, flags, H, i - 1);
        const sc = all.find((x) => x.n >= 4 && isFinite(x.wape));
        const rate = Math.max(0, (sc ? forecast(sc.method, h, flags, i - 1) : inStockRate(h, flags, i - 1, 90)) ?? 0);
        const sigma = Math.max(sc ? stdev(sc.errors) : 0, Math.sqrt(rate * H));
        const service = policy === 'optimal' ? optimalService(p.price - p.unitCost, p.unitCost, rate, H) : SERVICE_LEVEL;
        const lv = policyLevels(rate, sigma, sc ? sc.errors : [], L, p.minStock, service);
        const pos = onHand + incoming;
        if (pos <= lv.reorder || pos < p.minStock) q = Math.max(0, Math.ceil(lv.orderUpTo - pos));
      }
      if (q > 0) { pipeline.push({ day: i + L, qty: q }); res.purchasedValue += q * p.unitCost; res.orders++; }
    }
    const d = flags[i] ? h.demand[i] + h.lost[i] : (inStockRate(h, flags, i - 1, 30) ?? 0);
    const served = Math.min(onHand, d);
    onHand -= served;
    res.demand += d; res.served += served; res.lostUnits += d - served;
    if (d - served > 1e-9) res.stockoutDays++;
    res.marginEarned += served * margin;
    res.avgStockValue += onHand * p.unitCost;
    res.holdingCost += onHand * p.unitCost * HOLDING_PER_MONTH / 30;
    n++;
  }
  res.avgStockValue = n ? res.avgStockValue / n : 0;
  const rateEnd = inStockRate(h, flags, end, 30) ?? 0;
  res.endExcessValue = Math.max(0, onHand - rateEnd * 90) * p.unitCost;
  return res;
}
