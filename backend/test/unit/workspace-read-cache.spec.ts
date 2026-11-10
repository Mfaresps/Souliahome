import { EventEmitter } from 'node:events';
import { ShopifyService } from '../../src/shopify/shopify.service';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { cachedRead, invalidateReadCaches } from '../../src/shared/read-cache.util';
import { invalidateReadCachesOnWrite } from '../../src/shared/read-cache.middleware';

const query = (rows: any[]) => ({ select: jest.fn().mockReturnThis(),
  slice: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(),
  lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(rows),
  // Shopify awaits its lean query directly, like Mongoose's thenable Query.
  then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
});

describe('Workspace display caches', () => {
  beforeEach(invalidateReadCaches);

  it('shares Shopify reads across pages and users while keeping drafts private', async () => {
    const order = { _id: 'one', status: 'pending', createdAt: new Date(),
      items: [], total: 100, depositReceipts: [
        { id: 'draft', status: 'مسودة', submittedById: 'owner', amount: 25 },
      ] };
    const service: any = Object.create(ShopifyService.prototype);
    service.shopifyOrderModel = { find: jest.fn(() => query([order])) };
    service.txModel = { find: jest.fn(() => query([])) };
    service.transactionsService = { getInventory: jest.fn(async () => []) };
    service.followUpsService = { findDashboardSummary: jest.fn(async () => []) };
    const [owner, other] = await Promise.all([
      service.getOrdersSummaryPage({ limit: '30' }, 'owner'),
      service.getOrdersSummaryPage({ limit: '50' }, 'other'),
    ]);
    expect(owner.rows[0].depositReceipts.map((r: any) => r.id)).toEqual(['draft']);
    expect(other.rows[0].depositReceipts).toEqual([]);
    expect(order.depositReceipts).toHaveLength(1);
    expect(service.shopifyOrderModel.find).toHaveBeenCalledTimes(1);
    expect(service.transactionsService.getInventory).toHaveBeenCalledTimes(1);
    expect(service.followUpsService.findDashboardSummary).toHaveBeenCalledTimes(1);
    // The inventory endpoint and Shopify reuse the same display computation.
    await cachedRead('inventory', 5000, () => service.transactionsService.getInventory());
    expect(service.transactionsService.getInventory).toHaveBeenCalledTimes(1);
    invalidateReadCaches();
    await service.getOrdersSummaryPage({}, 'other');
    expect(service.shopifyOrderModel.find).toHaveBeenCalledTimes(2);
    expect(service.transactionsService.getInventory).toHaveBeenCalledTimes(2);
  });

  it('reuses Movements reads but applies filters and role masking to each response', async () => {
    const rows = [
      { _id: 'sale', type: 'مبيعات', ref: '1', total: 100 },
      { _id: 'purchase', type: 'مشتريات', ref: '2', total: 70 },
    ];
    const service: any = Object.create(TransactionsService.prototype);
    service.transactionModel = { find: jest.fn(() => query(rows)) };
    service.returnRequestModel = { find: jest.fn(() => query([])) };
    service.supplierReturnModel = { find: jest.fn(() => query([])) };
    const admin = await service.findMovementsPage({}, 'admin', true);
    const staff = await service.findMovementsPage({}, 'staff', true);
    const search = await service.findMovementsPage({ search: '1' }, 'admin', true);
    expect(admin.pageRows.find((r: any) => r.tx._id === 'purchase').tx.total).toBe(70);
    expect(staff.pageRows.find((r: any) => r.tx._id === 'purchase').tx.total).toBeNull();
    expect(search.pageRows.map((r: any) => r.tx._id)).toEqual(['sale']);
    expect(service.transactionModel.find).toHaveBeenCalledTimes(1);
    await service.findMovementsPage({}, 'staff', false);
    expect(service.transactionModel.find).toHaveBeenCalledTimes(2);
    invalidateReadCaches();
    await service.findMovementsPage({}, 'admin', true);
    expect(service.transactionModel.find).toHaveBeenCalledTimes(3);
  });

  it('shares the pickup board read and discards it after a save', async () => {
    const service: any = Object.create(TransactionsService.prototype);
    service.transactionModel = { find: jest.fn(() => query([{ _id: 'one' }])) };
    await Promise.all([service.findPickupWorkspaceOrders(), service.findPickupWorkspaceOrders()]);
    expect(service.transactionModel.find).toHaveBeenCalledTimes(1);
    invalidateReadCaches();
    await service.findPickupWorkspaceOrders();
    expect(service.transactionModel.find).toHaveBeenCalledTimes(2);
  });

  it.each(['findStartupOverview', 'findDashboardOverview'])(
    'shares %s across tabs and separates purchase visibility', async method => {
      const service: any = Object.create(TransactionsService.prototype);
      service.transactionModel = { find: jest.fn(() => query([{ _id: 'one' }])),
        countDocuments: jest.fn(() => ({ exec: async () => 1 })) };
      await Promise.all([service[method](true), service[method](true)]);
      expect(service.transactionModel.find).toHaveBeenCalledTimes(1);
      await service[method](false);
      expect(service.transactionModel.find).toHaveBeenCalledTimes(2);
      invalidateReadCaches();
      await service[method](true);
      expect(service.transactionModel.find).toHaveBeenCalledTimes(3);
    });

  it.each(['/api/transactions/movements-page/', '/api/auth/update-last-seen'])(
    'keeps cached reads for %s and invalidates before and after real writes', async path => {
    let value = 1;
    const read = () => cachedRead('test', 5000, async () => value);
    await read(); value = 2;
    const filters = new EventEmitter();
    invalidateReadCachesOnWrite({ method: 'POST', path } as any, filters as any, jest.fn());
    filters.emit('finish'); filters.emit('close');
    expect(await read()).toBe(1);
    const write = new EventEmitter();
    invalidateReadCachesOnWrite({ method: 'POST', path: '/api/transactions/pickup-orders/preparing' } as any, write as any, jest.fn());
    expect(await read()).toBe(2);
    value = 3; write.emit('finish');
    expect(await read()).toBe(3);
  });
});
