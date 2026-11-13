/**
 * Phase 3 wiring in the REAL ShopifyService code (prepareOrderEdit / approveOrder), with light fakes for the
 * database and the services they call. The rules themselves are covered in bundle-guard.spec.ts.
 */
import { ShopifyService } from '../../src/shopify/shopify.service';

export {};

const parts = () => [
  { productId: 'p1', code: 'Code 10', name: 'Basket', qty: 1, price: 1302.75, total: 1302.75, shopifyLineId: 'a', bundleGroupId: 'g1', priceBasis: 'bundle' },
  { productId: 'p2', code: 'HEARTH', name: 'Blanket', qty: 1, price: 1697.25, total: 1697.25, shopifyLineId: 'b', bundleGroupId: 'g1', priceBasis: 'bundle' },
  { productId: 'p3', code: 'SOLO', name: 'Cushion', qty: 1, price: 500, total: 500 },
];
const order = () => ({
  _id: 'o1', ref: '3146', status: 'pending', cancelled: false, shopifyCreatedAt: '2026-11-01T13:12:05+02:00',
  items: parts(), itemsTotal: 3500, discount: 0, manualDiscount: 0, codesDiscount: 0, shipCost: 0, total: 3500,
  rawData: { current_total_price: '3500.00' },
  bundleOriginal: { verified: true, groups: [{ groupId: 'g1', title: 'blanket with boho basket' }] },
});
function service() {
  const s: any = Object.create(ShopifyService.prototype);
  s.productModel = { find: () => ({ lean: async () => [{ code: 'Code 10', sellPrice: 1420 }, { code: 'HEARTH', sellPrice: 1850 }, { code: 'SOLO', sellPrice: 500 }] }) };
  s.transactionsService = { settleOfferRemovalsOrThrow: (items: any[]) => ({ items, added: [] }) };
  s.settingsService = { getSettings: async () => ({ otpEnabled: false }) };
  s.logger = { warn: () => {}, log: () => {} };
  return s;
}
const staff = { id: 'u1', name: 'Staff', username: 'staff', role: 'staff', perms: [] as string[] };
const errOf = async (p: Promise<any>) => { try { await p; return null; } catch (e: any) { return e?.getResponse?.() || { message: e.message }; } };

describe('Shopify edit window — bundle protection on the server', () => {
  it('removing a bundle part without confirmation is refused with a repricing preview', async () => {
    const e: any = await errOf(service().prepareOrderEdit(order(), { items: [parts()[1], parts()[2]] }, staff));
    expect(e.code).toBe('BUNDLE_BREAK_CONFIRM_REQUIRED');
    expect(e.preview[0].lines[0]).toMatchObject({ code: 'HEARTH', from: 1697.25, to: 1850 });
  });
  it('confirmed: the rest is repriced on the order\'s day, the difference from Shopify is recorded', async () => {
    const { patch, changes } = await service().prepareOrderEdit(order(), { items: [parts()[1], parts()[2]], confirmBundleBreak: true } as any, staff);
    expect(patch.items[0]).toMatchObject({ code: 'HEARTH', price: 1850, brokenFrom: 'g1', priceBasis: 'regular' });
    expect(patch.items[0].bundleGroupId).toBeUndefined();
    expect(patch.total).toBe(2350);
    expect(patch.shopifyDivergence).toMatchObject({ shopifyTotal: 3500, erpTotal: 2350, diff: -1150 });
    expect(changes.join(' ')).toMatch(/كسر الباقة «blanket with boho basket»/);
  });
  it('a bundle part\'s price sent from the browser is refused while the bundle is intact', async () => {
    const items = parts(); items[0].price = 1000;
    const e: any = await errOf(service().prepareOrderEdit(order(), { items }, staff));
    expect(e.code).toBe('BUNDLE_PRICE_LOCKED');
  });
  it('a discount over the non-bundle lines needs the permission and a reason', async () => {
    const disc = { manualDiscount: 600, manualDiscountType: 'fixed', codesDiscount: 0 };
    const e: any = await errOf(service().prepareOrderEdit(order(), { discount: disc }, staff));
    expect(e.code).toBe('BUNDLE_DISCOUNT_BLOCKED');
    expect(e.base).toBe(500);
    const allowed = { ...staff, perms: ['shopify-bundle-discount-override'] };
    const noReason: any = await errOf(service().prepareOrderEdit(order(), { discount: disc }, allowed));
    expect(noReason.code).toBe('BUNDLE_DISCOUNT_BLOCKED');
    const { patch } = await service().prepareOrderEdit(order(), { discount: { ...disc, bundleOverrideReason: 'customer complaint' } } as any, allowed);
    expect(patch.bundleDiscountOverride).toMatchObject({ reason: 'customer complaint', amount: 600, base: 500 });
  });
  it('a discount within the non-bundle lines is accepted as before', async () => {
    const { patch } = await service().prepareOrderEdit(order(), { discount: { manualDiscount: 100, manualDiscountType: 'fixed', codesDiscount: 0 } }, staff);
    expect(patch.manualDiscount).toBe(100);
    expect(patch.bundleDiscountOverride).toBeUndefined();
  });
});

describe('confirming an order whose total differs from Shopify', () => {
  it('needs an explicit acknowledgement', async () => {
    const s = service();
    const o: any = { ...order(), shopifyDivergence: { shopifyTotal: 3500, erpTotal: 2350, diff: -1150 } };
    s.shopifyOrderModel = { findById: async () => o };
    const e: any = await errOf(s.approveOrder('o1', 'Admin', 'bosta', 'u1'));
    expect(e.code).toBe('SHOPIFY_DIVERGENCE_ACK_REQUIRED');
    expect(e.divergence.diff).toBe(-1150);
  });
});
