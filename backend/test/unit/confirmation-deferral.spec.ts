import { ShopifyService } from '../../src/shopify/shopify.service';
import { confirmationDeferralActive } from '../../src/shopify/confirmation-deferral.util';

const actor = { id: 'u1', name: 'Reem' };
const inHours = (h: number) => new Date(Date.now() + h * 3600000).toISOString();

function fixture(order: any) {
  const service: any = Object.create(ShopifyService.prototype);
  const doc = order ? { ...order, save: jest.fn(async () => {}), markModified: jest.fn() } : null;
  service.shopifyOrderModel = {
    findOne: jest.fn(async (q: any) => (doc && (!q.status || doc.status === q.status) ? doc : null)),
    find: jest.fn(() => ({ select: () => ({ limit: () => ({ lean: async () => (doc ? [doc] : []) }) }) })),
    updateOne: jest.fn(async () => ({ modifiedCount: 1, matchedCount: 1 })),
  };
  service.presence = { emitEvent: jest.fn() };
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  service.notifications = { enqueue: jest.fn(async () => {}) };
  service.followUpsService = { recordConfirmationDeferral: jest.fn(async () => ({ id: 'f'.repeat(24), responsibleId: 'u1' })),
    clearConfirmationDeferral: jest.fn(async () => {}) };
  return { service, doc };
}

describe('Shopify confirmation deferral («تأجيل التواصل»)', () => {
  it('stores the time, reason, who, and counts each deferral', async () => {
    const { service, doc } = fixture({ _id: 'a'.repeat(24), status: 'pending' });
    await service.deferConfirmation(doc._id, { dueAt: inHours(2), reasonCode: 'no_answer' }, actor);
    expect(doc.confirmationDeferral).toEqual(expect.objectContaining({ status: 'scheduled', reasonCode: 'no_answer', count: 1, createdBy: 'Reem' }));
    await service.deferConfirmation(doc._id, { dueAt: inHours(5), reasonCode: 'call_later' }, actor);
    expect(doc.confirmationDeferral.count).toBe(2);
    expect(doc.confirmationDeferralHistory.map((h: any) => h.action)).toEqual(['scheduled', 'rescheduled']);
    expect(service.presence.emitEvent).toHaveBeenCalledWith('shopify:confirmation-deferral-changed', expect.anything());
  });

  it('refuses a past time, more than 14 days, an unknown reason and «other» without a note', async () => {
    const { service, doc } = fixture({ _id: 'b'.repeat(24), status: 'pending' });
    await expect(service.deferConfirmation(doc._id, { dueAt: inHours(-1), reasonCode: 'busy' }, actor)).rejects.toThrow();
    await expect(service.deferConfirmation(doc._id, { dueAt: inHours(24 * 15), reasonCode: 'busy' }, actor)).rejects.toThrow();
    await expect(service.deferConfirmation(doc._id, { dueAt: inHours(2), reasonCode: 'nope' }, actor)).rejects.toThrow();
    await expect(service.deferConfirmation(doc._id, { dueAt: inHours(2), reasonCode: 'other', note: '' }, actor)).rejects.toThrow();
    await service.deferConfirmation(doc._id, { dueAt: inHours(2), reasonCode: 'other', note: 'يسافر غدًا' }, actor);
    expect(doc.confirmationDeferral.note).toBe('يسافر غدًا');
  });

  it('refuses a confirmed order (deposit recorded, ship without deposit, confirmed tag)', async () => {
    for (const extra of [{ depositReceipts: [{ status: 'معلق', amount: 200 }] }, { shipWithoutDeposit: true }, { tags: 'vip, confirmed' }]) {
      const { service, doc } = fixture({ _id: '9'.repeat(24), status: 'pending', ...extra });
      await expect(service.deferConfirmation(doc._id, { dueAt: inHours(2), reasonCode: 'busy' }, actor)).rejects.toThrow('غير المؤكدة');
    }
  });

  it('refuses an order that is no longer pending', async () => {
    const { service, doc } = fixture({ _id: 'c'.repeat(24), status: 'approved' });
    await expect(service.deferConfirmation(doc._id, { dueAt: inHours(2), reasonCode: 'busy' }, actor)).rejects.toThrow();
  });

  it('cancel ends it; active() follows the order state', async () => {
    const { service, doc } = fixture({ _id: 'd'.repeat(24), status: 'pending' });
    await service.deferConfirmation(doc._id, { dueAt: inHours(2), reasonCode: 'busy' }, actor);
    expect(confirmationDeferralActive(doc)).toBe(true);
    expect(confirmationDeferralActive({ ...doc, status: 'approved' })).toBe(false);
    await service.cancelConfirmationDeferral(doc._id, actor);
    expect(doc.confirmationDeferral.status).toBe('cancelled');
    expect(confirmationDeferralActive(doc)).toBe(false);
  });

  it('reminds the employee who deferred it and the assignee, once per time', async () => {
    const { service, doc } = fixture({ _id: 'e'.repeat(24), ref: '3276', status: 'pending', assignedTo: 'u2',
      confirmationDeferral: { dueAt: inHours(-0.1), status: 'scheduled', createdById: 'u1', reasonCode: 'busy' } });
    await service.notifyDueConfirmationDeferrals();
    expect(service.notifications.enqueue).toHaveBeenCalledWith('followup', expect.stringContaining('confirm-deferral-due:'), '3276',
      'shopify:' + doc._id, ['u1', 'u2'], undefined, expect.objectContaining({ actionKey: 'followup-due', followupReason: 'confirmation_contact' }));
    service.shopifyOrderModel.updateOne = jest.fn(async () => ({ modifiedCount: 0, matchedCount: 0 }));
    service.notifications.enqueue.mockClear();
    await service.notifyDueConfirmationDeferrals();
    expect(service.notifications.enqueue).not.toHaveBeenCalled();
  });

  it('writes the deferral into the order follow-up and clears it on cancel', async () => {
    const { service, doc } = fixture({ _id: '1'.repeat(24), ref: '3276', status: 'pending' });
    const r = await service.deferConfirmation(doc._id, { dueAt: inHours(3), reasonCode: 'no_answer', note: 'بعد العصر' }, actor);
    expect(service.followUpsService.recordConfirmationDeferral).toHaveBeenCalledWith(doc, expect.any(Date), 'no_answer', 'لا يرد على الهاتف', 'بعد العصر', actor);
    expect(r.confirmationDeferral.followUpId).toBe('f'.repeat(24));
    doc.confirmationDeferral.followUpId = 'f'.repeat(24);
    await service.cancelConfirmationDeferral(doc._id, actor);
    expect(service.followUpsService.clearConfirmationDeferral).toHaveBeenCalledWith('f'.repeat(24), doc.confirmationDeferral.dueAt, actor);
  });

  it('does not remind the follow-up owner twice (the follow-up reminds them)', async () => {
    const { service } = fixture({ _id: '2'.repeat(24), ref: '1', status: 'pending', assignedTo: 'u2',
      confirmationDeferral: { dueAt: inHours(-0.1), status: 'scheduled', createdById: 'u1', reasonCode: 'busy', followUpId: 'f'.repeat(24), followUpResponsibleId: 'u1' } });
    await service.notifyDueConfirmationDeferrals();
    expect(service.notifications.enqueue.mock.calls[0][4]).toEqual(['u2']);
  });
});
