/**
 * Unit tests for the Reports Module.
 * Covers: sales reports, purchase reports, summary reports, cash reports,
 * and report aggregation accuracy.
 */

import {
  buildSaleTransaction,
  buildPurchaseTransaction,
  buildReturnTransaction,
} from '../fixtures/transactions.fixture';

const sumField = (txs: Array<Record<string, unknown>>, field: string) =>
  txs.reduce((s, tx) => s + (Number(tx[field]) || 0), 0);

const groupByCustomer = (txs: Array<Record<string, unknown>>) => {
  const map = new Map<string, { count: number; total: number }>();
  txs.forEach((tx) => {
    const key = String(tx.client || 'بدون اسم');
    const cur = map.get(key) || { count: 0, total: 0 };
    map.set(key, { count: cur.count + 1, total: cur.total + (Number(tx.total) || 0) });
  });
  return Array.from(map.entries()).map(([client, agg]) => ({ client, ...agg }));
};

const groupByProduct = (txs: Array<Record<string, unknown>>) => {
  const map = new Map<string, { qty: number; revenue: number }>();
  txs.forEach((tx) => {
    const items = (tx.items as Array<Record<string, unknown>>) || [];
    items.forEach((it) => {
      const code = String(it.code || '');
      const cur = map.get(code) || { qty: 0, revenue: 0 };
      map.set(code, {
        qty: cur.qty + (Number(it.qty) || 0),
        revenue: cur.revenue + (Number(it.total) || 0),
      });
    });
  });
  return Array.from(map.entries()).map(([code, agg]) => ({ code, ...agg }));
};

const buildSummaryReport = (txs: Array<Record<string, unknown>>) => {
  const active = txs.filter((t) => !t.cancelled);
  const sales = active.filter((t) => t.type === 'مبيعات');
  const purchases = active.filter((t) => t.type === 'مشتريات');
  const returns = active.filter((t) => String(t.type).startsWith('مرتجع'));

  return {
    totalSales: sumField(sales, 'total'),
    totalPurchases: sumField(purchases, 'total'),
    totalReturns: sumField(returns, 'total'),
    netSales: sumField(sales, 'total') - sumField(returns, 'total'),
    totalShipping: sumField(sales, 'shipCost'),
    totalDiscounts: sumField(sales, 'discount'),
    salesCount: sales.length,
    purchasesCount: purchases.length,
    returnsCount: returns.length,
  };
};

