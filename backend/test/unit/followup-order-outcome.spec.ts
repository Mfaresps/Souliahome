jest.mock('../../src/employee-performance/employee-scoring.service', () => ({ EmployeeScoringService: class {} }));
import { FollowUpsService } from '../../src/followups/followups.service';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

function fixture() {
  const service: any = Object.create(FollowUpsService.prototype);
  const exec = jest.fn().mockResolvedValue({ modifiedCount: 2 });
  service.model = { updateMany: jest.fn(() => ({ exec })) };
  service.presence = { emitEvent: jest.fn() };
  service.logger = { error: jest.fn() };
  return { service, exec };
}

describe('Order outcomes close follow-up trails', () => {
  it('closes older confirmation tickets when the customer cancels in another ticket', async () => {
    const { service } = fixture();
    const source = { _id: 'latest', ticketNo: 'FU-2909-2', shopifyOrderId: 'local-2909', orderRef: '2909',
      reason: 'عملية تأكيد الطلب', status: 'العميل ألغى الطلب' };
    service.model.findById = () => ({ lean: async () => ({ ...source, status: 'في انتظار العميل' }) });
    service.model.findOneAndUpdate = jest.fn(() => ({ lean: async () => source }));
    await service.update('latest', { status: source.status });
    const [query, update] = service.model.updateMany.mock.calls[0];
    expect(query).toMatchObject({ _id: { $ne: 'latest' }, reason: source.reason,
      autoSource: { $ne: 'shipping-issue' }, status: { $nin: expect.arrayContaining(['العميل ألغى الطلب']) } });
    expect(query.$or).toContainEqual({ orderRef: { $in: ['2909', '#2909'] } });
    expect(update.$set).toMatchObject({ status: source.status, orderOutcome: 'cancelled', deferredUntil: null, escalationLevel: 0 });
    expect(update.$push.comments.text).toContain(source.ticketNo);
  });
  it.each(['معلق', 'معتمد'])('closes only confirmation tasks when a deposit is %s', async status => {
    const { service, exec } = fixture();
    const order = { _id: 'local1', shopifyId: 'remote1', ref: '2952', status: 'pending',
      depositReceipts: [{ status, amount: 810 }] };
    await service.closeConfirmationForDeposit(order, 'Agent');
    const [query, update] = service.model.updateMany.mock.calls[0];
    expect(query).toMatchObject({ reason: 'عملية تأكيد الطلب', autoSource: { $ne: 'shipping-issue' },
      status: { $nin: expect.arrayContaining(['تمت عملية التأكيد']) }, orderOutcome: { $in: ['', null] } });
    expect(query.$or).toContainEqual({ shopifyOrderId: { $in: ['local1', 'remote1'] } });
    expect(update.$set).toMatchObject({ status: 'تمت عملية التأكيد', orderOutcome: 'confirmed', deferredUntil: null });
    expect(update.$set.resolution).toBe(status === 'معلق' ? 'تم تسجيل ديبوزت بانتظار المراجعة' : 'تم تسجيل ديبوزت معتمد');
    exec.mockResolvedValueOnce({ modifiedCount: 0 });
    service.presence.emitEvent.mockClear();
    await service.closeConfirmationForDeposit(order);
    expect(service.presence.emitEvent).not.toHaveBeenCalled();
  });

  it.each([
    { depositReceipts: [] },
    { depositReceipts: [{ status: 'مسودة', amount: 810 }] },
    { depositReceipts: [{ status: 'مرفوض', amount: 810 }] },
    { depositReceipts: [{ status: 'مُسترد', amount: 810 }] },
    { depositReceipts: [{ status: 'معلق', amount: 0 }] },
    { cancelled: true, depositReceipts: [{ status: 'معتمد', amount: 810 }] },
    { status: 'rejected', depositReceipts: [{ status: 'معتمد', amount: 810 }] },
  ])('does not close confirmation without a valid deposit: %j', async order => {
    const { service } = fixture();
    await service.closeConfirmationForDeposit({ _id: 'local1', ...order });
    expect(service.model.updateMany).not.toHaveBeenCalled();
  });

  it('repairs historical confirmation trails using linked order ids as well as references', async () => {
    const { service } = fixture();
    service.model.find = jest.fn(() => ({ select: () => ({ lean: () => ({ exec: async () =>
      [{ shopifyOrderId: 'remote1', orderRef: '#2952' }] }) }) }));
    const find = jest.fn((_query: any, _options: any) => ({ toArray: async () => [{ _id: 'local1', shopifyId: 'remote1', ref: '2952',
      status: 'pending', depositReceipts: [{ status: 'معتمد', amount: 810 }] }] }));
    service.model.db = { collection: jest.fn(() => ({ find })) };
    await service.reconcileDepositConfirmations();
    expect(find.mock.calls[0][0]).toMatchObject({ depositReceipts: { $elemMatch: {
      status: { $in: ['معلق', 'معتمد'] }, amount: { $gt: 0 } } } });
    expect(find.mock.calls[0][0].$or).toContainEqual({ shopifyId: { $in: ['remote1'] } });
    expect(service.model.updateMany.mock.calls[0][1].$set.status).toBe('تمت عملية التأكيد');
  });

  it.each(['تم دفع الديبوزت', 'سيتم الشحن بدون ديبوزت'])('records confirmation and payment outcome: %s', async detail => {
    const { service } = fixture();
    await service.closeForOrder({ transactionId: 'tx1', shopifyOrderIds: ['local1', 'remote1'], orderRef: '#2871' }, 'confirmed', detail, 'Agent');
    const [query, update] = service.model.updateMany.mock.calls[0];
    expect(query.$or).toEqual(expect.arrayContaining([{ transactionId: 'tx1' }, { shopifyOrderId: { $in: ['local1', 'remote1'] } }]));
    expect(query.orderOutcome).toEqual({ $in: ['', null] });
    expect(query.autoSource).toEqual({ $ne: 'shipping-issue' });
    expect(update.$set).toMatchObject({ status: 'تمت عملية التأكيد', orderOutcome: 'confirmed', transactionId: 'tx1', escalationLevel: 0 });
    expect(update.$push.comments).toMatchObject({ authorId: 'system', kind: 'decision', text: `العميل أكد الطلب — ${detail} — بواسطة Agent` });
    expect(service.presence.emitEvent).toHaveBeenCalledWith('followup:changed', { action: 'update' });
  });

  it('closes cancellation with the saved reason and can supersede confirmation once', async () => {
    const { service, exec } = fixture();
    await service.closeForOrder({ transactionId: 'tx1' }, 'cancelled', 'العميل طلب الإلغاء', 'Manager');
    const [query, update] = service.model.updateMany.mock.calls[0];
    expect(query.orderOutcome).toEqual({ $ne: 'cancelled' });
    expect(update.$set).toMatchObject({ status: 'العميل ألغى الطلب', orderOutcome: 'cancelled', resolution: 'العميل طلب الإلغاء' });
    expect(update.$push.comments.text).toContain('العميل طلب الإلغاء');
    service.presence.emitEvent.mockClear();
    exec.mockResolvedValueOnce({ modifiedCount: 0 });
    await service.closeForOrder({ transactionId: 'tx1' }, 'cancelled', 'العميل طلب الإلغاء');
    expect(service.presence.emitEvent).not.toHaveBeenCalled();
  });

  it('does not match unrelated trails when the order has no identifiers', async () => {
    const { service } = fixture();
    await service.closeForOrder({}, 'confirmed', 'paid');
    expect(service.model.updateMany).not.toHaveBeenCalled();
  });

  it('reconciles historical cancellations at startup even when all tickets already have numbers', async () => {
    const { service } = fixture();
    const select = jest.fn().mockReturnThis();
    const query = { select, sort: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ orderRef: '#2856' }]) };
    select.mockReturnValue(query);
    service.model.find = jest.fn(() => query);
    const cancelledAt = '2026-10-22T14:23:48.849Z';
    const find = jest.fn(() => ({ toArray: jest.fn().mockResolvedValueOnce([
      { _id: 'local1', shopifyId: 'remote1', ref: '2856', cancelReason: 'الرقم غلط', cancelledBy: 'Manager', cancelledAt },
    ]) }));
    const transactionFind = jest.fn(() => ({ toArray: async () => [] }));
    service.model.db = { collection: (name: string) => ({ find: name === 'shopifyorders' ? find : transactionFind }) };
    service.logger.log = jest.fn();
    await service.onModuleInit();
    expect(service.model.find).toHaveBeenCalledWith({ cancelled: { $ne: true }, status: { $nin: expect.any(Array) }, orderOutcome: { $in: ['', null] } });
    expect(find).toHaveBeenCalledWith({ cancelled: true, ref: { $in: ['2856', '#2856'] } }, expect.any(Object));
    const [filter, update] = service.model.updateMany.mock.calls[0];
    expect(filter.$or).toContainEqual({ shopifyOrderId: { $in: ['local1', 'remote1'] } });
    expect(update.$set).toMatchObject({ status: 'العميل ألغى الطلب', orderOutcome: 'cancelled', closedAt: new Date(cancelledAt), deferredUntil: null });
    expect(update.$push.comments.text).toContain('الرقم غلط — بواسطة Manager');
  });

  it('does not scan orders or update anything when there are no open trails', async () => {
    const { service } = fixture();
    service.model.find = () => ({ select: () => ({ lean: () => ({ exec: async () => [] }) }) });
    service.model.db = { collection: jest.fn() };
    await service.reconcileCancelledOrders();
    expect(service.model.db.collection).not.toHaveBeenCalled();
    expect(service.model.updateMany).not.toHaveBeenCalled();
  });

  it('logs a persistence failure without failing an already committed order', async () => {
    const { service, exec } = fixture();
    exec.mockRejectedValueOnce(new Error('database offline'));
    await service.closeForOrder({ transactionId: 'tx1' }, 'confirmed', 'paid');
    expect(service.logger.error).toHaveBeenCalledWith(expect.stringContaining('database offline'));
    expect(service.presence.emitEvent).not.toHaveBeenCalled();
  });

  it('rejects comments, calls and status edits on a system-closed trail', async () => {
    const { service } = fixture();
    service.model.findById = () => ({ lean: async () => ({ orderOutcome: 'confirmed' }) });
    await expect(service.addComment('f1', 'u1', 'Agent', 'extra')).rejects.toThrow('المتابعة مغلقة');
    await expect(service.addCallAttempt('f1', 'u1', 'Agent', 'answered')).rejects.toThrow('المتابعة مغلقة');
    await expect(service.update('f1', { status: 'open' })).rejects.toThrow('المتابعة مغلقة');
    await expect(service.cancel('f1', 'other', 'u1', 'Agent')).rejects.toThrow('المتابعة مغلقة');
  });

  it.each(['editComment', 'deleteComment'])('protects the final system entry from %s, even for admins', async method => {
    const { service } = fixture();
    service.model.findById = async () => ({ comments: [{ _id: 'c1', authorId: 'system', kind: 'decision' }] });
    const args = method === 'editComment' ? ['f1', 'c1', 'admin', 'changed', true] : ['f1', 'c1', 'admin', true];
    await expect(service[method](...args)).rejects.toThrow('نتيجة النظام');
  });

  it.each(['confirmed', 'cancelled'])('renders a distinct final %s entry without edit controls', outcome => {
    const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
    const start = html.indexOf('function _fuRenderCommentThread()');
    const end = html.indexOf('const FU_CALL_PHONE_ICON', start);
    const element = { innerHTML: '', scrollTop: 0, scrollHeight: 100 };
    const context = {
      qs: () => element, followUps: [{ _id: 'f1', orderOutcome: outcome,
        comments: [{ _id: 'c1', authorId: 'system', authorName: 'النظام', kind: 'decision', text: 'Final outcome', createdAt: new Date().toISOString() }] }],
      fuCommentTargetId: 'f1', currentUser: { _id: 'admin' }, isAdmin: () => true,
      users: [], userAvatarHtml: () => '', cmtJobTitleHtml: () => '',
      esc: (value: any) => String(value || ''), escHtml: (value: any) => String(value || ''),
      fmtDateTime: () => '', _fuRelTime: () => '', t: (value: string) => value,
    };
    runInNewContext(html.slice(start, end) + '\n_fuRenderCommentThread();', context);
    expect(element.innerHTML).toContain('Final outcome');
    expect(element.innerHTML).toContain(outcome === 'confirmed' ? '#16a34a' : '#dc2626');
    expect(element.innerHTML).not.toContain('fu-timeline-menu-btn');
  });
});
