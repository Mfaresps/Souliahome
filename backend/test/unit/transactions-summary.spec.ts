import { TransactionsService } from '../../src/transactions/transactions.service';

function makeService(rows: Record<string, any>[] = [], total = rows.length) {
  const query = {
    select: jest.fn().mockReturnThis(), slice: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(rows),
  };
  const model = {
    find: jest.fn().mockReturnValue(query),
    countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(total) }),
  };
  const service = Object.create(TransactionsService.prototype) as TransactionsService;
  (service as any).transactionModel = model;
  return { service, model, query };
}

describe('Transaction summary reads', () => {
  it('applies purchase visibility before skip and excludes AWB from the projection', async () => {
    const { service, model, query } = makeService([{ _id: 'one' }], 301);
    const result = await service.findSummaryPage({ page: 2, limit: 200, sort: 'oldest' }, false);
    expect(model.find).toHaveBeenCalledWith({ archived: { $ne: true }, type: { $nin: ['مشتريات', 'مرتجع مشتريات'] } });
    expect(model.countDocuments).toHaveBeenCalledWith(model.find.mock.calls[0][0]);
    expect(query.skip).toHaveBeenCalledWith(200);
    expect(query.limit).toHaveBeenCalledWith(200);
    expect(query.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
    expect(query.slice).toHaveBeenCalledWith('editHistory', 1);
    expect(query.select.mock.calls[0][0]).not.toMatch(/bostaAwbBase64|bostaAwbType/);
    expect(result).toMatchObject({ total: 301, page: 2, pageSize: 200 });
  });

  it('bounds page size and combines escaped search with date filters', async () => {
    const { service, model, query } = makeService();
    await service.findSummaryPage({ limit: 999, search: 'A.B', from: '2026-11-01', to: '2026-11-08' }, true);
    expect(query.limit).toHaveBeenCalledWith(200);
    const filter = model.find.mock.calls[0][0];
    expect(filter.$and).toHaveLength(2);
    expect(filter.$and[1].$or[0].ref.$regex).toBe('A\\.B');
  });

  it('keeps the legacy array response and hides AWB even for full list reads', async () => {
    const { service, model, query } = makeService([{ _id: 'one' }]);
    expect(await service.findAll()).toEqual([{ _id: 'one' }]);
    expect(model.find).toHaveBeenCalledWith({ archived: { $ne: true } });
    expect(query.select.mock.calls[0][0]).toMatchObject({ bostaAwbBase64: 0, bostaAwbType: 0 });
  });
});