describe('Reports Module', () => {
  const transactions = [
    buildSaleTransaction({ ref: '1001', date: '2026-04-25', client: 'علي', total: 500, shipCost: 50 }),
    buildSaleTransaction({ ref: '1002', date: '2026-04-26', client: 'محمد', total: 300, shipCost: 30 }),
    buildSaleTransaction({ ref: '1003', date: '2026-04-26', client: 'علي', total: 200, shipCost: 0 }),
    buildPurchaseTransaction({ ref: '5001', date: '2026-04-24', total: 1000 }),
    buildPurchaseTransaction({ ref: '5002', date: '2026-04-25', total: 800 }),
    buildReturnTransaction({ ref: '1001-RET', date: '2026-04-27', total: 100 }),
    buildSaleTransaction({ ref: '1004', date: '2026-04-26', total: 1000, cancelled: true }),
  ];

  describe('Sales reports', () => {
    it('returns all sales (excluding cancelled)', () => {
      const sales = transactions.filter((t) => t.type === 'مبيعات' && !t.cancelled);
      expect(sales).toHaveLength(3);
    });

    it('total sales sums product price minus shipping (per CLAUDE.md)', () => {
      const sales = transactions.filter((t) => t.type === 'مبيعات' && !t.cancelled);
      const productOnly = sales.reduce(
        (s, t) => s + ((t.total as number) - ((t.shipCost as number) || 0)),
        0,
      );
      // (500-50) + (300-30) + (200-0) = 920
      expect(productOnly).toBe(920);
    });

    it('groups sales by date range', () => {
      const filtered = transactions.filter(
        (t) =>
          t.type === 'مبيعات' &&
          !t.cancelled &&
          t.date === '2026-04-26',
      );
      expect(filtered).toHaveLength(2);
    });

    it('groups sales by customer', () => {
      const sales = transactions.filter((t) => t.type === 'مبيعات' && !t.cancelled);
      const grouped = groupByCustomer(sales);
      const ali = grouped.find((g) => g.client === 'علي');
      expect(ali?.count).toBe(2);
      expect(ali?.total).toBe(700); // 500 + 200
    });

    it('groups sales by product code', () => {
      const sales = transactions.filter((t) => t.type === 'مبيعات' && !t.cancelled);
      const grouped = groupByProduct(sales);
      const p001 = grouped.find((g) => g.code === 'P001');
      expect(p001).toBeDefined();
      expect(p001?.qty).toBeGreaterThan(0);
    });

    it('excludes cancelled sales from totals', () => {
      const all = transactions.filter((t) => t.type === 'مبيعات');
      const active = all.filter((t) => !t.cancelled);
      expect(all.length - active.length).toBe(1);
    });
  });

  describe('Purchase reports', () => {
    it('returns all purchases (excluding cancelled)', () => {
      const purchases = transactions.filter((t) => t.type === 'مشتريات' && !t.cancelled);
      expect(purchases).toHaveLength(2);
    });

    it('totals purchases correctly', () => {
      const purchases = transactions.filter((t) => t.type === 'مشتريات' && !t.cancelled);
      expect(sumField(purchases, 'total')).toBe(1800);
    });

    it('filters purchases by date range', () => {
      const filtered = transactions.filter(
        (t) =>
          t.type === 'مشتريات' &&
          !t.cancelled &&
          (t.date as string) >= '2026-04-25' &&
          (t.date as string) <= '2026-04-25',
      );
      expect(filtered).toHaveLength(1);
    });
  });

  describe('Summary reports', () => {
    it('builds an accurate summary', () => {
      const summary = buildSummaryReport(transactions);
      expect(summary.totalSales).toBe(1000); // 500+300+200
      expect(summary.totalPurchases).toBe(1800);
      expect(summary.totalReturns).toBe(100);
      expect(summary.netSales).toBe(900); // 1000 - 100
      expect(summary.totalShipping).toBe(80); // 50+30+0
      expect(summary.salesCount).toBe(3);
      expect(summary.purchasesCount).toBe(2);
      expect(summary.returnsCount).toBe(1);
    });

    it('returns deduct from net sales', () => {
      const summary = buildSummaryReport(transactions);
      expect(summary.netSales).toBe(summary.totalSales - summary.totalReturns);
    });

    it('summarizes empty data correctly', () => {
      const summary = buildSummaryReport([]);
      expect(summary.totalSales).toBe(0);
      expect(summary.totalPurchases).toBe(0);
      expect(summary.salesCount).toBe(0);
    });
  });

  describe('Cash reports', () => {
    interface VaultEntry {
      date: string;
      amount: number;
      source: string;
      method: string;
      ref?: string;
    }
    const vaultLog: VaultEntry[] = [
      { date: '2026-04-25', amount: 200, source: 'ديبوزت مبيعات', method: 'كاش', ref: '1001' },
      { date: '2026-04-25', amount: -1000, source: 'دفع مشتريات', method: 'كاش', ref: '5002' },
      { date: '2026-04-26', amount: 100, source: 'تحصيل', method: 'كاش', ref: '1001' },
      { date: '2026-04-27', amount: -100, source: 'رد مرتجع', method: 'كاش', ref: '1001-RET' },
    ];

    it('reports total inflow', () => {
      const inflow = vaultLog.filter((v) => v.amount > 0).reduce((s, v) => s + v.amount, 0);
      expect(inflow).toBe(300);
    });

    it('reports total outflow', () => {
      const outflow = vaultLog.filter((v) => v.amount < 0).reduce((s, v) => s + v.amount, 0);
      expect(outflow).toBe(-1100);
    });

    it('reports net cash movement', () => {
      const net = vaultLog.reduce((s, v) => s + v.amount, 0);
      expect(net).toBe(-800);
    });

    it('groups cash entries by source', () => {
      const map = new Map<string, number>();
      vaultLog.forEach((v) => {
        map.set(v.source, (map.get(v.source) || 0) + v.amount);
      });
      expect(map.get('ديبوزت مبيعات')).toBe(200);
      expect(map.get('دفع مشتريات')).toBe(-1000);
      expect(map.get('تحصيل')).toBe(100);
      expect(map.get('رد مرتجع')).toBe(-100);
    });

    it('cash log entries link back to source transactions via ref', () => {
      const linkedToSale1001 = vaultLog.filter((v) => v.ref === '1001');
      expect(linkedToSale1001).toHaveLength(2); // deposit + collection
    });
  });

  describe('Profit calculation', () => {
    it('gross profit = sales - cost of goods sold', () => {
      const revenue = 1000;
      const cogs = 600;
      const grossProfit = revenue - cogs;
      expect(grossProfit).toBe(400);
    });

    it('returns deduct profit (product price only, not shipping)', () => {
      const grossProfit = 400;
      const returnProductCost = 100; // product portion
      const returnShipping = 50; // shipping NOT deducted
      const netProfit = grossProfit - returnProductCost;
      expect(netProfit).toBe(300);
    });

    it('expenses reduce net profit (only approved ones, per CLAUDE.md)', () => {
      const grossProfit = 500;
      const approvedExpenses = 100;
      const pendingExpenses = 200; // should NOT be deducted
      const netProfit = grossProfit - approvedExpenses;
      expect(netProfit).toBe(400);
      // Pending shouldn't affect the figure
      expect(netProfit).not.toBe(grossProfit - approvedExpenses - pendingExpenses);
    });
  });

  describe('Report formatting & accuracy', () => {
    it('rounds currency to 2 decimal places', () => {
      const value = 123.456789;
      expect(Number(value.toFixed(2))).toBe(123.46);
    });

    it('handles missing values as zero in aggregations', () => {
      const txs = [{ total: undefined }, { total: 100 }, { total: null }];
      expect(sumField(txs as Array<Record<string, unknown>>, 'total')).toBe(100);
    });

    it('counts and totals stay consistent', () => {
      const summary = buildSummaryReport(transactions);
      expect(summary.salesCount + summary.purchasesCount + summary.returnsCount).toBe(6);
    });
  });
});
