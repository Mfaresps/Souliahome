import { TransactionsService } from '../../src/transactions/transactions.service';

describe('Cancellation report order-date period', () => {
  const cancelled = (ref: string, fields: Record<string, unknown>) => ({
    _id: ref, ref, cancelled: true, total: 100, deposit: 0,
    cancelReasonCode: 'customer-request', ...fields,
  });
  const report = async (transactions: any[], shopify: any[], from?: string, to?: string) => {
    const service: any = Object.create(TransactionsService.prototype);
    service.transactionModel = { find: jest.fn(() => ({ exec: async () => transactions })) };
    service.shopifyOrderModel = { find: jest.fn(() => ({ exec: async () => shopify })) };
    const result = await service.buildCancellationsReport(from, to);
    expect(service.transactionModel.find).toHaveBeenCalledWith({ cancelled: true });
    expect(service.shopifyOrderModel.find).toHaveBeenCalledWith({ cancelled: true });
    return result;
  };

  it('prioritizes the requester and exposes the approver separately for both cancellation stages', async () => {
    const result = await report([
      cancelled('approved-tx', { date: '2026-10-01', cancelledBy: 'Manager', cancelRequest: { status: 'معتمد', requestedBy: 'Sales employee', reviewedBy: 'Manager' } }),
      cancelled('direct-tx', { date: '2026-10-01', cancelledBy: 'Direct operator', cancelRequest: { status: 'مرفوض', requestedBy: 'Rejected requester', reviewedBy: 'Rejecting manager' } }),
      cancelled('missing-requester', { date: '2026-10-01', cancelledBy: 'Manager', cancelRequest: { status: 'معتمد', reviewedBy: 'Manager' } }),
    ], [
      cancelled('approved-shop', { shopifyCreatedAt: '2026-10-01', cancelledBy: 'Sales employee', cancelRequest: { status: 'معتمد', requestedBy: 'Sales employee', reviewedBy: 'Supervisor' } }),
      cancelled('pending-then-direct', { shopifyCreatedAt: '2026-10-01', cancelledBy: 'Admin', cancelRequest: { status: 'معلق', requestedBy: 'Pending requester' } }),
      cancelled('username-only', { shopifyCreatedAt: '2026-10-01', cancelledBy: 'Admin', cancelRequest: { status: 'معتمد', requestedByUsername: 'employee.login' } }),
      cancelled('automatic', { shopifyCreatedAt: '2026-10-01', cancelledBy: 'Shopify', cancelReasonCode: 'shopify-cancelled' }),
    ]);
    const find = (ref: string) => result.recent.find((row: any) => row.ref === ref);
    expect(find('approved-tx')).toMatchObject({ by: 'Sales employee', requestedBy: 'Sales employee', approvedBy: 'Manager', cancelledBy: 'Manager', cancellationMode: 'approved-request' });
    expect(find('approved-shop')).toMatchObject({ by: 'Sales employee', requestedBy: 'Sales employee', approvedBy: 'Supervisor', cancellationMode: 'approved-request' });
    expect(find('direct-tx')).toMatchObject({ by: 'Direct operator', requestedBy: '', approvedBy: '', cancellationMode: 'direct' });
    expect(find('pending-then-direct')).toMatchObject({ by: 'Admin', requestedBy: '', approvedBy: '', cancellationMode: 'direct' });
    expect(find('missing-requester')).toMatchObject({ by: '', requestedBy: '', approvedBy: 'Manager', cancellationMode: 'approved-request' });
    expect(find('username-only')).toMatchObject({ requestedBy: 'employee.login', approvedBy: '' });
    expect(find('automatic')).toMatchObject({ by: 'Shopify', requestedBy: '', approvedBy: '', cancellationMode: 'system' });
  });

  it('reports each customer detail separately across stages and keeps legacy generic records separate', async () => {
    const result = await report([
      cancelled('deposit-tx', { date: '2026-10-02', type: 'مبيعات', cancelReasonCode: 'customer-refused-deposit', cancelReasonNote: 'لا يريد تحويل مقدم', items: [{ productId: 'p1', name: 'Bowl', qty: 2 }] }),
      cancelled('legacy', { date: '2026-10-02', cancelReasonCode: 'customer-request' }),
    ], [
      cancelled('deposit-shop', { shopifyCreatedAt: '2026-10-03', cancelReasonCode: 'customer-refused-deposit', items: [{ productId: 'p1', name: 'Bowl', qty: 3 }] }),
      cancelled('inspection-shop', { shopifyCreatedAt: '2026-10-03', cancelReasonCode: 'customer-wants-inspection' }),
      cancelled('price-shop', { shopifyCreatedAt: '2026-10-03', cancelReasonCode: 'customer-price-too-high' }),
    ]);
    expect(result.total).toBe(5);
    expect(result.reasons).toHaveLength(4);
    expect(result.reasons.find((r: any) => r.code === 'customer-refused-deposit')).toMatchObject({ count: 2, shopifyCount: 1, transactionCount: 1, group: 'customer' });
    expect(result.reasons.find((r: any) => r.code === 'customer-request')).toMatchObject({ count: 1 });
    expect(result.recent.find((r: any) => r.ref === 'deposit-tx').note).toBe('لا يريد تحويل مقدم');
    expect(result.products[0]).toMatchObject({ orderCount: 2, quantity: 5 });
    expect(result.products[0].breakdown.map((b: any) => b.code)).toEqual(['customer-refused-deposit', 'customer-refused-deposit']);
  });

  it('aggregates products over the full selected period before the detail list is capped', async () => {
    const orders = Array.from({ length: 501 }, (_, index) => cancelled(`order-${index}`, {
      shopifyCreatedAt: '2026-10-03', items: [{ productId: 'bowl', name: 'Bowl', code: 'B1', qty: 2 }],
    }));
    orders.push(cancelled('outside', { shopifyCreatedAt: '2026-09-30', items: [{ productId: 'tray', name: 'Tray', qty: 10000 }] }));
    const result = await report([], orders, '2026-10-01', '2026-10-31');
    expect(result.recent).toHaveLength(500);
    expect(result.recentTruncated).toBe(true);
    expect(result.products).toEqual([expect.objectContaining({ name: 'Bowl', orderCount: 501, quantity: 1002 })]);
    expect(result.breakdown).toEqual([expect.objectContaining({ count: 501, stage: 'shopify', lostValue: 50100 })]);
  });

  it('includes October orders cancelled in November and excludes September orders cancelled in October across both stages', async () => {
    const result = await report([
      cancelled('tx-oct', { date: '2026-10-01', cancelledAt: '2026-11-02T10:00:00Z', deposit: 20 }),
      cancelled('tx-sep', { date: '2026-09-30', cancelledAt: '2026-10-12T10:00:00Z' }),
    ], [
      cancelled('shop-oct', { shopifyCreatedAt: '2026-10-31T10:00:00+02:00', createdAt: new Date('2026-11-01T10:00:00Z'), cancelledAt: '2026-11-03T10:00:00Z',
        depositReceipts: [{ status: 'مُسترد', amount: 30 }] }),
      cancelled('shop-sep', { shopifyCreatedAt: '2026-09-30T10:00:00+03:00', createdAt: new Date('2026-10-01T10:00:00Z'), cancelledAt: '2026-10-12T10:00:00Z' }),
    ], '2026-10-01', '2026-10-31');
    expect(result).toMatchObject({ total: 2, transactionCount: 1, shopifyCount: 1, lostValue: 200, refunded: 50 });
    expect(result.recent.map((row: any) => [row.ref, row.date])).toEqual([['shop-oct', '2026-10-31'], ['tx-oct', '2026-10-01']]);
    expect(result.series.map((row: any) => row.date)).toEqual(['2026-10-01', '2026-10-31']);
    expect(result.reasons[0]).toMatchObject({ count: 2, lostValue: 200, refunded: 50 });
  });

  it('keeps the original Shopify order date after registration and uses the manual business date', async () => {
    const result = await report([
      cancelled('registered-shop', { shopifyCreatedAt: '2026-10-02T12:00:00Z', transactionDate: '2026-11-01', date: '2026-11-01', createdAt: new Date('2026-11-01') }),
      cancelled('manual', { transactionDate: '2026-10-03', date: '2026-11-01', createdAt: new Date('2026-11-01') }),
      cancelled('legacy', { date: '2026-10-04' }),
      cancelled('created-only', { createdAt: new Date('2026-10-05T12:00:00Z') }),
    ], [cancelled('shop-legacy', { shopifyCreatedAt: 'invalid', createdAt: new Date('2026-10-06T12:00:00Z') })], '2026-10-01', '2026-10-31');
    expect(result.total).toBe(5);
    expect(result.recent.map((row: any) => row.date)).toEqual(['2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02']);
  });

  it('uses Cairo calendar days at inclusive period boundaries', async () => {
    const result = await report([], [
      cancelled('oct-start', { shopifyCreatedAt: '2026-09-30T22:30:00Z' }),
      cancelled('before-oct', { shopifyCreatedAt: '2026-09-30T20:30:00Z' }),
      cancelled('oct-end', { shopifyCreatedAt: '2026-10-31T21:30:00Z' }),
      cancelled('nov-start', { shopifyCreatedAt: '2026-10-31T22:30:00Z' }),
    ], '2026-10-01', '2026-10-31');
    expect(result.recent.map((row: any) => [row.ref, row.date])).toEqual([['oct-end', '2026-10-31'], ['oct-start', '2026-10-01']]);
  });

  it('supports one-sided periods and never uses cancellation time as a missing order date', async () => {
    const rows = [
      cancelled('sep', { date: '2026-09-30' }),
      cancelled('oct', { date: '2026-10-01' }),
      cancelled('undated', { createdAt: new Date(NaN), cancelledAt: '2026-10-02T12:00:00Z' }),
    ];
    expect((await report(rows, [], '2026-10-01')).recent.map((row: any) => row.ref)).toEqual(['oct']);
    expect((await report(rows, [], undefined, '2026-09-30')).recent.map((row: any) => row.ref)).toEqual(['sep']);
    expect((await report(rows, [])).total).toBe(2);
  });
});
