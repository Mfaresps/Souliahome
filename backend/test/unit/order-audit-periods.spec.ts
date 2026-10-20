import { OrderAuditService } from '../../src/shopify/order-audit.service';
const model = (rows: any[]) => ({ find: jest.fn(() => ({ lean: async () => rows })) });
function service(orders: any[], transactions: any[] = []) {
  const value: any = Object.create(OrderAuditService.prototype);
  value.txModel = model(transactions); value.shopifyOrderModel = model(orders); value.productModel = model([]);
  value.loadReviews = jest.fn(async () => new Map()); value.saveAuditLog = jest.fn(async () => {});
  return value as OrderAuditService;
}
it('combines nonconsecutive months without including intervening months or inferred numeric gaps', async () => {
  const s = service([
    { ref: '10', status: 'pending', total: 100, shopifyCreatedAt: '2026-01-15T10:00:00Z' },
    { ref: '20', status: 'pending', total: 200, shopifyCreatedAt: '2026-02-15T10:00:00Z' },
    { ref: '10000', status: 'pending', total: 300, shopifyCreatedAt: '2026-03-15T10:00:00Z' },
  ]);
  const r = await s.runAuditPeriod({ fromDate: '2026-01-01', toDate: '2026-03-31', months: '1,3', year: '2026' }, { persist: false });
  expect(r.rows.map(row => row.orderNumber)).toEqual(['10', '10000']);
  expect(r.sequence.expectedCount).toBe(2); expect(r.sequence.missingCount).toBe(0);
  expect(r.period?.months).toEqual([1, 3]);
});
it('uses Cairo day boundaries and prefers the actual Shopify date over later transaction creation', async () => {
  const s = service([
    { ref: '1', status: 'pending', shopifyCreatedAt: '2026-09-30T22:30:00Z' },
    { ref: '2', status: 'pending', shopifyCreatedAt: '2026-09-15T10:00:00Z' },
    { ref: '3', status: 'pending', shopifyCreatedAt: '2026-10-20T22:30:00Z' },
  ], [{ ref: '2', total: 300, date: '2026-10-05', type: 'مبيعات' }]);
  const r = await s.runAuditPeriod({ fromDate: '2026-10-01', toDate: '2026-10-20' }, { persist: false });
  expect(r.rows.map(row => row.orderNumber)).toEqual(['1']);
});
it('returns empty summaries for an empty period and validates months/date input', async () => {
  const s = service([]);
  const r = await s.runAuditPeriod({ fromDate: '2026-10-01', toDate: '2026-10-20' }, { persist: false });
  expect(r.rows).toEqual([]); expect(r.sequence.expectedCount).toBe(0); expect(r.financials.totalSales).toBe(0);
  await expect(s.runAuditPeriod({ fromDate: '2026-02-30', toDate: '2026-03-01' })).rejects.toThrow();
  await expect(s.runAuditPeriod({ fromDate: '2026-01-01', toDate: '2026-03-01', months: '13', year: '2026' })).rejects.toThrow();
  await expect(s.runAuditPeriod({ fromDate: '2026-01-01', toDate: '2026-03-01', months: '1', year: 'bad' })).rejects.toThrow();
});
