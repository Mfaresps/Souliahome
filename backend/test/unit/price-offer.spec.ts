import { activeOffer, carryLinePrices, effectiveSellPrice, lineMarkdown, offersOverlap, stampSaleLinePrices } from '../../src/shared/price-offer.util';
import { invoiceDiscount, invoiceDiscountRatio, invoiceNetSales } from '../../src/shared/sale-discount.util';

export {};

const offer = { id: 'o1', price: 800, from: '2026-11-10', to: '2026-11-20' };
const product = { code: 'A', sellPrice: 1000, priceOffers: [offer] };

describe('price offers — a temporary price for a period', () => {
  it('applies inside the period only, both ends included', () => {
    expect(effectiveSellPrice(product, '2026-11-09').price).toBe(1000);
    expect(effectiveSellPrice(product, '2026-11-10').price).toBe(800);
    expect(effectiveSellPrice(product, '2026-11-20').price).toBe(800);
    expect(effectiveSellPrice(product, '2026-11-21').price).toBe(1000);
  });
  it('a raised base price does not end a running offer; it applies after it', () => {
    const raised = { ...product, sellPrice: 1100 };
    expect(effectiveSellPrice(raised, '2026-11-15')).toMatchObject({ price: 800, listPrice: 1100 });
    expect(effectiveSellPrice(raised, '2026-11-21').price).toBe(1100);
  });
  it('a cancelled offer never applies', () => {
    expect(activeOffer({ priceOffers: [{ ...offer, cancelled: true }] }, '2026-11-15')).toBeNull();
  });
  it('detects overlapping periods', () => {
    expect(offersOverlap(offer, { from: '2026-11-20', to: '2026-11-25' })).toBe(true);
    expect(offersOverlap(offer, { from: '2026-11-21', to: '2026-11-25' })).toBe(false);
  });
});

describe('sale lines record where their price came from', () => {
  const productOf = (code: string) => (code === 'A' ? product : null);
  it('offer price inside the period → source offer, base price kept', () => {
    const [l] = stampSaleLinePrices([{ code: 'A', qty: 2, price: 800, total: 1600 }], productOf, '2026-11-15')!;
    expect(l).toMatchObject({ listPrice: 1000, priceSource: 'offer', offerId: 'o1' });
    expect(lineMarkdown(l)).toEqual({ source: 'offer', value: 400 });
  });
  it('base price → list; anything else → manual', () => {
    expect(stampSaleLinePrices([{ code: 'A', qty: 1, price: 1000 }], productOf, '2026-11-25')![0].priceSource).toBe('list');
    expect(stampSaleLinePrices([{ code: 'A', qty: 1, price: 950 }], productOf, '2026-11-25')![0].priceSource).toBe('manual');
    // the offer price outside its period is a manual price, not the offer
    expect(stampSaleLinePrices([{ code: 'A', qty: 1, price: 800 }], productOf, '2026-11-25')![0].priceSource).toBe('manual');
  });
  it('never trusts a source sent by the client', () => {
    const [l] = stampSaleLinePrices([{ code: 'A', qty: 1, price: 950, priceSource: 'offer', listPrice: 5 }], productOf, '2026-11-25')!;
    expect(l).toMatchObject({ priceSource: 'manual', listPrice: 1000 });
  });
  it('Shopify lines keep the system price they were imported against', () => {
    const [l] = stampSaleLinePrices([{ code: 'A', qty: 1, price: 800, listPrice: 1000 }], () => ({ sellPrice: 1200 }), '2026-11-25', 'shopify')!;
    expect(l).toMatchObject({ priceSource: 'shopify', listPrice: 1000 });
  });
  it('an invoice edit keeps the source while the price is unchanged, and calls a changed price manual', () => {
    const stored = [{ lineId: 'l1', code: 'A', qty: 1, price: 800, listPrice: 1000, priceSource: 'offer', offerId: 'o1' }];
    expect(carryLinePrices(stored, [{ lineId: 'l1', code: 'A', qty: 3, price: 800 }])![0]).toMatchObject({ priceSource: 'offer', offerId: 'o1' });
    expect(carryLinePrices(stored, [{ lineId: 'l1', code: 'A', qty: 1, price: 750 }])![0]).toMatchObject({ priceSource: 'manual', listPrice: 1000 });
  });
});

describe('invoice discount — sales and profit are after it', () => {
  it('uses the stored discount', () => {
    const tx = { itemsTotal: 1000, discount: 100, total: 950, shipCost: 50 };
    expect(invoiceDiscount(tx)).toBe(100);
    expect(invoiceDiscountRatio(tx)).toBe(0.1);
    expect(invoiceNetSales(tx)).toBe(900);
  });
  it('infers it from the totals on old rows', () => {
    expect(invoiceDiscount({ itemsTotal: 1000, total: 930, shipCost: 30 })).toBe(100);
  });
  it('never exceeds the goods value', () => {
    expect(invoiceDiscount({ itemsTotal: 100, discount: 500, total: 0 })).toBe(100);
  });
});
