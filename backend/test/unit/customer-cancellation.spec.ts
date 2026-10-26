import { customerCancellationExclusions } from '../../src/employee-performance/customer-cancellation';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

describe('Customer cancellation excludes outstanding confirmation work', () => {
  it('excludes linked orders and older confirmation tickets across assignees', () => {
    const id = '507f1f77bcf86cd799439011';
    const result = customerCancellationExclusions([{ shopifyOrderId: id, transactionId: 'tx1', orderRef: '#2909' }]);
    expect(result.isCancelledOrder({ _id: id, ref: 'different' })).toBe(true);
    expect(result.isCancelledOrder({ shopifyId: id })).toBe(true);
    expect(result.isCancelledOrder({ ref: '2909' })).toBe(true);
    expect(result.isCancelledOrder({ ref: '2911' })).toBe(false);
    expect(result.orders).toHaveProperty('$nor');
    expect(result.followUps).toMatchObject({ $nor: [{ reason: 'عملية تأكيد الطلب', autoSource: { $ne: 'shipping-issue' },
      $or: expect.arrayContaining([{ transactionId: { $in: ['tx1'] } }, { orderRef: { $in: ['2909', '#2909'] } }]) }] });
  });

  it('does not create a filter for an unlinked decision', () => {
    expect(customerCancellationExclusions([{}]).orders).toEqual({});
    expect(customerCancellationExclusions([]).followUps).toEqual({});
  });

  it('removes both the stale waiting ticket and its assigned-order fallback from priorities', () => {
    const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
    const fn = (name: string) => { const start = html.indexOf(`function ${name}(`); return html.slice(start, html.indexOf('\n}', start) + 2); };
    const context: any = {
      currentLang: 'ar', _myShowOtherTasks: true, myDeliveryIssueCount: () => 0,
      _fuIsSettled: (f: any) => f.status === 'العميل ألغى الطلب',
      followUps: [{ _id: 'latest', reason: 'عملية تأكيد الطلب', status: 'العميل ألغى الطلب', shopifyOrderId: 'local-2909', orderRef: '#2909' }],
      _myWorkspace: {
        orders: [{ id: 'local-2909', ref: '2909', status: 'pending', needsConfirmation: true }],
        followUps: [{ id: 'old', shopifyOrderId: 'local-2909', orderRef: '2909', reason: 'عملية تأكيد الطلب', status: 'في انتظار العميل' },
          { id: 'unrelated', orderRef: '2911', reason: 'عملية تأكيد الطلب', status: 'في انتظار العميل' },
          { id: 'shipping', orderRef: '2909', reason: 'مشكلة في الاستلام', autoSource: 'shipping-issue' }],
      },
    };
    runInNewContext(fn('_customerCancelledConfirmation') + '\n' + fn('myFollowUpPriorities'), context);
    expect(context.myFollowUpPriorities(false).map((row: any) => row.f.id)).toEqual(['shipping', 'unrelated']);
  });
});
