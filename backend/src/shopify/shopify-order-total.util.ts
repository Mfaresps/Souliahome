/**
 * Money of a pending Shopify order — the one rule for its total (Nov 27, 2026).
 *
 * Mirrored in frontend/public/index.html by `_spOrderMoney` (⚠ keep both in step).
 *
 * - `discount` is Shopify's own discount; it may include a shipping part (`shippingDiscount`, Free Shipping).
 * - `manualDiscount` + `codesDiscount` are ours (never written by the webhook).
 * - Free shipping off (unchanged rule): total = items − min(Shopify discount + ours, items) + shipping.
 * - Free shipping on (`freeShipping` set by an employee): the customer pays NO shipping. Shopify's shipping part
 *   leaves the item cap (it covered shipping, not products), the rest is capped at the items.
 *
 * `room` = how much of the items is left for OUR discount after Shopify's. A discount over it would be cut
 * silently by the cap, so a change that exceeds it is refused instead.
 * `concession` = the shipping the employee waived beyond what Shopify already waived (counted in the
 * high-value discount approval, like any other discount an employee grants).
 */
export interface ShopifyOrderMoneyInput {
  itemsTotal?: number; shipCost?: number; discount?: number; shippingDiscount?: number;
  manualDiscount?: number; codesDiscount?: number; freeShipping?: unknown;
}
export interface ShopifyOrderMoney {
  freeShipping: boolean;
  itemsTotal: number;
  shipCost: number;
  /** Shopify's discount on shipping (clamped to shipping and to its own discount). */
  shopifyShipDiscount: number;
  /** Discount applied to the items (Shopify's product part + ours, capped at the items). */
  itemDiscount: number;
  /** Shipping the customer pays. */
  shipCharged: number;
  room: number;
  concession: number;
  /** Discount as the old callers read it (all discounts, capped at the items). */
  totalDiscount: number;
  total: number;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const pos = (v: unknown) => Math.max(0, Number(v) || 0);

/**
 * What a confirmed sale records for an order with «شحن مجاني» (null when it is off — the caller keeps the old fields):
 * shipping charged 0, the discount on the items only (Shopify's shipping part is not a product discount and the
 * whole shipping is waived anyway), no shippingDiscount, and the waived shipping kept in `freeShipping`.
 */
export function confirmedFreeShipping(order: ShopifyOrderMoneyInput & { freeShipping?: any }):
  { shipCost: 0; discount: number; freeShipping: { amount: number; by: string; at: string } } | null {
  const money = shopifyOrderMoney(order);
  if (!money.freeShipping) return null;
  const f = order.freeShipping && typeof order.freeShipping === 'object' ? order.freeShipping : {};
  return { shipCost: 0, discount: money.itemDiscount,
    freeShipping: { amount: money.shipCost, by: String(f.by || ''), at: String(f.at || '') } };
}

export function shopifyOrderMoney(order: ShopifyOrderMoneyInput): ShopifyOrderMoney {
  const freeShipping = !!order?.freeShipping;
  const itemsTotal = pos(order?.itemsTotal);
  const shipCost = pos(order?.shipCost);
  const shopify = pos(order?.discount);
  const shopifyShipDiscount = Math.min(pos(order?.shippingDiscount), shipCost, shopify);
  const ours = pos(order?.manualDiscount) + pos(order?.codesDiscount);
  const shopifyOnItems = freeShipping ? shopify - shopifyShipDiscount : shopify;
  const itemDiscount = r2(Math.min(shopifyOnItems + ours, itemsTotal));
  const shipCharged = freeShipping ? 0 : shipCost;
  return {
    freeShipping, itemsTotal, shipCost, shopifyShipDiscount, itemDiscount, shipCharged,
    room: r2(Math.max(0, itemsTotal - shopifyOnItems)),
    concession: freeShipping ? r2(shipCost - shopifyShipDiscount) : 0,
    totalDiscount: itemDiscount,
    total: r2(Math.max(0, itemsTotal - itemDiscount + shipCharged)),
  };
}
