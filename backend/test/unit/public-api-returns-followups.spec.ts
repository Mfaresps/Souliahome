import { PublicApiService, orderClosedReason, cairoToday } from '../../src/public-api/public-api.service';
import { returnStage, returnView } from '../../src/public-api/returns-api.view';
import { normalizeScopes, API_SCOPE_CODES } from '../../src/public-api/api-key.util';

const key: any = { _id: 'k1', linkedUserId: 'u1', linkedUserName: 'Instinct', scopes: ['orders', 'followups', 'followups-write', 'returns'], phoneAccess: 'detail' };

/** A tiny in-memory stand-in for the Mongo collections the service reads. */
function fakeDb(data: Record<string, any[]>) {
  const match = (doc: any, f: any): boolean => Object.entries(f || {}).every(([k, v]: [string, any]) => {
    if (k === '$or') return v.some((x: any) => match(doc, x));
    const val = k.split('.').reduce((o: any, p) => (o == null ? o : o[p]), doc);
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.includes(val ?? null) || (v.$in.includes('') && !val);
      if ('$nin' in v) return !v.$nin.includes(val);
      if ('$ne' in v) return val !== v.$ne;
      if ('$gte' in v) return new Date(val) >= v.$gte && new Date(val) < v.$lt;
    }
    return val === v;
  });
  const cursor = (rows: any[]) => ({ sort: () => cursor(rows), skip: () => cursor(rows), limit: () => cursor(rows), toArray: async () => rows });
  return { collection: (name: string) => ({
    find: (f: any) => cursor((data[name] || []).filter((d) => match(d, f))),
    findOne: async (f: any) => (data[name] || []).find((d) => match(d, f)) || null,
    countDocuments: async (f: any) => (data[name] || []).filter((d) => match(d, f)).length,
  }) };
}

function service(data: Record<string, any[]>) {
  const s: any = Object.create(PublicApiService.prototype);
  s.connection = { db: fakeDb(data) };
  s.opening = new Set();
  s.presence = { emitEvent: jest.fn() };
  s.followups = {
    create: jest.fn(async (dto: any) => ({ _id: 'f-new', ticketNo: 'FU-1', ...dto })),
    addComment: jest.fn(async () => ({})),
  };
  return s;
}

describe('POST /v1/orders/{ref}/followups', () => {
  const shop = { _id: 's1', ref: '3276', shopifyId: '99', status: 'pending', client: 'سمر', phone: '01012345678', createdAt: new Date() };

  it('opens a follow-up on an order without one and writes the first note as the key account', async () => {
    const s = service({ shopifyorders: [shop], transactions: [], followups: [] });
    const r = await s.openFollowup('#3276', { note: 'العميل طلب الاتصال مساءً' }, key);
    expect(r).toEqual(expect.objectContaining({ created: true, followupId: 'f-new', orderRef: '3276', reason: 'عملية تأكيد الطلب' }));
    expect(s.followups.create).toHaveBeenCalledWith(expect.objectContaining({ orderRef: '3276', shopifyOrderId: 's1', responsibleId: 'u1', responsibleName: 'Instinct', status: 'في انتظار العميل' }), 'u1');
    expect(s.followups.addComment).toHaveBeenCalledWith('f-new', 'u1', 'Instinct', 'العميل طلب الاتصال مساءً');
  });

  it('keeps a known reason, stores any other text as «أخرى» + reasonOther', async () => {
    const s = service({ shopifyorders: [shop], transactions: [], followups: [] });
    await s.openFollowup('3276', { note: 'x note', reason: 'أجل الاستلام' }, key);
    expect(s.followups.create.mock.calls[0][0].reason).toBe('أجل الاستلام');
    await s.openFollowup('3276', { note: 'x note', reason: 'سؤال عن المقاس' }, key);
    expect(s.followups.create.mock.calls[1][0]).toEqual(expect.objectContaining({ reason: 'أخرى', reasonOther: 'سؤال عن المقاس' }));
  });

  it('409 FOLLOWUP_EXISTS with the open follow-up id; nothing created', async () => {
    const s = service({ shopifyorders: [shop], transactions: [], followups: [{ _id: 'f-open', ticketNo: 'FU-9', orderRef: '3276', status: 'في انتظار العميل', createdAt: new Date() }] });
    await expect(s.openFollowup('3276', { note: 'hi there' }, key)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'FOLLOWUP_EXISTS', followupId: 'f-open' }) });
    expect(s.followups.create).not.toHaveBeenCalled();
  });

  it('a settled follow-up does not block a new one', async () => {
    const s = service({ shopifyorders: [shop], transactions: [], followups: [{ _id: 'f-old', orderRef: '3276', status: 'تمت عملية التأكيد', createdAt: new Date() }] });
    await expect(s.openFollowup('3276', { note: 'again' }, key)).resolves.toMatchObject({ created: true });
  });

  it('404 for an unknown order; 409 ORDER_CLOSED for cancelled or delivered; 400 without a note', async () => {
    const s = service({ shopifyorders: [], transactions: [], followups: [] });
    await expect(s.openFollowup('1', { note: 'x' }, key)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ORDER_NOT_FOUND' }) });
    const tx = { _id: 't1', type: 'مبيعات', ref: '500', deliveredAt: '2026-11-20', createdAt: new Date() };
    const s2 = service({ shopifyorders: [], transactions: [tx], followups: [] });
    await expect(s2.openFollowup('500', { note: 'x' }, key)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ORDER_CLOSED', state: 'delivered' }) });
    const s3 = service({ shopifyorders: [{ ...shop, cancelled: true }], transactions: [], followups: [] });
    await expect(s3.openFollowup('3276', { note: 'x' }, key)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'ORDER_CLOSED', state: 'cancelled' }) });
    await expect(s3.openFollowup('3276', { note: '   ' }, key)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'NOTE_REQUIRED' }) });
    expect(orderClosedReason({ status: 'rejected' }, null)).toBe('cancelled');
    expect(orderClosedReason(null, { pickupStatus: 'Delivered' })).toBe('delivered');
  });

  it('refuses a key with no linked account', async () => {
    const s = service({ shopifyorders: [shop] });
    await expect(s.openFollowup('3276', { note: 'x' }, { ...key, linkedUserId: '' })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'NO_LINKED_USER' }) });
  });
});

