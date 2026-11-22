import {
  ProductHistory, ProductInput, backtest, dayRange, forecast, inStockFlags, inStockRate, optimalService,
  planProduct, poissonQuantile, policyLevels, simulate, REVIEW_DAYS,
} from '../../src/purchasing-engine/engine.util';

const TODAY = '2026-11-23';
function history(n: number, demandAt: (i: number) => number, start = 30): ProductHistory {
  const days = dayRange('2026-05-01', TODAY).slice(-n);
  const demand = days.map((_, i) => demandAt(i));
  const balance: number[] = [];
  let b = start;
  for (let i = 0; i < days.length; i++) { b = Math.max(0, b - demand[i]); if (b < 5) b += 40; balance.push(b); }
  return { days, demand, balance, lost: days.map(() => 0) };
}
const input = (o: Partial<ProductInput> = {}): ProductInput => ({
  id: 'p1', code: 'C1', name: 'Test', active: true, ready: 10, incoming: 0, reserved: 0, damaged: 0, lost: 0, minStock: 0,
  unitCost: 100, price: 250, supplier: 'S', leadDays: 5, leadSource: 'measured:3', pendingUnits: 0, cancelledUnits90: 0, offerShare90: 0, ...o,
});

describe('purchasing engine — demand', () => {
  it('out-of-stock days are not zero demand', () => {
    // 2 a day, but the last 10 days were out of stock (balance 0, no sales).
    const h = history(60, (i) => (i < 50 ? 2 : 0));
    for (let i = 49; i < 60; i++) h.balance[i] = 0;
    const flags = inStockFlags(h);
    expect(flags.slice(50).every((f) => !f)).toBe(true);
    expect(inStockRate(h, flags, 59, 30)).toBeCloseTo(2, 5);
  });

  it('Croston handles intermittent demand without going negative', () => {
    const h = history(140, (i) => (i % 10 === 0 ? 3 : 0));
    const f = forecast('croston', h, inStockFlags(h), 139);
    expect(f).not.toBeNull();
    expect(f!).toBeGreaterThan(0.15);
    expect(f!).toBeLessThan(0.45);
  });

  it('the backtest prefers a method that tracks a level shift', () => {
    const h = history(160, (i) => (i < 100 ? 1 : 4));
    const best = backtest(h, inStockFlags(h), 12)[0];
    expect(['ma7', 'wma30', 'holt', 'ses']).toContain(best.method);
  });
});

describe('purchasing engine — policy', () => {
  it('Poisson quantile for slow sellers', () => {
    expect(poissonQuantile(0.5, 0.95)).toBe(2);
    expect(poissonQuantile(0, 0.95)).toBe(0);
  });

  it('safety stock covers lead time + the review week', () => {
    const lv = policyLevels(2, 3, [], 5, 0);
    expect(lv.H).toBe(5 + REVIEW_DAYS);
    expect(lv.reorder).toBeGreaterThanOrEqual(2 * 12);
    expect(lv.orderUpTo).toBeCloseTo(lv.reorder + 2 * REVIEW_DAYS, 5);
  });

  it('orders below the reorder level and not above it; incoming counts as position, never as ready', () => {
    const h = history(150, () => 2);
    const low = planProduct(input({ ready: 5 }), h, TODAY);
    expect(low.qty).toBeGreaterThan(0);
    expect(low.priority === 'urgent' || low.priority === 'order').toBe(true);
    const covered = planProduct(input({ ready: 5, incoming: 200 }), h, TODAY);
    expect(covered.qty).toBe(0);
    expect(covered.daysNow).toBeCloseTo(5 / covered.rate, 5);          // «يكفي الآن» uses ready only
    expect(covered.daysAfterIncoming!).toBeGreaterThan(covered.daysNow!);
  });

  it('a product with no demand in 90 days is excluded with a reason', () => {
    const h = history(150, () => 0);
    const p = planProduct(input({ ready: 3 }), h, TODAY);
    expect(p.priority).toBe('excluded');
    expect(p.qty).toBe(0);
    expect(p.reasons.length).toBeGreaterThan(0);
  });

  it('margin-optimal service rises with margin and falls with holding time', () => {
    expect(optimalService(150, 100, 2, 12)).toBeGreaterThan(optimalService(10, 100, 2, 12));
    expect(optimalService(150, 100, 0.01, 12)).toBeLessThan(optimalService(150, 100, 2, 12));
  });
});

describe('purchasing engine — simulation', () => {
  it('is deterministic and conserves units', () => {
    const h = history(160, (i) => (i % 3 === 0 ? 3 : 1));
    const a = simulate('engine', input(), h, 70), b = simulate('engine', input(), h, 70);
    expect(a).toEqual(b);
    expect(a.served + a.lostUnits).toBeCloseTo(a.demand, 5);
  });
});
