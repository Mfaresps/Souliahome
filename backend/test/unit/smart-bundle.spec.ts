import { deriveAppliedBundles } from '../../src/shared/smart-bundle.util';

export {};
const bundles = [
  { id: 'b1', name: 'Bow dining offer', productIds: ['pL', 'pS'], discountCodeId: 'c-full', allowPartial: true,
    partialDiscountCodeId: 'c-part', minQty: 6, productMinQtys: { pL: 6, pS: 6 } },
  { id: 'b2', name: 'Vase set', productIds: ['pV'], discountCodeId: 'c-vase' },
];
const codes = [
  { id: 'c-full', code: 'BOWDINING', type: 'fixed', value: 300 },
  { id: 'c-part', code: 'BOWHALF', type: 'percent', value: 5 },
  { id: 'c-vase', code: 'VASE10', type: 'percent', value: 10 },
];
const line = (productId: string, qty: number, price = 100) => ({ productId, qty, price });

describe('deriveAppliedBundles — which smart bundle a sale used', () => {
  it('a full bundle: every product at its minimum and the bundle code applied', () => {
    const r = deriveAppliedBundles([line('pL', 6), line('pS', 6)], 'c-full', bundles, codes, 300);
    expect(r).toEqual([expect.objectContaining({ id: 'b1', kind: 'full', code: 'BOWDINING', discount: 300, productIds: ['pL', 'pS'] })]);
  });

  it('the code alone is not enough — products missing or under the minimum are not attributed', () => {
    expect(deriveAppliedBundles([line('pX', 1)], 'c-full', bundles, codes, 300)).toEqual([]);
    expect(deriveAppliedBundles([line('pL', 6), line('pS', 2)], 'c-full', bundles, codes, 300)).toEqual([]);
  });

  it('the products alone are not enough — the bundle code must be on the invoice', () => {
    expect(deriveAppliedBundles([line('pL', 6), line('pS', 6)], '', bundles, codes, 0)).toEqual([]);
    expect(deriveAppliedBundles([line('pL', 6), line('pS', 6)], 'c-vase', bundles, codes, 0)).toEqual([]);
  });

  it('a partial bundle uses its partial code and is marked partial', () => {
    const r = deriveAppliedBundles([line('pL', 6, 200)], 'c-part', bundles, codes, 1000);
    expect(r).toEqual([expect.objectContaining({ id: 'b1', kind: 'partial', code: 'BOWHALF', discount: 60 })]);
  });

  it('several codes on one invoice credit each bundle; the discount never exceeds the invoice product discount', () => {
    const r = deriveAppliedBundles([line('pL', 6), line('pS', 6), line('pV', 1, 1000)], 'c-full,c-vase', bundles, codes, 250);
    expect(r.map((b) => [b.id, b.discount])).toEqual([['b1', 250], ['b2', 220]]);
  });
});
