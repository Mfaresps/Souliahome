import { buildClientProfiles, clientPhone, shopifyContact } from '../../src/clients/client-profile.util';
import { ClientEmailDto } from '../../src/clients/clients.controller';
import { validate } from 'class-validator';

const sale = (id: string, extra: any = {}) => ({ _id: id, type: 'مبيعات', client: 'منى', phone: '01012345678',
  date: '2026-10-01', pickupStatus: 'Pending', total: 1000, deposit: 250, remaining: 750, ...extra });
const order = (id: string, extra: any = {}) => ({ _id: 'o-' + id, shopifyId: id, client: 'منى', phone: '+201012345678',
  shopifyCreatedAt: '2026-10-02', total: 1000, ...extra });
const build = (tx: any[], orders: any[] = [], returns: any[] = [], followups: any[] = []) => buildClientProfiles(tx, orders, returns, followups);
const orderStatuses = require('../../../frontend/public/order-status.js');

describe('customer profiles — evidence and identity', () => {
  it.each(['01012345678', '+201012345678', '00201012345678', '1012345678', '٠١٠١٢٣٤٥٦٧٨'])('normalizes Egyptian phone %s', phone => {
    expect(clientPhone(phone)).toBe('201012345678');
  });
  it('keeps foreign country codes distinct', () => {
    expect(clientPhone('+441012345678')).not.toBe(clientPhone('+201012345678'));
  });
  it('deduplicates Shopify orders after conversion and preserves all cancellations', () => {
    const p = build([sale('t1', { shopifyOrderId: '1', deliveredAt: '2026-10-03' }),
      sale('t2', { cancelled: true, cancelReasonCode: 'customer-changed-mind' })],
    [order('1'), order('2', { cancelled: true, cancelReasonCode: 'customer-found-cheaper' })])[0];
    expect(p.stats).toMatchObject({ orders: 3, delivered: 1, cancelledBefore: 1, cancelledAfter: 1, customerIssues: 2 });
    expect(p.money).toMatchObject({ total: 1000, paid: 250, remaining: 750 });
    expect(p.assessment).toBe('depositRecommended');
  });
  it('calculates 2 delivered and 1 refused as 67%, excluding open and unshipped cancelled orders', () => {
    const p = build([sale('1', { deliveredAt: '2026-10-02' }), sale('2', { bostaShippingStatus: 'Delivered' }),
      sale('3', { bostaStatus: 'RETURNED', failedDelivery: { outcome: 'refused' } }), sale('4'),
      sale('5', { cancelled: true, cancelReasonCode: 'out-of-stock' })])[0];
    expect(p.stats).toMatchObject({ delivered: 2, failed: 1, active: 1, cancelledAfter: 1, deliveryRate: 67, customerIssues: 1 });
  });
  it('does not use paid status as delivery proof or fabricate a 0% success rate', () => {
    const p = build([sale('1', { payStatus: 'مكتمل', remaining: 0, deposit: 1000 })])[0];
    expect(p.stats.delivered).toBe(0); expect(p.stats.deliveryRate).toBeNull();
    expect(p.assessment).toBe('insufficient');
  });
  it.each([
    [{ pickupStatus: 'Preparing' }, 'Preparing'],
    [{ pickupStatus: 'Ready' }, 'Ready'],
    [{ bostaOrderId: 'b1', bostaStatus: 'PICKED_UP' }, 'PICKED_UP'],
    [{ bostaOrderId: 'b1', bostaStatus: 'IN_TRANSIT' }, 'IN_TRANSIT'],
    [{ bostaOrderId: 'b1', bostaStatus: 'OUT_FOR_DELIVERY' }, 'OUT_FOR_DELIVERY'],
    [{ bostaOrderId: 'b1', bostaStatus: 'CUSTOMER_POSTPONED' }, 'CUSTOMER_POSTPONED'],
    [{ bostaOrderId: 'b1', bostaStatus: 'FAILED_ATTEMPT' }, 'FAILED_ATTEMPT'],
    [{ bostaOrderId: 'b1', bostaStatus: 'RETURNED' }, 'RETURNED'],
    [{ deliveredAt: '2026-11-01' }, 'DELIVERED'],
    [{ bostaShippingStatus: 'Delivered' }, 'DELIVERED'],
    [{ cancelled: true }, 'CANCELLED'],
    [{ deliverySource: 'MANUAL' }, 'Shipped'],
  ])('preserves the shared delivery label for %j', (fields, key) => {
    const row = build([sale('1', fields)])[0].history[0];
    for (const lang of ['ar', 'en']) {
      const state = orderStatuses.resolve(row.orderState, row.source, lang);
      expect(state.key).toBe(key);
      expect(state.label).toBe(orderStatuses.text(key, lang));
    }
  });
  it('preserves shipment retries, customer postponement and delay labels without exposing shipment details', () => {
    const row = build([sale('1', { bostaOrderId: 'b1', bostaStatus: 'IN_TRANSIT', bostaIsDelayed: true,
      bostaDeliveryException: { code: 3 }, shipmentAttempts: [{ bostaOrderId: 'old', private: 'PRIVATE_SHIPMENT' }],
      bostaLastTrackingUpdate: { status: 'IN_TRANSIT', reason: 'Customer postponed', reasonAr: 'طلب العميل التأجيل' } })])[0].history[0];
    expect(orderStatuses.resolve(row.orderState, row.source, 'en')).toMatchObject({
      label: 'In Transit · Customer Postponed', delayed: true, note: 'Customer postponed' });
    expect(JSON.stringify(row)).not.toContain('PRIVATE_SHIPMENT');
    const retry = build([sale('1', { pickupStatus: 'Ready', bostaStatus: 'DELETED',
      shipmentAttempts: [{ bostaOrderId: 'old' }] })])[0].history[0];
    expect(orderStatuses.resolve(retry.orderState, retry.source, 'en').label).toBe('Awaiting Shipment 2');
  });
  it('uses the standard confirmation and cancellation labels for orders without invoices', () => {
    const p = build([], [order('1', { status: 'pending' }),
      order('2', { status: 'pending', depositReceipts: [{ status: 'معتمد', amount: 250 }] }),
      order('3', { status: 'pending', shipWithoutDeposit: true }), order('4', { status: 'pending' })], [],
    [{ shopifyOrderId: 'o-4', status: 'العميل ألغى الطلب', reason: 'عملية تأكيد الطلب' }])[0];
    const keys = Object.fromEntries(p.history.map(r => [r.id, orderStatuses.resolve(r.orderState, r.source, 'en').key]));
    expect(keys).toEqual({ 'o-1': 'awaiting_confirmation', 'o-2': 'confirmed', 'o-3': 'confirmed', 'o-4': 'customer_cancelled' });
  });
  it('shows approved deposits before registration and includes them in actual payments', () => {
    const p = build([sale('1')], [order('2', { status: 'pending', depositAmount: 999,
      depositReceipts: [{ status: 'معتمد', amount: 100.25 }, { status: 'معتمد', amount: 50.5 },
        { status: 'معلق', amount: 200 }, { status: 'مسودة', amount: 300 },
        { status: 'مرفوض', amount: 400 }, { status: 'مُسترد', amount: 500 },
        { status: 'ملغي', amount: 600 }, { status: 'مسحوب', amount: 700 }] })])[0];
    expect(p.history.find(r => r.source === 'shopify')).toMatchObject({ paid: 150.75, outcome: 'active' });
    expect(p.money).toMatchObject({ total: 1000, paid: 400.75, remaining: 750 });
    expect(p.stats).toMatchObject({ invoices: 1, unregisteredOrders: 1, delivered: 0 });
  });
  it.each(['معلق', 'مسودة', 'مرفوض', 'مُسترد', 'ملغي', 'مسحوب'])('does not treat %s receipts or stale summaries as paid', status => {
    const p = build([], [order('1', { depositAmount: 500, depositReceipts: [{ status, amount: 500 }] })])[0];
    expect(p.history[0].paid).toBe(0);
    expect(p.money.paid).toBe(0);
  });
  it.each([{ depositReceipts: undefined }, { depositReceipts: [] }])('supports historical deposit summaries without receipts ($depositReceipts)', ({ depositReceipts }) => {
    const p = build([], [order('1', { depositAmount: 125.25, depositReceipts })])[0];
    expect(p.history[0].paid).toBe(125.25);
    expect(p.money.paid).toBe(125.25);
  });
  it('excludes deposits for cancelled orders and orders cancelled through follow-ups', () => {
    const p = build([], [order('1', { cancelled: true, depositAmount: 200 }),
      order('2', { depositReceipts: [{ status: 'معتمد', amount: 300 }] })], [],
    [{ shopifyOrderId: 'o-2', status: 'العميل ألغى الطلب', reason: 'عملية تأكيد الطلب' }])[0];
    expect(p.history.every(r => r.paid === 0)).toBe(true);
    expect(p.money.paid).toBe(0);
  });
  it.each(['1', 'o-1'])('uses invoice payments once after conversion linked by %s', shopifyOrderId => {
    const p = build([sale('1', { shopifyOrderId, deposit: 350 })],
      [order('1', { depositAmount: 200, depositReceipts: [{ status: 'معتمد', amount: 200 }] })])[0];
    expect(p.history).toHaveLength(1);
    expect(p.history[0]).toMatchObject({ source: 'transaction', paid: 350 });
    expect(p.money.paid).toBe(350);
  });
  it('shows missing historical outcomes as unknown rather than asserting that they are active', () => {
    const p = build([sale('old', { pickupStatus: '' })])[0];
    expect(p.stats).toMatchObject({ unknown: 1, active: 0, recentOrders: 0, deliveryRate: null });
  });
  it('does not charge courier, stock, unknown or company problems to the customer', () => {
    const p = build([sale('1', { failedDelivery: { outcome: 'courier-error' } }),
      sale('2', { cancelled: true, cancelReasonCode: 'out-of-stock' }),
      sale('3', { cancelled: true, cancelReasonCode: 'shopify-cancelled' }),
      sale('4', { cancelled: true, cancelReason: 'قديم' })])[0];
    expect(p.stats.customerIssues).toBe(0); expect(p.assessment).toBe('insufficient');
  });
  it('does not count a reshipped issue as final failure', () => {
    const p = build([sale('1', { bostaStatus: 'RETURNED', failedDelivery: { outcome: 'refused' }, shipIssueState: 'reshipped' })])[0];
    expect(p.stats).toMatchObject({ active: 1, failed: 0, customerIssues: 0 });
  });
  it('keeps return history separate from delivery and excludes reversed returns from the money total', () => {
    const p = build([sale('1', { deliveredAt: '2026-10-02' })], [], [
      { originalTransactionId: '1', status: 'معتمد', total: 200, reason: 'عيب', returnTxId: 'return-1' },
      { originalTransactionId: '1', status: 'معتمد', total: 500, reversedAt: '2026-10-03' },
    ])[0];
    expect(p.stats).toMatchObject({ delivered: 1, failed: 0, returns: 2, deliveryRate: 100, customerIssues: 0 });
    expect(p.money.returns).toBe(200); expect(p.returns).toHaveLength(2);
    expect(p.returns.find(r => r.reversed)).toMatchObject({ stage: 'reversed', refunded: 0 });
  });
  it('includes each pending, completed, rejected and reversed case, with separate exchange counts and actual settlements', () => {
    const cases = [
      { _id: 'pending', originalTransactionId: '1', originalRef: '1001', status: 'معلق', requestKind: 'return', total: 200,
        workflow: { version: 2, ref: 'AS-1', stage: 'approved', quote: { refundDue: 175 } } },
      { _id: 'exchange', originalTransactionId: '1', originalRef: '1001', status: 'معتمد', requestKind: 'exchange', total: 300,
        returnTxId: 'rt2', workflow: { version: 2, ref: 'AS-2', stage: 'closed', receivedAt: '2026-11-10',
          replacementTxId: 'replacement', replacementRef: '2001', quote: { collectDue: 100 }, collection: { amount: 100 } } },
      { _id: 'paid-return', originalTransactionId: '1', status: 'معتمد', total: 200,
        returnTxId: 'rt3', workflow: { version: 2, stage: 'closed', receivedAt: '2026-11-10', quote: { refundDue: 150 }, refund: { amount: 150 } } },
      { _id: 'rejected', originalTransactionId: '1', status: 'مرفوض', total: 200,
        workflow: { version: 2, stage: 'cancelled', quote: { refundDue: 200 } } },
      { _id: 'other-customer', originalTransactionId: 'other', status: 'معتمد', total: 900 },
    ];
    const p = build([sale('1', { deliveredAt: '2026-10-02' })], [], cases)[0];
    expect(p.stats).toMatchObject({ returns: 3, exchanges: 1, delivered: 1, customerIssues: 0 });
    expect(p.money.returns).toBe(500);
    expect(p.returns).toHaveLength(4);
    expect(p.returns.find(r => r.caseId === 'pending')).toMatchObject({ stage: 'approved', refunded: 0, refundDue: 175 });
    expect(p.returns.find(r => r.kind === 'exchange')).toMatchObject({ replacementId: 'replacement', replacementRef: '2001', collected: 100, collectDue: 0, refunded: 0 });
    expect(p.returns.find(r => r.caseId === 'paid-return')).toMatchObject({ refunded: 150, refundDue: 0 });
    expect(p.returns.find(r => r.caseId === 'rejected')).toMatchObject({ refundDue: 0 });
  });
  it('attaches replacements to the original Shopify identity even with shared numbers and counts only new cash as paid', () => {
    const profiles = build([sale('original', { shopifyOrderId: 's1', deposit: 1000 }),
      sale('replacement', { total: 600, deposit: 600, remaining: 0,
        afterSales: { role: 'replacement', originalTransactionId: 'original', originalRef: '1001', creditApplied: 500 } })],
    [order('o1', { shopifyId: 's1', shopifyCustomerId: 'customer-a' }),
      order('o2', { shopifyCustomerId: 'customer-b' })]);
    expect(profiles).toHaveLength(2);
    const p = profiles.find(r => r.key === 's:customer-a')!;
    expect(p.history).toHaveLength(2);
    expect(p.history.find(r => r.replacement)).toMatchObject({ paid: 100, creditApplied: 500, originalRef: '1001' });
    expect(p.money.paid).toBe(1100);
  });
  it('does not merge the same name on different numbers, or unknown contacts', () => {
    expect(build([sale('1'), sale('2', { phone: '01112345678' })])).toHaveLength(2);
    expect(build([sale('1', { phone: '' }), sale('2', { phone: '' })])).toHaveLength(2);
  });
  it('combines one Shopify identity across changed numbers and a unique legacy phone', () => {
    const p = build([sale('legacy')], [order('1', { shopifyCustomerId: 'c1' }),
      order('2', { shopifyCustomerId: 'c1', phone: '01112345678' })]);
    expect(p).toHaveLength(1); expect(p[0].stats.orders).toBe(3); expect(p[0].phones).toHaveLength(2);
  });
  it('does not merge different Shopify customers sharing a family number', () => {
    const profiles = build([sale('legacy')], [order('1', { shopifyCustomerId: 'c1' }), order('2', { shopifyCustomerId: 'c2' })]);
    expect(profiles).toHaveLength(3);
  });
  it('does not count tests and duplicates as real orders or negative behavior', () => {
    const p = build([], [order('1', { cancelled: true, cancelReasonCode: 'test-order' }),
      order('2', { cancelled: true, cancelReasonCode: 'duplicate-order' })])[0];
    expect(p.stats.orders).toBe(0); expect(p.stats.customerIssues).toBe(0);
  });
  it('requires recorded invalid details to display the invalid-details label', () => {
    expect(build([], [order('1', { cancelled: true, cancelReasonCode: 'fake-order' })])[0].assessment).toBe('documentedFake');
    expect(build([], [order('1', { cancelled: true }), order('2', { cancelled: true })])[0].assessment).toBe('insufficient');
  });
  it('includes linked confirmation cancellations without duplicating orders or changing finances', () => {
    const p = build([], [order('1')], [], [{ shopifyOrderId: 'o-1', status: 'العميل ألغى الطلب', reason: 'عملية تأكيد الطلب' }])[0];
    expect(p.stats).toMatchObject({ orders: 1, cancelledBefore: 1, active: 0 });
    expect(p.money.total).toBe(0);
  });
  it('deduplicates historical addresses and sorts Date objects chronologically', () => {
    const p = build([sale('1', { date: '', createdAt: new Date('2026-10-01'), shippingAddress: 'شارع 1' }),
      sale('2', { date: '', createdAt: new Date('2026-11-01'), shippingAddress: 'شارع 1' })])[0];
    expect(p.history.map(r => r.id)).toEqual(['2', '1']); expect(p.addresses).toHaveLength(1);
  });
  it('extracts and normalizes email and stable identity from new Shopify payloads', () => {
    expect(shopifyContact({ customer: { id: 321, email: ' Person@Example.com ' }, email: 'other@example.com' }))
      .toEqual({ shopifyCustomerId: '321', customerEmail: 'person@example.com' });
    expect(shopifyContact({ customer: { email: null }, contact_email: 'order@example.com' }).customerEmail).toBe('order@example.com');
    expect(shopifyContact({ email: 'invalid' }).customerEmail).toBe('');
  });
  it('computes regular and valued classifications only with sufficient completed evidence', () => {
    const deliveries = (count: number) => Array.from({ length: count }, (_, i) => sale(String(i), { pickupStatus: 'Delivered' }));
    expect(build(deliveries(2))[0].assessment).toBe('insufficient');
    expect(build(deliveries(3))[0].assessment).toBe('reliable');
    expect(build(deliveries(5))[0].assessment).toBe('valued');
  });
  it('does not permanently penalize a reliable customer for old cancellations', () => {
    const good = Array.from({ length: 20 }, (_, i) => sale('good-' + i, { pickupStatus: 'Delivered', date: '2026-10-01' }));
    const old = [sale('old1', { cancelled: true, cancelReasonCode: 'customer-changed-mind', date: '2025-01-01' }),
      sale('old2', { cancelled: true, cancelReasonCode: 'customer-found-cheaper', date: '2025-01-01' })];
    const p = build([...good, ...old])[0];
    expect(p.stats).toMatchObject({ customerIssues: 2, recentCustomerIssues: 0, recentOrders: 10 });
    expect(p.assessment).toBe('valued');
  });
  it('does not join a legacy contact when its phone and email point at different Shopify customers', () => {
    const profiles = build([sale('legacy', { customerEmail: 'b@example.com' })], [order('1', { shopifyCustomerId: 'a' }),
      order('2', { shopifyCustomerId: 'b', phone: '01112345678', customerEmail: 'b@example.com' })]);
    expect(profiles).toHaveLength(3);
  });
  it.each(['', 'person@example.com'])('accepts an optional, valid email (%s)', async email => {
    expect(await validate(Object.assign(new ClientEmailDto(), { email }))).toHaveLength(0);
  });
  it.each([undefined, null, 'invalid', '<script>@bad', 42])('rejects malformed email %s', async email => {
    expect((await validate(Object.assign(new ClientEmailDto(), { email })))).not.toHaveLength(0);
  });
});
