/**
 * Shopify line identity and bundle fields on order/invoice lines (Phase 2, Nov 13, 2026).
 *
 * The edit paths rebuild lines from the request, and both whitelists (validEditItems, TransactionItemDto)
 * drop unknown fields — so these would vanish on the first edit. They are carried from the STORED line,
 * never taken from the client (a client cannot mark a line as a bundle component or invent a Shopify id).
 * Matching: `shopifyLineId` (Shopify edit window) or `lineId` (invoice edit), else a code unique on both
 * sides — the same rule as carryLineCosts (shared/line-cost.util.ts).
 */
export const SHOPIFY_LINE_FIELDS = ['shopifyLineId', 'shopifyVariantId', 'shopifyProductId', 'shopifyLineDiscount', 'bundleGroupId', 'priceBasis'] as const;

export function carryShopifyLineFields<T extends Record<string, any>>(stored: any[] | undefined, incoming: T[] | undefined): T[] | undefined {
  if (!Array.isArray(incoming)) return incoming;
  const old = Array.isArray(stored) ? stored : [];
  const code = (i: any) => String(i?.code || '').trim();
  const count = (arr: any[], c: string) => arr.filter((i) => code(i) === c).length;
  return incoming.map((raw) => {
    const item: any = { ...raw };
    const claimed = String(item.shopifyLineId || '');
    for (const f of SHOPIFY_LINE_FIELDS) delete item[f];
    let match = claimed ? old.find((o) => String(o?.shopifyLineId || '') === claimed && code(o) === code(item)) : null;
    if (!match && item.lineId) match = old.find((o) => o?.lineId && o.lineId === item.lineId);
    const c = code(item);
    if (!match && c && count(old, c) === 1 && count(incoming, c) === 1) match = old.find((o) => code(o) === c);
    if (match) for (const f of SHOPIFY_LINE_FIELDS) if (match[f] !== undefined && match[f] !== '') item[f] = match[f];
    return item;
  });
}