describe('GET /v1/orders?include=items', () => {
  const day = cairoToday();
  const shop = { _id: 's1', ref: '10', shopifyId: '1', status: 'pending', createdAt: new Date(), items: [{ code: 'C1', name: 'Bowl', qty: 2, price: 150 }] };
  it('adds each order\'s items only when asked', async () => {
    const s = service({ shopifyorders: [shop], transactions: [], followups: [] });
    const plain = await s.listOrders({ from: day, to: day }, key);
    expect(plain.items[0].items).toBeUndefined();
    const withItems = await s.listOrders({ from: day, to: day, include: 'items' }, key);
    expect(withItems.items[0].items).toEqual([{ code: 'C1', name: 'Bowl', qty: 2, price: 150, total: 300 }]);
    await expect(s.listOrders({ from: day, to: day, include: 'cost' }, key)).rejects.toMatchObject({ response: expect.objectContaining({ code: 'BAD_FILTER' }) });
  });
});

describe('GET /v1/returns view', () => {
  const v2 = (w: any, extra: any = {}) => ({ _id: 'r', originalRef: '#3095', requestKind: 'return', reason: 'defect', createdAt: '2026-11-20T10:00:00Z', requestedBy: 'Reem',
    items: [{ name: 'Bowl', qty: 2, condition: 'سليم' }, { name: 'Cup', qty: 1, condition: 'تالف' }], approvedBy: 'Receiver', approvedAt: '2026-11-22T10:00:00Z',
    workflow: { version: 2, ref: 'AS-2026-000001', quote: { credit: 590, refundDue: 590 }, ...w }, ...extra });

  it('reads the stage, approver and refund of an after-sales case — never the receipt stamp as approval', () => {
    const r = returnView(v2({ stage: 'settlement', approvedBy: 'Admin', approvedAt: '2026-11-21T09:00:00Z', receivedAt: '2026-11-22T10:00:00Z', receivedBy: 'Store' }));
    expect(r).toEqual(expect.objectContaining({ orderRef: '3095', caseRef: 'AS-2026-000001', system: 'after-sales', amount: 590, recordedBy: 'Reem' }));
    expect(r.stage.state).toBe('received');
    expect(r.approval).toEqual({ required: true, approved: true, by: 'Admin', at: '2026-11-21T09:00:00.000Z' });
    expect(r.received).toEqual({ by: 'Store', at: '2026-11-22T10:00:00.000Z' });
    expect(r.reason.label).toBe('عيب في المنتج');
    expect(r.resolution.state).toBe('refund');
    expect(r.stock).toEqual({ restocked: 2, damaged: 1 });
  });

  it('a requested case is not approved and states no stock yet; exchange resolution', () => {
    const r = returnView(v2({ stage: 'requested' }, { requestKind: 'exchange' }));
    expect(r.stage.state).toBe('requested');
    expect(r.approval.approved).toBe(false);
    expect(r.stock).toBeNull();
    expect(r.resolution.state).toBe('exchange');
  });

  it('legacy rows: pending, approved (booked at once), rejected, reversed', () => {
    const base = { _id: 'l', originalRef: '2000', requestKind: 'return', reason: 'تلف الشحنة', total: 300, createdAt: '2026-11-01', requestedBy: 'Ali', items: [{ name: 'X', qty: 1, condition: 'سليم' }] };
    expect(returnStage({ ...base, status: 'معلق' })).toBe('requested');
    const ok = returnView({ ...base, status: 'معتمد', approvedBy: 'Admin', approvedAt: '2026-11-02', vaultRefundAccount: 'كاش' });
    expect(ok.stage.state).toBe('closed');
    expect(ok.approval.by).toBe('Admin');
    expect(ok.refund).toEqual(expect.objectContaining({ paid: 300, method: 'كاش' }));
    expect(returnView({ ...base, status: 'مرفوض', approvedBy: 'Admin', approvedAt: '2026-11-02', rejectedReason: 'خارج المدة' }).rejection?.reason).toBe('خارج المدة');
    const rev = returnView({ ...base, status: 'معتمد', approvedBy: 'Admin', reversedAt: '2026-11-05', reversedBy: 'Admin' });
    expect(rev.stage.state).toBe('reversed');
    expect(rev.refund.paid).toBe(0);
  });
});

describe('returns scope', () => {
  it('is a known section', () => {
    expect(API_SCOPE_CODES).toContain('returns');
    expect(normalizeScopes(['returns', 'x'])).toEqual(['returns']);
  });
});
