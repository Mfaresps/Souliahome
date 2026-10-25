import { ShopifyService } from '../../src/shopify/shopify.service';
import { ShopifyController } from '../../src/shopify/shopify.controller';

describe('Shopify preparation actor', () => {
  it.each([
    { userId: 'picker-id', name: 'Fares', username: 'fares-login' },
    { userId: 'picker-id', username: 'fares-login' },
  ])('takes the actor from the authenticated account: %j', async user => {
    const service = { approveOrder: jest.fn().mockResolvedValue({ success: true }) };
    const controller = new ShopifyController(service as any, undefined as any, undefined as any);
    await controller.approve('order-id', 'bosta', { user, body: { actorName: 'Gannh' } });
    expect(service.approveOrder).toHaveBeenCalledWith('order-id', user.name || user.username, 'bosta', user.userId);
  });

  it('attributes movements and preparation notifications to the picker while retaining the assigned employee', async () => {
    const service: any = Object.create(ShopifyService.prototype);
    const order = {
      _id: 'order-id', status: 'pending', assignedToName: 'Gannh', ref: '2924',
      shopifyId: 'shopify-id', total: 100, itemsTotal: 100, depositReceipts: [],
      items: [{ code: '40', name: 'Infinity runner', qty: 1 }],
      toObject() { return this; },
    };
    service.shopifyOrderModel = {
      findById: jest.fn().mockResolvedValue(order),
      findOneAndUpdate: jest.fn(() => ({ exec: jest.fn().mockResolvedValue(order) })),
    };
    service.txModel = { create: jest.fn(async data => ({ ...data, _id: 'tx-id' })) };
    service.settingsService = { getSettings: jest.fn().mockResolvedValue({}) };
    service.transactionsService = {
      getInventory: jest.fn().mockResolvedValue([{ _id: 'product-id', code: '40', current: 2 }]),
      assertWarehouseSale: jest.fn(),
    };
    service.inventoryMovementsService = { record: jest.fn() };
    service.depositReceipts = { discardDrafts: jest.fn() };
    service.notifications = { enqueue: jest.fn() };
    service.emit = jest.fn();
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    await service.approveOrder('order-id', 'Fares', undefined, 'picker-id');

    expect(service.txModel.create).toHaveBeenCalledWith(expect.objectContaining({
      employee: 'Gannh', assignedToName: 'Gannh', confirmedByName: 'Fares',
    }));
    expect(service.inventoryMovementsService.record).toHaveBeenCalledWith([
      expect.objectContaining({ by: 'Fares', sourceTransactionRef: '2924' }),
    ]);
    expect(service.notifications.enqueue).toHaveBeenCalledWith(
      'approval', 'approval:shopify:order-id:approved', '2924', 'shopify:order-id', undefined, undefined,
      expect.objectContaining({ actorName: 'Fares', actorUserId: 'picker-id', actionKey: 'order', status: 'approved' }),
    );
    expect(service.emit).toHaveBeenCalledWith('tx:created', expect.objectContaining({ by: 'Fares' }));
  });
});
