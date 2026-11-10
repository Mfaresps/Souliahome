import { TransactionsService } from '../../src/transactions/transactions.service';
import { notificationBody } from '../../src/notifications/notifications.service';
import { notificationTitle } from '../../src/notifications/notification-titles';

const ids = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'];
function fixture(existing: any = null) {
  const service: any = Object.create(TransactionsService.prototype);
  service.transactionModel = {
    find: jest.fn(() => ({ select: () => ({ exec: async () => ids.map(_id => ({ _id })) }) })),
    findOne: jest.fn(() => ({ select: () => ({ lean: async () => existing }) })),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
    countDocuments: jest.fn().mockResolvedValue(existing ? 8 : 2),
  };
  service.notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  service.emit = jest.fn();
  return service;
}

describe('Preparation group notifications', () => {
  it.each([null, { prepCreatedAt: '2026-11-10T09:00:00Z', prepNote: 'Existing group' }])(
    'sends one notification after the group is saved, with the total group size: %j', async existing => {
      const service = fixture(existing);
      await expect(service.setPickupPreparing([...ids, ids[0]], 'Fares', '710-10NOV')).resolves.toEqual({ updated: 2 });
      expect(service.notifications.enqueue).toHaveBeenCalledTimes(1);
      expect(service.notifications.enqueue).toHaveBeenCalledWith('approval', expect.stringContaining('prep-group:710-10NOV:'),
        '710-10NOV', 'prep-group:710-10NOV', undefined, undefined, {
          actionKey: 'prep-group', status: 'approved', prepRef: '710-10NOV', orderCount: existing ? 8 : 2, actorName: 'Fares',
        });
      expect(service.transactionModel.countDocuments).toHaveBeenCalledWith({
        pickupRef: '710-10NOV', pickupStatus: 'Preparing', type: 'مبيعات', cancelled: { $ne: true },
      });
      expect(service.transactionModel.updateMany.mock.invocationCallOrder[0]).toBeLessThan(service.notifications.enqueue.mock.invocationCallOrder[0]);
    },
  );

  it('does not announce a failed group update', async () => {
    const service = fixture();
    service.transactionModel.updateMany.mockResolvedValue({ modifiedCount: 0 });
    await expect(service.setPickupPreparing(ids, 'Fares', '710-10NOV')).rejects.toThrow();
    expect(service.notifications.enqueue).not.toHaveBeenCalled();
  });

  it('keeps a committed preparation successful when counting or sending notifications fails', async () => {
    for (const failure of ['count', 'enqueue']) {
      const service = fixture();
      if (failure === 'count') service.transactionModel.countDocuments.mockRejectedValue(new Error('offline'));
      else service.notifications.enqueue.mockRejectedValue(new Error('offline'));
      await expect(service.setPickupPreparing(ids, 'Fares', '710-10NOV')).resolves.toEqual({ updated: 2 });
    }
  });

  it.each([
    ['en', '📦 Prep group orders', '710-10NOV · 12 orders'],
    ['ar', '📦 طلبات مجموعة التحضير', '710-10NOV · عدد الطلبات: 12'],
  ] as const)('shows only the group reference and count in %s', (language, title, body) => {
    const details = { actionKey: 'prep-group', status: 'approved' as const, prepRef: '710-10NOV', orderCount: 12, actorName: 'Fares' };
    expect(notificationTitle('approval', details, language)).toBe(title);
    expect(notificationBody('approval', '710-10NOV', details, language)).toBe(body);
  });

  it('uses the singular order label and rejects invalid counts', () => {
    const details = { actionKey: 'prep-group', prepRef: '710-10NOV', orderCount: 1 };
    expect(notificationBody('approval', '', details, 'en')).toBe('710-10NOV · 1 order');
    for (const orderCount of [0, -1, NaN, Infinity, 1.5]) {
      expect(notificationBody('approval', '', { ...details, orderCount }, 'en')).toBe('');
    }
  });
});
