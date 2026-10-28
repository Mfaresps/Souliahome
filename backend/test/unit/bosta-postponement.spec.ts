jest.mock('../../src/employee-performance/employee-scoring.service', () => ({ EmployeeScoringService: class {} }));
import { BostaService } from '../../src/bosta/bosta.service';
import { isOpenShippingIssue } from '../../src/employee-performance/shipping-issue-state';

const orderStates = require('../../../frontend/public/order-status.js');
const reason = 'Postponed - the customer requested postponement for another day.';

function fixture(overrides: any = {}) {
  const service: any = Object.create(BostaService.prototype);
  const tx = { _id: 'tx1', ref: '123', type: 'مبيعات', bostaOrderId: 'b1',
    bostaStatus: 'OUT_FOR_DELIVERY', pickupStatus: 'Ready', ...overrides };
  service.txModel = { findByIdAndUpdate: jest.fn().mockResolvedValue(tx) };
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  service.emit = jest.fn();
  service.autoSettleScheduleFor = jest.fn().mockResolvedValue({});
  service.resolveCodStatusUpdate = jest.fn().mockReturnValue({});
  service.followUpsService = {
    openShippingIssueFollowUp: jest.fn().mockResolvedValue(undefined),
    closeShippingIssueFollowUp: jest.fn().mockResolvedValue(undefined),
  };
  service.notifications = { enqueue: jest.fn().mockResolvedValue(undefined) };
  return { service, tx };
}

