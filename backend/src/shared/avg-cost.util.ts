/**
 * متوسط التكلفة المرجّح المتحرك — خطوة 3 من خطة تصحيح الربح. دوال بحتة بدون قاعدة بيانات.
 *
 * القواعد (قرارات مكتوبة في CLAUDE.md):
 * - **فواتير الشراء بس هي اللي بتغيّر المتوسط.** المرتجع والإلغاء والتسوية ومرتجع المورد
 *   بيدخلوا أو بيطلعوا المخزن بالمتوسط الحالي ومابيغيّروهوش.
 * - المخزون السالب أو الصفر يتعامل كصفر: المتوسط يبقى سعر الشراء الجديد بالظبط.
 * - البداية: المنتج اللي ماعندوش متوسط بياخد سعر الكارت (`buyPrice`) كمتوسط حالي.
 */

const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

/** التكلفة اللي البيعة بتاخدها دلوقتي: المتوسط لو موجود، وإلا سعر الكارت. */
export function currentUnitCost(product: { avgCost?: number | null; buyPrice?: number } | null | undefined): number | null {
  if (!product) return null;
  const avg = product.avgCost;
  if (avg !== null && avg !== undefined && Number.isFinite(Number(avg)) && Number(avg) >= 0) return Number(avg);
  const buy = Number(product.buyPrice);
  return Number.isFinite(buy) && buy >= 0 ? buy : 0;
}

/**
 * التكلفة **المعروفة** للبيعة الجديدة + مصدرها، أو null لو مفيش تكلفة معروفة.
 * ⚠ منتج ماعندوش متوسط وسعر الكارت صفر = تكلفة ناقصة، مش صفر: البيعة ماتتحفظش بتكلفة صفر
 *   (ربح وهمي)، وبتظهر في تقرير مصدر التكلفة كـ«ناقصة». المتوسط صفر قيمة حقيقية وبيتحفظ.
 */
export function knownUnitCost(product: { avgCost?: number | null; buyPrice?: number } | null | undefined): { cost: number; basis: 'avg' | 'card' } | null {
  if (!product) return null;
  const avg = product.avgCost;
  if (avg !== null && avg !== undefined && Number.isFinite(Number(avg)) && Number(avg) >= 0) return { cost: Number(avg), basis: 'avg' };
  const buy = Number(product.buyPrice);
  return Number.isFinite(buy) && buy > 0 ? { cost: buy, basis: 'card' } : null;
}

/** دخول كمية بسعر: المتوسط الجديد. */
export function averageAfterPurchase(stockBefore: number, avgBefore: number, qtyIn: number, unitCostIn: number): number {
  const stock = Math.max(0, Number(stockBefore) || 0);
  const qty = Number(qtyIn) || 0;
  const cost = Number(unitCostIn) || 0;
  if (qty <= 0) return round4(Number(avgBefore) || 0);
  if (stock <= 0) return round4(cost);
  return round4((stock * (Number(avgBefore) || 0) + qty * cost) / (stock + qty));
}

/**
 * تعديل أو إلغاء فاتورة شراء دخلت في المتوسط: يشيل مساهمتها القديمة ويضيف الجديدة عند
 * المخزون الحالي. دقيق لو قطع الفاتورة ماتباعتش لسه، وتقريبي لو اتباع منها.
 * `stockNow` = المخزون الحالي **وهو شامل الكمية القديمة للفاتورة**.
 */
export function averageAfterCorrection(stockNow: number, avgNow: number, oldQty: number, oldCost: number, newQty: number, newCost: number): number {
  const stock = Math.max(0, Number(stockNow) || 0);
  const avg = Number(avgNow) || 0;
  const oQ = Math.max(0, Number(oldQty) || 0), nQ = Math.max(0, Number(newQty) || 0);
  const stockAfter = stock - oQ + nQ;
  const valueAfter = stock * avg - oQ * (Number(oldCost) || 0) + nQ * (Number(newCost) || 0);
  if (stockAfter <= 0 || valueAfter < 0) return round4(nQ > 0 ? Number(newCost) || 0 : avg);
  return round4(valueAfter / stockAfter);
}

