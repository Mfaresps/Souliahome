/**
 * Shopify native bundles (Phase 2). Fixture = the real #3146 payload, trimmed to the fields read:
 * two component lines in group 35343434029, priced at their share of a 3000 bundle (1302.75 + 1697.25).
 */
import { buildBundleSnapshot, bundleParentConflicts, compositionKey, groupInfoFromGraphql, hasBundles, stampBundleItems } from '../../src/shopify/shopify-bundles.util';
import { carryShopifyLineFields } from '../../src/shared/shopify-line.util';
import { itemKey } from '../../src/shopify/shopify-item-merge.util';
import { lineMarkdown } from '../../src/shared/price-offer.util';
import { ShopifyService } from '../../src/shopify/shopify.service';

export {};

const order3146 = () => ({
  id: 7000000003146,
  line_items: [
    { id: 17278319132973, title: 'Boho Charm Basket', variant_title: 'L 40x35', sku: 'Code 10', product_id: 10230230221101, variant_id: 67635072663853,
      quantity: 1, current_quantity: 1, price: '1302.75', discount_allocations: [], sales_line_item_group_id: 35343434029 },
    { id: 17278319165741, title: 'Hearth Blanket Throw', variant_title: null, sku: 'HEARTH-BLANKET-BRN-S-001', product_id: 15403474944301, variant_id: 67626381148461,
      quantity: 1, current_quantity: 1, price: '1697.25', discount_allocations: [], sales_line_item_group_id: 35343434029 },
  ],
  line_item_groups: [{ id: 35343434029, parent_line_item_id: null }],
});
const gqlNodes = [
  { id: 'gid://shopify/LineItem/17278319132973', lineItemGroup: { id: 'gid://shopify/LineItemGroup/35343434029', title: 'blanket with boho basket', quantity: 1,
    productId: 'gid://shopify/Product/999', variantId: 'gid://shopify/ProductVariant/888', variantSku: 'BUNDLE-BOHO' } },
  { id: 'gid://shopify/LineItem/17278319165741', lineItemGroup: { id: 'gid://shopify/LineItemGroup/35343434029', title: 'blanket with boho basket', quantity: 1,
    productId: 'gid://shopify/Product/999', variantId: 'gid://shopify/ProductVariant/888', variantSku: 'BUNDLE-BOHO' } },
];

describe('bundle snapshot', () => {
  it('reads the components and Shopify\'s allocated prices; unverified without GraphQL', () => {
    const s = buildBundleSnapshot(order3146(), null)!;
    expect(hasBundles(order3146())).toBe(true);
    expect(s.verified).toBe(false);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].title).toBeNull();
    expect(s.groups[0].components.map(c => c.unitPrice)).toEqual([1302.75, 1697.25]);
    expect(s.groups[0].allocatedTotal).toBe(3000);
  });
  it('is verified with the bundle name and quantity from GraphQL', () => {
    const s = buildBundleSnapshot(order3146(), groupInfoFromGraphql(gqlNodes))!;
    expect(s.verified).toBe(true);
    expect(s.groups[0]).toMatchObject({ groupId: '35343434029', title: 'blanket with boho basket', quantity: 1, sku: 'BUNDLE-BOHO', variantId: '888' });
  });
  it('a group missing from GraphQL leaves the whole snapshot unverified', () => {
    const s = buildBundleSnapshot(order3146(), groupInfoFromGraphql([]))!;
    expect(s.verified).toBe(false);
    expect(s.reason).toMatch(/35343434029/);
  });
  it('the composition key ignores names but changes with quantity or price', () => {
    const a = buildBundleSnapshot(order3146(), null), b = buildBundleSnapshot(order3146(), groupInfoFromGraphql(gqlNodes));
    expect(compositionKey(a)).toBe(compositionKey(b));
    const o = order3146(); o.line_items[0].current_quantity = 2;
    expect(compositionKey(buildBundleSnapshot(o, null))).not.toBe(compositionKey(a));
  });
  it('a line carrying the bundle\'s own SKU beside its parts is a conflict; native bundles are not', () => {
    const verified = buildBundleSnapshot(order3146(), groupInfoFromGraphql(gqlNodes));
    expect(bundleParentConflicts(order3146(), verified)).toEqual([]);
    const o: any = order3146();
    o.line_items.push({ id: 1, sku: 'BUNDLE-BOHO', quantity: 1, current_quantity: 1, price: '3000.00' });
    expect(bundleParentConflicts(o, verified)).toEqual([{ lineId: '1', sku: 'BUNDLE-BOHO', groupTitle: 'blanket with boho basket' }]);
  });
});

