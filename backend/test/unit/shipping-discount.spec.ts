/**
 * Shipping-discount classification (Phase 1, Nov 13, 2026).
 * The rule: `discount` keeps holding the whole invoice discount (totals, vault, Bosta unchanged);
 * `shippingDiscount` is the part applied to shipping. Product revenue rises by it, a separate
 * shipping subsidy takes it back, and gross profit is identical to the pre-split formula.
 */
import {
  invoiceDiscount, invoiceDiscountRatio, invoiceNetSales, invoiceShipCharged, invoiceShippingDiscount, invoiceShippingSubsidyRatio,
} from '../../src/shared/sale-discount.util';
import { clampShippingDiscount, shopifyShippingDiscount, shopifyShippingDiscountCodes } from '../../src/shopify/shopify-discounts.util';
import { buildCorrectionPlan } from '../../src/transactions/shipping-discount-correction';
import { shippingBreakdown } from '../../src/transactions/shipping-breakdown.util';

export {};

/** Gross profit exactly as getReports computes it (revenue part; cost is identical on both sides). */
function grossRevenue(tx: any): number {
  const keep = 1 - invoiceDiscountRatio(tx) - invoiceShippingSubsidyRatio(tx);
  return (tx.items || []).reduce((s: number, i: any) => s + i.price * keep * i.qty, 0);
}
const sale = (o: any) => ({ items: [{ code: 'A', price: o.itemsTotal, qty: 1, total: o.itemsTotal }], ...o });

// The real #3146 payload (trimmed to the fields read): automatic Free Shipping on the shipping line.
const order3146 = {
  total_discounts: '120.00',
  discount_applications: [{ type: 'automatic', target_type: 'shipping_line', title: 'Free Shipping', value: '100.0', value_type: 'percentage' }],
  shipping_lines: [{ title: 'Cairo', price: '120.00', discount_allocations: [{ amount: '120.00', discount_application_index: 0 }] }],
};

describe('Shopify payload → shipping discount', () => {
  it('reads the real #3146 free shipping as 120, not from a code', () => {
    expect(shopifyShippingDiscount(order3146)).toBe(120);
    expect(shopifyShippingDiscountCodes(order3146)).toEqual([]);
  });
  it('names the code when a code discounted the shipping', () => {
    const o = { discount_applications: [{ type: 'discount_code', code: 'FREESHIP', target_type: 'shipping_line' }],
      shipping_lines: [{ price: '80', discount_allocations: [{ amount: '80', discount_application_index: 0 }] }] };
    expect(shopifyShippingDiscountCodes(o)).toEqual(['FREESHIP']);
  });
  it('is 0 with no shipping line or no allocation, and sums several lines', () => {
    expect(shopifyShippingDiscount({})).toBe(0);
    expect(shopifyShippingDiscount({ shipping_lines: [{ price: '120', discount_allocations: [] }] })).toBe(0);
    expect(shopifyShippingDiscount({ shipping_lines: [{ discount_allocations: [{ amount: '30' }] }, { discount_allocations: [{ amount: '20.5' }] }] })).toBe(50.5);
  });
  it('is clamped by the shipping and by the stored discount', () => {
    expect(clampShippingDiscount(200, 120, 500)).toBe(120);
    expect(clampShippingDiscount(120, 120, 80)).toBe(80);
    expect(clampShippingDiscount(-5, 120, 80)).toBe(0);
  });
});

describe('invoice rule with shippingDiscount', () => {
  it('full free shipping: no product discount, shipping charged 0, totals untouched', () => {
    const tx = sale({ itemsTotal: 2470, discount: 120, shipCost: 120, total: 2470, shippingDiscount: 120 });
    expect(invoiceDiscount(tx)).toBe(0);
    expect(invoiceShipCharged(tx)).toBe(0);
    expect(invoiceNetSales(tx)).toBe(2470);
    expect(invoiceShippingDiscount(tx)).toBe(120);
    expect(invoiceNetSales(tx) + invoiceShipCharged(tx)).toBe(tx.total);
  });
  it('a row without the field reads exactly as before', () => {
    const tx = sale({ itemsTotal: 2470, discount: 120, shipCost: 120, total: 2470 });
    expect(invoiceDiscount(tx)).toBe(120);
    expect(invoiceShipCharged(tx)).toBe(120);
    expect(invoiceShippingSubsidyRatio(tx)).toBe(0);
  });
  it('product discount + shipping discount split', () => {
    const tx = sale({ itemsTotal: 1000, discount: 220, shipCost: 120, total: 900, shippingDiscount: 120 });
    expect(invoiceDiscount(tx)).toBe(100);
    expect(invoiceShipCharged(tx)).toBe(0);
  });
  it('partial shipping discount', () => {
    const tx = sale({ itemsTotal: 1000, discount: 50, shipCost: 120, total: 1070, shippingDiscount: 50 });
    expect(invoiceDiscount(tx)).toBe(0);
    expect(invoiceShipCharged(tx)).toBe(70);
  });
  it('a manual discount on top stays a product discount', () => {
    const tx = sale({ itemsTotal: 1000, discount: 170, shipCost: 120, total: 950, shippingDiscount: 120 });
    expect(invoiceDiscount(tx)).toBe(50);
  });
  it('legacy row with no stored discount still infers from the totals', () => {
    const tx = sale({ itemsTotal: 1000, discount: 0, shipCost: 50, total: 950 });
    expect(invoiceDiscount(tx)).toBe(100);
  });
  it('an over-large stored shippingDiscount is clamped', () => {
    const tx = sale({ itemsTotal: 1000, discount: 120, shipCost: 100, total: 980, shippingDiscount: 500 });
    expect(invoiceShippingDiscount(tx)).toBe(100);
    expect(invoiceDiscount(tx)).toBe(20);
  });
  it('gross profit is identical with and without the classification', () => {
    const cases = [
      { itemsTotal: 2470, discount: 120, shipCost: 120, total: 2470, sd: 120 },
      { itemsTotal: 1000, discount: 220, shipCost: 120, total: 900, sd: 120 },
      { itemsTotal: 3000, discount: 50, shipCost: 120, total: 3070, sd: 50 },
      { itemsTotal: 1555.5, discount: 205.25, shipCost: 85, total: 1435.25, sd: 85 },
    ];
    for (const c of cases) {
      const items = [{ code: 'A', price: c.itemsTotal * 0.4, qty: 1 }, { code: 'B', price: c.itemsTotal * 0.3, qty: 2 }];
      const before = grossRevenue({ ...c, items });
      const after = grossRevenue({ ...c, items, shippingDiscount: c.sd });
      expect(Math.abs(before - after)).toBeLessThan(1e-9);
    }
  });
});

