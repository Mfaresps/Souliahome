jest.mock('../../src/employee-performance/employee-scoring.service', () => ({ EmployeeScoringService: class {} }));
import { FollowUpsService, DONE_STATUSES } from '../../src/followups/followups.service';
import { BostaService } from '../../src/bosta/bosta.service';

function followUpFixture() {
  const service: any = Object.create(FollowUpsService.prototype);
  const exec = jest.fn().mockResolvedValue({ modifiedCount: 2 });
  service.model = { updateMany: jest.fn(() => ({ exec })) };
  service.presence = { emitEvent: jest.fn() };
  service.logger = { error: jest.fn() };
  return { service, exec };
}

describe('shipping alert completion', () => {
  it('closes all open shipping tickets with one audited terminal outcome', async () => {
    const { service, exec } = followUpFixture();
    await service.closeShippingIssueFollowUp('tx1', 'تم التسليم', 'Bosta');
    const [query, update] = service.model.updateMany.mock.calls[0];
    expect(query).toEqual({ transactionId: 'tx1', autoSource: 'shipping-issue', cancelled: { $ne: true }, status: { $nin: DONE_STATUSES } });
    expect(update.$set).toMatchObject({ status: 'تم حل المشكلة', resolution: 'تم التسليم', escalationLevel: 0 });
    expect(update.$set.closedAt).toBeInstanceOf(Date);
    expect(update.$push.comments.text).toContain('تم التسليم');
    expect(service.presence.emitEvent).toHaveBeenCalledWith('followup:changed', { action: 'update', transactionId: 'tx1' });
    service.presence.emitEvent.mockClear();exec.mockResolvedValue({ modifiedCount: 0 });
    await service.closeShippingIssueFollowUp('tx1', 'تم التسليم', 'Bosta');
    expect(service.presence.emitEvent).not.toHaveBeenCalled();
  });
  it('logs a closing failure without undoing a committed shipment update', async () => {
    const { service, exec } = followUpFixture();
    exec.mockRejectedValue(new Error('database offline'));
    await expect(service.closeShippingIssueFollowUp('tx1', 'resolved', 'system')).resolves.toBeUndefined();
    expect(service.presence.emitEvent).not.toHaveBeenCalled();
    expect(service.logger.error).toHaveBeenCalled();
  });
  function carrierFixture(state = 'open', currentStatus = 'FAILED_ATTEMPT') {
    const service: any = Object.create(BostaService.prototype);
    const tx = { _id: 'tx1', ref: '123', bostaStatus: currentStatus, shipIssueState: state, shipIssueTrigger: 'FAILED_ATTEMPT' };
    service.txModel = { findByIdAndUpdate: jest.fn().mockResolvedValue(tx) };
    service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    service.emit = jest.fn();
    service.autoSettleScheduleFor = async () => ({});
    service.resolveCodStatusUpdate = () => ({});
    service.followUpsService = { closeShippingIssueFollowUp: jest.fn().mockResolvedValue(undefined), openShippingIssueFollowUp: jest.fn().mockResolvedValue(undefined) };
    return { service, tx };
  }
  it.each([45])('closes the issue and employee alert after resolving carrier status %s', async code => {
    const { service, tx } = carrierFixture();
    await service.applyDeliveryUpdate('tx1', tx, { state: code }, 'webhook');
    expect(service.txModel.findByIdAndUpdate).toHaveBeenCalledWith('tx1', expect.objectContaining({ $set: expect.objectContaining({ shipIssueState: 'closed' }) }));
    expect(service.followUpsService.closeShippingIssueFollowUp).toHaveBeenCalledWith('tx1', expect.any(String), 'bosta:webhook');
  });
  it('repairs a stale employee alert on repeated delivered syncs', async () => {
    const { service, tx } = carrierFixture('closed', 'DELIVERED');
    await service.applyDeliveryUpdate('tx1', tx, { state: 45 }, 'webhook');
    expect(service.followUpsService.closeShippingIssueFollowUp).toHaveBeenCalledTimes(1);
  });
  it.each([46, 48, 47, 30, 41, 21])('keeps the issue open until delivery or final return handling for carrier status %s', async code => {
    const { service, tx } = carrierFixture('open', code === 47 ? 'FAILED_ATTEMPT' : 'IN_TRANSIT');
    await service.applyDeliveryUpdate('tx1', tx, { state: code }, 'webhook');
    expect(service.followUpsService.closeShippingIssueFollowUp).not.toHaveBeenCalled();
  });
});
