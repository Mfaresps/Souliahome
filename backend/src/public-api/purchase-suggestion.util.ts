import type { ProductPlan } from '../purchasing-engine/engine.util';
import { REVIEW_DAYS, SERVICE_LEVEL } from '../purchasing-engine/engine.util';

/**
 * Suggested purchase quantity for the external API — pure, no I/O.
 *
 * Built ON the purchasing engine (`planProduct`): its forecast, backtested method, safety stock,
 * reorder level and order-up-to level are taken as they are. The one thing added here is demand
 * that already EXISTS but is not yet in the stock balance: unconfirmed (pending) Shopify orders.
 * A pending order has not deducted stock, yet the pieces are already promised to a customer, so
 * they are netted from the position before the reorder test (standard MRP "allocated" stock):
 *
 *   available        = ready to sell − units owed to pending orders
 *   position         = available + incoming (open purchase orders)
 *   reorder when     position ≤ reorder level  OR  position < minimum stock
 *   suggested qty    = ⌈ order-up-to level − position ⌉
 *
 * No double count: the forecast covers demand that has NOT arrived yet; a pending order has
 * already arrived. ⚠ The engine's own quantity (without pending orders) is returned beside it, so
 * the effect of the orders is visible. The owner's 44-day rule is untouched (purchasing engine notes).
 */
export type SuggestionPriority = 'urgent' | 'order' | 'watch' | 'ok' | 'excluded';

export interface SuggestionInput {
  pendingUnits: number; // units on pending (unconfirmed) Shopify orders
  lateUnits: number;    // of which on orders waiting longer than the late threshold
  lateOrders: number;   // number of such orders
}

