import { buildOrderArrivalTrend } from '../../src/transactions/order-arrival-trend';

describe('Daily received and confirmed orders by arrival date', () => {
  it('keeps a later confirmation on the arrival day and counts the linked order only once', () => {
    const order = { shopifyId: '42', shopifyCreatedAt: '2026-10-20T12:00:00Z', createdAt: '2026-10-22T12:00:00Z' };
    const sale = { shopifyOrderId: '42', date: '2026-10-23', confirmedAt: '2026-10-23T12:00:00Z', createdAt: '2026-10-23T12:00:00Z' };
    expect(buildOrderArrivalTrend([order], [sale], '2026-10-20', '2026-10-23').series).toEqual([
      { date: '2026-10-20', receivedOrders: 1, confirmedOrders: 1 },
      { date: '2026-10-21', receivedOrders: 0, confirmedOrders: 0 },
      { date: '2026-10-22', receivedOrders: 0, confirmedOrders: 0 },
      { date: '2026-10-23', receivedOrders: 0, confirmedOrders: 0 },
    ]);
    expect(buildOrderArrivalTrend([order], [sale], '2026-10-23', '2026-10-23').series[0].confirmedOrders).toBe(0);
  });

  it('includes pending, rejected, cancelled and archived arrivals but only active sales as confirmed', () => {
    const orders = ['pending', 'rejected', 'cancelled', 'archived', 'approved'].map(status => ({
      shopifyId: status, shopifyCreatedAt: '2026-10-20', status, cancelled: status === 'cancelled',
    }));
    const sales = [
      { shopifyOrderId: 'cancelled', cancelled: true },
      { shopifyOrderId: 'archived', archived: true },
      { shopifyOrderId: 'approved' },
    ];
    expect(buildOrderArrivalTrend(orders, sales).series).toEqual([
      { date: '2026-10-20', receivedOrders: 5, confirmedOrders: 1 },
    ]);
  });

  it('uses Cairo days across midnight and the daylight-saving transition', () => {
    const orders = [
      { shopifyId: '1', shopifyCreatedAt: '2026-09-30T22:30:00Z' },
      { shopifyId: '2', shopifyCreatedAt: '2026-09-30T20:30:00Z' },
      { shopifyId: '3', shopifyCreatedAt: '2026-10-31T21:30:00Z' },
      { shopifyId: '4', shopifyCreatedAt: '2026-10-31T22:30:00Z' },
    ];
    const { series } = buildOrderArrivalTrend(orders, [], '2026-10-01', '2026-10-31');
    expect(series[0].receivedOrders).toBe(1);
    expect(series[30].receivedOrders).toBe(1);
    expect(series.reduce((sum, row) => sum + row.receivedOrders, 0)).toBe(2);
  });

  it('uses the chosen original date for manual sales, ignoring registration timestamps', () => {
    const sales = [
      { _id: 'manual', transactionDate: '2026-10-20', date: '2026-10-23', createdAt: new Date('2026-10-24') },
      { _id: 'legacy', date: '2026-10-20T23:30:00+03:00' },
      { _id: 'cancelled', date: '2026-10-20', cancelled: true },
    ];
    expect(buildOrderArrivalTrend([], sales).series).toEqual([
      { date: '2026-10-20', receivedOrders: 3, confirmedOrders: 2 },
    ]);
  });

  it('recovers arrivals from invoices when the source order is missing and deduplicates linked invoices', () => {
    const sale = { shopifyOrderId: '42', shopifyCreatedAt: '2026-10-20', date: '2026-10-23' };
    expect(buildOrderArrivalTrend([], [sale, { ...sale, cancelled: true }]).series).toEqual([
      { date: '2026-10-20', receivedOrders: 1, confirmedOrders: 1 },
    ]);
  });

  it('never substitutes import/registration dates for an unknown arrival', () => {
    const order = { shopifyId: '42', shopifyCreatedAt: 'invalid', createdAt: '2026-10-23' };
    const sale = { _id: 'manual', date: 'invalid', createdAt: '2026-10-23', confirmedAt: '2026-10-23' };
    expect(buildOrderArrivalTrend([order], [sale])).toEqual({ series: [], undatedOrders: 2 });
  });

  it('supports an empty bounded period and a period with only unconfirmed arrivals', () => {
    expect(buildOrderArrivalTrend([], [], '2026-10-20', '2026-10-20').series).toEqual([
      { date: '2026-10-20', receivedOrders: 0, confirmedOrders: 0 },
    ]);
    expect(buildOrderArrivalTrend([{ shopifyId: '1', shopifyCreatedAt: '2026-10-20' }], []).series).toEqual([
      { date: '2026-10-20', receivedOrders: 1, confirmedOrders: 0 },
    ]);
  });
});
