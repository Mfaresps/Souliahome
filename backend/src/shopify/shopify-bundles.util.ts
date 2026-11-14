/**
 * Shopify native bundles (Phase 2, Nov 13, 2026) — pure rules, no database, no network.
 *
 * What Shopify sends (verified on the real #3146): a bundle arrives as its COMPONENT lines only, each with
 * `sales_line_item_group_id`; each component's `price` is already its share of the bundle price (3000 ×
 * 1420/3270 = 1302.75). The REST `line_item_groups` carries only `{id, parent_line_item_id}` — the bundle's
 * name and quantity come from GraphQL (`LineItem.lineItemGroup { id title quantity productId variantId variantSku }`).
 *
 * Rules:
 *   - Shopify's allocated price is the selling price. Nothing here recalculates a price.
 *   - `bundleOriginal` is set ONCE, only from a verified snapshot whose composition equals what arrived first.
 *   - A snapshot is "verified" only when every grouped line has its group's title and quantity from GraphQL.
 */
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const money = (v: unknown): number => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const tail = (gid: unknown) => String(gid ?? '').split('/').pop() || '';

export interface BundleComponent {
  shopifyLineId: string; sku: string; name: string; variantTitle: string; qty: number;
  /** Shopify's allocated unit price for this component (its share of the bundle). */
  unitPrice: number; lineTotal: number;
  /** Shopify discount allocated on this line on top of the bundle split (codes / automatic). */
  lineDiscount: number;
}
export interface BundleGroup {
  groupId: string; title: string | null; quantity: number | null;
  productId: string; variantId: string; sku: string;
  components: BundleComponent[];
  /** Σ component line totals = what Shopify charged for the bundle(s), before line discounts. */
  allocatedTotal: number;
}
export interface BundleSnapshot {
  groups: BundleGroup[];
  verified: boolean;
  /** Why it is not verified (missing GraphQL data, composition changed, …). */
  reason?: string;
  capturedAt: string;
  source: 'webhook' | 'graphql';
}
export interface GqlGroupInfo { title: string; quantity: number; productId: string; variantId: string; sku: string }

export function lineDiscountOf(line: any): number {
  return r2((Array.isArray(line?.discount_allocations) ? line.discount_allocations : []).reduce((s: number, a: any) => s + money(a?.amount), 0));
}
const qtyOf = (line: any) => Number(line?.current_quantity ?? line?.quantity ?? 0) || 0;

/** The grouped (bundle component) lines of a REST order payload, still present (qty > 0). */
export function bundleLines(order: any): any[] {
  return (Array.isArray(order?.line_items) ? order.line_items : [])
    .filter((l: any) => l?.sales_line_item_group_id != null && String(l.sales_line_item_group_id) !== '' && qtyOf(l) > 0);
}
export function hasBundles(order: any): boolean { return bundleLines(order).length > 0; }

/**
 * Marks the order's stored lines as bundle parts from Shopify's own payload — for orders whose lines were
 * mapped before bundle support (they carry no `bundleGroupId`, so no screen shows the bundle). A line is
 * matched by its Shopify line id, else by a code + qty + price that is unique among the unmarked lines;
 * an ambiguous or unmatched line is left as it is (never guessed). Prices and quantities are never changed.
 * Returns how many lines were marked.
 */
export function stampBundleItems(items: any[], order: any): number {
  if (!Array.isArray(items)) return 0;
  let n = 0;
  for (const line of bundleLines(order)) {
    const g = String(line.sales_line_item_group_id);
    const id = line.id != null ? String(line.id) : '';
    if (id && items.some((it) => String(it?.shopifyLineId || '') === id && it?.bundleGroupId)) continue;
    let hit = id ? items.find((it) => String(it?.shopifyLineId || '') === id && !it?.bundleGroupId) : undefined;
    if (!hit) {
      const sku = String(line.sku || '').trim();
      const price = money(line.price);
      const cands = sku ? items.filter((it) => !it?.bundleGroupId && !it?.shopifyLineId
        && String(it?.code || '').trim() === sku && Number(it?.qty) === qtyOf(line)
        && Math.abs((Number(it?.price) || 0) - price) < 0.01) : [];
      if (cands.length === 1) hit = cands[0];
    }
    if (!hit) continue;
    hit.bundleGroupId = g;
    hit.priceBasis = 'bundle';
    if (!hit.shopifyLineId && id) hit.shopifyLineId = id;
    n++;
  }
  return n;
}

