jest.mock('../../src/employee-performance/employee-scoring.service', () => ({ EmployeeScoringService: class {} }));
import { BostaService } from '../../src/bosta/bosta.service';
import { FollowUpsService, DONE_STATUSES } from '../../src/followups/followups.service';
import { carrierTrackingUpdate, carrierExceptionHistory } from '../../src/bosta/bosta-tracking.util';
import { notificationBody } from '../../src/notifications/notifications.service';

function fixture() {
  let ticket: any = null;
  const state: any = { _id: 't1', ref: '2883', bostaOrderId: 'b1', bostaStatus: 'OUT_FOR_DELIVERY', type: 'مبيعات', bostaTrackingEvents: [] };
  const follow: any = Object.create(FollowUpsService.prototype);
  follow.model = {
    findOne: () => ({ sort: () => ({ exec: async () => ticket }) }),
    create: jest.fn(async value => {
      ticket = { ...value, _id: 'f1', save: jest.fn(async () => ticket) };
      return ticket;
    }),
    updateMany: jest.fn((query, update) => ({ exec: async () => {
      if (!ticket || (query['comments.requestKey'] && ticket.comments.some(c => c.requestKey === query['comments.requestKey'].$ne))
        || (query.status && DONE_STATUSES.includes(ticket.status))) return { modifiedCount: 0 };
      Object.assign(ticket, update.$set || {});
      if (update.$push?.comments) ticket.comments.push(update.$push.comments);
      return { modifiedCount: 1 };
    } })),
  };
  follow.pickAvailableAssignee = jest.fn(async () => ({ userId: 'u1', name: 'Test', reason: 'shift-online' }));
  follow.generateTicketNo = async () => 'FU-2883-1';
  follow.notifyAssignee = jest.fn(async () => {});
  follow.presence = { emitEvent: jest.fn() };
  follow.logger = { log() {}, warn() {}, error: jest.fn() };
  const service: any = Object.create(BostaService.prototype);
  service.txModel = {
    findByIdAndUpdate: jest.fn(async (_id, update) => {
      Object.assign(state, update.$set || {});
      for (const event of update.$addToSet?.bostaTrackingEvents?.$each || []) {
        if (!state.bostaTrackingEvents.some(e => e.key === event.key)) state.bostaTrackingEvents.push(event);
      }
      return structuredClone(state);
    }),
    findById: () => ({ lean: async () => structuredClone(state) }),
    findOne: () => ({ lean: async () => structuredClone(state) }),
  };
  service.logger = follow.logger;
  service.emit = jest.fn();
  service.resolveCodStatusUpdate = () => ({});
  service.autoSettleScheduleFor = async () => ({});
  service.followUpsService = follow;
  service.notifications = { enqueue: jest.fn(async () => {}) };
  service.applyAfterSalesUpdate = async () => false;
  return { service, state, follow, ticket: () => ticket,
    run: async (payload: any, source = 'webhook') => service.applyDeliveryUpdate(state._id, structuredClone(state), payload, source) };
}

const failed = (code: number, attempt = 1) => ({ state: 47, exceptionCode: code,
  exceptionReason: code === 7 ? 'Customer is not answering.' : 'Cancellation - the customer refuses to receive the shipment.',
  numberOfAttempts: attempt });

