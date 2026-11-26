import { abcClass, suggestPurchase } from '../../src/public-api/purchase-suggestion.util';

const plan = (over: Record<string, unknown> = {}) => ({
  id: 'p1', code: 'C1', name: 'Cushion', active: true,
  ready: 20, incoming: 0, reserved: 3, damaged: 1, lost: 0, minStock: 5,
  unitCost: 100, price: 200, supplier: 'Talla', leadDays: 5, leadSource: 'measured:9',
  pendingUnits: 0, cancelledUnits90: 0, offerShare90: 0,
  method: 'ma30', methodWape: 0.3, confidence: 'high',
  rate: 2, rate7: 2, rate30: 2, rate60: 2, rate90: 2, trendPct: 0, cv: 0.4, sold90: 180, lostDemand90: 0, stockoutDays90: 0,
  horizon: 12, sigmaH: 4, safety: 7, rop: 31, orderUpTo: 45, position: 20,
  qty: 25, cost: 2500, margin: 100, daysNow: 10, daysAfterIncoming: 10, daysAfterPurchase: 22.5,
  stockoutDate: '2026-12-06', pStockout: 0.4, expectedLostIfWait: 1, marginAtRisk: 100, holdingCost: 10, score: 0.1,
  priority: 'order', reasons: ['x'], reasonsEn: ['x'], alt: [],
  ...over,
}) as any;

describe('purchase suggestion (engine + pending orders)', () => {
  it('orders up to the order-up-to level from the position', () => {
    const s = suggestPurchase(plan(), { pendingUnits: 0, lateUnits: 0, lateOrders: 0 }, '2026-11-26');
    expect(s.calculation.position).toBe(20);
    expect(s.suggestedQty).toBe(25); // ⌈45 − 20⌉
    expect(s.engineQty).toBe(25);
    expect(s.calculation.steps.length).toBeGreaterThanOrEqual(5);
  });

  it('nets units owed to pending orders before the reorder test', () => {
    const s = suggestPurchase(plan({ ready: 40, qty: 0, priority: 'ok' }), { pendingUnits: 12, lateUnits: 5, lateOrders: 2 }, '2026-11-26');
    // without orders: position 40 > rop 31 → nothing; with 12 owed: 28 ≤ 31 → ⌈45 − 28⌉ = 17
    expect(s.calculation.available).toBe(28);
    expect(s.suggestedQty).toBe(17);
    expect(s.engineQty).toBe(0);
    expect(s.reasons.some((r) => r.en.includes('late order'))).toBe(true);
  });

  it('counts incoming purchase orders and stays quiet above the reorder level', () => {
    const s = suggestPurchase(plan({ incoming: 30, qty: 0 }), { pendingUnits: 0, lateUnits: 0, lateOrders: 0 }, '2026-11-26');
    expect(s.calculation.position).toBe(50);
    expect(s.suggestedQty).toBe(0);
    expect(s.priority).toBe('ok');
  });

  it('marks urgent when waiting orders exceed stock and incoming', () => {
    const s = suggestPurchase(plan({ ready: 4, incoming: 2 }), { pendingUnits: 10, lateUnits: 0, lateOrders: 0 }, '2026-11-26');
    expect(s.calculation.shortForOrders).toBe(4);
    expect(s.priority).toBe('urgent');
    expect(s.suggestedQty).toBe(Math.ceil(45 - (4 - 10 + 2)));
  });

  it('never suggests an inactive product', () => {
    const s = suggestPurchase(plan({ active: false, priority: 'excluded' }), { pendingUnits: 50, lateUnits: 50, lateOrders: 3 }, '2026-11-26');
    expect(s.suggestedQty).toBe(0);
    expect(s.priority).toBe('excluded');
  });

  it('without a forecast, buys only what waiting orders are short of', () => {
    const s = suggestPurchase(plan({ priority: 'excluded', method: null, rate: 0, ready: 1, reasons: ['no data'], reasonsEn: ['no data'] }), { pendingUnits: 4, lateUnits: 0, lateOrders: 0 }, '2026-11-26');
    expect(s.suggestedQty).toBe(3);
    const none = suggestPurchase(plan({ priority: 'excluded', method: null, rate: 0, ready: 10, reasons: ['no data'], reasonsEn: ['no data'] }), { pendingUnits: 4, lateUnits: 0, lateOrders: 0 }, '2026-11-26');
    expect(none.suggestedQty).toBe(0);
  });

  it('below the recorded minimum triggers an order even above the reorder level', () => {
    const s = suggestPurchase(plan({ rate: 0.1, rop: 2, orderUpTo: 50, minStock: 50, ready: 30 }), { pendingUnits: 0, lateUnits: 0, lateOrders: 0 }, '2026-11-26');
    expect(s.suggestedQty).toBe(20);
  });
});

describe('ABC by units sold', () => {
  it('A = first 80% of units, B = next 15%, C = rest, D = none', () => {
    const rows = [
      { name: 'a', units: 50, netSales: 1 }, { name: 'b', units: 30, netSales: 1 }, { name: 'c', units: 15, netSales: 1 },
      { name: 'd', units: 5, netSales: 1 }, { name: 'e', units: 0, netSales: 0 },
    ];
    const out = abcClass(rows);
    const cls = Object.fromEntries(out.map((r) => [r.name, r.class]));
    expect(cls).toEqual({ a: 'A', b: 'A', c: 'B', d: 'C', e: 'D' });
    expect(out[0].rank).toBe(1);
    expect(out.find((r) => r.name === 'e')!.rank).toBeNull();
    expect(out.find((r) => r.name === 'a')!.sharePct).toBe(50);
  });
});
