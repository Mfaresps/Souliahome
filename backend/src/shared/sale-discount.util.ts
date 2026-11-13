/**
 * خصم فاتورة البيع — قاعدة واحدة لكل الأرقام (التقارير، لوحة التحكم، تحليل المنتج).
 *
 * الفاتورة: `itemsTotal` = مجموع السطور (قبل الخصم)، و`total` = itemsTotal − discount + الشحن.
 * المبيعات والربح لازم يتحسبوا **بعد** الخصم — اللي العميل دفعه فعلًا. قبل كده التقارير ولوحة
 * التحكم كانوا بيحسبوا قبل الخصم، فالربح كان أعلى بقيمة كل الخصومات (Nov 12, 2026).
 *
 * الخصم بيتوزع على السطور بنسبة قيمة كل سطر — نفس قاعدة خصم فاتورة الشراء وحد رد المرتجع.
 * ⚠ نفس القاعدة في products/product-analytics.service.ts (الخصم المخزَّن، وإلا المستنتج).
 *
 * ── خصم الشحن (Nov 13, 2026) ──────────────────────────────────────────────────────────────
 * `discount` المخزَّن هو **كل** الخصم اللي على الفاتورة، وفيه خصم الشحن لو موجود (Free Shipping
 * في Shopify بيوصل جوّه `total_discounts`). `shippingDiscount` هو الجزء اللي اتعمل على الشحن.
 * - الإجمالي والمتبقي والخزنة وBosta مابيتغيّروش: `total = items − discount + shipCost` زي ما هو،
 *   والـ 120 بتلغي نفسها. اللي بيقرأ الحقل الجديد هو تقسيم الإيراد بس.
 * - خصم المنتجات = discount − shippingDiscount. الشحن المحصَّل من العميل = shipCost − shippingDiscount.
 * - دعم الشحن (الشحن المجاني اللي الشركة شالته) بيتوزّع على السطور بنسبة قيمتها ويتطرح من الربح
 *   الإجمالي، فالربح الإجمالي **مطابق رياضياً** للحساب القديم:
 *     سطر × (1 − (dp + sd)/I) = سطر × (1 − d/I)   لأن dp + sd = d.
 * - صف من غير الحقل (كل الصفوف القديمة) = shippingDiscount صفر = نفس الأرقام القديمة بالظبط.
 */
type SaleTx = {
  itemsTotal?: number; total?: number; shipCost?: number; discount?: number; shippingDiscount?: number;
  items?: Array<{ total?: number }>;
};

/** إجمالي الأصناف قبل الخصم. */
export function invoiceItemsTotal(tx: SaleTx): number {
  const stored = Number(tx?.itemsTotal) || 0;
  if (stored > 0) return stored;
  const lines = (tx?.items || []).reduce((s, i) => s + (Number(i?.total) || 0), 0);
  if (lines > 0) return lines;
  return Math.max(0, (Number(tx?.total) || 0) - (Number(tx?.shipCost) || 0));
}

/** الجزء من خصم الفاتورة اللي اتعمل على الشحن. لا يزيد عن الشحن ولا عن الخصم المخزَّن. */
export function invoiceShippingDiscount(tx: SaleTx): number {
  const sd = Number(tx?.shippingDiscount) || 0;
  if (sd <= 0) return 0;
  const ship = Math.max(0, Number(tx?.shipCost) || 0);
  const stored = Math.max(0, Number(tx?.discount) || 0);
  return Math.min(sd, ship, stored);
}

/** الشحن اللي العميل اتحاسب عليه فعلاً (بعد خصم الشحن). */
export function invoiceShipCharged(tx: SaleTx): number {
  return Math.max(0, (Number(tx?.shipCost) || 0) - invoiceShippingDiscount(tx));
}

/** خصم **المنتجات**: المخزَّن ناقص خصم الشحن، وإلا المستنتج من الإجماليات (صفوف قديمة). لا يزيد عن قيمة الأصناف. */
export function invoiceDiscount(tx: SaleTx): number {
  const items = invoiceItemsTotal(tx);
  const stored = Number(tx?.discount) || 0;
  const d = stored > 0
    ? stored - invoiceShippingDiscount(tx)
    : Math.max(0, items - ((Number(tx?.total) || 0) - invoiceShipCharged(tx)));
  return Math.min(Math.max(d, 0), items);
}

/** نسبة خصم المنتجات من قيمة الأصناف (0..1) — سعر السطر الصافي = السعر × (1 − النسبة). */
export function invoiceDiscountRatio(tx: SaleTx): number {
  const items = invoiceItemsTotal(tx);
  return items > 0 ? invoiceDiscount(tx) / items : 0;
}

/**
 * نسبة دعم الشحن من قيمة الأصناف — دعم السطر = السعر × الكمية × النسبة. بيتطرح من الربح الإجمالي
 * علشان يفضل مطابق للحساب القديم (شوف الشرح فوق).
 */
export function invoiceShippingSubsidyRatio(tx: SaleTx): number {
  const items = invoiceItemsTotal(tx);
  return items > 0 ? invoiceShippingDiscount(tx) / items : 0;
}

/** صافي مبيعات الفاتورة (الأصناف بعد خصم المنتجات، من غير الشحن). */
export function invoiceNetSales(tx: SaleTx): number {
  return Math.max(0, invoiceItemsTotal(tx) - invoiceDiscount(tx));
}
