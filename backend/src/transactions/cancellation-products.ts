import { LEGACY_CANCEL_REASON_CODE } from '../shared/cancellation.constants';

type CancellationRow = {
  stage: string;
  code: string;
  type: string;
  items?: Array<{ productId?: unknown; code?: unknown; name?: unknown; shopifyName?: unknown; qty?: unknown }>;
};

/** Count a product once per cancelled order, but sum every valid item quantity. */
export function buildCancelledProducts(rows: CancellationRow[]) {
  const text = (value: unknown) => String(value ?? '').trim();
  const eligible = (row: CancellationRow) => !row.type || row.type === 'مبيعات' || row.type === 'شوبيفاي';
  const idsByCode = new Map<string, Set<string>>();
  for (const row of rows.filter(eligible)) for (const item of row.items || []) {
    if (!item) continue;
    const id = text(item.productId), code = text(item.code);
    if (id && code) {
      if (!idsByCode.has(code)) idsByCode.set(code, new Set());
      idsByCode.get(code)!.add(id);
    }
  }
  type Bucket = { code: string; stage: string; orderCount: number; quantity: number };
  const products = new Map<string, { key: string; name: string; code: string; orderCount: number; quantity: number; buckets: Map<string, Bucket> }>();
  const coverage = new Map<string, { code: string; stage: string; orders: number; missingOrders: number; partialOrders: number; excludedOrders: number }>();
  for (const row of rows) {
    const code = row.code || LEGACY_CANCEL_REASON_CODE;
    const stage = row.stage === 'shopify' ? 'shopify' : 'transaction';
    const bucketKey = JSON.stringify([code, stage]);
    if (!coverage.has(bucketKey)) coverage.set(bucketKey, { code, stage, orders: 0, missingOrders: 0, partialOrders: 0, excludedOrders: 0 });
    const covered = coverage.get(bucketKey)!;
    if (!eligible(row)) { covered.excludedOrders++; continue; }
    covered.orders++;
    let invalid = false;
    const orderProducts = new Map<string, { name: string; code: string; quantity: number }>();
    for (const item of row.items || []) {
      if (!item) { invalid = true; continue; }
      const id = text(item.productId), sku = text(item.code), name = text(item.name || item.shopifyName);
      const aliases = idsByCode.get(sku);
      const canonicalId = id || (aliases?.size === 1 ? [...aliases][0] : '');
      const key = canonicalId ? `id:${canonicalId}` : sku ? `sku:${sku}` : name ? `name:${name.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase()}` : '';
      const quantity = Number(item.qty);
      if (!key || !Number.isFinite(quantity) || quantity <= 0) { invalid = true; continue; }
      const entry = orderProducts.get(key) || { name: name || sku || id, code: sku, quantity: 0 };
      entry.quantity += quantity;
      orderProducts.set(key, entry);
    }
    if (!orderProducts.size) covered.missingOrders++;
    else if (invalid) covered.partialOrders++;
    for (const [key, item] of orderProducts) {
      if (!products.has(key)) products.set(key, { key, name: item.name, code: item.code, orderCount: 0, quantity: 0, buckets: new Map() });
      const product = products.get(key)!;
      product.orderCount++;
      product.quantity += item.quantity;
      if (!product.buckets.has(bucketKey)) product.buckets.set(bucketKey, { code, stage, orderCount: 0, quantity: 0 });
      const bucket = product.buckets.get(bucketKey)!;
      bucket.orderCount++;
      bucket.quantity += item.quantity;
    }
  }
  return {
    products: [...products.values()].map(({ buckets, ...product }) => ({ ...product, breakdown: [...buckets.values()] }))
      .sort((a, b) => b.orderCount - a.orderCount || b.quantity - a.quantity || a.key.localeCompare(b.key)),
    productCoverage: [...coverage.values()],
  };
}
