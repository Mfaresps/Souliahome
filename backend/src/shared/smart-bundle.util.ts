/**
 * «الباقات الذكية» (settings.discountBundles) — which bundle a sale used (Nov 14, 2026).
 *
 * A smart bundle applies through a discount code, and a sale only ever stored the code, so a
 * bundle's use could not be counted. The SERVER now decides it when a sale is saved, from the
 * codes and the products on the invoice — nothing the browser sends is trusted.
 *
 * ⚠ Tracking starts with this change (owner's decision): an invoice carries `appliedBundles`
 * only if it was saved after it. Old invoices are never guessed from their code.
 */
export interface SmartBundle {
  id: string;
  name?: string;
  productIds?: string[];
  discountCodeId?: string;
  allowPartial?: boolean;
  partialDiscountCodeId?: string | null;
  minQty?: number;
  productMinQtys?: Record<string, number>;
}
export interface DiscountCodeDef { id: string; code?: string; type?: string; value?: number }
export interface AppliedBundle {
  id: string;
  name: string;
  kind: 'full' | 'partial';
  codeId: string;
  code: string;
  productIds: string[];
  /** What the bundle's code took off this invoice, at the code's own value (EGP). */
  discount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function deriveAppliedBundles(
  items: any[] | undefined,
  codeIdsField: string | undefined,
  bundles: SmartBundle[] | undefined,
  codes: DiscountCodeDef[] | undefined,
  productDiscount: number,
): AppliedBundle[] {
  const codeIds = String(codeIdsField || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!codeIds.length || !Array.isArray(bundles) || !bundles.length) return [];
  const qtyByProduct = new Map<string, number>();
  let itemsTotal = 0;
  for (const it of items || []) {
    const pid = String(it?.productId || '');
    const qty = Number(it?.qty) || 0;
    itemsTotal += qty * (Number(it?.price) || 0);
    if (pid) qtyByProduct.set(pid, (qtyByProduct.get(pid) || 0) + qty);
  }
  const codeById = new Map((codes || []).map((c) => [String(c.id), c]));
  const out: AppliedBundle[] = [];
  for (const b of bundles) {
    const pids = (b.productIds || []).map(String).filter(Boolean);
    if (!b?.id || !pids.length) continue;
    const meets = (pid: string) => (qtyByProduct.get(pid) || 0) >= (Number(b.productMinQtys?.[pid]) || Number(b.minQty) || 1);
    const present = pids.filter((pid) => (qtyByProduct.get(pid) || 0) > 0);
    if (!present.length || !present.every(meets)) continue;
    const full = present.length === pids.length;
    const codeId = full
      ? String(b.discountCodeId || '')
      : (b.allowPartial ? String(b.partialDiscountCodeId || b.discountCodeId || '') : '');
    if (!codeId || !codeIds.includes(codeId)) continue;
    const c = codeById.get(codeId);
    const raw = !c ? 0 : c.type === 'percent' ? itemsTotal * (Number(c.value) || 0) / 100 : Number(c.value) || 0;
    out.push({
      id: String(b.id), name: String(b.name || ''), kind: full ? 'full' : 'partial',
      codeId, code: String(c?.code || ''), productIds: present,
      discount: round2(Math.max(0, Math.min(raw, Math.max(0, productDiscount)))),
    });
  }
  return out;
}
