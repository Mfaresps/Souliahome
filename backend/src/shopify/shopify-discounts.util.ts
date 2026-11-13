/**
 * خصم الشحن في أوردر Shopify (REST webhook payload) — Nov 13, 2026.
 *
 * Shopify بيحط Free Shipping جوّه `total_discounts`، فكان بيتسجّل عندنا كخصم على المنتجات.
 * الجزء الخاص بالشحن متسجّل على سطر الشحن نفسه: `shipping_lines[].discount_allocations[].amount`
 * (مثال حقيقي #3146: total_discounts 120، و`discount_applications[0].target_type = 'shipping_line'`
 * «Free Shipping» تلقائي، و120 على سطر الشحن «Cairo»).
 *
 * ⚠ ده **تصنيف** بس: `discount` و`shipCost` و`total` بيفضلوا زي ما هم (shared/sale-discount.util.ts).
 * Pure — no database, no network.
 */
const money = (v: unknown): number => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

/** مجموع الخصم اللي Shopify عمله على الشحن. */
export function shopifyShippingDiscount(order: any): number {
  const lines: any[] = Array.isArray(order?.shipping_lines) ? order.shipping_lines : [];
  return r2(lines.reduce((sum, line) => sum + (Array.isArray(line?.discount_allocations)
    ? line.discount_allocations.reduce((s: number, a: any) => s + money(a?.amount), 0) : 0), 0));
}

/**
 * هل جزء من خصم الشحن جه من كود خصم (مش عرض تلقائي)؟ ⇒ تقرير الأكواد يحطه تحت «خصومات الشحن».
 * بيرجّع الأكواد اللي اتطبقت على الشحن (فاضي لو مفيش).
 */
export function shopifyShippingDiscountCodes(order: any): string[] {
  const apps: any[] = Array.isArray(order?.discount_applications) ? order.discount_applications : [];
  const used = new Set<number>();
  for (const line of Array.isArray(order?.shipping_lines) ? order.shipping_lines : []) {
    for (const a of Array.isArray(line?.discount_allocations) ? line.discount_allocations : []) {
      if (money(a?.amount) > 0 && Number.isInteger(a?.discount_application_index)) used.add(a.discount_application_index);
    }
  }
  return [...used].map(i => apps[i]).filter(a => a && a.type === 'discount_code' && a.code).map(a => String(a.code));
}

/** خصم الشحن بعد القصّ: لا يزيد عن الشحن ولا عن إجمالي الخصم المخزَّن. */
export function clampShippingDiscount(raw: number, shipCost: number, discount: number): number {
  return r2(Math.max(0, Math.min(Number(raw) || 0, Math.max(0, Number(shipCost) || 0), Math.max(0, Number(discount) || 0))));
}