describe('carrier evidence and one follow-up thread', () => {
  it('opens with the actual reason, updates it without a state change, and ignores replay', async () => {
    const f = fixture();
    await f.run(failed(7));
    expect(f.ticket().comments[0].text).toContain('العميل لا يرد');
    expect(f.ticket().comments[0].text).toContain('Customer is not answering.');
    await f.run(failed(8, 2));
    expect(f.ticket().comments).toHaveLength(2);
    expect(f.ticket().comments[1].text).toContain('العميل رفض الاستلام');
    expect(f.state.bostaTrackingEvents).toHaveLength(2);
    await f.run(failed(8, 2));
    expect(f.ticket().comments).toHaveLength(2);
    expect(f.state.bostaTrackingEvents).toHaveLength(2);
    expect(f.follow.model.create).toHaveBeenCalledTimes(1);
    expect(f.service.notifications.enqueue).toHaveBeenCalledTimes(1);
  });

  it('does not reopen a manually settled ticket for replay, but does for a new attempt', async () => {
    const f = fixture();
    await f.run(failed(7));
    f.ticket().status = 'تم حل المشكلة'; f.state.shipIssueState = 'closed';
    await f.run(failed(7));
    expect(f.ticket().status).toBe('تم حل المشكلة');
    expect(f.state.shipIssueState).toBe('closed');
    await f.run(failed(7, 2));
    expect(f.ticket().status).toBe('في انتظار المتابعة');
    expect(f.state.shipIssueState).toBe('open');
    expect(f.follow.model.create).toHaveBeenCalledTimes(1);
  });

  it('creates a postponement ticket, retains its reminder through movement, and closes it at delivery', async () => {
    const f = fixture(), scheduledAt = new Date(Date.now() + 86400000).toISOString();
    await f.run({ state: 47, exceptionCode: 3, exception: { scheduledAt } });
    expect(f.ticket()).toMatchObject({ autoSource: 'shipping-followup', autoTrigger: 'CUSTOMER_POSTPONED', reason: 'أجل الاستلام', deferReason: 'customer_postponed' });
    expect(f.ticket().deferredUntil.toISOString()).toBe(scheduledAt);
    expect(f.state.shipIssueState).toBeUndefined();
    expect(f.service.notifications.enqueue).toHaveBeenCalledWith('deliveryPostponed', expect.any(String), '2883', 'tx:t1', undefined, 'CUSTOMER_POSTPONED', expect.any(Object));
    await f.run({ state: 41 });
    expect(f.ticket().comments.at(-1).text).toContain('خارج للتسليم');
    expect(f.ticket().deferredUntil.toISOString()).toBe(scheduledAt);
    await f.run({ state: 45 });
    expect(f.ticket().status).toBe('تم حل المشكلة');
    expect(f.ticket().comments.at(-1).text).toContain('تم تسليم');
  });

  it('uses the same postponement ticket if a genuine failure follows', async () => {
    const f = fixture();
    await f.run({ state: 47, exceptionCode: 3 });
    await f.run(failed(8));
    expect(f.ticket()).toMatchObject({ autoSource: 'shipping-issue', autoTrigger: 'FAILED_ATTEMPT', reason: 'مشكلة في الاستلام', deferredUntil: null });
    expect(f.follow.model.create).toHaveBeenCalledTimes(1);
    expect(f.state.shipIssueState).toBe('open');
  });

  it('does not reopen an employee-settled postponement just because the same exception appears again after movement', async () => {
    const f = fixture();
    await f.run({ state: 47, exceptionCode: 3, numberOfAttempts: 1 });
    f.ticket().status = 'تمت المتابعة';
    await f.run({ state: 41 });
    await f.run({ state: 24, exceptionCode: 3, numberOfAttempts: 1 });
    expect(f.ticket().status).toBe('تمت المتابعة');
  });

  it('converts a previously corrected legacy failure ticket to postponement even if its update was already logged', async () => {
    const f = fixture();
    await f.run(failed(7));
    f.ticket().status = 'تم حل المشكلة';
    const event = carrierTrackingUpdate({ state: 24 }, 'IN_TRANSIT', 'في الطريق', 'b1',
      { code: 3, reason: 'Customer postponed' }, 'sync', new Date().toISOString());
    await f.follow.recordCarrierUpdate('t1', event);
    await f.follow.openShippingIssueFollowUp(f.state, 'CUSTOMER_POSTPONED', event);
    expect(f.ticket()).toMatchObject({ autoSource: 'shipping-followup', autoTrigger: 'CUSTOMER_POSTPONED', status: 'في انتظار المتابعة' });
    expect(f.follow.model.create).toHaveBeenCalledTimes(1);
  });

  it('states explicitly when Bosta has supplied no reason', async () => {
    const f = fixture();
    await f.run({ state: 47 });
    expect(f.ticket().carrierUpdate.reasonVerified).toBe(false);
    expect(f.ticket().comments[0].text).toContain('لم ترسل بوسطة سببًا تفصيليًا');
    expect(f.ticket().comments[0].text).not.toContain('العميل رفض');
  });

  it('fetches the missing webhook reason from Bosta before classifying a failure', async () => {
    const f = fixture();
    f.service.fetchDelivery = jest.fn(async () => ({ data: { state: { code: 47, lastExceptionCode: 3,
      exception: [{ code: 3, reason: 'Postponed - the customer requested postponement for another day.' }] } } }));
    await f.service.processWebhook({ _id: 'b1', state: 47 });
    expect(f.service.fetchDelivery).toHaveBeenCalledWith('b1');
    expect(f.ticket().autoSource).toBe('shipping-followup');
    expect(f.service.notifications.enqueue).toHaveBeenCalledWith('deliveryPostponed', expect.any(String), '2883', 'tx:t1', undefined, 'CUSTOMER_POSTPONED', expect.any(Object));
  });

  it('keeps a follow-up awaiting verification if the carrier lookup fails', async () => {
    const f = fixture();
    f.service.fetchDelivery = jest.fn(async () => { throw Error('unavailable'); });
    await f.service.processWebhook({ _id: 'b1', state: 47 });
    expect(f.ticket().carrierUpdate.reasonVerified).toBe(false);
    expect(f.ticket().autoSource).toBe('shipping-issue');
  });

  it('does not reuse a stale postponement reason for loss or damage', async () => {
    const f = fixture();
    await f.run({ state: 100, exceptionCode: 3 });
    expect(f.ticket().carrierUpdate.reasonAr).toBe('فقدان الشحنة');
    await f.run({ state: 101, exceptionCode: 3 });
    expect(f.ticket().carrierUpdate.reasonAr).toBe('تلف الشحنة');
    expect(f.ticket().comments).toHaveLength(2);
  });

  it('preserves metadata and key when a polling timestamp changes without a meaningful update', () => {
    const first = carrierTrackingUpdate({ state: 24, updatedAt: '2026-10-28T12:00:00Z' }, 'IN_TRANSIT', 'في الطريق', 'b1', null, 'sync', '2026-10-28T12:01:00Z');
    const next = carrierTrackingUpdate({ state: 24, updatedAt: '2026-10-28T12:10:00Z' }, 'IN_TRANSIT', 'في الطريق', 'b1', null, 'sync', '2026-10-28T12:11:00Z', first);
    expect(next).toEqual(first);
  });

  it('puts the specific reported reason in notifications', () => {
    const body = notificationBody('deliveryProblem', '2883', { deliveryStatus: 'FAILED_ATTEMPT', deliveryReason: 'العميل لا يرد', deliveryReasonOriginal: 'Customer is not answering.' });
    expect(body).toContain('العميل لا يرد');
  });

  it('recovers earlier attempt reasons from REST history without duplicating state/attempt copies', () => {
    const first = { code: 7, reason: 'Customer is not answering.', time: '2026-10-27T09:00:00Z' };
    const second = { code: 3, reason: 'Customer postponed', time: '2026-10-28T09:00:00Z', scheduledAt: '2026-10-29T03:00:00Z' };
    const history = carrierExceptionHistory({ state: { exception: [second, first] },
      attempts: [{ exception: first }, { exception: second }] }, 'b1');
    expect(history.map(event => event.reasonCode)).toEqual([7, 3]);
    expect(history[1].scheduledAt).toBe(second.scheduledAt);
  });
});
