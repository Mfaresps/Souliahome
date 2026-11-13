import { averageAfterCorrection, averageAfterPurchase, averageAt, currentUnitCost, knownUnitCost, purchaseLotsByCode, replayAverage, supplierReturnLots } from '../../src/shared/avg-cost.util';

export {};

describe('avg cost — step 3 (moving weighted average)', () => {
  it('a product with no average yet costs its card price', () => {
    expect(currentUnitCost({ avgCost: null, buyPrice: 300 })).toBe(300);
    expect(currentUnitCost({ buyPrice: 300 })).toBe(300);
  });

  it('an average of 0 is a real value, not "missing"', () => {
    expect(currentUnitCost({ avgCost: 0, buyPrice: 300 })).toBe(0);
  });

  it('weights the new lot by quantity', () => {
    // 10 pcs at 100 + 5 pcs at 130 → 110
    expect(averageAfterPurchase(10, 100, 5, 130)).toBe(110);
  });

  it('zero or negative stock takes the new price exactly', () => {
    expect(averageAfterPurchase(0, 100, 5, 130)).toBe(130);
    expect(averageAfterPurchase(-3, 100, 5, 130)).toBe(130);
  });

  it('spreads the invoice discount over lines by value', () => {
    // lines 2×100 (200) + 1×300 (300) = 500, discount 50 → ratio 0.9
    const lots = purchaseLotsByCode([{ code: 'A', qty: 2, price: 100, total: 200 }, { code: 'B', qty: 1, price: 300, total: 300 }], 50);
    expect(lots.get('A')).toEqual({ qty: 2, unitCost: 90 });
    expect(lots.get('B')).toEqual({ qty: 1, unitCost: 270 });
  });

  it('merges repeated lines of one product into one lot', () => {
    const lots = purchaseLotsByCode([{ code: 'A', qty: 2, price: 100, total: 200 }, { code: 'A', qty: 2, price: 120, total: 240 }], 0);
    expect(lots.get('A')).toEqual({ qty: 4, unitCost: 110 });
  });

  it('a correction before any sale undoes the old lot exactly', () => {
    // stock 10 @100, then +10 @130 → 115. Price corrected to 120 → (10×100 + 10×120)/20 = 110
    const after = averageAfterPurchase(10, 100, 10, 130);
    expect(after).toBe(115);
    expect(averageAfterCorrection(20, after, 10, 130, 10, 120)).toBe(110);
  });

  it('cancelling the lot before any sale returns to the previous average', () => {
    expect(averageAfterCorrection(20, 115, 10, 130, 0, 0)).toBe(100);
  });

  it('never produces a negative average', () => {
    expect(averageAfterCorrection(2, 10, 5, 500, 0, 0)).toBe(10);
  });
});

describe('audit — known cost and supplier returns', () => {
  it('no average and a card price of 0 is unknown, not 0', () => {
    expect(knownUnitCost({ avgCost: null, buyPrice: 0 })).toBeNull();
    expect(knownUnitCost({ avgCost: null, buyPrice: 50 })).toEqual({ cost: 50, basis: 'card' });
    expect(knownUnitCost({ avgCost: 0, buyPrice: 50 })).toEqual({ cost: 0, basis: 'avg' });
  });
  it('a supplier return is valued at its allocated purchase cost', () => {
    const lots = supplierReturnLots([{ code: 'A', qty: 3, price: 999, allocations: [{ qty: 1, unitCost: 100 }, { qty: 2, unitCost: 130 }] }]);
    expect(lots.get('A')).toEqual({ qty: 3, unitCost: 120 });
  });
  it('falls back to the line price without allocations', () => {
    expect(supplierReturnLots([{ code: 'B', qty: 2, price: 40 }]).get('B')).toEqual({ qty: 2, unitCost: 40 });
  });
  it('returning to the supplier at cost then reversing restores the average', () => {
    // 20 @ 115 (10@100 + 10@130); return the 10 @130 → 100; reverse → back to 115
    const afterReturn = averageAfterCorrection(20, 115, 10, 130, 0, 0);
    expect(afterReturn).toBe(100);
    expect(averageAfterPurchase(10, afterReturn, 10, 130)).toBe(115);
  });
});

describe('final audit — editing a purchase after part of it was sold (chronological replay)', () => {
  // 10 pcs @100 in stock. A: +10 @130 → 115. 15 sold (stock 5). B: +5 @120 → 117.5.
  const ev = [
    { kind: 'purchase', txId: 'A', createdAt: '2026-11-01T10:00:00Z', stockBefore: 10, avgBefore: 100, qtyIn: 10, unitCostIn: 130, avgAfter: 115 },
    { kind: 'purchase', txId: 'B', createdAt: '2026-11-05T10:00:00Z', stockBefore: 5, avgBefore: 115, qtyIn: 5, unitCostIn: 120, avgAfter: 117.5 },
  ];
  it('replaying with no change reproduces the recorded averages', () => {
    const r = replayAverage(ev, 'A', { qty: 10, unitCost: 130 })!;
    expect(r.timeline.map((p) => p.avg)).toEqual([115, 117.5]);
    expect(r.finalAvg).toBe(117.5);
  });
  it('a price correction is applied where the invoice was, not at the current stock', () => {
    const r = replayAverage(ev, 'A', { qty: 10, unitCost: 110 })!;
    expect(r.timeline[0].avg).toBe(105);
    expect(r.finalAvg).toBe(112.5);
    // the old approximation (remove at current stock) would give 97.5
    expect(averageAfterCorrection(10, 117.5, 10, 130, 10, 110)).toBe(97.5);
  });
  it('a quantity correction moves the stock recorded at later events', () => {
    const r = replayAverage(ev, 'A', { qty: 8, unitCost: 130 })!;
    expect(r.finalAvg).toBe(117.5); // (3 × 113.3333 + 5 × 120) / 8
    expect(r.timeline[0].avg).toBe(113.3333);
  });
  it('a second edit replays from the latest recorded value, not the original', () => {
    const withEdit = [...ev, { kind: 'purchase-edit', txId: 'A', createdAt: '2026-11-06T10:00:00Z', stockBefore: 10, qtyIn: 10, unitCostIn: 110, avgAfter: 112.5 }];
    expect(replayAverage(withEdit, 'B', { qty: 5, unitCost: 120 })!.finalAvg).toBe(112.5);
  });
  it('sales in between keep their saved cost; the gap is measurable', () => {
    const r = replayAverage(ev, 'A', { qty: 10, unitCost: 110 })!;
    expect(averageAt(r.timeline, new Date('2026-11-03T00:00:00Z'))).toBe(105); // a sale saved at 115 → variance −10 / pc
    expect(averageAt(r.timeline, new Date('2026-10-01T00:00:00Z'))).toBeNull();
  });
  it('supplier returns and manual revalues are replayed too', () => {
    const more = [...ev,
      { kind: 'supplier-return', txId: 'R', createdAt: '2026-11-07T10:00:00Z', stockBefore: 10, oldQty: 5, oldUnitCost: 120 },
      { kind: 'revalue', createdAt: '2026-11-08T10:00:00Z', avgAfter: 99 }];
    const r = replayAverage(more, 'A', { qty: 10, unitCost: 110 })!;
    expect(r.timeline[2].avg).toBe(105);   // (10×112.5 − 5×120) / 5
    expect(r.finalAvg).toBe(99);
  });
  it('an invoice outside the average cannot be replayed', () => {
    expect(replayAverage(ev, 'OLD', { qty: 1, unitCost: 1 })).toBeNull();
  });
});
