/**
 * Shopify order cancellation: the staff-request → manager-approval flow.
 *
 * A staff member with `shopify-cancel-request` (and not `shopify-cancel`) can only ASK. The
 * order must stay live until a manager decides — the bug this guards against is a request that
 * quietly behaves like a cancellation, which would hand the requester the effect of a permission
 * they were not granted.
 *
 * These call the three service methods against a minimal stateful model stub rather than building
 * the whole ShopifyService DI graph: the rules under test are entirely inside these methods.
 *
 * Run with: npm test -- shopify-cancel-approval
 */

import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';

/**
 * ⚠ `employee-scoring.service.ts` is stubbed, and the class is then reached through `require`.
 *
 *   ShopifyService imports EmployeeScoringService for DI, and ts-jest type-checks every file it
 *   transitively loads under settings stricter than the build tsconfig — so a pre-existing typing
 *   issue in that unrelated file fails this suite for reasons that have nothing to do with
 *   cancellations. None of the methods under test touch scoring, so stubbing the module keeps
 *   this spec's failures about this spec. Remove the mock if that file's typing is tightened.
 */
jest.mock('../../src/employee-performance/employee-scoring.service', () => ({
  EmployeeScoringService: class {},
}));

function ShopifyServiceClass(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../src/shopify/shopify.service').ShopifyService;
}

function buildOrder(overrides: Record<string, unknown> = {}): any {
  const o: any = {
    _id: 'o1',
    ref: '2450',
    client: 'زينه شريف',
    total: 895,
    status: 'pending',
    cancelled: false,
    cancelledBy: '',
    cancelledAt: '',
    cancelReason: '',
    cancelReasonCode: '',
    cancelReasonNote: '',
    cancelRequest: null,
    ...overrides,
  };
  o.save = jest.fn().mockImplementation(async () => o);
  return o;
}

/** The subset of ShopifyService the three methods touch, with a real `this`. */
function serviceFor(order: any): any {
  const svc = Object.create(ShopifyServiceClass().prototype);
  svc.shopifyOrderModel = { findById: jest.fn().mockResolvedValue(order) };
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return svc;
}