/**
 * Builds the bundle snapshot from the REST payload plus, when available, GraphQL group info keyed by the
 * numeric group id. Without GraphQL info for every group the snapshot is NOT verified (title/quantity null).
 */
export function buildBundleSnapshot(order: any, gql: Map<string, GqlGroupInfo> | null, at = new Date().toISOString()): BundleSnapshot | null {
  const lines = bundleLines(order);
  if (!lines.length) return null;
  const byGroup = new Map<string, any[]>();
  for (const l of lines) {
    const g = String(l.sales_line_item_group_id);
    byGroup.set(g, [...(byGroup.get(g) || []), l]);
  }
  const missing: string[] = [];
  const groups: BundleGroup[] = [...byGroup.entries()].map(([groupId, ls]) => {
    const info = gql?.get(groupId) || null;
    if (!info || !info.title || !(info.quantity > 0)) missing.push(groupId);
    const components = ls.map((l: any): BundleComponent => ({
      shopifyLineId: String(l.id), sku: String(l.sku || ''), name: String(l.title || l.name || ''), variantTitle: String(l.variant_title || ''),
      qty: qtyOf(l), unitPrice: r2(money(l.price)), lineTotal: r2(money(l.price) * qtyOf(l)), lineDiscount: lineDiscountOf(l),
    }));
    return {
      groupId, title: info?.title || null, quantity: info?.quantity ?? null,
      productId: info?.productId || '', variantId: info?.variantId || '', sku: info?.sku || '',
      components, allocatedTotal: r2(components.reduce((s, c) => s + c.lineTotal, 0)),
    };
  });
  return {
    groups, verified: !missing.length && !!gql,
    ...(missing.length || !gql ? { reason: gql ? `بيانات الباقة ناقصة من Shopify للمجموعة ${missing.join(', ')}` : 'اسم الباقة وعددها غير متاحين بعد (يُقرآن من Shopify GraphQL)' } : {}),
    capturedAt: at, source: gql ? 'graphql' : 'webhook',
  };
}

/** GraphQL `order.lineItems.nodes` → group info keyed by the numeric group id (same id REST sends). */
export function groupInfoFromGraphql(nodes: any[]): Map<string, GqlGroupInfo> {
  const out = new Map<string, GqlGroupInfo>();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const g = n?.lineItemGroup;
    if (!g?.id) continue;
    out.set(tail(g.id), { title: String(g.title || ''), quantity: Number(g.quantity) || 0,
      productId: tail(g.productId), variantId: tail(g.variantId), sku: String(g.variantSku || '') });
  }
  return out;
}

/** The composition that must not change between the first arrival and a later verified snapshot. */
export function compositionKey(s: Pick<BundleSnapshot, 'groups'> | null | undefined): string {
  if (!s) return '';
  return JSON.stringify(s.groups.map(g => [g.groupId, g.components.map(c => [c.shopifyLineId, c.qty, c.unitPrice]).sort()]).sort());
}

/**
 * A line that carries the BUNDLE's own SKU/variant beside its components (some bundle apps do this): its
 * revenue and stock would be counted twice — confirmation must be refused. Native Shopify bundles never do.
 */
export function bundleParentConflicts(order: any, snapshot: BundleSnapshot | null): Array<{ lineId: string; sku: string; groupTitle: string }> {
  if (!snapshot) return [];
  const out: Array<{ lineId: string; sku: string; groupTitle: string }> = [];
  const others = (Array.isArray(order?.line_items) ? order.line_items : []).filter((l: any) => (l?.sales_line_item_group_id == null || l.sales_line_item_group_id === '') && qtyOf(l) > 0);
  for (const g of snapshot.groups) {
    for (const l of others) {
      const skuHit = g.sku && String(l.sku || '') === g.sku;
      const variantHit = g.variantId && String(l.variant_id || '') === g.variantId;
      if (skuHit || variantHit) out.push({ lineId: String(l.id), sku: String(l.sku || ''), groupTitle: g.title || g.groupId });
    }
  }
  return out;
}
