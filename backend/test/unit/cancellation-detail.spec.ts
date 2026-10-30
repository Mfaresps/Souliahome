import { TransactionsService } from '../../src/transactions/transactions.service';
import { CANCEL_REASON_CODES, cancelReasonSummary } from '../../src/shared/cancellation.constants';

describe('Transaction cancellation details', () => {
  const service: any = Object.create(TransactionsService.prototype);
  it('refuses the generic customer reason even when a note is supplied', () => {
    expect(() => service.resolveCancelReason({ code: 'customer-request', note: 'العميل طلب الإلغاء' }, 'transaction')).toThrow('حدد السبب الفعلي');
  });
  it.each(['customer-wants-inspection', 'customer-refused-deposit', 'customer-changed-mind', 'customer-price-too-high'])(
    'accepts %s and preserves its classified summary', code => {
      expect(CANCEL_REASON_CODES).toContain(code);
      expect(service.resolveCancelReason({ code, note: 'توضيح العميل' }, 'transaction')).toEqual({ code, note: 'توضيح العميل', summary: cancelReasonSummary(code, 'توضيح العميل') });
      expect(cancelReasonSummary(code)).toMatch(/^العميل طلب الإلغاء — /);
    },
  );
  it('requires a meaningful-length explanation for other and preserves historical labels', () => {
    expect(() => service.resolveCancelReason({ code: 'customer-request-other', note: 'أ  خ  ر' }, 'transaction')).toThrow();
    expect(service.resolveCancelReason({ code: 'customer-request-other', note: 'العميل مسافر قبل التوصيل' }, 'transaction').note).toBe('العميل مسافر قبل التوصيل');
    expect(cancelReasonSummary('customer-request')).toBe('العميل طلب الإلغاء');
  });
});