export interface SuggestionLine {
  code: string;
  name: string;
  active: boolean;
  supplier: string;
  priority: SuggestionPriority;
  suggestedQty: number;
  engineQty: number;
  calculation: {
    readyToSell: number;
    reservedForConfirmedOrders: number;
    needsAttention: number;
    pendingOrderUnits: number;
    lateOrderUnits: number;
    lateOrders: number;
    available: number;
    incoming: number;
    position: number;
    dailyDemand: number;
    leadTimeDays: number;
    leadTimeSource: string;
    reviewDays: number;
    horizonDays: number;
    demandOverHorizon: number;
    safetyStock: number;
    serviceLevel: number;
    reorderLevel: number;
    orderUpTo: number;
    minStock: number;
    shortForOrders: number;
    steps: { ar: string; en: string }[];
  };
  movement: {
    dailyRate7: number | null; dailyRate30: number | null; dailyRate60: number | null; dailyRate90: number | null;
    sold90: number; trendPct: number | null; variability: number | null;
    lostDemand90: number; stockoutDays90: number; cancelledUnits90: number;
    daysOfCover: number | null; daysOfCoverWithIncoming: number | null; daysOfCoverAfterPurchase: number | null;
    runOutDate: string | null;
  };
  forecast: { method: string | null; confidence: string; errorPct: number | null; alternatives: { method: string; errorPct: number }[] };
  reasons: { ar: string; en: string }[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number | null) => (n === null || !isFinite(n) ? null : Math.round(n * 100) / 100);
const pct = (n: number | null) => (n === null || !isFinite(n) ? null : Math.round(n * 1000) / 10);

export function suggestPurchase(p: ProductPlan, x: SuggestionInput, today: string): SuggestionLine {
  const pending = Math.max(0, Math.round(x.pendingUnits || 0));
  const available = p.ready - pending;
  const position = available + p.incoming;
  const shortForOrders = Math.max(0, pending - p.ready - p.incoming);
  const L = Math.max(1, p.leadDays);
  const muL = p.rate * L;
  const steps: { ar: string; en: string }[] = [];
  const reasons: { ar: string; en: string }[] = [];
  const say = (list: typeof steps, ar: string, en: string) => list.push({ ar, en });

  say(steps, `الصالح للبيع ${r1(p.ready)} − قطع مطلوبة لأوردرات لم تُؤكد بعد ${pending} = المتاح ${r1(available)}`,
    `Ready to sell ${r1(p.ready)} − units owed to unconfirmed orders ${pending} = available ${r1(available)}`);
  say(steps, `المتاح ${r1(available)} + الوارد من أوامر شراء مفتوحة ${r1(p.incoming)} = الموقف ${r1(position)}`,
    `Available ${r1(available)} + incoming on open POs ${r1(p.incoming)} = position ${r1(position)}`);
  say(steps, `الطلب اليومي المتوقع ${r2(p.rate)} × (مدة التوريد ${L} + المراجعة ${REVIEW_DAYS}) يوم = ${r1(p.rate * p.horizon)} قطعة`,
    `Forecast daily demand ${r2(p.rate)} × (lead ${L} + review ${REVIEW_DAYS}) days = ${r1(p.rate * p.horizon)} units`);
  say(steps, `+ مخزون أمان ${r1(p.safety)} (خدمة ${SERVICE_LEVEL * 100}%) = نقطة إعادة الطلب ${r1(p.rop)}؛ والحد الأعلى ${r1(p.orderUpTo)}`,
    `+ safety stock ${r1(p.safety)} (${SERVICE_LEVEL * 100}% service) = reorder level ${r1(p.rop)}; order-up-to ${r1(p.orderUpTo)}`);

  let qty = 0;
  let priority: SuggestionPriority;
  if (!p.active) {
    priority = 'excluded';
    say(reasons, 'المنتج غير نشط — لا يُقترح شراؤه', 'The product is inactive — never suggested');
  } else if (p.priority === 'excluded') {
    // No demand history / no forecast: only orders already waiting can justify a purchase.
    if (shortForOrders > 0) {
      qty = shortForOrders;
      priority = 'urgent';
      say(reasons, `لا يوجد تاريخ بيع كافٍ للتنبؤ، لكن ${pending} قطعة مطلوبة لأوردرات قائمة ولا يغطيها المخزون والوارد`,
        `Not enough sales history to forecast, but ${pending} units are owed to waiting orders that stock and incoming cannot cover`);
    } else {
      priority = 'excluded';
      for (let i = 0; i < p.reasons.length; i++) say(reasons, p.reasons[i], p.reasonsEn[i] || p.reasons[i]);
    }
  } else if (position <= p.rop || position < p.minStock) {
    qty = Math.max(0, Math.ceil(p.orderUpTo - position));
    priority = shortForOrders > 0 || position < muL ? 'urgent' : 'order';
    if (shortForOrders > 0) say(reasons, `${shortForOrders} قطعة مطلوبة لأوردرات قائمة لا يغطيها المخزون ولا الوارد`, `${shortForOrders} units owed to waiting orders are covered by neither stock nor incoming`);
    if (position < muL) say(reasons, `الموقف (${r1(position)}) أقل من طلب مدة التوريد (${r1(muL)})، فسينفد قبل وصول طلب جديد`, `Position (${r1(position)}) is below demand during the lead time (${r1(muL)}); it runs out before a new order arrives`);
    else say(reasons, `الموقف (${r1(position)}) وصل إلى نقطة إعادة الطلب (${r1(p.rop)})`, `Position (${r1(position)}) reached the reorder level (${r1(p.rop)})`);
    if (position < p.minStock) say(reasons, `أقل من الحد الأدنى المسجّل (${p.minStock})`, `Below the recorded minimum (${p.minStock})`);
  } else if (position <= p.rop + p.rate * REVIEW_DAYS) {
    priority = 'watch';
    say(reasons, `لم يصل إلى نقطة إعادة الطلب (${r1(p.rop)}) لكنه يقترب منها خلال أسبوع`, `Not at the reorder level (${r1(p.rop)}) yet, but close within a week`);
  } else {
    priority = 'ok';
    say(reasons, `الموقف (${r1(position)}) فوق نقطة إعادة الطلب (${r1(p.rop)})`, `Position (${r1(position)}) is above the reorder level (${r1(p.rop)})`);
  }
  if (x.lateOrders > 0) say(reasons, `${x.lateOrders} أوردر متأخر بانتظار التأكيد يطلب ${x.lateUnits} قطعة`, `${x.lateOrders} late order(s) awaiting confirmation want ${x.lateUnits} units`);
  if (p.trendPct !== null && Math.abs(p.trendPct) >= 25) say(reasons, `البيع ${p.trendPct > 0 ? 'يرتفع' : 'ينخفض'} ${Math.abs(Math.round(p.trendPct))}% (آخر 30 يومًا مقابل 90)`, `Sales are ${p.trendPct > 0 ? 'up' : 'down'} ${Math.abs(Math.round(p.trendPct))}% (last 30 vs 90 days)`);
  if (p.stockoutDays90 > 0) say(reasons, `نفد ${p.stockoutDays90} يومًا في آخر 90 يومًا — أيام النفاد لا تُحسب طلبًا صفريًا`, `Out of stock ${p.stockoutDays90} of the last 90 days — those days are not counted as zero demand`);
  if (qty > 0) say(steps, `الكمية المقترحة = ⌈${r1(p.orderUpTo)} − ${r1(position)}⌉ = ${qty}`, `Suggested = ⌈${r1(p.orderUpTo)} − ${r1(position)}⌉ = ${qty}`);
  else say(steps, 'لا شراء الآن: الموقف فوق نقطة إعادة الطلب', 'No purchase now: position is above the reorder level');

  const days = (stock: number) => (p.rate > 0 ? r1(stock / p.rate) : null);
  const coverNow = days(available);
  return {
    code: p.code, name: p.name, active: p.active, supplier: p.supplier, priority,
    suggestedQty: qty, engineQty: p.qty,
    calculation: {
      readyToSell: r1(p.ready), reservedForConfirmedOrders: r1(p.reserved), needsAttention: r1(p.damaged + p.lost),
      pendingOrderUnits: pending, lateOrderUnits: x.lateUnits || 0, lateOrders: x.lateOrders || 0,
      available: r1(available), incoming: r1(p.incoming), position: r1(position),
      dailyDemand: r2(p.rate) ?? 0, leadTimeDays: L, leadTimeSource: p.leadSource, reviewDays: REVIEW_DAYS,
      horizonDays: p.horizon, demandOverHorizon: r1(p.rate * p.horizon), safetyStock: r1(p.safety), serviceLevel: SERVICE_LEVEL,
      reorderLevel: r1(p.rop), orderUpTo: r1(p.orderUpTo), minStock: p.minStock, shortForOrders, steps,
    },
    movement: {
      dailyRate7: r2(p.rate7), dailyRate30: r2(p.rate30), dailyRate60: r2(p.rate60), dailyRate90: r2(p.rate90),
      sold90: p.sold90, trendPct: p.trendPct === null ? null : Math.round(p.trendPct), variability: r2(p.cv),
      lostDemand90: p.lostDemand90, stockoutDays90: p.stockoutDays90, cancelledUnits90: p.cancelledUnits90,
      daysOfCover: coverNow, daysOfCoverWithIncoming: days(position), daysOfCoverAfterPurchase: qty > 0 ? days(position + qty) : null,
      runOutDate: coverNow !== null && coverNow < 3650 ? addDays(today, Math.max(0, Math.floor(coverNow))) : null,
    },
    forecast: {
      method: p.method, confidence: p.confidence, errorPct: pct(p.methodWape),
      alternatives: (p.alt || []).map((a) => ({ method: a.method, errorPct: pct(a.wape) ?? 0 })),
    },
    reasons,
  };
}

export const PRIORITY_RANK: Record<SuggestionPriority, number> = { urgent: 0, order: 1, watch: 2, ok: 3, excluded: 4 };

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d));
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/**
 * ABC by units sold in the period: A = the products that make the first 80% of units, B = the next
 * 15%, C = the rest that sold, D = sold nothing. Ranks are by units, ties by sales value.
 */
export function abcClass<T extends { units: number; netSales: number }>(rows: T[]): (T & { rank: number | null; sharePct: number; cumulativePct: number; class: 'A' | 'B' | 'C' | 'D' })[] {
  const total = rows.reduce((s, r) => s + Math.max(0, r.units), 0);
  const sold = rows.filter((r) => r.units > 0).sort((a, b) => b.units - a.units || b.netSales - a.netSales);
  const none = rows.filter((r) => !(r.units > 0));
  let cum = 0;
  const out = sold.map((r, i) => {
    const before = total ? (cum / total) * 100 : 0;
    cum += r.units;
    const share = total ? (r.units / total) * 100 : 0;
    const cls: 'A' | 'B' | 'C' = before < 80 ? 'A' : before < 95 ? 'B' : 'C';
    return { ...r, rank: i + 1, sharePct: Math.round(share * 10) / 10, cumulativePct: Math.round((total ? (cum / total) * 100 : 0) * 10) / 10, class: cls };
  });
  return [...out, ...none.map((r) => ({ ...r, rank: null, sharePct: 0, cumulativePct: 100, class: 'D' as const }))];
}
