import { ShopifyService } from '../../src/shopify/shopify.service';
import { ShopifyController } from '../../src/shopify/shopify.controller';

describe('Deposit review transport', () => {
  it('reads only orders with requested pending receipts and excludes large unrelated fields', async () => {
    const rows = [{ _id: 'order', depositReceipts: [{ id: 'receipt', status: 'معلق', ocr: { confident: true }, warnings: [] }] }];
    const query = { select: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue(rows) };
    const service = Object.create(ShopifyService.prototype) as any;
    service.shopifyOrderModel = { find: jest.fn(() => query) };
    expect(await service.getDepositReviewOrders()).toBe(rows);
    expect(service.shopifyOrderModel.find).toHaveBeenCalledWith({ depositReceipts: { $elemMatch: {
      status: 'معلق', $or: [{ 'workflow.version': { $ne: 2 } }, { 'workflow.stage': 'requested' }],
    } } });
    expect(query.select.mock.calls[0][0]).toContain('-rawData');
    expect(query.select.mock.calls[0][0]).not.toContain('-depositReceipts');
    expect(query.sort).toHaveBeenCalledWith({ createdAt: -1 });
  });
  it('restricts the queue endpoint to administrators', () => {
    expect(Reflect.getMetadata('roles', ShopifyController.prototype.getDepositReview)).toEqual(['admin']);
  });
});
