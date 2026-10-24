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
