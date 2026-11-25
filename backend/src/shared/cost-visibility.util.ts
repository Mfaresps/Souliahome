/**
 * Who may see what a product COSTS (Nov 25, 2026). The purchase price used to be sent to every
 * account and only hidden on screen. Now the server strips it for anyone without one of these.
 * ⚠ Display only — internal callers (profit, stock value, sale cost stamping) read the model directly.
 * ⚠ Mirrors `_canSeeCost()` in index.html.
 */
export const COST_VIEW_PERMS = ['products-cost-view', 'purchase-edit-price', 'purchase-create'];
export const COST_FIELDS = ['buyPrice', 'avgCost', 'avgCostUpdatedAt'] as const;

export type CostUser = { role?: string; perms?: string[] } | undefined;

/** Who may see WHO supplies a product (Nov 25, 2026) — a supplier's name is a business secret.
 *  ⚠ Mirrors `_canSeeSupplier()` in index.html and the /suppliers reader list. */
export const SUPPLIER_VIEW_PERMS = ['products-supplier-view', 'suppliers', 'purchase-create', 'purchase-view', 'purchase-edit-price'];
export const SUPPLIER_FIELDS = ['supplier', 'supplierId'] as const;
export function canSeeSupplier(user: CostUser): boolean {
  if (user?.role === 'admin') return true;
  const perms = user?.perms || [];
  return SUPPLIER_VIEW_PERMS.some(p => perms.includes(p));
}

export function canSeeCost(user: CostUser): boolean {
  if (user?.role === 'admin') return true;
  const perms = user?.perms || [];
  return COST_VIEW_PERMS.some(p => perms.includes(p));
}

function plain(row: any): any {
  if (!row || typeof row !== 'object') return row;
  return typeof row.toObject === 'function' ? row.toObject() : { ...row };
}

/** Removes cost fields from one product-like row (or each row of an array) for a user who may not see them. */
export function maskCost<T>(rows: T, user: CostUser): T {
  if (canSeeCost(user)) return rows;
  const strip = (row: any) => { const o = plain(row); if (o && typeof o === 'object') for (const f of COST_FIELDS) delete o[f]; return o; };
  return (Array.isArray(rows) ? rows.map(strip) : strip(rows)) as T;
}

/** Cost AND supplier: what a product row may show this user. */
export function maskProductPrivacy<T>(rows: T, user: CostUser): T {
  const costed = maskCost(rows, user);
  if (canSeeSupplier(user)) return costed;
  const strip = (row: any) => { const o = plain(row); if (o && typeof o === 'object') for (const f of SUPPLIER_FIELDS) delete o[f]; return o; };
  return (Array.isArray(costed) ? (costed as any[]).map(strip) : strip(costed)) as T;
}

/** Product analytics card: removes the buy price, cost, profit and the purchase-invoice list. */
export function maskAnalyticsCost<T>(card: T, user: CostUser): T {
  if (canSeeCost(user) || !card || typeof card !== 'object') return card;
  const c: any = JSON.parse(JSON.stringify(card));
  if (c.product) delete c.product.buyPrice;
  if (c.summary) for (const k of ['avgBuyPrice', 'netCost', 'currentUnitCost', 'netProfit', 'profitBeforeShipping', 'profitMargin', 'totalCostFromPurchases', 'shippingSubsidy']) delete c.summary[k];
  if (c.invoices) c.invoices.purchases = [];
  return c;
}
export function maskAnalyticsPrivacy<T>(card: T, user: CostUser): T {
  const c: any = maskAnalyticsCost(card, user);
  if (!canSeeSupplier(user) && c?.product) { const p = { ...c.product }; delete p.supplier; delete p.supplierId; return { ...c, product: p }; }
  return c;
}

/** Field names whose value differs between the stored record and an update body. */
export function changedFields(existing: any, dto: Record<string, unknown>, ignore: string[] = ['otpId']): string[] {
  const src = plain(existing) || {};
  // Never-set and the form's default (0, false, '', [], {}, size «standard») are the same value.
  // ⚠ Mirrors _diffRecord() in index.html.
  const empty = (v: unknown): boolean => v === undefined || v === null || v === '' || v === 0 || v === false
    || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v) && !Object.values(v as object).some(x => !empty(x)));
  const norm = (k: string, v: unknown) => {
    if (empty(v) || (k === 'sizeType' && v === 'standard')) return '';
    if (Array.isArray(v)) return JSON.stringify(k === 'features' ? [...v].map(String).sort() : v);
    if (typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) && typeof src[k] === 'number')) return String(Number(v));
    return String(v);
  };
  return Object.keys(dto || {}).filter(k => !ignore.includes(k) && dto[k] !== undefined && norm(k, src[k]) !== norm(k, dto[k])).sort();
}

/** A purchase order as this user may see it (Nov 25, 2026): the supplier's identity is removed
 *  without supplier view, and each line's buy price without cost view. ⚠ Read routes only. */
export function maskPurchaseOrders<T>(rows: T, user: CostUser): T {
  const seeSupplier = canSeeSupplier(user), seeCost = canSeeCost(user);
  if (seeSupplier && seeCost) return rows;
  const strip = (row: any) => {
    const o = plain(row);
    if (!o || typeof o !== 'object') return o;
    if (!seeSupplier) { o.supplierName = ''; o.supplierId = ''; }
    if (!seeCost && Array.isArray(o.items)) o.items = o.items.map((it: any) => { const c = { ...it }; delete c.unitPrice; delete c.buyPrice; delete c.total; return c; });
    return o;
  };
  return (Array.isArray(rows) ? rows.map(strip) : strip(rows)) as T;
}
