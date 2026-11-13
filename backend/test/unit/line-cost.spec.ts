import { carryLineCosts, freezeLineCost, frozenUnitCost, lineCostSourceKey, lineUnitCost, returnLineCost, stampMissingSaleLineCosts, stampSaleLineCosts } from '../../src/shared/line-cost.util';

export {};

const AT = '2026-11-12T00:00:00.000Z';

describe('line cost — step 1 (freeze legacy sale costs)', () => {
  it('an unfrozen line keeps using the live card price, exactly as before', () => {
    expect(lineUnitCost({ code: 'A', qty: 1, price: 700 }, 300)).toBe(300);
    expect(lineUnitCost({ code: 'A', qty: 1, price: 700 }, null)).toBe(0);
  });

  it('a frozen line ignores a later card price change', () => {
    const frozen = freezeLineCost({ code: 'A', qty: 2, price: 700 }, 300, AT);
    expect(frozen).toMatchObject({ unitCost: 300, costSource: 'legacy-frozen', costAt: AT });
    expect(lineUnitCost(frozen, 150)).toBe(300);
  });

  it('a card price of 0 is a missing cost and is not frozen as 0 (audit)', () => {
    expect(freezeLineCost({ code: 'GIFT', qty: 1, price: 0 }, 0, AT)).toBeNull();
  });

  it('a stored cost of 0 is still a real value once frozen', () => {
    const line = { code: 'GIFT', unitCost: 0, costSource: 'sale-snapshot' };
    expect(frozenUnitCost(line)).toBe(0);
    expect(lineUnitCost(line, 999)).toBe(0);
  });

  it('freezing is idempotent and never re-freezes at a newer price', () => {
    const once = freezeLineCost({ code: 'A', qty: 1, price: 700 }, 300, AT);
    expect(freezeLineCost(once, 150, AT)).toBeNull();
  });

  it('a line whose product is missing is left unfrozen', () => {
    expect(freezeLineCost({ code: 'GONE', qty: 1, price: 50 }, null, AT)).toBeNull();
  });

  it('an unknown costSource is not trusted', () => {
    expect(lineUnitCost({ code: 'A', unitCost: 1, costSource: 'client' }, 300)).toBe(300);
  });
});

describe('carryLineCosts — an invoice edit must not wipe the frozen cost', () => {
  const stored = [
    { lineId: 'l1', code: 'A', qty: 1, price: 700, unitCost: 300, costSource: 'legacy-frozen', costAt: AT },
    { lineId: 'l2', code: 'B', qty: 2, price: 100, unitCost: 40, costSource: 'legacy-frozen', costAt: AT },
  ];

  it('matches by lineId and keeps the cost', () => {
    const next = carryLineCosts(stored, [{ lineId: 'l1', code: 'A', qty: 1, price: 650 }])!;
    expect(next[0]).toMatchObject({ unitCost: 300, costSource: 'legacy-frozen', price: 650 });
  });

  it('falls back to a unique code when lineId was stripped (Shopify edit)', () => {
    const next = carryLineCosts(stored, [{ code: 'B', qty: 3, price: 100 }])!;
    expect(next[0]).toMatchObject({ unitCost: 40, costSource: 'legacy-frozen' });
  });

  it('a brand-new line gets no cost and uses the live price', () => {
    const next = carryLineCosts(stored, [{ code: 'C', qty: 1, price: 10 }])!;
    expect(next[0].unitCost).toBeUndefined();
    expect(next[0].costSource).toBeUndefined();
  });

  it('never trusts a cost sent by the client', () => {
    const next = carryLineCosts([], [{ code: 'C', qty: 1, price: 10, unitCost: 1, costSource: 'legacy-frozen' }])!;
    expect(next[0].unitCost).toBeUndefined();
  });

  it('does not borrow a cost when the code repeats on several lines', () => {
    const dup = [...stored, { lineId: 'l3', code: 'B', qty: 1, price: 90, unitCost: 55, costSource: 'legacy-frozen', costAt: AT }];
    const next = carryLineCosts(dup, [{ code: 'B', qty: 1, price: 90 }])!;
    expect(next[0].unitCost).toBeUndefined();
  });

  it('a lineId pointing at another product does not carry its cost', () => {
    const next = carryLineCosts(stored, [{ lineId: 'l1', code: 'Z', qty: 1, price: 5 }])!;
    expect(next[0].unitCost).toBeUndefined();
  });
});

