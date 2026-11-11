import { buildOrderArrivalTrend } from '../../src/transactions/order-arrival-trend';
import { buildSalesOverview, mongoCairoDay, salesOverviewMonth } from '../../src/transactions/sales-overview';
import { TransactionsService } from '../../src/transactions/transactions.service';

describe('Monthly sales overview', () => {
  it('keeps every calendar day and matches real order arrivals, confirmations, and product revenue', () => {
    const orders = [
      { shopifyId: '42', shopifyCreatedAt: '2026-10-31T22:30:00Z' },
      { shopifyId: '43', shopifyCreatedAt: '2026-11-02T12:00:00Z' },
    ];
    const sales = [
      { shopifyOrderId: '42', shopifyCreatedAt: '2026-10-31T22:30:00Z', date: '2026-11-03' },
    ];
    const actual = buildOrderArrivalTrend(orders, sales, '2026-11-01', '2026-11-30');
    const arrivalBuckets = actual.series.filter(day => day.receivedOrders).map(day => ({
      _id: day.date, receivedOrders: day.receivedOrders,
      confirmedOrders: day.confirmedOrders,
    }));
    const invoice = { date: '2026-11-03', itemsTotal: 250, total: 280, shipCost: 30 };
    const buckets = [...arrivalBuckets, {
      _id: invoice.date, activeSales: 1,
      grossRevenue: Number(invoice.itemsTotal) || invoice.total - invoice.shipCost,
    }];
    const result = buildSalesOverview(2026, 11, buckets, [{ _id: '2026-11-04', amount: 50 }], new Date('2026-11-08T12:00:00Z'));
    expect(result.days).toHaveLength(30);
    expect(result.days[0]).toEqual({ date: '2026-11-01', orders: 1, confirmedOrders: 1, revenue: 0, receivedValue: 0, confirmedValue: 0 });
    expect(result.days[1].orders).toBe(1);
    expect(result.days[2].revenue).toBe(250);
    expect(result.days[3].revenue).toBe(-50);
    expect(result).toMatchObject({ totalOrders: 2, confirmedOrders: 1, totalRevenue: 200, averageOrderValue: 250, today: '2026-11-08' });
    const reportGross = Number(invoice.itemsTotal) || invoice.total - invoice.shipCost;
    expect(result.totalRevenue).toBe(Math.max(0, reportGross - 50));
    expect(result.averageOrderValue).toBe(Math.round(reportGross / sales.length));
    expect(result.days.reduce((sum, day) => sum + day.revenue, 0)).toBe(result.totalRevenue);
  });

  it('handles empty and leap months without inventing orders', () => {
    expect(buildSalesOverview(2028, 2, [], []).days).toHaveLength(29);
    expect(buildSalesOverview(2026, 2, [], [])).toMatchObject({ totalOrders: 0, totalRevenue: 0, confirmedOrders: 0, averageOrderValue: 0 });
    expect(salesOverviewMonth(2026, 12).next).toBe('2027-01-01');
    expect(JSON.stringify(mongoCairoDay('$date'))).toContain('Africa/Cairo');
  });

  it('keeps full received and confirmed cohort values separate from net invoice revenue and returns', () => {
    const result = buildSalesOverview(2026, 11, [
      { _id: '2026-11-11', receivedOrders: 5, confirmedOrders: 2, receivedValue: 1500.25, confirmedValue: 600.15 },
      { _id: '2026-11-12', receivedOrders: 1, confirmedOrders: 0, receivedValue: 200.1, confirmedValue: 0 },
      { _id: '2026-11-15', activeSales: 2, grossRevenue: 500 },
    ], [{ _id: '2026-11-15', amount: 100 }]);
    expect(result.days[10]).toMatchObject({ orders: 5, receivedValue: 1500.25, confirmedValue: 600.15, revenue: 0 });
    expect(result.days[11]).toMatchObject({ orders: 1, receivedValue: 200.1, confirmedValue: 0 });
    expect(result).toMatchObject({ totalReceivedValue: 1700.35, totalConfirmedValue: 600.15, totalRevenue: 400 });
    expect(result.days[14]).toMatchObject({ receivedValue: 0, confirmedValue: 0, revenue: 400 });
  });

  it('uses bounded database aggregates and returns only daily buckets', async () => {
    const calls: unknown[][] = [];
    const aggregate = (result: unknown[]) => (pipeline: unknown[]) => {
      calls.push(pipeline);
      return { exec: async () => result };
    };
    const service = {
      shopifyOrderModel: { collection: { name: 'shopifyorders' }, aggregate: aggregate([
        { _id: '2026-11-01', receivedOrders: 2, confirmedOrders: 1, receivedValue: 800, confirmedValue: 300 },
      ]) },
      transactionModel: { collection: { name: 'transactions' }, aggregate: aggregate([
        { _id: '2026-11-03', activeSales: 2, grossRevenue: 230 },
      ]) },
      returnRequestModel: { aggregate: aggregate([{ _id: '2026-11-03', amount: 20 }]) },
    };
    const result = await TransactionsService.prototype.getSalesOverview.call(service as unknown as TransactionsService, 2026, 11);
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(calls[0])).toContain('shopifyCreatedAt');
    expect(JSON.stringify(calls[0])).toContain('depositReceipts');
    expect(JSON.stringify(calls[0])).toContain('shipWithoutDeposit');
    expect(JSON.stringify(calls[1])).toContain('itemsTotal');
    expect(JSON.stringify(calls[1])).toContain('date');
    expect(JSON.stringify(calls[2])).toContain('reversedAt');
    expect(result).toMatchObject({ totalOrders: 2, confirmedOrders: 1, totalRevenue: 210, averageOrderValue: 115, orderSource: 'shopify' });
    expect(result).toMatchObject({ totalReceivedValue: 800, totalConfirmedValue: 300 });
    expect(result.days).toHaveLength(30);
  });
});
