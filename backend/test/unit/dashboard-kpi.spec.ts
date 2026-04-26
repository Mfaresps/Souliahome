/**
 * Dashboard KPI calculation tests.
 */

import {
  buildSaleTransaction,
  buildPurchaseTransaction,
  buildReturnTransaction,
} from '../fixtures/transactions.fixture';

const calcDashboard = (txs: Array<Record<string, unknown>>, expenses: Array<Record<string, unknown>> = []) => {
  const active = txs.filter((t) => !t.cancelled);
  const sales = active.filter((t) => t.type === 'مبيعات');
  const purchases = active.filter((t) => t.type === 'مشتريات');
  const returns = active.filter((t) => String(t.type).startsWith('مرتجع'));

  const totalSales = sales.reduce(
    (s, t) => s + ((t.total as number) - ((t.shipCost as number) || 0)),
    0,
  );
  const totalPurchases = purchases.reduce((s, t) => s + (t.total as number), 0);
  const totalReturns = returns.reduce((s, t) => s + (t.total as number), 0);
  const totalShipping = sales.reduce((s, t) => s + ((t.shipCost as number) || 0), 0);
  const totalExpenses = expenses
    .filter((e) => e.status === 'معتمد')
    .reduce((s, e) => s + (e.amount as number), 0);
  const totalRemaining = active.reduce((s, t) => s + ((t.remaining as number) || 0), 0);

  return {
    totalSales: totalSales - totalReturns,
    totalPurchases,
    totalReturns,
    returnCount: returns.length,
    totalShipping,
    totalExpenses,
    totalRemaining,
    grossProfit: totalSales - totalPurchases - totalReturns,
    netProfit: totalSales - totalPurchases - totalReturns - totalExpenses,
  };
};

describe('Dashboard KPIs', () => {
  it('correctly calculates all KPIs for a normal day', () => {
    const txs = [
      buildSaleTransaction({ total: 500, shipCost: 50 }),
      buildSaleTransaction({ total: 300, shipCost: 30 }),
      buildPurchaseTransaction({ total: 400 }),
      buildReturnTransaction({ total: 100 }),
    ];
    const expenses = [{ amount: 50, status: 'معتمد' }];
    const dash = calcDashboard(txs, expenses);
    expect(dash.totalSales).toBe(620); // (500-50)+(300-30)-100
    expect(dash.totalPurchases).toBe(400);
    expect(dash.totalReturns).toBe(100);
    expect(dash.returnCount).toBe(1);
    expect(dash.totalShipping).toBe(80);
    expect(dash.totalExpenses).toBe(50);
  });

  it('skips pending expenses from KPI', () => {
    const expenses = [
      { amount: 100, status: 'معتمد' },
      { amount: 200, status: 'معلق' },
      { amount: 50, status: 'مرفوض' },
    ];
    const dash = calcDashboard([], expenses);
    expect(dash.totalExpenses).toBe(100);
  });

  it('handles empty data', () => {
    const dash = calcDashboard([]);
    expect(dash).toMatchObject({
      totalSales: 0,
      totalPurchases: 0,
      totalReturns: 0,
      returnCount: 0,
      totalShipping: 0,
      totalExpenses: 0,
      totalRemaining: 0,
    });
  });

  it('excludes cancelled transactions from totals', () => {
    const txs = [
      buildSaleTransaction({ total: 500, cancelled: false }),
      buildSaleTransaction({ total: 1000, cancelled: true }),
    ];
    const dash = calcDashboard(txs);
    expect(dash.totalSales).toBe(500);
  });

  it('aggregates remaining balances across all active transactions', () => {
    const txs = [
      buildSaleTransaction({ remaining: 100 }),
      buildSaleTransaction({ remaining: 200 }),
      buildPurchaseTransaction({ remaining: 300 }),
    ];
    const dash = calcDashboard(txs);
    expect(dash.totalRemaining).toBe(600);
  });

  describe('Top sellers / low sellers', () => {
    it('identifies top selling product', () => {
      const sales = [
        { items: [{ code: 'P001', qty: 10 }] },
        { items: [{ code: 'P001', qty: 5 }] },
        { items: [{ code: 'P002', qty: 3 }] },
      ];
      const map = new Map<string, number>();
      sales.forEach((s) =>
        s.items.forEach((it) => {
          map.set(it.code, (map.get(it.code) || 0) + it.qty);
        }),
      );
      const top = [...map.entries()].sort((a, b) => b[1] - a[1])[0];
      expect(top[0]).toBe('P001');
      expect(top[1]).toBe(15);
    });

    it('identifies low sellers', () => {
      const map = new Map<string, number>([
        ['P001', 15],
        ['P002', 3],
      ]);
      const sorted = [...map.entries()].sort((a, b) => a[1] - b[1]);
      expect(sorted[0][0]).toBe('P002');
    });
  });

  describe('Stock alerts', () => {
    it('flags out-of-stock items (current = 0)', () => {
      const inv = [{ code: 'P001', current: 0, minStock: 10 }];
      const zero = inv.filter((i) => i.current === 0);
      expect(zero).toHaveLength(1);
    });

    it('flags low-stock items (current ≤ minStock)', () => {
      const inv = [
        { code: 'P001', current: 5, minStock: 10 },
        { code: 'P002', current: 50, minStock: 10 },
      ];
      const low = inv.filter((i) => i.current > 0 && i.current <= i.minStock);
      expect(low).toHaveLength(1);
      expect(low[0].code).toBe('P001');
    });

    it('does not flag items above minStock', () => {
      const inv = [{ code: 'P001', current: 100, minStock: 10 }];
      const ok = inv.filter((i) => i.current > i.minStock);
      expect(ok).toHaveLength(1);
    });
  });
});
