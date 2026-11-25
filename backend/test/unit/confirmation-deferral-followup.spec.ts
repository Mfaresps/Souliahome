import { FollowUpsService } from '../../src/followups/followups.service';

const actor = { id: 'u1', name: 'Reem' };
const order = { _id: 'a'.repeat(24), shopifyId: '999', ref: '3276', client: 'سمر', phone: '01012345678' };

function fixture(existing: any) {
  const service: any = Object.create(FollowUpsService.prototype);
  let saved: any = null;
  service.model = {
    findOne: jest.fn(() => ({ sort: () => ({ lean: async () => existing }) })),
    create: jest.fn(async (data: any) => { saved = { _id: 'n'.repeat(24), ...data }; return { toObject: () => saved }; }),
    findOneAndUpdate: jest.fn((_q: any, update: any) => ({ lean: async () => ({ ...(existing || saved), ...update.$set, _id: (existing || saved)._id }) })),
    find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })),
  };
  service.generateTicketNo = jest.fn(async () => 'FU-1');
  service.presence = { emitEvent: jest.fn(), emitToUser: jest.fn() };
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  service.notifications = { notifyFollowUpSchedule: jest.fn(async () => ['u1']) };
  return { service };
}

describe('Confirmation deferral → follow-up thread', () => {
  it('opens a confirmation follow-up for the employee when none exists, then defers it with a comment', async () => {
    const { service } = fixture(null);
    const until = new Date(Date.now() + 3600000);
    const r = await service.recordConfirmationDeferral(order, until, 'no_answer', 'لا يرد على الهاتف', 'بعد العصر', actor);
    expect(service.model.create).toHaveBeenCalledWith(expect.objectContaining({ reason: 'عملية تأكيد الطلب', status: 'العميل لم يرد',
      responsibleId: 'u1', shopifyOrderId: order._id, orderRef: '3276' }));
    const update = service.model.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set).toEqual(expect.objectContaining({ deferredUntil: until, deferReason: 'confirmation_contact' }));
    expect(update.$push.comments.text).toContain('موعد المتابعة: ' + until.toISOString());
    expect(update.$push.comments.authorName).toBe('Reem');
    expect(r).toEqual({ id: 'n'.repeat(24), responsibleId: 'u1' });
    expect(service.presence.emitEvent).toHaveBeenCalledWith('followup:changed', expect.anything());
  });

  it('reuses the open follow-up of the order', async () => {
    const { service } = fixture({ _id: 'e'.repeat(24), reason: 'عملية تأكيد الطلب', responsibleId: 'u9', orderRef: '3276' });
    const r = await service.recordConfirmationDeferral(order, new Date(Date.now() + 3600000), 'consulting', 'يستشير شخصًا آخر', '', actor);
    expect(service.model.create).not.toHaveBeenCalled();
    expect(service.model.findOneAndUpdate.mock.calls[0][1].$set.status).toBe('العميل مازال متردد');
    expect(r.responsibleId).toBe('u9');
  });
});