describe('customer postponement from Bosta', () => {
  it.each([
    ['webhook', { state: 47, exceptionCode: 3, exceptionReason: reason }],
    ['webhook', { state: '47', exceptionCode: '3' }],
    ['webhook', { state: 47, exceptionReason: reason }],
    ['sync', { data: { state: { code: 47 }, exceptionCode: 3 } }],
    ['sync', { data: { state: { code: 47 }, exception: { code: 3, reason } } }],
    ['sync', { data: { currentStatus: { value: 'Exception' }, exceptionCode: 3 } }],
    ['sync', { data: { state: { code: 47 }, exception: { reason } } }],
    ['sync', { data: { state: { code: 47, lastExceptionCode: 3, exception: [{ code: 3, reason }] } } }],
  ])('%s postponement keeps the parcel in transit without a failure alert (%j)', async (source, payload) => {
    const { service, tx } = fixture();
    const result = await service.applyDeliveryUpdate(tx._id, tx, payload, source);
    expect(result).toMatchObject({ status: 'CUSTOMER_POSTPONED', statusLabel: 'العميل أجّل الاستلام' });
    expect(service.txModel.findByIdAndUpdate).toHaveBeenCalledWith(tx._id, expect.objectContaining({
      $set: expect.objectContaining({ bostaShippingStatus: 'InTransit', pickupStatus: 'Shipped', bostaRawResponse: payload }),
    }));
    expect(service.followUpsService.openShippingIssueFollowUp).toHaveBeenCalledWith(tx, 'CUSTOMER_POSTPONED', expect.objectContaining({ status: 'CUSTOMER_POSTPONED' }));
    expect(service.notifications.enqueue).toHaveBeenCalledWith('deliveryPostponed', expect.any(String), '123', 'tx:tx1', undefined, 'CUSTOMER_POSTPONED', expect.any(Object));
    expect(isOpenShippingIssue({ ...tx, bostaStatus: result.status })).toBe(false);
  });

  it.each([
    { state: 47 },
    { state: 47, exceptionCode: 7 },
    { state: 47, exceptionCode: 8 },
    { state: 47, exceptionCode: 21 },
    { state: 47, exceptionCode: 7, exceptionReason: reason },
    { state: 47, exceptionReason: 'Postponed - Business requested postponement for another day.' },
    { state: 47, attempts: [{ exception: { code: 3, reason } }] },
    { state: 100, exceptionCode: 3 },
    { state: 101, exceptionCode: 3 },
    { state: 102, exceptionCode: 3 },
    { state: 103, exceptionCode: 3 },
  ])('does not suppress real or unspecified exceptions: %j', async payload => {
    const { service, tx } = fixture();
    expect((await service.applyDeliveryUpdate(tx._id, tx, payload, 'webhook')).status).toBe('FAILED_ATTEMPT');
    expect(service.followUpsService.openShippingIssueFollowUp).toHaveBeenCalled();
    expect(service.notifications.enqueue).toHaveBeenCalledWith('deliveryProblem', expect.any(String), '123', 'tx:tx1', undefined, 'FAILED_ATTEMPT', expect.objectContaining({ deliveryReason: expect.any(String) }));
  });

  it.each([[41, 'OUT_FOR_DELIVERY'], [46, 'RETURNED'], [49, 'CANCELLED']])(
    'ignores old postponement metadata when state is %s', async (state, expected) => {
      const { service, tx } = fixture({ bostaStatus: 'CUSTOMER_POSTPONED' });
      expect((await service.applyDeliveryUpdate(tx._id, tx, { state, exceptionCode: 3 }, 'webhook')).status).toBe(expected);
    });

  it('repairs an old false failure only when its saved payload proves customer postponement', async () => {
    const raw = { data: { state: { code: 47 }, exceptionCode: 3 } };
    const { service, tx } = fixture({ bostaStatus: 'FAILED_ATTEMPT', shipIssueState: 'open',
      shipIssueTrigger: 'FAILED_ATTEMPT', bostaRawResponse: raw });
    await service.applyDeliveryUpdate(tx._id, tx, raw, 'sync');
    expect(service.txModel.findByIdAndUpdate).toHaveBeenCalledWith(tx._id, expect.objectContaining({
      $set: expect.objectContaining({ shipIssueState: '', shipIssueTrigger: '' }),
      $push: { deliveryAuditLog: expect.objectContaining({ action: 'BOSTA_POSTPONEMENT_CORRECTION' }) },
    }));
    expect(service.followUpsService.closeShippingIssueFollowUp).toHaveBeenCalledWith(tx._id, expect.stringContaining('تصحيح التصنيف'), 'bosta:sync');
  });

  it('repairs invoice 2883 shape after the postponed parcel returns to the warehouse', async () => {
    const exception = { code: 3, reason, time: '2026-10-28T08:46:38.320Z', scheduledAt: '2026-10-29T03:00:00.000Z' };
    const raw = { data: { state: { code: 24, lastExceptionCode: 3, exception: [exception] },
      deliveryAttemptsLength: 1, attempts: [{ type: 'delivery', exception }] } };
    const { service, tx } = fixture({ bostaStatus: 'IN_TRANSIT', shipIssueState: 'open',
      shipIssueTrigger: 'FAILED_ATTEMPT', bostaRawResponse: raw });
    expect((await service.applyDeliveryUpdate(tx._id, tx, raw, 'sync')).status).toBe('IN_TRANSIT');
    expect(service.txModel.findByIdAndUpdate).toHaveBeenCalledWith(tx._id, expect.objectContaining({
      $set: expect.objectContaining({ bostaDeliveryException: { code: 3, reason, at: exception.time, scheduledAt: exception.scheduledAt } }),
    }));
    expect(service.followUpsService.closeShippingIssueFollowUp).toHaveBeenCalled();
    expect(service.notifications.enqueue).toHaveBeenCalledWith('deliveryPostponed', expect.any(String), '123', 'tx:tx1', undefined, 'CUSTOMER_POSTPONED', expect.any(Object));
    expect(orderStates.resolve({ ...tx, bostaDeliveryException: exception }, 'transaction', 'ar').label).toBe('في الطريق · العميل أجّل الاستلام');
  });

  it.each([
    { deliveryAttemptsLength: 2, attempts: [{ type: 'delivery', exception: { code: 3 } }] },
    { deliveryAttemptsLength: 2, attempts: [{ type: 'delivery', exception: { code: 7 } }, { type: 'delivery', exception: { code: 3 } }] },
  ])('does not erase an issue using incomplete or mixed attempt history: %j', async history => {
    const { service, tx } = fixture({ bostaStatus: 'IN_TRANSIT', shipIssueState: 'open', shipIssueTrigger: 'FAILED_ATTEMPT' });
    await service.applyDeliveryUpdate(tx._id, tx, { data: { state: { code: 24, lastExceptionCode: 3 }, ...history } }, 'sync');
    expect(service.followUpsService.closeShippingIssueFollowUp).not.toHaveBeenCalled();
  });

  it.each([
    { state: 47, exceptionCode: 7 },
    { state: 47 },
    undefined,
  ])('preserves earlier unresolved failures without proof they were misclassified (%j)', async previous => {
    const { service, tx } = fixture({ bostaStatus: 'FAILED_ATTEMPT', shipIssueState: 'open',
      shipIssueTrigger: 'FAILED_ATTEMPT', bostaRawResponse: previous });
    await service.applyDeliveryUpdate(tx._id, tx, { state: 47, exceptionCode: 3 }, 'webhook');
    expect(service.followUpsService.closeShippingIssueFollowUp).not.toHaveBeenCalled();
    expect(isOpenShippingIssue({ ...tx, bostaStatus: 'CUSTOMER_POSTPONED' })).toBe(true);
  });

  it('does not reopen an alert on repeated postponement updates', async () => {
    const { service, tx } = fixture({ bostaStatus: 'CUSTOMER_POSTPONED' });
    await service.applyDeliveryUpdate(tx._id, tx, { state: 47, exceptionCode: 3 }, 'webhook');
    expect(service.followUpsService.openShippingIssueFollowUp).toHaveBeenCalledWith(tx, 'CUSTOMER_POSTPONED', expect.any(Object));
    expect(service.notifications.enqueue).toHaveBeenCalledWith('deliveryPostponed', expect.any(String), '123', 'tx:tx1', undefined, 'CUSTOMER_POSTPONED', expect.any(Object));
  });

  it('does not clear a genuine earlier issue on the next sync after postponement', async () => {
    const { service, tx } = fixture({ bostaStatus: 'CUSTOMER_POSTPONED', shipIssueState: 'open',
      shipIssueTrigger: 'FAILED_ATTEMPT', bostaRawResponse: { state: 47, exceptionCode: 3 } });
    await service.applyDeliveryUpdate(tx._id, tx, { state: 47, exceptionCode: 3 }, 'webhook');
    expect(service.followUpsService.closeShippingIssueFollowUp).not.toHaveBeenCalled();
  });

  it('still alerts when a customer refusal follows postponement', async () => {
    const { service, tx } = fixture({ bostaStatus: 'CUSTOMER_POSTPONED' });
    await service.applyDeliveryUpdate(tx._id, tx, { state: 47, exceptionCode: 8 }, 'webhook');
    expect(service.followUpsService.openShippingIssueFollowUp).toHaveBeenCalledWith(tx, 'FAILED_ATTEMPT', expect.objectContaining({ reasonCode: 8 }));
  });

  it('respects manually confirmed delivery', async () => {
    const { service, tx } = fixture({ bostaStatus: 'DELIVERED', deliverySource: 'MANUAL' });
    expect((await service.applyDeliveryUpdate(tx._id, tx, { state: 47, exceptionCode: 3 }, 'webhook')).status).toBe('DELIVERED');
    expect(service.notifications.enqueue).not.toHaveBeenCalled();
  });

  it.each(['ar', 'en'])('shows postponement as waiting with the carrier in %s', lang => {
    const meta = orderStates.resolve({ bostaOrderId: 'b1', bostaStatus: 'CUSTOMER_POSTPONED' }, 'transaction', lang);
    expect(meta).toMatchObject({ key: 'CUSTOMER_POSTPONED', tone: 'waiting',
      label: lang === 'ar' ? 'العميل أجّل الاستلام' : 'Postponed by Customer', carrier: lang === 'ar' ? 'بوسطة' : 'Bosta' });
    expect(orderStates.badge(meta)).toContain('data-tone="waiting"');
  });
});
