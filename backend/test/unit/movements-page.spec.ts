import { buildMovementsPage } from '../../src/transactions/movements-page.util';
import { TransactionsService } from '../../src/transactions/transactions.service';

const sale = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  _id: id, type: 'مبيعات', ref: id, createdAt, transactionDate: createdAt,
  total: 100, shipCost: 10, remaining: 25, payStatus: 'معلق',
  client: 'Customer', pickupStatus: 'Pending', ...extra,
});

describe('Movements service visibility', () => {
  it('applies purchase permissions before sorting, counts, and pagination', async () => {
    const query = (value: unknown) => ({ select: jest.fn().mockReturnThis(),
      slice: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(value) });
    const transactionQuery = query([sale('1', '2026-10-10T10:00:00.000Z')]);
    const model = { find: jest.fn().mockReturnValue(transactionQuery) };
    const service = Object.create(TransactionsService.prototype) as TransactionsService;
    (service as any).transactionModel = model;
    (service as any).returnRequestModel = { find: jest.fn().mockReturnValue(query([])) };
    (service as any).supplierReturnModel = { find: jest.fn().mockReturnValue(query([])) };
    const result = await service.findMovementsPage({ page: 1, limit: 20 }, 'staff', false);
    expect(model.find).toHaveBeenCalledWith({ archived: { $ne: true },
      type: { $nin: ['مشتريات', 'مرتجع مشتريات'] } });
    expect(transactionQuery.select.mock.calls[0][0]).not.toMatch(/bostaAwbBase64/);
    expect(transactionQuery.sort).toHaveBeenCalledWith({ createdAt: -1, _id: -1 });
    expect(result.total).toBe(1);
    expect(result.tabCounts.purchase).toBe(0);
  });
});

describe('Movements server page', () => {
  const rows = [
    sale('1', '2026-10-10T10:00:00.000Z', { tags: ['priority'] }),
    sale('2', '2026-10-11T10:00:00.000Z', { pickupStatus: 'Delivered' }),
    sale('3', '2026-11-01T10:00:00.000Z', { total: 250 }),
    sale('4', '2026-09-01T10:00:00.000Z', { transactionDate: '' }),
  ];
  const returns = [{ _id: 'request', createdAt: '2026-10-12T10:00:00.000Z', status: 'معلق',
    requestKind: 'return', total: 100, client: 'Customer' }];

  it('pages after merging return requests and keeps the same total on every page', () => {
    const first = buildMovementsPage(rows, returns, [], { page: 1, limit: 2, sort: 'date-desc' });
    const second = buildMovementsPage(rows, returns, [], { page: 2, limit: 2, sort: 'date-desc' });
    expect(first.total).toBe(5);
    expect(second.total).toBe(5);
    expect(first.pageRows).toHaveLength(2);
    expect(second.pageRows).toHaveLength(2);
    expect(first.pageRows[0].tx?._id).toBe('3');
    expect(first.pageRows[1].r?._id).toBe('request');
  });

  it('uses transaction date and registration date exactly as the old filters did', () => {
    const state = { dateFrom: '2026-10-01', dateTo: '2026-10-31', limit: 20 };
    const byTransactionDate = buildMovementsPage(rows, returns, [], state);
    const byRegistrationDate = buildMovementsPage(rows, returns, [], { ...state, dateField: 'createdAt' });
    expect(byTransactionDate.transactionCount).toBe(3); // undated row remains included
    expect(byTransactionDate.total).toBe(4);
    expect(byRegistrationDate.transactionCount).toBe(2);
    expect(byRegistrationDate.total).toBe(3);
  });

  it('filters and sorts before slicing, while keeping tag filtering after KPI calculation', () => {
    const page = buildMovementsPage(rows, returns, [], { tag: 'priority', limit: 2,
      sort: 'amount-desc', search: 'Customer' });
    expect(page.total).toBe(1);
    expect(page.pageRows[0].tx?._id).toBe('1');
    expect(page.transactionCount).toBe(4);
    expect(page.kpi.sales).toBe(510);
    expect(page.facets.tags.priority).toBe(1);
  });
});
