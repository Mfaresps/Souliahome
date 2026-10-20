import { TransactionsService } from '../../src/transactions/transactions.service';

it('reads pickup rows as plain objects while retaining the existing eligibility and ordering', async () => {
  const service: any = Object.create(TransactionsService.prototype);
  const rows = [{ _id: 'one', pickupStatus: 'Preparing' }];
  const query: any = { select: jest.fn(), sort: jest.fn(), lean: jest.fn(), exec: jest.fn().mockResolvedValue(rows) };
  ['select', 'sort', 'lean'].forEach(method => query[method].mockReturnValue(query));
  service.transactionModel = { find: jest.fn().mockReturnValue(query) };
  expect(await service.findPickupOrders()).toBe(rows);
  expect(service.transactionModel.find).toHaveBeenCalledWith({ type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true } });
  expect(query.sort).toHaveBeenCalledWith({ createdAt: -1 });
  expect(query.lean).toHaveBeenCalledTimes(1);
});

it('broadcasts the persisted preparation metadata so other devices can build the same group', async () => {
  const service: any = Object.create(TransactionsService.prototype);
  const id = '64b000000000000000000001';
  const groupMeta = { prepNote: 'Fragile', prepShipCo: 'Manual', prepCreatedAt: '2026-10-20', prepCreatedBy: 'Picker' };
  service.transactionModel = {
    find: () => ({ select: () => ({ exec: async () => [{ _id: id }] }) }),
    findOne: () => ({ select: () => ({ lean: async () => groupMeta }) }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
  service.emit = jest.fn();
  await service.setPickupPreparing([id], 'Other picker', 'PREP-A');
  expect(service.emit).toHaveBeenCalledWith('pickup:updated', expect.objectContaining({ ids: [id], pickupRef: 'PREP-A', groupMeta }));
});
