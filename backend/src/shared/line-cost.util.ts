/**
 * تكلفة سطر البيع المثبّتة — خطوة 1 من خطة تصحيح حساب الربح.
 *
 * قبل ده كل تقرير ربح كان بيحسب تكلفة كل سطر بيع قديم من `Product.buyPrice` **الحالي**،
 * فأي تعديل في سعر الشراء في كارت المنتج كان بيغيّر أرباح كل الشهور اللي فاتت.
 *
 * التثبيت بيكتب على السطر نفسه `unitCost` + `costSource` + `costAt`:
 *   - `legacy-frozen` : اتثبّت من سعر الكارت وقت تشغيل التثبيت — نفس الرقم اللي التقارير
 *                       كانت بتستخدمه، فمفيش رقم ظاهر بيتغيّر.
 * سطر من غير تكلفة مثبّتة يفضل يتحسب بسعر الكارت الحالي، **بالظبط** زي قبل التغيير.
 *
 * ⚠ كل مكان بيحسب تكلفة سطر بيع لازم يعدّي من `lineUnitCost` — مكان واحد بيقرا
 *   `buyPrice` مباشرة = رقمين مختلفين لنفس الشهر.
 */

/**
 *   - `legacy-frozen`   : خطوة 1 — سطر قديم اتثبّت بسعر الكارت وقت تشغيل التثبيت.
 *   - `sale-snapshot`   : خطوة 2 — اتحفظ لحظة إنشاء البيع (أو إضافة السطر في تعديل).
 *   - `return-original` : سطر مرتجع واخد تكلفة سطر البيع الأصلي.
 * ⚠ نسخة مكتوبة يدويًا من القائمة دي في index.html (تحليل الأرباح) — يتغيّروا مع بعض.
 */
export const LINE_COST_SOURCES = ['legacy-frozen', 'sale-snapshot', 'return-original'] as const;
export type LineCostSource = (typeof LINE_COST_SOURCES)[number];

const COST_FIELDS = ['unitCost', 'costSource', 'costAt', 'costBasis'] as const;

