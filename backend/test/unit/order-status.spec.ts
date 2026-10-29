const orderStates = require('../../../frontend/public/order-status.js');

describe('Order lifecycle vocabulary and precedence', () => {
  it.each([
    [{}, 'awaiting_confirmation'],
    [{ notes: '500', tags: 'confirmed, verified via whatsapp', pendingStatus: 'confirmed' }, 'awaiting_confirmation'],
    [{ depositReceipts: [{ status: 'معلق', amount: 500 }] }, 'confirmed'],
    [{ depositReceipts: [{ status: 'مرفوض', amount: 500 }] }, 'awaiting_confirmation'],
    [{ depositReceipts: [{ status: 'معتمد', amount: 0 }] }, 'awaiting_confirmation'],
    [{ depositReceipts: [{ status: 'معتمد', amount: 500 }] }, 'confirmed'],
    [{ shipWithoutDeposit: true }, 'confirmed'],
    [{ confirmationApproved: true }, 'confirmed'],
    [{ cancelled: true, shipWithoutDeposit: true }, 'CANCELLED'],
    [{ status: 'rejected', shipWithoutDeposit: true }, 'rejected'],
  ])('uses submitted deposits or recorded approval for Shopify confirmation: %j', (row, key) => {
    expect(orderStates.resolve({ status: 'pending', ...row }, 'shopify', 'en').key).toBe(key);
  });
  it.each([
    [{}, 'Pending'],
    [{ pickupStatus: 'Preparing' }, 'Preparing'],
    [{ pickupStatus: 'Preparing', prepChecked: true }, 'Preparing'],
    [{ pickupStatus: 'Ready' }, 'Ready'],
    [{ pickupStatus: 'Picked-Up' }, 'Ready'],
    [{ pickupStatus: 'Delivered' }, 'DELIVERED'],
    [{ bostaOrderId: 'b1', bostaStatus: 'CREATED' }, 'Ready'],
    [{ bostaOrderId: 'b1' }, 'Ready'],
    [{ bostaOrderId: 'b1', bostaStatus: 'PICKED_UP' }, 'PICKED_UP'],
    [{ bostaOrderId: 'b1', bostaStatus: 'OUT_FOR_DELIVERY' }, 'OUT_FOR_DELIVERY'],
    [{ bostaOrderId: 'b1', bostaStatus: 'RETURNED' }, 'RETURNED'],
    [{ bostaOrderId: 'b1', bostaStatus: 'DELIVERY_FAILED' }, 'DELIVERY_FAILED'],
    [{ cancelled: true, bostaStatus: 'DELIVERED' }, 'CANCELLED'],
    [{ payStatus: 'ملغي', bostaStatus: 'DELIVERED' }, 'CANCELLED'],
    [{ deliverySource: 'MANUAL', pickupStatus: 'Ready' }, 'Shipped'],
    [{ bostaOrderId: 'old', bostaStatus: 'DELETED', pickupStatus: 'Ready' }, 'Ready'],
  ])('keeps the actual fulfillment stage: %j', (row, key) => {
    expect(orderStates.resolve(row, 'transaction', 'en').key).toBe(key);
  });
  it('adds the carrier only from ready to ship onward, in both languages', () => {
    expect(orderStates.resolve({ pickupStatus: 'Pending', shipCo: 'Bosta' }, 'transaction', 'ar').carrier).toBe('');
    expect(orderStates.resolve({ pickupStatus: 'Ready', shipCo: 'Bosta' }, 'transaction', 'ar').carrier).toBe('بوسطة');
    expect(orderStates.resolve({ pickupStatus: 'Ready', shipCo: 'Other courier' }, 'transaction', 'en').carrier).toBe('Other courier');
  });
  it('keeps deleted and invalid waybills as notes and respects reshipment', () => {
    const row = { pickupStatus: 'Ready', bostaOrderId: 'old', bostaStatus: 'DELETED', shipmentAttempts: [{}] };
    expect(orderStates.resolve(row, 'transaction', 'en')).toMatchObject({ label: 'Awaiting Shipment 2', note: 'AWB Deleted at Bosta' });
    expect(orderStates.resolve({ ...row, bostaOrderId: 'new', bostaStatus: 'IN_TRANSIT' }, 'transaction', 'en').label).toBe('In Transit');
  });
  it('preserves new carrier status codes without making up a known stage', () => {
    expect(orderStates.resolve({ hasShipment: true, bostaStatus: 'NEW_CARRIER_STATUS' }, 'transaction', 'en').label).toBe('NEW_CARRIER_STATUS');
  });
  it.each(['ar', 'en'])('hides old delivery exceptions after successful delivery in %s', lang => {
    const reason = 'Postponed - the customer requested postponement for another day.';
    const row = { bostaOrderId: 'b1', bostaTrackingNumber: '519265', bostaStatus: 'DELIVERED',
      bostaDeliveryException: { code: 3, reason, at: '2026-10-28T12:00:00Z' },
      bostaLastTrackingUpdate: { status: 'DELIVERED', reason, reasonAr: 'طلب العميل تأجيل الاستلام' } };
    expect(orderStates.resolve(row, 'transaction', lang)).toMatchObject({ key: 'DELIVERED', note: '' });
    // Exercise the actual row renderer: remove the warning icon, keep the tracking link.
    const source = require('fs').readFileSync(require('path').resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
    const start = source.indexOf('function _bostaPrimaryStatusBadge(');
    const end = source.indexOf('\n/**', start);
    const render = new Function('_orderStateMeta', 'SouliaOrderStatus', 'escHtml', 'esc',
      source.slice(start, end) + '\nreturn _bostaPrimaryStatusBadge;')(
      tx => orderStates.resolve(tx, 'transaction', lang), orderStates, String, String);
    const html = render(row, { hideStatus: true });
    expect(html).not.toContain('order-state-info');
    expect(html).not.toContain(reason);
    expect(html).toContain('shipment-number=519265');
    expect(orderStates.postponements(row)).toHaveLength(1);
    const waiting = { ...row, bostaStatus: 'IN_TRANSIT', bostaLastTrackingUpdate: { ...row.bostaLastTrackingUpdate, status: 'IN_TRANSIT' } };
    expect(render(waiting, { hideStatus: true })).toContain('order-state-info');
  });
  it('escapes labels and notes and omits the carrier from the badge', () => {
    const badge = orderStates.badge({ key: 'x', tone: 'shipping', label: '<img src=x onerror=alert(1)>', carrier: 'A&B', note: '"test"' });
    expect(badge).not.toContain('<img');
    expect(badge).not.toContain('A&amp;B');
    expect(badge).toContain('&quot;test&quot;');
  });
});