describe('bundleOriginal is set once, only verified, only for the first composition', () => {
  const svc = (gql: any) => {
    const self: any = { shopifyGraphql: gql, logger: { warn: () => {} } };
    return (order: any, raw: any) => (ShopifyService.prototype as any).refreshBundles.call(self, order, raw);
  };
  const doc = () => { const d: any = { ref: '3146', markModified: () => {} }; return d; };
  it('first arrival without GraphQL → current unverified, no original; later verification fills the original', async () => {
    const d = doc();
    await svc(null)(d, order3146());
    expect(d.bundleOriginal).toBeUndefined();
    expect(d.bundleCurrent.verified).toBe(false);
    await svc({ query: async () => ({ order: { lineItems: { nodes: gqlNodes } } }) })(d, order3146());
    expect(d.bundleOriginal.verified).toBe(true);
    expect(d.bundleOriginal.groups[0].title).toBe('blanket with boho basket');
    expect(d.bundleHistory).toHaveLength(2);
  });
  it('a composition changed before verification never becomes the original', async () => {
    const d = doc();
    await svc(null)(d, order3146());
    const changed = order3146(); changed.line_items[0].current_quantity = 2;
    await svc({ query: async () => ({ order: { lineItems: { nodes: gqlNodes } } }) })(d, changed);
    expect(d.bundleOriginal).toBeUndefined();
    expect(d.bundleCurrent.verified).toBe(true);
  });
  it('once set, the original is never overwritten by a later change', async () => {
    const d = doc();
    const gql = { query: async () => ({ order: { lineItems: { nodes: gqlNodes } } }) };
    await svc(gql)(d, order3146());
    const original = JSON.stringify(d.bundleOriginal);
    const changed = order3146(); changed.line_items[1].current_quantity = 3;
    await svc(gql)(d, changed);
    expect(JSON.stringify(d.bundleOriginal)).toBe(original);
    expect(d.bundleCurrent.groups[0].components[1].qty).toBe(3);
  });
  it('a verified, unchanged bundle does not ask Shopify again', async () => {
    const d = doc(); let calls = 0;
    const gql = { query: async () => { calls++; return { order: { lineItems: { nodes: gqlNodes } } }; } };
    await svc(gql)(d, order3146()); await svc(gql)(d, order3146());
    expect(calls).toBe(1);
  });
});

describe('bundle fields survive edits and are never taken from the client', () => {
  const stored = [
    { code: 'Code 10', qty: 1, price: 1302.75, shopifyLineId: '17278319132973', bundleGroupId: '35343434029', priceBasis: 'bundle', shopifyVariantId: '67635072663853' },
    { code: 'HEARTH', qty: 1, price: 1697.25, shopifyLineId: '17278319165741', bundleGroupId: '35343434029', priceBasis: 'bundle' },
  ];
  it('copies the stored fields by Shopify line id', () => {
    const out = carryShopifyLineFields(stored, [{ code: 'Code 10', qty: 2, price: 1302.75, shopifyLineId: '17278319132973' }])!;
    expect(out[0]).toMatchObject({ bundleGroupId: '35343434029', priceBasis: 'bundle', shopifyVariantId: '67635072663853' });
  });
  it('drops bundle fields the client sends on a new line', () => {
    const out = carryShopifyLineFields(stored, [{ code: 'NEW', qty: 1, price: 50, bundleGroupId: 'forged', priceBasis: 'bundle', shopifyLineId: 'forged' } as any])!;
    expect(out[0].bundleGroupId).toBeUndefined();
    expect(out[0].shopifyLineId).toBeUndefined();
  });
  it('keeps a bundle part and the same product bought alone as two lines', () => {
    expect(itemKey({ productId: 'p1', bundleGroupId: 'g1' })).not.toBe(itemKey({ productId: 'p1' }));
  });
  it('reports a bundle part\'s gap to the system price as «bundle», not «shopify»', () => {
    expect(lineMarkdown({ listPrice: 1850, price: 1697.25, qty: 1, priceSource: 'shopify', bundleGroupId: 'g1' })).toEqual({ source: 'bundle', value: 152.75 });
    expect(lineMarkdown({ listPrice: 1850, price: 1697.25, qty: 1, priceSource: 'shopify' })!.source).toBe('shopify');
  });
});

describe('stampBundleItems — lines mapped before bundle support', () => {
  // The real #3146 as stored locally: no shopifyLineId, no bundleGroupId on its lines.
  const oldItems = () => [
    { code: 'Code 10', name: 'Boho Charm Basket L', qty: 1, price: 1302.75 },
    { code: 'HEARTH-BLANKET-BRN-S-001', name: 'Hearth Blanket Throw', qty: 1, price: 1697.25 },
    { code: 'SOLO', name: 'Solo', qty: 1, price: 500 },
  ];
  it('marks both parts by code + qty + price, leaves the ordinary line alone, keeps prices', () => {
    const items: any[] = oldItems();
    expect(stampBundleItems(items, order3146())).toBe(2);
    expect(items.map(i => i.bundleGroupId)).toEqual(['35343434029', '35343434029', undefined]);
    expect(items[0]).toMatchObject({ priceBasis: 'bundle', shopifyLineId: '17278319132973', price: 1302.75, qty: 1 });
  });
  it('a second run marks nothing', () => {
    const items: any[] = oldItems();
    stampBundleItems(items, order3146());
    expect(stampBundleItems(items, order3146())).toBe(0);
  });
  it('matches by Shopify line id first', () => {
    const items: any[] = [{ code: 'X', qty: 1, price: 1, shopifyLineId: '17278319132973' }];
    expect(stampBundleItems(items, order3146())).toBe(1);
    expect(items[0].bundleGroupId).toBe('35343434029');
  });
  it('never guesses: two identical unmarked lines, or a changed price, are left unmarked', () => {
    const twin: any[] = [{ code: 'Code 10', qty: 1, price: 1302.75 }, { code: 'Code 10', qty: 1, price: 1302.75 }];
    stampBundleItems(twin, order3146());
    expect(twin.every(i => !i.bundleGroupId)).toBe(true);
    const edited: any[] = [{ code: 'Code 10', qty: 1, price: 1420 }];
    expect(stampBundleItems(edited, order3146())).toBe(0);
  });
});