/**
 * سطور مرتجع مورد مجمّعة لكل كود بتكلفتها الفعلية: من `allocations` (الكمية × تكلفة فاتورة الشراء
 * الأصلية) لو موجودة، وإلا سعر السطر.
 */
export function supplierReturnLots(items: Array<{ code?: string; qty?: number; price?: number; allocations?: Array<{ qty?: number; unitCost?: number }> }>): Map<string, { qty: number; unitCost: number }> {
  const acc = new Map<string, { qty: number; value: number }>();
  for (const i of items || []) {
    const code = String(i?.code || '').trim();
    const qty = Number(i?.qty) || 0;
    if (!code || qty <= 0) continue;
    const allocs = Array.isArray(i.allocations) ? i.allocations.filter((a) => Number(a?.qty) > 0) : [];
    const value = allocs.length
      ? allocs.reduce((s, a) => s + Number(a.qty) * (Number(a.unitCost) || 0), 0) * (qty / allocs.reduce((s, a) => s + Number(a.qty), 0))
      : qty * (Number(i.price) || 0);
    const cur = acc.get(code) || { qty: 0, value: 0 };
    acc.set(code, { qty: cur.qty + qty, value: cur.value + value });
  }
  const out = new Map<string, { qty: number; unitCost: number }>();
  for (const [code, v] of acc) out.set(code, { qty: v.qty, unitCost: round4(v.qty > 0 ? v.value / v.qty : 0) });
  return out;
}

/**
 * سطور فاتورة شراء مجمّعة لكل كود: الكمية والتكلفة بعد نصيبها من خصم الفاتورة
 * (الخصم يتوزع بنسبة قيمة كل سطر).
 */
export function purchaseLotsByCode(items: Array<{ code?: string; qty?: number; price?: number; total?: number }>, invoiceDiscount: number): Map<string, { qty: number; unitCost: number }> {
  const rows = (items || []).filter((i) => Number(i?.qty) > 0 && String(i?.code || '').trim());
  const gross = rows.reduce((s, i) => s + (Number(i.total) || Number(i.qty) * Number(i.price) || 0), 0);
  const discount = Math.min(Math.max(Number(invoiceDiscount) || 0, 0), gross);
  const ratio = gross > 0 ? (gross - discount) / gross : 1;
  const acc = new Map<string, { qty: number; value: number }>();
  for (const i of rows) {
    const code = String(i.code).trim();
    const lineValue = (Number(i.total) || Number(i.qty) * Number(i.price) || 0) * ratio;
    const cur = acc.get(code) || { qty: 0, value: 0 };
    acc.set(code, { qty: cur.qty + Number(i.qty), value: cur.value + lineValue });
  }
  const out = new Map<string, { qty: number; unitCost: number }>();
  for (const [code, v] of acc) out.set(code, { qty: v.qty, unitCost: round4(v.qty > 0 ? v.value / v.qty : 0) });
  return out;
}

export interface CostEventLike {
  kind: string; txId?: string; createdAt: Date | string;
  stockBefore?: number; qtyIn?: number; unitCostIn?: number; oldQty?: number; oldUnitCost?: number;
  avgBefore?: number; avgAfter?: number;
}

