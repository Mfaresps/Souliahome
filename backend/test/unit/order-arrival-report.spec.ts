import { TransactionsService } from '../../src/transactions/transactions.service';

it('reports confirmed arrivals even when their invoice date falls outside the selected period', async () => {
  const service: any = Object.create(TransactionsService.prototype);
  const sale = {
    _id: 'sale', type: 'مبيعات', shopifyOrderId: '42', date: '2026-10-23',
    confirmedAt: '2026-10-23T12:00:00Z', items: [], total: 100,
  };
  const query = (rows: unknown[]) => ({
    select: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: async () => rows,
  });
  service.transactionModel = { find: jest.fn(() => query([sale])) };
  service.shopifyOrderModel = { find: jest.fn(() => query([
    { shopifyId: '42', shopifyCreatedAt: '2026-10-20T12:00:00Z' },
    { shopifyId: 'cancelled', shopifyCreatedAt: '2026-10-20', cancelled: true },
  ])) };
  service.returnRequestModel = { find: jest.fn(() => query([])) };
  service.productsService = { findAll: async () => [] };
  service.getSettledSupplierReturns = async () => [];
  service.buildStagnantStock = async () => ({});
  service.buildCancellationsReport = async () => ({});
  service.buildShippingReport = async () => ({});
  const report = await service.getReports('2026-10-20', '2026-10-20');
  expect(report.orderActivity.series).toEqual([
    { date: '2026-10-20', receivedOrders: 2, confirmedOrders: 1 },
  ]);
  expect(service.transactionModel.find).toHaveBeenCalledWith({ type: 'مبيعات' });
  // Intake is independent of current order status and invoice-date filters.
  expect(service.shopifyOrderModel.find).toHaveBeenCalledWith();
});
