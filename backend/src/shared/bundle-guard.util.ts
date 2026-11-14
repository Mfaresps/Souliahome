/**
 * Shopify bundle protection on edits (Phase 3, Nov 13, 2026) — ONE rule for the Shopify edit window
 * (prepareOrderEdit) and the confirmed-invoice edit (TransactionsService.update).
 *
 * Owner's decisions:
 *   - A bundle part keeps Shopify's allocated price: its price never changes and its quantity never grows
 *     (more pieces = a separate line at the normal price).
 *   - Removing or reducing a part breaks the bundle: the remaining parts are repriced at their STANDALONE
 *     price on the day the order was placed (any individual offer running that day included) — never today's
 *     price, never the old allocation. Needs explicit confirmation (`confirmBundleBreak`).
 *   - After delivery the composition cannot change — returns / after-sales handle it.
 * The incoming lines must already carry their bundle fields from the STORED lines (carryShopifyLineFields).
 * Pure: the caller supplies the product lookup and the day.
 */
import { effectiveSellPrice } from './price-offer.util';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface BundleBreakLine { code: string; name: string; qty: number; from: number; to: number }
export interface BundleBreak { groupId: string; title: string; lines: BundleBreakLine[]; addedToCustomer: number }

export class BundleGuardError extends Error {
  constructor(public code: string, message: string, public preview?: BundleBreak[]) { super(message); }
}

export function bundleGuard(opts: {
  stored: any[]; incoming: any[]; day: string; delivered: boolean; confirmBreak: boolean;
  titleOf?: (groupId: string) => string;
  productOf: (line: any) => any;
}): { items: any[]; broken: BundleBreak[] } {
  const stored = (opts.stored || []).filter((l) => l?.bundleGroupId);
  if (!stored.length) return { items: opts.incoming, broken: [] };
  const storedById = new Map(stored.map((l) => [String(l.shopifyLineId || ''), l]));
  const incoming = opts.incoming || [];

  // A group is broken when any of its stored parts is gone or has fewer pieces.
  const groups = new Map<string, any[]>();
  for (const l of stored) groups.set(String(l.bundleGroupId), [...(groups.get(String(l.bundleGroupId)) || []), l]);
  const brokenIds = [...groups.entries()].filter(([g, parts]) => parts.some((p) => {
    const now = incoming.find((l) => l?.bundleGroupId && String(l.bundleGroupId) === g && String(l.shopifyLineId || '') === String(p.shopifyLineId || ''));
    return !now || (Number(now.qty) || 0) < (Number(p.qty) || 0);
  })).map(([g]) => g);

  for (const line of incoming) {
    if (!line?.bundleGroupId) continue;
    const was = storedById.get(String(line.shopifyLineId || ''));
    if (!was) continue;
    // In a broken group the price is decided below (standalone price of the order's day), whatever was sent.
    if (!brokenIds.includes(String(line.bundleGroupId)) && Math.abs((Number(line.price) || 0) - (Number(was.price) || 0)) > 0.005) {
      throw new BundleGuardError('BUNDLE_PRICE_LOCKED', `سعر «${line.name || line.code}» هو نصيبه من سعر الباقة في Shopify ولا يُعدَّل`);
    }
    if ((Number(line.qty) || 0) > (Number(was.qty) || 0)) {
      throw new BundleGuardError('BUNDLE_QTY_LOCKED', `لا تُزاد كمية «${line.name || line.code}» بسعر الباقة — أضف القطع الزيادة سطراً منفصلاً بسعرها العادي`);
    }
  }

  if (!brokenIds.length) return { items: incoming, broken: [] };
  if (opts.delivered) {
    throw new BundleGuardError('BUNDLE_LOCKED_AFTER_DELIVERY', 'سُلِّم الطلب، ولا يتغيّر تكوين الباقة بعد التسليم. استخدم المرتجعات أو خدمة ما بعد البيع');
  }

  const broken: BundleBreak[] = [];
  const items = incoming.map((line) => {
    if (!line?.bundleGroupId || !brokenIds.includes(String(line.bundleGroupId))) return line;
    const p = opts.productOf(line);
    if (!p) throw new BundleGuardError('BUNDLE_PRICE_UNKNOWN', `لا يمكن تحديد السعر العادي لـ«${line.name || line.code}» — الصنف غير مطابق لمنتج في النظام`);
    const to = r2(effectiveSellPrice(p, opts.day).price);
    const g = String(line.bundleGroupId);
    let b = broken.find((x) => x.groupId === g);
    if (!b) { b = { groupId: g, title: opts.titleOf?.(g) || '', lines: [], addedToCustomer: 0 }; broken.push(b); }
    b.lines.push({ code: String(line.code || ''), name: String(line.name || ''), qty: Number(line.qty) || 0, from: r2(line.price), to });
    b.addedToCustomer = r2(b.addedToCustomer + (to - (Number(line.price) || 0)) * (Number(line.qty) || 0));
    const { bundleGroupId: _g, ...rest } = line;
    return { ...rest, price: to, total: r2(to * (Number(line.qty) || 0)), priceBasis: 'regular', brokenFrom: g };
  });
  // Groups broken by removing every part leave nothing to reprice — still a break worth confirming.
  for (const g of brokenIds) if (!broken.find((x) => x.groupId === g)) broken.push({ groupId: g, title: opts.titleOf?.(g) || '', lines: [], addedToCustomer: 0 });
  if (!opts.confirmBreak) {
    throw new BundleGuardError('BUNDLE_BREAK_CONFIRM_REQUIRED', 'حذف جزء من الباقة يُلغي سعرها، وتُسعَّر الأجزاء المتبقية بسعرها العادي في تاريخ الطلب. أكِّد للمتابعة', broken);
  }
  return { items, broken };
}

/** Value of the lines outside any bundle — the only base codes and extra discounts apply to by default. */
export function nonBundleSubtotal(items: any[]): number {
  return r2((items || []).filter((l) => !l?.bundleGroupId).reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.qty) || 0), 0));
}
export function hasBundleLines(items: any[]): boolean { return (items || []).some((l) => l?.bundleGroupId); }