describe('shipping breakdown', () => {
  it('collected, subsidy and the known carrier cost are separate', () => {
    const b = shippingBreakdown([
      sale({ itemsTotal: 2470, discount: 120, shipCost: 120, total: 2470, shippingDiscount: 120, actualShipCost: 114 }),
      sale({ itemsTotal: 1000, discount: 0, shipCost: 80, total: 1080 }),
      sale({ itemsTotal: 500, discount: 0, shipCost: 80, total: 580, failedDelivery: { returnShipCost: 40 } }),
    ]);
    expect(b.shippingCollected).toBe(160);
    expect(b.shippingSubsidy).toBe(120);
    expect(b.shippingSubsidyOrders).toBe(1);
    expect(b.actualCarrierCost).toEqual({ amount: 154, known: 1, of: 3, returnLegFees: 40 });
  });
});

describe('historical correction plan', () => {
  const order = (id: string, sd: number) => ({ _id: 'o' + id, shopifyId: id, ref: id, status: 'approved', shipCost: 120, discount: 120,
    rawData: { shipping_lines: [{ price: '120', discount_allocations: sd ? [{ amount: String(sd) }] : [] }] } });
  const tx = (id: string, o: any = {}) => ({ _id: 't' + id, ref: id, date: '2026-10-05', shopifyOrderId: id, client: 'C',
    discount: 120, shipCost: 120, itemsTotal: 2470, total: 2470, remaining: 0, deposit: 2470,
    items: [{ code: 'A', price: 2470, qty: 1, total: 2470, unitCost: 1000, costSource: 'sale-snapshot' }], ...o });
  const input = {
    sales: [tx('1'), tx('2', { cancelled: true }), tx('3', { cancelled: true }), tx('4', { shippingDiscount: 120, shippingDiscountSource: 'order' }), tx('5'), tx('6')],
    orders: [order('1', 120), order('2', 120), order('3', 120), order('4', 120), order('5', 0)],
    products: [{ code: 'A', buyPrice: 900 }],
    vault: [
      { ref: '2', amount: 500, source: 'عربون' },                     // cancelled with a deposit never refunded
      { ref: '3', amount: 500, source: 'عربون' }, { ref: '3', amount: -500, source: 'إلغاء' },  // fully reversed
    ],
  };
  const plan = buildCorrectionPlan(input as any, 'scratch');

  it('lists only active sales with free shipping, and gross profit is unchanged', () => {
    expect(plan.affected.map(r => r.ref)).toEqual(['1']);
    const r = plan.affected[0];
    expect(r.shippingDiscount).toBe(120);
    expect(r.before.netProductSales).toBe(2350);
    expect(r.after.netProductSales).toBe(2470);
    expect(r.after.shippingCharged).toBe(0);
    expect(r.after.shippingSubsidy).toBe(120);
    expect(r.after.grossProfit).toBe(r.before.grossProfit);
    expect(plan.checks.every(c => c.pass)).toBe(true);
  });
  it('a cancelled sale with an unreversed vault posting goes to review; a reversed one is skipped', () => {
    expect(plan.cancelledReview.map(r => r.ref)).toEqual(['2']);
    expect(plan.cancelledReview[0].vaultNet).toBe(500);
    expect(plan.skipped.find(s => s.ref === '3')?.reason).toBe('cancelled-fully-reversed');
  });
  it('skips already-classified sales and sales with no Shopify payload', () => {
    expect(plan.skipped.find(s => s.ref === '4')?.reason).toBe('already-classified');
    expect(plan.skipped.find(s => s.ref === '6')?.reason).toBe('no-shopify-payload');
    expect(plan.affected.find(r => r.ref === '5')).toBeUndefined();   // no free shipping
  });
  it('monthly totals equal the rows', () => {
    expect(plan.months).toHaveLength(1);
    expect(plan.months[0].after.shippingSubsidy).toBe(120);
    expect(plan.months[0].grossProfitEqual).toBe(true);
  });
});