/** التكلفة المثبّتة على السطر، أو `null` لو السطر لسه ماتثبّتش. */
export function frozenUnitCost(item: any): number | null {
  if (!item || !(LINE_COST_SOURCES as readonly string[]).includes(item.costSource)) return null;
  const cost = Number(item.unitCost);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

/**
 * تكلفة القطعة في السطر: المثبّتة لو موجودة، وإلا سعر الشراء الحالي في الكارت
 * (`liveBuyPrice`). المنتج الغير موجود = 0، زي ما التقارير كانت بتعمل.
 */
export function lineUnitCost(item: any, liveBuyPrice: number | null | undefined): number {
  const frozen = frozenUnitCost(item);
  if (frozen !== null) return frozen;
  return Number(liveBuyPrice) || 0;
}

/**
 * يرجّع نسخة من السطر عليها التكلفة المثبّتة، أو `null` لو مفيش داعي:
 * السطر متثبّت بالفعل (التثبيت مايتعادش)، أو منتجه مش موجود (يفضل بدون تثبيت ويتبلّغ).
 */
export function freezeLineCost(item: any, liveBuyPrice: number | null | undefined, at: string): any | null {
  if (frozenUnitCost(item) !== null) return null;
  if (liveBuyPrice === null || liveBuyPrice === undefined) return null;
  const cost = Number(liveBuyPrice);
  // ⚠ سعر كارت صفر = تكلفة ناقصة، ماتتثبّتش صفر (التقرير بيعرضها «ناقصة»).
  if (!Number.isFinite(cost) || cost <= 0) return null;
  return { ...item, unitCost: cost, costSource: 'legacy-frozen', costAt: at };
}

function stripCost(item: any): any {
  const clean: any = { ...item };
  for (const f of COST_FIELDS) delete clean[f];
  return clean;
}

/**
 * خطوة 2: سطور بيع جديدة تاخد تكلفتها لحظة الإنشاء. أي تكلفة جاية مع السطر بتتشال الأول —
 * التكلفة بيقررها السيرفر بس. المنتج الغير معروف يفضل من غير تكلفة (يتحسب زي النهارده).
 * `costOf(code)` بيرجّع سعر التكلفة الحالي أو `null` لو المنتج مش موجود.
 */
export type CostOf = (code: string) => number | { cost: number; basis: string } | null | undefined;

export function stampSaleLineCosts(items: any[] | undefined, costOf: CostOf, at: string): any[] | undefined {
  if (!Array.isArray(items)) return items;
  return items.map((item) => {
    const clean = stripCost(item);
    const r = costOf(String(item?.code || '').trim());
    const cost = r !== null && typeof r === 'object' ? r.cost : r;
    const basis = r !== null && typeof r === 'object' ? r.basis : '';
    if (cost === null || cost === undefined || !Number.isFinite(Number(cost)) || Number(cost) < 0) return clean;
    // costBasis: 'avg' (متوسط التكلفة) أو 'card' (سعر الكارت لأن المتوسط لسه ماتحسبش) — لتقرير مصدر التكلفة.
    return { ...clean, unitCost: Number(cost), costSource: 'sale-snapshot', costAt: at, ...(basis ? { costBasis: basis } : {}) };
  });
}

/**
 * بعد `carryLineCosts` في التعديل: السطر اللي مالقاش تكلفة يتنقل (سطر جديد) ياخد التكلفة
 * الحالية. السطور اللي اتنقلت تكلفتها مابتتلمسش.
 */
export function stampMissingSaleLineCosts(items: any[] | undefined, costOf: CostOf, at: string): any[] | undefined {
  if (!Array.isArray(items)) return items;
  return items.map((item) => frozenUnitCost(item) !== null ? item : stampSaleLineCosts([item], costOf, at)![0]);
}

/** سطر المرتجع ياخد تكلفة سطر البيع الأصلي — المثبّتة لو موجودة، وإلا السعر الحالي. */
export function returnLineCost(originalLine: any, liveBuyPrice: number | null | undefined, at: string): Record<string, unknown> {
  const frozen = frozenUnitCost(originalLine);
  const cost = frozen !== null ? frozen : liveBuyPrice;
  if (cost === null || cost === undefined || !Number.isFinite(Number(cost)) || Number(cost) < 0) return {};
  return { unitCost: Number(cost), costSource: 'return-original', costAt: at };
}

/**
 * تعديل الفاتورة بيعيد كتابة السطور من الطلب، والـDTO و`validEditItems` الاتنين بيشيلوا أي
 * حقل مش معروف — فالتكلفة المثبّتة كانت هتضيع مع أول تعديل لأي فاتورة قديمة. ده بينقلها
 * من السطر المخزّن للسطر المعدّل قبل الحفظ.
 *
 * المطابقة: بـ`lineId` لو موجود في الاتنين، وإلا بالكود لو الكود متكرر مرة واحدة بس في
 * القديم والجديد (`validEditItems` في Shopify بيشيل `lineId`). سطر مالقاش مطابق يفضل من غير
 * تكلفة ويتحسب بسعر الكارت الحالي. التكلفة **مابتتاخدش أبدًا من الطلب نفسه**.
 */
export function carryLineCosts(stored: any[] | undefined, next: any[] | undefined): any[] | undefined {
  if (!Array.isArray(next)) return next;
  const old = Array.isArray(stored) ? stored : [];
  const code = (row: any) => String(row?.code || '').trim();
  return next.map((row) => {
    const clean: any = { ...row };
    for (const f of COST_FIELDS) delete clean[f];
    const byId = row?.lineId ? old.find((o) => o?.lineId && o.lineId === row.lineId) : null;
    const source = byId && code(byId) === code(row) ? byId
      : (!byId && old.filter((o) => code(o) === code(row)).length === 1 && next.filter((n) => code(n) === code(row)).length === 1)
        ? old.find((o) => code(o) === code(row)) : null;
    if (!source || frozenUnitCost(source) === null) return clean;
    for (const f of COST_FIELDS) clean[f] = source[f];
    return clean;
  });
}

/**
 * التدقيق المحاسبي — مصدر تكلفة سطر بيع، للعرض في تقرير الربح بس (مابيغيّرش أي حساب):
 * - `frozen-history` : تكلفة تاريخية اتثبّتت بأداة التثبيت (خطوة 1).
 * - `sale-avg`       : اتحفظت وقت البيع من متوسط التكلفة (خطوة 3).
 * - `sale-card`      : اتحفظت وقت البيع من سعر الكارت (المتوسط لسه ماكانش اتحسب).
 * - `live-card`      : مش مثبّتة — بتتحسب بسعر الكارت الحالي (لسه ماتشغّلتش أداة التثبيت عليها).
 * - `missing`        : مش مثبّتة ومفيش تكلفة معروفة (منتج مش موجود أو سعره صفر).
 */
export type LineCostSourceKey = 'frozen-history' | 'sale-avg' | 'sale-card' | 'live-card' | 'missing';
export const LINE_COST_SOURCE_KEYS: LineCostSourceKey[] = ['frozen-history', 'sale-avg', 'sale-card', 'live-card', 'missing'];

export function lineCostSourceKey(item: any, liveBuyPrice: number | null | undefined): LineCostSourceKey {
  if (frozenUnitCost(item) !== null) {
    if (item.costSource === 'sale-snapshot') return item.costBasis === 'avg' ? 'sale-avg' : 'sale-card';
    return 'frozen-history';
  }
  return Number(liveBuyPrice) > 0 ? 'live-card' : 'missing';
}