describe('step 2 — new sales save their cost', () => {
  const costs: Record<string, number> = { A: 300, B: 40, FREE: 0 };
  const costOf = (code: string) => (code in costs ? costs[code] : null);

  it('stamps each line with the current cost at creation', () => {
    const [a, b] = stampSaleLineCosts([{ code: 'A', qty: 1, price: 700 }, { code: 'B', qty: 2, price: 100 }], costOf, AT)!;
    expect(a).toMatchObject({ unitCost: 300, costSource: 'sale-snapshot', costAt: AT });
    expect(lineUnitCost(a, 150)).toBe(300);
    expect(b.unitCost).toBe(40);
  });

  it('discards a cost sent with the request', () => {
    const [a] = stampSaleLineCosts([{ code: 'A', qty: 1, price: 700, unitCost: 1, costSource: 'legacy-frozen' }], costOf, AT)!;
    expect(a.unitCost).toBe(300);
    expect(a.costSource).toBe('sale-snapshot');
  });

  it('a configured cost of 0 is stamped as 0', () => {
    expect(stampSaleLineCosts([{ code: 'FREE', qty: 1, price: 0 }], costOf, AT)![0].unitCost).toBe(0);
  });

  it('an unknown product is left unstamped (live fallback, as today)', () => {
    const [x] = stampSaleLineCosts([{ code: 'NOPE', qty: 1, price: 5, unitCost: 9, costSource: 'sale-snapshot' }], costOf, AT)!;
    expect(x.unitCost).toBeUndefined();
    expect(x.costSource).toBeUndefined();
  });

  it('on edit: carried lines keep their cost, only new lines are stamped', () => {
    const stored = [{ lineId: 'l1', code: 'A', qty: 1, price: 700, unitCost: 250, costSource: 'sale-snapshot', costAt: AT }];
    const carried = carryLineCosts(stored, [{ lineId: 'l1', code: 'A', qty: 1, price: 700 }, { code: 'B', qty: 1, price: 100 }]);
    const [a, b] = stampMissingSaleLineCosts(carried, costOf, 'later')!;
    expect(a).toMatchObject({ unitCost: 250, costAt: AT });
    expect(b).toMatchObject({ unitCost: 40, costSource: 'sale-snapshot', costAt: 'later' });
  });
});

describe('returns take the original sale line cost', () => {
  it('uses the frozen cost of the original line, not today\'s price', () => {
    expect(returnLineCost({ code: 'A', unitCost: 250, costSource: 'sale-snapshot' }, 999, AT))
      .toEqual({ unitCost: 250, costSource: 'return-original', costAt: AT });
  });
  it('falls back to the live cost for an original line that was never frozen', () => {
    expect(returnLineCost({ code: 'A' }, 300, AT)).toMatchObject({ unitCost: 300 });
  });
  it('adds nothing when neither is known', () => {
    expect(returnLineCost(undefined, null, AT)).toEqual({});
  });
});

describe('audit — cost basis and cost-source classification', () => {
  it('records the basis when the cost comes with one', () => {
    const [a] = stampSaleLineCosts([{ code: 'A', qty: 1, price: 10 }], () => ({ cost: 7, basis: 'avg' }), AT)!;
    expect(a).toMatchObject({ unitCost: 7, costSource: 'sale-snapshot', costBasis: 'avg' });
  });
  it('an unknown cost (null) leaves the line unstamped, never 0', () => {
    const [a] = stampSaleLineCosts([{ code: 'A', qty: 1, price: 10 }], () => null, AT)!;
    expect(a.unitCost).toBeUndefined();
  });
  it('classifies every source', () => {
    expect(lineCostSourceKey({ unitCost: 5, costSource: 'legacy-frozen' }, 9)).toBe('frozen-history');
    expect(lineCostSourceKey({ unitCost: 5, costSource: 'sale-snapshot', costBasis: 'avg' }, 9)).toBe('sale-avg');
    expect(lineCostSourceKey({ unitCost: 5, costSource: 'sale-snapshot', costBasis: 'card' }, 9)).toBe('sale-card');
    expect(lineCostSourceKey({ unitCost: 5, costSource: 'sale-snapshot' }, 9)).toBe('sale-card');
    expect(lineCostSourceKey({ code: 'A' }, 9)).toBe('live-card');
    expect(lineCostSourceKey({ code: 'A' }, 0)).toBe('missing');
    expect(lineCostSourceKey({ code: 'A' }, null)).toBe('missing');
  });
});