/**
 * إعادة حساب المتوسط **بالترتيب الزمني** بعد تعديل فاتورة شراء (التدقيق النهائي).
 *
 * كل فاتورة شراء بتتحسب في **مكانها الزمني الأصلي** بآخر كميتها وتكلفتها (الفاتورة المعدّلة
 * بالقيم الجديدة \`txId\`/\`newLot\`، والباقي بآخر تعديل اتسجل لكل واحدة). أحداث التعديل والإلغاء
 * نفسها بتتحسب "اتلغى أثرها" لأن أثرها اتنقل لمكان الفاتورة الأصلي. المخزون المسجّل وقت كل حدث
 * بيتعدّل بفرق الكميات (الكمية النهائية − الكمية اللي كانت متسجلة وقتها). مرتجعات الموردين
 * بتتعاد زي ما اتسجلت، والتصحيح اليدوي بيثبّت المتوسط على قيمته.
 *
 * المبيعات **مابتغيّرش** المتوسط في النموذج ده، فالحساب ده دقيق مهما اتباع من الفاتورة.
 * بيرجّع المتوسط النهائي + المتوسط بعد كل حدث (للفرق على البيعات اللي اتعملت في النص).
 * \`events\` = كل أحداث المنتج مترتبة زمنيًا. لو الفاتورة مالهاش حدث \`purchase\` → null.
 */
export function replayAverage(events: CostEventLike[], txId: string, newLot: { qty: number; unitCost: number }):
  { finalAvg: number; txPurchaseAt: Date; timeline: Array<{ at: Date; avg: number }> } | null {
  const sorted = [...events].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const first = sorted.find((e) => e.kind === 'purchase');
  if (!first || !sorted.some((e) => e.kind === 'purchase' && e.txId === txId)) return null;
  // آخر كمية/تكلفة لكل فاتورة شراء.
  const finalLot = new Map<string, { qty: number; cost: number }>();
  for (const e of sorted) {
    if (!e.txId) continue;
    if (e.kind === 'purchase' || e.kind === 'purchase-edit') finalLot.set(e.txId, { qty: Number(e.qtyIn) || 0, cost: Number(e.unitCostIn) || 0 });
    else if (e.kind === 'purchase-cancel') finalLot.set(e.txId, { qty: 0, cost: 0 });
  }
  finalLot.set(txId, { qty: Number(newLot.qty) || 0, cost: Number(newLot.unitCost) || 0 });
  const recorded = new Map<string, number>(); // الكمية المتسجلة لكل فاتورة وقت الحدث
  let avg = Number(first.avgBefore) || 0;
  let txPurchaseAt = new Date(first.createdAt);
  const timeline: Array<{ at: Date; avg: number }> = [];
  for (const e of sorted) {
    let adjust = 0;
    for (const [tx, q] of recorded) adjust += (finalLot.get(tx)?.qty ?? q) - q;
    const S = (Number(e.stockBefore) || 0) + adjust;
    if (e.kind === 'purchase' && e.txId) {
      const lot = finalLot.get(e.txId) || { qty: 0, cost: 0 };
      avg = averageAfterPurchase(S, avg, lot.qty, lot.cost);
      recorded.set(e.txId, Number(e.qtyIn) || 0);
      if (e.txId === txId) txPurchaseAt = new Date(e.createdAt);
    } else if ((e.kind === 'purchase-edit' || e.kind === 'purchase-cancel') && e.txId) {
      recorded.set(e.txId, e.kind === 'purchase-cancel' ? 0 : Number(e.qtyIn) || 0);
    } else if (e.kind === 'supplier-return') {
      avg = averageAfterCorrection(S, avg, Number(e.oldQty) || 0, Number(e.oldUnitCost) || 0, 0, 0);
    } else if (e.kind === 'supplier-return-reversed') {
      avg = averageAfterPurchase(S, avg, Number(e.qtyIn) || 0, Number(e.unitCostIn) || 0);
    } else if (e.kind === 'revalue') {
      avg = round4(Number(e.avgAfter) || 0);
    }
    timeline.push({ at: new Date(e.createdAt), avg });
  }
  return { finalAvg: round4(avg), txPurchaseAt, timeline };
}

/** المتوسط اللي كان سليم وقت \`at\` حسب الإعادة (آخر نقطة قبله)، أو null لو قبل كل الأحداث. */
export function averageAt(timeline: Array<{ at: Date; avg: number }>, at: Date): number | null {
  let v: number | null = null;
  for (const p of timeline) { if (p.at.getTime() <= at.getTime()) v = p.avg; else break; }
  return v;
}
