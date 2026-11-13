/**
 * Bundle protection on edits (Phase 3) — shared/bundle-guard.util.ts, the one rule behind the Shopify edit
 * window and the confirmed-invoice edit. Data shaped like #3146 (1302.75 + 1697.25 = 3000).
 */
import { BundleGuardError, bundleGuard, nonBundleSubtotal } from '../../src/shared/bundle-guard.util';

export {};

const basket = { code: 'Code 10', name: 'Basket', qty: 1, price: 1302.75, shopifyLineId: 'a', bundleGroupId: 'g1', priceBasis: 'bundle' };
const blanket = { code: 'HEARTH', name: 'Blanket', qty: 1, price: 1697.25, shopifyLineId: 'b', bundleGroupId: 'g1', priceBasis: 'bundle' };
const stored = [basket, blanket];
const products: any = {
  'Code 10': { sellPrice: 1420 },
  HEARTH: { sellPrice: 1850, priceOffers: [{ id: 'o1', price: 1000, from: '2026-11-12', to: '2026-11-19', reason: 'black friday' }] },
};
const run = (incoming: any[], o: Partial<{ day: string; delivered: boolean; confirmBreak: boolean }> = {}) => bundleGuard({
  stored, incoming, day: o.day || '2026-11-01', delivered: !!o.delivered, confirmBreak: !!o.confirmBreak,
  titleOf: () => 'blanket with boho basket', productOf: (l) => products[l.code] || null,
});
const code = (f: () => any) => { try { f(); return 'none'; } catch (e) { return e instanceof BundleGuardError ? e.code : 'other:' + (e as Error).message; } };

describe('bundle guard', () => {
  it('an untouched bundle passes unchanged', () => {
    const r = run([{ ...basket }, { ...blanket }]);
    expect(r.broken).toEqual([]);
    expect(r.items[0].price).toBe(1302.75);
  });
  it('a bundle part\'s price is locked', () => {
    expect(code(() => run([{ ...basket, price: 1000 }, { ...blanket }]))).toBe('BUNDLE_PRICE_LOCKED');
  });
  it('a bundle part\'s quantity never grows at the bundle price', () => {
    expect(code(() => run([{ ...basket, qty: 2 }, { ...blanket }]))).toBe('BUNDLE_QTY_LOCKED');
  });
  it('the same product as a separate line is allowed at its own price', () => {
    const r = run([{ ...basket }, { ...blanket }, { code: 'HEARTH', name: 'Blanket', qty: 1, price: 1850 }]);
    expect(r.items).toHaveLength(3);
    expect(r.broken).toEqual([]);
  });
  it('removing a part needs confirmation, with the repricing preview', () => {
    try { run([{ ...blanket }]); throw new Error('no error'); } catch (e: any) {
      expect(e.code).toBe('BUNDLE_BREAK_CONFIRM_REQUIRED');
      expect(e.preview[0]).toMatchObject({ groupId: 'g1', title: 'blanket with boho basket', lines: [{ code: 'HEARTH', from: 1697.25, to: 1850 }], addedToCustomer: 152.75 });
    }
  });
  it('confirmed: the rest is repriced at its standalone price on the ORDER\'s day, and leaves the bundle', () => {
    const r = run([{ ...blanket }], { confirmBreak: true });
    expect(r.items[0]).toMatchObject({ code: 'HEARTH', price: 1850, total: 1850, priceBasis: 'regular', brokenFrom: 'g1' });
    expect(r.items[0].bundleGroupId).toBeUndefined();
  });
  it('an offer running on the order\'s day is that day\'s standalone price', () => {
    const r = run([{ ...blanket }], { confirmBreak: true, day: '2026-11-13' });
    expect(r.items[0].price).toBe(1000);
  });
  it('a price sent for a part of a broken bundle is ignored — the server decides it', () => {
    const r = run([{ ...blanket, price: 1 }], { confirmBreak: true });
    expect(r.items[0].price).toBe(1850);
  });
  it('reducing a part\'s quantity also breaks the bundle', () => {
    const two = [{ ...basket, qty: 2 }, { ...blanket, qty: 2 }];
    const r = bundleGuard({ stored: two, incoming: [{ ...basket, qty: 1 }, { ...blanket, qty: 2 }], day: '2026-11-01', delivered: false,
      confirmBreak: true, productOf: (l) => products[l.code] || null });
    expect(r.broken).toHaveLength(1);
    expect(r.items.map((i: any) => i.price)).toEqual([1420, 1850]);
  });
  it('after delivery the composition cannot change', () => {
    expect(code(() => run([{ ...blanket }], { delivered: true, confirmBreak: true }))).toBe('BUNDLE_LOCKED_AFTER_DELIVERY');
  });
  it('a part matching no product cannot be repriced — refused, never guessed', () => {
    const r = () => bundleGuard({ stored, incoming: [{ ...blanket }], day: '2026-11-01', delivered: false, confirmBreak: true, productOf: () => null });
    expect(code(r)).toBe('BUNDLE_PRICE_UNKNOWN');
  });
  it('codes and extra discounts are based on the lines outside the bundle', () => {
    expect(nonBundleSubtotal([basket, blanket, { code: 'X', qty: 2, price: 250 }])).toBe(500);
  });
});