describe('ShopifyService — cancellation request/approval', () => {
  describe('requestCancelOrder()', () => {
    it('records the request WITHOUT cancelling the order', async () => {
      const o = buildOrder();
      await serviceFor(o).requestCancelOrder('o1', 'موظف', 'out-of-stock', '', 'u1', 'staff1');

      // The load-bearing assertion: a request is not an outcome.
      expect(o.cancelled).toBe(false);
      expect(o.status).toBe('pending');
      expect(o.cancelRequest.status).toBe('معلق');
      expect(o.cancelRequest.cancelReasonCode).toBe('out-of-stock');
      expect(o.cancelRequest.reason).toBe('الصنف غير متوفر');
      expect(o.cancelRequest.requestedBy).toBe('موظف');
    });

    it('validates the reason at submission, not at approval', async () => {
      const o = buildOrder();
      await expect(
        serviceFor(o).requestCancelOrder('o1', 'موظف', 'other', '   '),
      ).rejects.toThrow(BadRequestException);
      expect(o.cancelRequest).toBeNull();
    });

    it('rejects a reason that is not valid at the shopify stage', async () => {
      const o = buildOrder();
      await expect(
        serviceFor(o).requestCancelOrder('o1', 'موظف', 'delivery-failed', ''),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a second request while one is pending', async () => {
      const o = buildOrder({ cancelRequest: { status: 'معلق', requestedBy: 'x', reason: 'y', requestedAt: '' } });
      await expect(
        serviceFor(o).requestCancelOrder('o1', 'موظف', 'out-of-stock', ''),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses on an already-cancelled order', async () => {
      const o = buildOrder({ cancelled: true });
      await expect(
        serviceFor(o).requestCancelOrder('o1', 'موظف', 'out-of-stock', ''),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses once the order has left the pending list', async () => {
      const o = buildOrder({ status: 'approved' });
      await expect(
        serviceFor(o).requestCancelOrder('o1', 'موظف', 'out-of-stock', ''),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when the order does not exist', async () => {
      const svc = Object.create(ShopifyServiceClass().prototype);
      svc.shopifyOrderModel = { findById: jest.fn().mockResolvedValue(null) };
      svc.logger = { log: jest.fn() };
      await expect(
        svc.requestCancelOrder('nope', 'موظف', 'out-of-stock', ''),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('approveCancelRequest()', () => {
    it('cancels the order and carries the requester reason through unchanged', async () => {
      const o = buildOrder({
        cancelRequest: {
          requestedBy: 'موظف', requestedById: '', requestedByUsername: '',
          reason: 'الصنف غير متوفر', cancelReasonCode: 'out-of-stock', cancelReasonNote: '',
          requestedAt: '2026-08-28T00:00:00.000Z', status: 'معلق',
        },
      });
      await serviceFor(o).approveCancelRequest('o1', 'مدير');

      expect(o.cancelled).toBe(true);
      // The approver decides WHETHER, not WHY — losing the code here would send every approved
      // request to «غير محدد» in the cancellations report.
      expect(o.cancelReasonCode).toBe('out-of-stock');
      expect(o.cancelReason).toBe('الصنف غير متوفر');
      // Attribution: the requester made the operational decision; reviewedBy authorised it.
      expect(o.cancelledBy).toBe('موظف');
      expect(o.cancelRequest.status).toBe('معتمد');
      expect(o.cancelRequest.reviewedBy).toBe('مدير');
    });

    it('refuses when there is no pending request', async () => {
      const o = buildOrder();
      await expect(serviceFor(o).approveCancelRequest('o1', 'مدير')).rejects.toThrow(BadRequestException);
    });

    it('refuses to approve an already-reviewed request', async () => {
      const o = buildOrder({ cancelRequest: { status: 'مرفوض', requestedBy: 'x', reason: 'y', requestedAt: '' } });
      await expect(serviceFor(o).approveCancelRequest('o1', 'مدير')).rejects.toThrow(BadRequestException);
    });
  });

  describe('rejectCancelRequest()', () => {
    it('leaves the order live and records why', async () => {
      const o = buildOrder({
        cancelRequest: {
          requestedBy: 'موظف', reason: 'الصنف غير متوفر',
          cancelReasonCode: 'out-of-stock', requestedAt: '', status: 'معلق',
        },
      });
      await serviceFor(o).rejectCancelRequest('o1', 'مدير', 'المخزون متاح فعلاً');

      expect(o.cancelled).toBe(false);
      expect(o.status).toBe('pending');
      expect(o.cancelRequest.status).toBe('مرفوض');
      expect(o.cancelRequest.rejectedReason).toBe('المخزون متاح فعلاً');
    });

    it('refuses when there is no pending request', async () => {
      const o = buildOrder();
      await expect(serviceFor(o).rejectCancelRequest('o1', 'مدير', 'x')).rejects.toThrow(BadRequestException);
    });
  });

  /**
   * withdrawCancelRequest() — the requester takes their own request back before it is decided.
   *
   * A request is not an outcome, so withdrawing one must not cancel, restore or reverse anything:
   * it erases the request and leaves the order exactly as it was before it was filed.
   */
  describe('withdrawCancelRequest()', () => {
    const pending = (extra: Record<string, unknown> = {}) => ({
      status: 'معلق',
      requestedBy: 'ريم',
      requestedById: 'u-reem',
      requestedByUsername: 'reem',
      reason: 'الصنف غير متوفر',
      cancelReasonCode: 'out-of-stock',
      requestedAt: '2026-09-08T10:00:00.000Z',
      ...extra,
    });

    it('the requester withdraws their own request and the order is untouched', async () => {
      const o = buildOrder({ cancelRequest: pending() });
      await serviceFor(o).withdrawCancelRequest('o1', 'u-reem', 'reem', false);

      expect(o.cancelRequest).toBeNull();
      // Nothing was cancelled, and nothing was "restored" either — it was never cancelled.
      expect(o.cancelled).toBe(false);
      expect(o.status).toBe('pending');
      expect(o.cancelReasonCode).toBe('');
      expect(o.save).toHaveBeenCalled();
    });

    it('matches on username alone for rows written before requestedById existed', async () => {
      const o = buildOrder({ cancelRequest: pending({ requestedById: '' }) });
      await serviceFor(o).withdrawCancelRequest('o1', 'some-other-id', 'reem', false);
      expect(o.cancelRequest).toBeNull();
    });

    /* The load-bearing rule: holding `shopify-cancel-request` lets you file YOUR request,
       not drop a colleague's — that would be exercising the decision authority you lack. */
    it('refuses to let a colleague withdraw someone else request', async () => {
      const o = buildOrder({ cancelRequest: pending() });
      await expect(
        serviceFor(o).withdrawCancelRequest('o1', 'u-other', 'other', false),
      ).rejects.toThrow(ForbiddenException);
      expect(o.cancelRequest).not.toBeNull();
      expect(o.cancelRequest.status).toBe('معلق');
      expect(o.save).not.toHaveBeenCalled();
    });

    it('an admin may withdraw any pending request', async () => {
      const o = buildOrder({ cancelRequest: pending() });
      await serviceFor(o).withdrawCancelRequest('o1', 'u-boss', 'boss', true);
      expect(o.cancelRequest).toBeNull();
    });

    /* After approval the order is genuinely cancelled: the only way back is restoreOrder(),
       which is admin-only. Allowing a withdraw here would un-cancel it through the back door. */
    it('refuses once the request has been approved', async () => {
      const o = buildOrder({
        cancelled: true,
        cancelRequest: pending({ status: 'معتمد' }),
      });
      await expect(
        serviceFor(o).withdrawCancelRequest('o1', 'u-reem', 'reem', false),
      ).rejects.toThrow(BadRequestException);
      expect(o.cancelled).toBe(true);
    });

    /* A rejected request carries the manager's reason — the only reply the requester ever gets.
       Erasing it would delete that answer and invite an identical re-submission. */
    it('refuses once the request has been rejected, keeping the rejection reason', async () => {
      const o = buildOrder({
        cancelRequest: pending({ status: 'مرفوض', rejectedReason: 'العميل أكد الطلب' }),
      });
      await expect(
        serviceFor(o).withdrawCancelRequest('o1', 'u-reem', 'reem', false),
      ).rejects.toThrow(BadRequestException);
      expect(o.cancelRequest.rejectedReason).toBe('العميل أكد الطلب');
    });

    it('refuses when there is no request at all', async () => {
      const o = buildOrder();
      await expect(
        serviceFor(o).withdrawCancelRequest('o1', 'u-reem', 'reem', false),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFound for an unknown order', async () => {
      const svc = Object.create(ShopifyServiceClass().prototype);
      svc.shopifyOrderModel = { findById: jest.fn().mockResolvedValue(null) };
      svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      await expect(
        svc.withdrawCancelRequest('nope', 'u-reem', 'reem', false),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('restoreOrder()', () => {
    it('clears the approved request so approvals stops listing a cancellation that is gone', async () => {
      const o = buildOrder({
        cancelled: true,
        cancelReasonCode: 'out-of-stock',
        cancelRequest: { status: 'معتمد', requestedBy: 'موظف', reason: 'الصنف غير متوفر', requestedAt: '' },
      });
      await serviceFor(o).restoreOrder('o1');

      expect(o.cancelled).toBe(false);
      expect(o.cancelReasonCode).toBe('');
      expect(o.cancelRequest).toBeNull();
    });
  });
});
