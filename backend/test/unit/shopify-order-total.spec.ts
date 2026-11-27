import { confirmedFreeShipping, shopifyOrderMoney } from '../../src/shopify/shopify-order-total.util';

export {};

describe('shopifyOrderMoney — pending Shopify order total + «شحن مجاني»', () => {
  it('off: the old rule exactly (items − min(Shopify + ours, items) + shipping)', () => {
    const m = shopifyOrderMoney({ itemsTotal: 1000, shipCost: 120, discount: 100, manualDiscount: 50, codesDiscount: 20 });
    expect(m.total).toBe(950);
    expect(m.totalDiscount).toBe(170);
    expect(m.room).toBe(900);
    expect(m.concession).toBe(0);
  });

  it('#3266: items fully discounted by Shopify — an extra 120 has no room; free shipping makes it 0', () => {
    const base = { itemsTotal: 2050, shipCost: 120, discount: 2050 };
    expect(shopifyOrderMoney({ ...base, manualDiscount: 120 }).total).toBe(120);
    expect(shopifyOrderMoney(base).room).toBe(0);
    const free = shopifyOrderMoney({ ...base, freeShipping: { amount: 120 } });
    expect(free.total).toBe(0);
    expect(free.shipCharged).toBe(0);
    expect(free.itemDiscount).toBe(2050);
    expect(free.concession).toBe(120);
  });

  it('on: Shopify\'s own shipping part leaves the item cap and is not counted as our concession', () => {
    // Shopify discount 150 = 100 on items + 50 on shipping.
    const m = shopifyOrderMoney({ itemsTotal: 1000, shipCost: 120, discount: 150, shippingDiscount: 50, freeShipping: true });
    expect(m.itemDiscount).toBe(100);
    expect(m.total).toBe(900);
    expect(m.concession).toBe(70);
    expect(m.room).toBe(900);
  });

  it('on: our discount is still capped at the items', () => {
    const m = shopifyOrderMoney({ itemsTotal: 500, shipCost: 80, discount: 0, manualDiscount: 700, freeShipping: true });
    expect(m.total).toBe(0);
    expect(m.itemDiscount).toBe(500);
  });

  it('confirming #3266 with free shipping: shipping charged 0, items discount only, the 120 kept on record', () => {
    const c = confirmedFreeShipping({ itemsTotal: 2050, shipCost: 120, discount: 2050, freeShipping: { amount: 120, by: 'Admin', at: '2026-11-27T20:00:00Z' } });
    expect(c).toEqual({ shipCost: 0, discount: 2050, freeShipping: { amount: 120, by: 'Admin', at: '2026-11-27T20:00:00Z' } });
    // invoice: items − discount + shipping = 0 = the order total
    expect(2050 - c!.discount + c!.shipCost).toBe(shopifyOrderMoney({ itemsTotal: 2050, shipCost: 120, discount: 2050, freeShipping: true }).total);
  });

  it('confirming: Shopify\'s shipping part never becomes a product discount on the invoice', () => {
    const c = confirmedFreeShipping({ itemsTotal: 1000, shipCost: 120, discount: 150, shippingDiscount: 50, manualDiscount: 30, freeShipping: true });
    expect(c!.discount).toBe(130);
    expect(confirmedFreeShipping({ itemsTotal: 1000, shipCost: 120, discount: 150 })).toBeNull();
  });

  it('null / missing free shipping = off', () => {
    expect(shopifyOrderMoney({ itemsTotal: 300, shipCost: 50, freeShipping: null }).total).toBe(350);
    expect(shopifyOrderMoney({ itemsTotal: 300, shipCost: 50 }).freeShipping).toBe(false);
  });
});
