import { fullPaymentEvidence, planSync, shippingEvent, syncSource } from '../../src/shopify/sync/sync-plan';
import { applyFixtureAction, syncFixture } from '../fixtures/shopify-sync';

describe('outbound Shopify planner', () => {
  beforeAll(() => jest.useFakeTimers().setSystemTime(new Date('2026-10-29T12:00:00Z')));
  afterAll(() => jest.useRealTimers());
  function setup() { const f = syncFixture(); return { ...f, source: syncSource(f.tx, f.order) }; }
  it('omits removed order-edit lines with zero remaining quantity from fulfillment', () => {
    const { source, remote } = setup();
    remote.fulfillmentOrders.nodes[0].lineItems.nodes.push({ id:'removed',remainingQuantity:0,lineItem:{id:'gid://shopify/LineItem/removed'} });
    const p = planSync(source, remote, false); expect(p.issues).toEqual([]);
    expect(p.actions[0].input.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems).toEqual([{id:'gid://shopify/FulfillmentOrderLineItem/1',quantity:1}]);
  });
  it('uses an explicit six-pieces-to-one-pack reconciliation, while shipping only one pack', () => {
    const f = syncFixture(); f.tx.items[0].qty = 6; f.tx.items[0].price = 145;
    f.order.rawData.line_items[0].price = '870.00';
    const mapping = [{ lineId: '123', sku: 'B-1', localQty: 6, remoteQty: 1, localUnitPrice: 14500, remoteUnitPrice: 87000 }];
    const p = planSync(syncSource(f.tx, f.order, mapping), f.remote, false);
    expect(p.issues).toEqual([]);
    expect(p.actions[0].input.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems[0].quantity).toBe(1);
    expect(p.warnings[0]).toContain('6');
    expect(planSync(syncSource(f.tx, f.order), f.remote, false).actions).toEqual([]);
  });
  it.each(['price','qty','lineId','sku','ambiguous','remotePrice'])('rejects a stale or invalid unit mapping: %s', change => {
    const f = syncFixture(); f.tx.items[0].qty = 6; f.tx.items[0].price = 145; f.order.rawData.line_items[0].price = '870.00';
    const mapping: any[] = [{ lineId:'123',sku:'B-1',localQty:6,remoteQty:1,localUnitPrice:14500,remoteUnitPrice:87000 }];
    if (change === 'price') f.tx.items[0].price = 140;
    if (change === 'qty') f.tx.items[0].qty = 5;
    if (change === 'lineId') mapping[0].lineId = 'other';
    if (change === 'sku') mapping[0].sku = 'other';
    if (change === 'ambiguous') mapping.push(mapping[0]);
    if (change === 'remotePrice') f.order.rawData.line_items[0].price = '900';
    expect(planSync(syncSource(f.tx, f.order, mapping), f.remote, false).actions).toEqual([]);
  });
  function manual() {
    const f = syncFixture(); Object.assign(f.tx, { type: 'مبيعات', deliverySource: 'MANUAL', bostaOrderId: '', bostaTrackingNumber: '', bostaRawResponse: null,
      deliveryAuditLog: [{ action: 'MANUAL_DELIVERY_CONFIRMATION', newStatus: 'DELIVERED', by: 'admin', at: f.tx.deliveredAt }] });
    return f;
  }
  it('syncs an audited manual delivery without inventing a carrier or tracking number', () => {
    const f = manual(); const source = syncSource(f.tx, f.order);
    expect(source.shipmentType).toBe('MANUAL_SEND');
    const p = planSync(source, f.remote, false);
    expect(p.issues).toEqual([]); expect(p.actions.map(a => a.kind)).toEqual(['fulfill', 'event', 'metadata']);
    expect(p.actions[0].input.trackingInfo).toBeUndefined();
    applyFixtureAction(f.remote, p.actions[0]);
    const event = planSync(source, f.remote, false).actions[0];
    expect(event.input).toMatchObject({ fulfillmentId: 'gid://shopify/Fulfillment/1', status: 'DELIVERED', happenedAt: f.tx.deliveredAt.toISOString() });
    applyFixtureAction(f.remote, event); applyFixtureAction(f.remote, planSync(source, f.remote, false).actions[0]);
    expect(planSync(source, f.remote, false).actions).toEqual([]);
    expect(f.remote.displayFinancialStatus).toBe('PENDING');
  });
  it.each(['noAudit', 'undone', 'wrongDate', 'notSales', 'noActor'])('does not infer manual delivery from incomplete evidence: %s', kind => {
    const f = manual();
    if (kind === 'noAudit') f.tx.deliveryAuditLog = [];
    if (kind === 'undone') f.tx.deliveryAuditLog.push({ action: 'MANUAL_DELIVERY_UNDO' });
    if (kind === 'wrongDate') f.tx.deliveredAt = '2026-10-26T00:00:00Z';
    if (kind === 'notSales') f.tx.type = 'مرتجع';
    if (kind === 'noActor') f.tx.deliveryAuditLog[0].by = '';
    const p = planSync(syncSource(f.tx, f.order), f.remote, false);
    expect(p.actions).toEqual([]); expect(p.issues.length).toBeGreaterThan(0);
  });
  it('does not overwrite another tracked fulfillment for a manual delivery', () => {
    const f = manual(); const source = syncSource(f.tx, f.order);
    applyFixtureAction(f.remote, planSync(source, f.remote, false).actions[0]);
    f.remote.fulfillments[0].trackingInfo = [{ number: 'external-carrier' }];
    expect(planSync(source, f.remote, false).actions).toEqual([]);
  });
  it.each([
    ['CREATED', 10, null], ['CREATED', 11, null], ['CREATED', 20, null],
    ['PICKED_UP', 21, 'CARRIER_PICKED_UP'], ['PICKED_UP', 23, 'CARRIER_PICKED_UP'],
    ...[22, 24, 25, 30, 40].map(c => ['IN_TRANSIT', c, 'IN_TRANSIT']),
    ['OUT_FOR_DELIVERY', 41, 'OUT_FOR_DELIVERY'], ['DELIVERED', 45, 'DELIVERED'],
    ['RETURNED', 46, null], ['FAILED_ATTEMPT', 47, 'ATTEMPTED_DELIVERY'],
    ['CANCELLED', 48, null], ['CANCELLED', 49, null], ['RETURNED', 60, null],
    ['FAILED_ATTEMPT', 100, 'FAILURE'], ['FAILED_ATTEMPT', 101, 'FAILURE'],
    ['FAILED_ATTEMPT', 102, 'DELAYED'], ['FAILED_ATTEMPT', 103, null],
    ['CANCELLED', 104, null], ['IN_TRANSIT', 105, 'DELAYED'], ['CUSTOMER_POSTPONED', 47, 'DELAYED'],
    ['UNKNOWN', null, null],
  ])('maps local %s / %s to %s', (state, code, expected) => {
    const { source } = setup(); source.state = state; source.rawCode = code;
    expect(shippingEvent(source)).toBe(expected);
  });
  it('does not let a stale postponement override a confirmed delivery or return', () => {
    const { source } = setup(); source.exception = 3; source.rawCode = 105;
    expect(shippingEvent(source)).toBe('DELIVERED');
    source.state = 'RETURNED'; expect(shippingEvent(source)).toBeNull();
  });
  it('accepts the actual Bosta shipment-type object and preserves unknown types', () => {
    const { tx, order } = setup(); tx.bostaRawResponse.type = { code: 10, value: 'Send' };
    expect(shippingEvent(syncSource(tx, order))).toBe('DELIVERED');
    tx.bostaRawResponse.type = { code: 99 }; expect(shippingEvent(syncSource(tx, order))).toBeNull();
    delete tx.bostaRawResponse.type; expect(syncSource(tx, order).shipmentType).toBe('UNKNOWN');
  });
  it.each(['RTO', 'EXCHANGE', 'CUSTOMER_RETURN_PICKUP'])('never sends customer delivery for %s legs', shipmentType => {
    const { source, remote } = setup(); source.shipmentType = shipmentType;
    expect(planSync(source, remote, false).actions.map(a => a.kind)).toEqual(['metadata']);
  });
  it('creates fulfillment, delivery event and operational info, without assuming payment', () => {
    const { source, remote } = setup();
    const plan = planSync(source, remote, true);
    expect(plan.issues).toEqual([]);
    expect(plan.actions.map(a => a.kind)).toEqual(['fulfill', 'event', 'metadata']);
    expect(plan.actions[0].input.notifyCustomer).toBe(false);
    expect(plan.actions[0].input.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems).toEqual([{ id: 'gid://shopify/FulfillmentOrderLineItem/1', quantity: 1 }]);
  });
  it('replanning after each successful operation converges, and never duplicates delivery', () => {
    const { source, remote } = setup(); const kinds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = planSync(source, remote, false); expect(p.issues).toEqual([]);
      if (!p.actions.length) break;
      kinds.push(p.actions[0].kind); applyFixtureAction(remote, p.actions[0]);
    }
    expect(kinds).toEqual(['fulfill', 'event', 'metadata']);
    expect(planSync(source, remote, false).actions).toEqual([]);
  });
  it.each(['identity', 'ref', 'currency', 'total', 'quantity', 'sku', 'missingOriginal', 'cancelled', 'refunded', 'multiLocation', 'partial', 'missingTime', 'futureTime'])('blocks mismatched or unsafe %s before any write', kind => {
    const { source, remote } = setup();
    if (kind === 'identity') remote.id = 'gid://shopify/Order/other';
    if (kind === 'ref') remote.name = '#other';
    if (kind === 'currency') remote.currentTotalPriceSet.shopMoney.currencyCode = 'USD';
    if (kind === 'total') remote.currentTotalPriceSet.shopMoney.amount = '999';
    if (kind === 'quantity') remote.lineItems.nodes[0].currentQuantity = 2;
    if (kind === 'sku') source.items[0].sku = 'WRONG';
    if (kind === 'missingOriginal') source.original = [];
    if (kind === 'cancelled') remote.cancelledAt = '2026-10-28';
    if (kind === 'refunded') remote.totalRefundedSet.shopMoney.amount = '1';
    if (kind === 'multiLocation') remote.fulfillmentOrders.nodes.push(remote.fulfillmentOrders.nodes[0]);
    if (kind === 'partial') remote.fulfillmentOrders.nodes[0].lineItems.nodes[0].remainingQuantity = 0;
    if (kind === 'missingTime') source.eventAt = null;
    if (kind === 'futureTime') source.eventAt = '2026-11-29T00:00:00Z';
    const p = planSync(source, remote, false); expect(p.actions).toEqual([]); expect(p.issues.length).toBeGreaterThan(0);
  });
  it('blocks external tracking and stale events, but permits a known tracking correction', () => {
    const { source, remote } = setup(); applyFixtureAction(remote, planSync(source, remote, false).actions[0]);
    remote.fulfillments[0].trackingInfo[0].number = 'old';
    expect(planSync(source, remote, false).actions).toEqual([]);
    expect(planSync(source, remote, false, { fulfillmentId: remote.fulfillments[0].id, tracking: 'old' }).actions[0].kind).toBe('tracking');
    remote.fulfillments[0].trackingInfo[0].number = source.tracking;
    remote.fulfillments[0].events.nodes = [{ status: 'OUT_FOR_DELIVERY', happenedAt: '2026-10-26T00:00:00Z' }];
    expect(planSync(source, remote, false).actions).toEqual([]);
  });
  it('does not regress a delivered shipment even when an in-transit event arrives later', () => {
    const { source, remote } = setup(); applyFixtureAction(remote, planSync(source, remote, false).actions[0]);
    remote.fulfillments[0].events.nodes = [{ status: 'DELIVERED', happenedAt: source.eventAt }];
    source.state = 'IN_TRANSIT'; source.rawCode = 22; source.eventAt = '2026-10-28T00:00:00Z';
    expect(planSync(source, remote, false).actions).toEqual([]);
  });
  it('records returns and local cancellation only as operational information', () => {
    const { source, remote } = setup(); source.state = 'RETURNED'; source.cancelled = true;
    expect(planSync(source, remote, true).actions.map(a => a.kind)).toEqual(['metadata']);
  });
  it('requires exact gross COD and matching shipment proof, not the net carrier payout', () => {
    const { tx, order } = setup(); tx.carrierSettlement = { phase: 'wallet', status: 'pending', walletDepositedAt: '2026-10-26', carrierCod: 470, trackingNumber: tx.bostaTrackingNumber, shortfall: 0 };
    expect(fullPaymentEvidence(syncSource(tx, order))).toBe(true);
    tx.carrierSettlement.carrierCod = 400; expect(fullPaymentEvidence(syncSource(tx, order))).toBe(false);
    tx.carrierSettlement.carrierCod = 470; tx.carrierSettlement.trackingNumber = 'other'; expect(fullPaymentEvidence(syncSource(tx, order))).toBe(false);
  });
  it('payment is opt-in; partial deposit is informational; full proven payment can be recorded', () => {
    const { source, remote } = setup();
    expect(planSync(source, remote, true).actions.some(a => a.kind === 'payment')).toBe(false);
    source.deposit = source.total; source.remaining = 0;
    expect(planSync(source, remote, false).actions.some(a => a.kind === 'payment')).toBe(false);
    expect(planSync(source, remote, true).actions.some(a => a.kind === 'payment')).toBe(true);
    source.reversed = true; expect(fullPaymentEvidence(source)).toBe(false);
  });
  it.each(['AUTHORIZATION', 'CAPTURE', 'SALE'])('never captures or duplicates an existing %s', kind => {
    const { source, remote } = setup(); source.deposit = source.total; source.remaining = 0;
    remote.transactions = [{ kind, status: 'SUCCESS' }];
    const p = planSync(source, remote, true); expect(p.actions).toEqual([]); expect(p.issues.length).toBeGreaterThan(0);
  });
  it('uses compare-and-set for existing ERP metadata', () => {
    const { source, remote } = setup(); remote.erpStatus = { value: '{}', compareDigest: 'previous' };
    expect(planSync(source, remote, false).actions.find(a => a.kind === 'metadata')?.input.compareDigest).toBe('previous');
  });
  it('business fingerprint ignores webhook echoes and unrelated updates', () => {
    const { tx, order } = setup(); const before = syncSource(tx, order);
    tx.updatedAt = new Date(); tx.client = 'private'; order.rawData.metafields = [{ value: 'echo' }];
    expect(syncSource(tx, order)).toEqual(before);
  });
});
