jest.mock('../../src/employee-performance/employee-scoring.service', () => ({ EmployeeScoringService: class {} }));
import { FollowUpsService, DONE_STATUSES } from '../../src/followups/followups.service';

function fixture() {
  const service: any = Object.create(FollowUpsService.prototype);
  const row = { _id: 'ticket', responsibleId: 'employee', responsibleName: 'Sara', orderRef: '123', autoSource: 'shipping-issue',
    deferredUntil: new Date(Date.now() - 1000), deferReason: 'awaiting_return' };
  service.model = {
    findOneAndUpdate: jest.fn(() => ({ lean: async () => row })),
    find: jest.fn(() => ({ lean: async () => [row] })),
    updateOne: jest.fn(() => ({ exec: async () => ({}) })),
  };
  service.presence = { emitEvent: jest.fn(), emitToUser: jest.fn() };
  service.mentionsService = { create: jest.fn().mockResolvedValue({ _id: 'reminder' }) };
  service.notifications = { notifyFollowUpSchedule: jest.fn().mockResolvedValue(['employee', 'admin', 'manager']) };
  service.logger = { error: jest.fn(), warn: jest.fn() };
  return { service, row };
}
it.each(['confirmation_contact', 'awaiting_deposit', 'confirm_details', 'awaiting_customer', 'customer_postponed', 'carrier_delay', 'awaiting_return'])('persists %s and an audit note without resolving the issue', async reason => {
  const { service } = fixture();
  const until = new Date(Date.now() + 3600000).toISOString();
  await service.defer('ticket', { reason, until, note: 'موعد متفق عليه' }, 'employee', 'staff', 'Sara');
  const [filter, update] = service.model.findOneAndUpdate.mock.calls[0];
  expect(filter).toMatchObject({ responsibleId: 'employee', cancelled: { $ne: true }, status: { $nin: DONE_STATUSES } });
  if (['confirmation_contact', 'awaiting_deposit', 'confirm_details'].includes(reason)) {
    expect(filter).toMatchObject({ reason: 'عملية تأكيد الطلب', autoSource: { $ne: 'shipping-issue' } });
  }
  expect(update.$set).toMatchObject({ deferredUntil: new Date(until), deferReason: reason, deferReminderSent: false, escalationBaseline: new Date(until) });
  expect(update.$set.status).toBeUndefined();
  expect(update.$push.comments.text).toContain('موعد متفق عليه');
  expect(service.notifications.notifyFollowUpSchedule).toHaveBeenCalledWith(expect.objectContaining({id:'ticket', responsibleId:'employee', until, reason}), false, 'employee', 'Sara');
  expect(service.presence.emitToUser.mock.calls.map((call: any[]) => call[0])).toEqual(['employee', 'admin', 'manager']);
});
it('rejects invalid/past reminder times and inaccessible or closed tickets', async () => {
  const { service } = fixture();
  for (const until of ['invalid', new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 31 * 86400000).toISOString()]) {
    await expect(service.defer('ticket', { reason: 'carrier_delay', until }, 'employee', 'staff', 'Sara')).rejects.toThrow();
  }
  expect(service.model.findOneAndUpdate).not.toHaveBeenCalled();
  service.model.findOneAndUpdate.mockReturnValue({ lean: async () => null });
  await expect(service.defer('ticket', { reason: 'carrier_delay', until: new Date(Date.now() + 100000).toISOString() }, 'other', 'staff', 'Other')).rejects.toThrow('متابعاتك المفتوحة');
});
it('retries a saved task action without duplicating the note or notifications', async () => {
  const { service, row } = fixture();
  const requestId = 'a50cbd99-a110-4db8-a1b8-a6670a744c84';
  const dto = { reason: 'awaiting_customer', until: new Date(Date.now() + 3600000).toISOString(), note: 'Contacted via Vrobo', requestId, channel: 'vrobo' };
  service.model.findOneAndUpdate.mockReturnValueOnce({ lean: async () => row }).mockReturnValueOnce({ lean: async () => null });
  service.model.findOne = jest.fn(() => ({ lean: async () => row }));
  await service.defer('ticket', dto, 'employee', 'staff', 'Sara');
  await expect(service.defer('ticket', dto, 'employee', 'staff', 'Sara')).resolves.toEqual(row);
  expect(service.model.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ 'comments.requestKey': { $ne: requestId }, orderOutcome: { $in: ['', null] } });
  expect(service.model.findOneAndUpdate.mock.calls[0][1].$push.comments.requestKey).toBe(requestId);
  expect(service.model.findOneAndUpdate.mock.calls[0][1].$push.comments.contactChannel).toBe('vrobo');
  expect(service.model.findOne).toHaveBeenCalledWith({ _id: 'ticket', responsibleId: 'employee', comments: { $elemMatch: { requestKey: requestId, authorId: 'employee' } } });
  expect(service.notifications.notifyFollowUpSchedule).toHaveBeenCalledTimes(1);
});
it('reminds the employee and management when due and claims a reminder only once', async () => {
  const { service } = fixture();
  await service.scheduledDeferredScan();
  expect(service.notifications.notifyFollowUpSchedule).toHaveBeenCalledWith(expect.objectContaining({id:'ticket', responsibleId:'employee', reason:'awaiting_return'}), true);
  expect(service.presence.emitToUser.mock.calls.map((call: any[]) => call[0])).toEqual(['employee','admin','manager']);
  expect(service.model.findOneAndUpdate.mock.calls[0][0]).toMatchObject({ deferReminderSent: { $ne: true }, status: { $nin: DONE_STATUSES } });
  service.model.findOneAndUpdate.mockReturnValue({ lean: async () => null });
  await service.scheduledDeferredScan();
  expect(service.notifications.notifyFollowUpSchedule).toHaveBeenCalledTimes(1);
});
it('retries a failed reminder and suppresses escalation while deferred', async () => {
  const { service, row } = fixture();
  service.notifications.notifyFollowUpSchedule.mockRejectedValue(new Error('offline'));
  await service.scheduledDeferredScan();
  expect(service.model.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: 'ticket' }), { $set: { deferReminderSent: false } });
  service.model.updateOne.mockClear();
  row.deferredUntil = new Date(Date.now() + 3600000);
  await service.scheduledEscalationScan();
  expect(service.model.updateOne).not.toHaveBeenCalled();
});
it('keeps a committed schedule when its notification fails', async () => {
  const { service, row } = fixture();
  service.notifications.notifyFollowUpSchedule.mockRejectedValue(new Error('offline'));
  await expect(service.defer('ticket',{reason:'carrier_delay',until:new Date(Date.now()+100000).toISOString()},'employee','staff','Sara')).resolves.toEqual(row);
  expect(service.logger.warn).toHaveBeenCalled();
});
