/**
 * خصم فاتورة البيع — قاعدة واحدة لكل الأرقام (التقارير، لوحة التحكم، تحليل المنتج).
 *
 * الفاتورة: `itemsTotal` = مجموع السطور (قبل الخصم)، و`total` = itemsTotal − discount + الشحن.
 * المبيعات والربح لازم يتحسبوا **بعد** الخصم — اللي العميل دفعه فعلًا. قبل كده التقارير ولوحة
 * التحكم كانوا بيحسبوا قبل الخصم، فالربح كان أعلى بقيمة كل الخصومات (Nov 12, 2026).
 *
 * الخصم بيتوزع على السطور بنسبة قيمة كل سطر — نفس قاعدة خصم فاتورة الشراء وحد رد المرتجع.
 * ⚠ نفس القاعدة في products/product-analytics.service.ts (الخصم المخزَّن، وإلا المستنتج).
 */
type SaleTx = { itemsTotal?: number; total?: number; shipCost?: number; discount?: number; items?: Array<{ total?: number }> };

/** إجمالي الأصناف قبل الخصم. */
export function invoiceItemsTotal(tx: SaleTx): number {
  const stored = Number(tx?.itemsTotal) || 0;
  if (stored > 0) return stored;
  const lines = (tx?.items || []).reduce((s, i) => s + (Number(i?.total) || 0), 0);
  if (lines > 0) return lines;
  return Math.max(0, (Number(tx?.total) || 0) - (Number(tx?.shipCost) || 0));
}

/** خصم الفاتورة: المخزَّن، وإلا المستنتج من الإجماليات (صفوف قديمة). لا يزيد عن قيمة الأصناف. */
export function invoiceDiscount(tx: SaleTx): number {
  const items = invoiceItemsTotal(tx);
  const stored = Number(tx?.discount) || 0;
  const d = stored > 0 ? stored : Math.max(0, items - ((Number(tx?.total) || 0) - (Number(tx?.shipCost) || 0)));
  return Math.min(Math.max(d, 0), items);
}

/** نسبة الخصم من قيمة الأصناف (0..1) — سعر السطر الصافي = السعر × (1 − النسبة). */
export function invoiceDiscountRatio(tx: SaleTx): number {
  const items = invoiceItemsTotal(tx);
  return items > 0 ? invoiceDiscount(tx) / items : 0;
}

/** صافي مبيعات الفاتورة (الأصناف بعد الخصم، من غير الشحن). */
export function invoiceNetSales(tx: SaleTx): number {
  return Math.max(0, invoiceItemsTotal(tx) - invoiceDiscount(tx));
}
