// «شيل العرض من السطر ده» — shared/price-offer.util.ts → settleOfferRemovals.
import { OfferRemovalError, settleOfferRemovals, stampSaleLinePrices } from '../../src/shared/price-offer.util';

export {};

const offer = { id: 'o1', price: 800, from: '2026-11-10', to: '2026-11-20', reason: 'Limited-time offer' };
const product = { code: 'A', sellPrice: 1000, priceOffers: [offer] };
const productOf = (line: any) => (line?.code === 'A' ? product : null);
const ctx = (allowed: boolean) => ({ actor: 'Fares', allowed, productOf, now: '2026-11-13T10:00:00.000Z' });
const removal = { offerId: 'o1', offerName: 'x', reason: 'العميل مش مستحق', by: 'forged', at: 'forged' };

describe('settleOfferRemovals', () => {
  it('a new removal on a line back at the base price is stamped by the server (by/at from the session)', () => {
    const lines = stampSaleLinePrices([{ code: 'A', qty: 1, price: 1000, offerRemoved: removal }], () => product, '2026-11-13');
    const { items, added } = settleOfferRemovals(lines, [], ctx(true));
    expect(items![0].offerRemoved).toEqual({ offerId: 'o1', offerName: 'Limited-time offer', reason: 'العميل مش مستحق', by: 'Fares', at: '2026-11-13T10:00:00.000Z' });
    expect(items![0].priceSource).toBe('list');
    expect(items![0].offerId).toBeUndefined();
    expect(added).toHaveLength(1);
  });

  it('refuses a new removal without promotions-offers', () => {
    expect(() => settleOfferRemovals([{ code: 'A', price: 1000, offerRemoved: removal }], [], ctx(false)))
      .toThrow(OfferRemovalError);
  });

  it('a removal already stored passes any later edit unchanged, perm or not', () => {
    const stored = [{ code: 'A', price: 1000, offerRemoved: { offerId: 'o1', offerName: 'Limited-time offer', reason: 'r1', by: 'Fares', at: 'T1' } }];
    const { items, added } = settleOfferRemovals([{ code: 'A', price: 1000, qty: 2, offerRemoved: { ...stored[0].offerRemoved } }], stored, ctx(false));
    expect(items![0].offerRemoved).toEqual(stored[0].offerRemoved);
    expect(added).toHaveLength(0);
  });

  it('a stored removal whose reason was changed by the client counts as new (needs the perm)', () => {
    const stored = [{ code: 'A', price: 1000, offerRemoved: { offerId: 'o1', offerName: 'Limited-time offer', reason: 'r1', by: 'Fares', at: 'T1' } }];
    expect(() => settleOfferRemovals([{ code: 'A', price: 1000, offerRemoved: { ...stored[0].offerRemoved, reason: 'other' } }], stored, ctx(false)))
      .toThrow('صلاحية');
  });

  it('a line at the offer price cannot also claim the offer was removed', () => {
    const { items } = settleOfferRemovals([{ code: 'A', price: 800, offerRemoved: removal }], [], ctx(true));
    expect(items![0].offerRemoved).toBeUndefined();
  });

  it('an unknown offer and a missing reason are refused', () => {
    expect(() => settleOfferRemovals([{ code: 'A', price: 1000, offerRemoved: { ...removal, offerId: 'nope' } }], [], ctx(true))).toThrow('غير موجود');
    expect(() => settleOfferRemovals([{ code: 'A', price: 1000, offerRemoved: { ...removal, reason: '' } }], [], ctx(true))).toThrow('سبب');
  });

  it('dropping the removal (offer re-applied) needs no perm', () => {
    const stored = [{ code: 'A', price: 1000, offerRemoved: { offerId: 'o1', reason: 'r1', by: 'F', at: 'T' } }];
    const { items } = settleOfferRemovals<any>([{ code: "A", price: 800 }], stored, ctx(false));
    expect(items![0].offerRemoved).toBeUndefined();
  });
});
