/**
 * Editing a confirmed sale follows the Shopify edit window's rules (TransactionsService.saleEditGuards):
 * a discount raised over the lines outside intact bundles needs the exception permission + a reason, and a
 * Shopify sale whose total moves away from what Shopify charged needs an explicit acknowledgement.
 * Real method; only the Shopify order lookup is stubbed.
 */
import { TransactionsService, describeSaleLineChanges } from '../../src/transactions/transactions.service';

export {};

const svc = (shopifyTotal: string | null = '4892.00'): any => {
  const s: any = Object.create(TransactionsService.prototype);
  s.shopifyOrderModel = { findOne: () => ({ select: () => ({ lean: () => ({ exec: async () => (shopifyTotal === null ? null : { rawData: { current_total_price: shopifyTotal } }) }) }) }) };
  return s;
};
const bundle = [
  { lineId: 'sh:1', code: 'Code 05', name: 'XL', qty: 1, price: 1200.58, bundleGroupId: 'g1' },
  { lineId: 'sh:2', code: 'Code 06', name: 'M', qty: 1, price: 1056.85, bundleGroupId: 'g1' },
  { lineId: 'sh:3', code: 'Code 07', name: 'S', qty: 1, price: 642.57, bundleGroupId: 'g1' },
];
const single = { lineId: 'sh:4', code: 'Code 02', name: 'Geo', qty: 1, price: 1872 };
const sale = (extra: any = {}) => ({ type: 'مبيعات', shopifyOrderId: '999', items: [...bundle, single], discount: 0, total: 4892, ...extra });
const opts = (o: any = {}) => ({ oldDiscount: 0, newDiscount: 0, oldTotal: 4892, newTotal: 4892, discountSent: true, acknowledged: false,
  actor: 'Ahmed', role: 'staff', perms: [] as string[], ...o });
const codeOf = async (p: Promise<any>) => { try { await p; return 'ok'; } catch (e: any) { return e.response?.code || e.message; } };

describe('saleEditGuards — bundle discount', () => {
  it('a discount within the lines outside the bundle passes', async () => {
    expect(await svc().saleEditGuards(sale(), [...bundle, single], opts({ newDiscount: 1000, newTotal: 3892, acknowledged: true }))).toMatchObject({});
  });
  it('a discount over them is refused for staff without the permission', async () => {
    expect(await codeOf(svc().saleEditGuards(sale(), [...bundle, single], opts({ newDiscount: 2000, newTotal: 2892, acknowledged: true, reason: 'عميل مميز' }))))
      .toBe('BUNDLE_DISCOUNT_BLOCKED');
  });
  it('allowed with the permission and a reason — recorded', async () => {
    const out = await svc().saleEditGuards(sale(), [...bundle, single],
      opts({ newDiscount: 2000, newTotal: 2892, acknowledged: true, reason: 'عميل مميز', perms: ['shopify-bundle-discount-override'] }));
    expect(out.bundleDiscountOverride).toMatchObject({ reason: 'عميل مميز', amount: 2000, base: 1872, by: 'Ahmed' });
  });
  it('an admin still needs a reason', async () => {
    expect(await codeOf(svc().saleEditGuards(sale(), [...bundle, single], opts({ role: 'admin', newDiscount: 2000, newTotal: 2892, acknowledged: true }))))
      .toBe('BUNDLE_DISCOUNT_BLOCKED');
  });
  it('a discount that only goes down is never blocked', async () => {
    expect(await codeOf(svc().saleEditGuards(sale({ discount: 2500 }), [...bundle, single],
      opts({ oldDiscount: 2500, newDiscount: 2400, oldTotal: 2392, newTotal: 2492, acknowledged: true })))).toBe('ok');
  });
});

describe('saleEditGuards — total differs from Shopify', () => {
  it('asks when the new total moves away from what Shopify charged, with the change lines', async () => {
    let err: any;
    try { await svc().saleEditGuards(sale(), bundle, opts({ newTotal: 3020 })); } catch (e: any) { err = e.response; }
    expect(err.code).toBe('SHOPIFY_DIVERGENCE_ACK_REQUIRED');
    expect(err.divergence).toMatchObject({ shopifyTotal: 4892, erpTotal: 3020, diff: -1872 });
    expect(err.divergence.changes).toContain('حُذف صنف: Geo (كمية 1)');
  });
  it('acknowledged → recorded on the sale', async () => {
    const out = await svc().saleEditGuards(sale(), bundle, opts({ newTotal: 3020, acknowledged: true }));
    expect(out.shopifyDivergence).toMatchObject({ shopifyTotal: 4892, erpTotal: 3020, acknowledgedBy: 'Ahmed' });
  });
  it('an edit that brings the total back to Shopify clears the record', async () => {
    const out = await svc().saleEditGuards(sale({ total: 3020, shopifyDivergence: { shopifyTotal: 4892 } }), [...bundle, single], opts({ oldTotal: 3020, newTotal: 4892 }));
    expect(out.shopifyDivergence).toBeNull();
  });
  it('an edit that does not move the total asks nothing; a non-Shopify sale is never asked', async () => {
    expect(await codeOf(svc().saleEditGuards(sale(), [...bundle, single], opts()))).toBe('ok');
    expect(await codeOf(svc().saleEditGuards(sale({ shopifyOrderId: '' }), bundle, opts({ newTotal: 3020 })))).toBe('ok');
  });
});

describe('describeSaleLineChanges', () => {
  it('names removed, added and changed lines in MSA', () => {
    expect(describeSaleLineChanges([...bundle, single], [{ ...bundle[0], qty: 2 }, bundle[1], bundle[2], { code: 'Code 09', name: 'New', qty: 1, price: 10 }]))
      .toEqual(['كمية XL: 1 ← 2', 'حُذف صنف: Geo (كمية 1)', 'أُضيف صنف: New (كمية 1)']);
  });
});
