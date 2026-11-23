import {
  afterSalesCollectedAt, bostaCollectedAt, collectedDateCorrection, courierCollectedAt, courierCollectedButOnBoard, courierCollectedUpdate, courierHasParcel,
} from '../../src/shared/courier-collected.util';

export {};

const sale = (over: any = {}) => ({ type: 'مبيعات', cancelled: false, shipCo: 'Bosta', ...over });
// #3198: sent from the prep workspace (stays Preparing), collected Nov 19, delivered Nov 21.
const raw3198 = {
  collectedFromBusiness: '2026-11-19T16:20:28.603Z',
  timeline: [{ code: 10, date: '2026-11-19T14:22:01.934Z' }, { code: 21, date: '2026-11-19T16:20:28.603Z' }, { code: 45, date: '2026-11-21T20:13:01.086Z' }],
};

describe('courier-collected rule', () => {
  it('moves an order still in Preparing to Shipped once Bosta delivered it (#3198)', () => {
    const u = courierCollectedUpdate(sale({ pickupStatus: 'Preparing', pickupRef: '306-10NOV' }), 'DELIVERED', raw3198, '2026-11-23T10:00:00.000Z');
    expect(u.pickupStatus).toBe('Shipped');
    expect(u.shippedAt).toBe('2026-11-19T16:20:28.603Z');
    expect(u.pickupDate).toBe('2026-11-19');
    expect(u.pickupRef).toMatch(/^SH-2026-11-19-/);
  });

  it('still promotes Ready on pickup, as before', () => {
    const u = courierCollectedUpdate(sale({ pickupStatus: 'Ready' }), 'PICKED_UP', {}, '2026-11-23T10:00:00.000Z');
    expect(u.pickupStatus).toBe('Shipped');
    expect(u.pickupDate).toBe('2026-11-23');
  });

  it('never touches Shipped / Delivered, nor an order Bosta has not collected', () => {
    expect(courierCollectedUpdate(sale({ pickupStatus: 'Shipped' }), 'DELIVERED', raw3198, '2026-11-23T10:00:00.000Z')).toEqual({});
    expect(courierCollectedUpdate(sale({ pickupStatus: 'Delivered' }), 'DELIVERED', raw3198, '2026-11-23T10:00:00.000Z')).toEqual({});
    expect(courierCollectedUpdate(sale({ pickupStatus: 'Preparing' }), 'CREATED', {}, '2026-11-23T10:00:00.000Z')).toEqual({});
    expect(courierCollectedUpdate(sale({ pickupStatus: 'Ready' }), 'DELETED', {}, '2026-11-23T10:00:00.000Z')).toEqual({});
  });

  it("Bosta's pickup time wins over a stored shippedAt; without it the stored one is kept", () => {
    const u = courierCollectedUpdate(sale({ pickupStatus: 'Ready', shippedAt: '2026-11-23T03:00:00.000Z' }), 'DELIVERED', raw3198, '2026-11-23T10:00:00.000Z');
    expect(u.shippedAt).toBe('2026-11-19T16:20:28.603Z');
    const v = courierCollectedUpdate(sale({ pickupStatus: 'Ready', shippedAt: '2026-11-18T09:00:00.000Z' }), 'DELIVERED', {}, '2026-11-23T10:00:00.000Z');
    expect(v.shippedAt).toBe('2026-11-18T09:00:00.000Z');
  });

  it('fixes the shipped day from Bosta, never from a return-leg record (#3202, #2281)', () => {
    const shipped = sale({ pickupStatus: 'Shipped', pickupRef: 'SH-2026-11-23-0D5F', bostaStatus: 'IN_TRANSIT', shippedAt: '2026-11-23T03:20:24.283Z' });
    const fix = collectedDateCorrection(shipped, { type: { code: 10, value: 'Send' }, collectedFromBusiness: '2026-11-19T16:20:28.603Z' });
    expect(fix).toMatchObject({ shippedAt: '2026-11-19T16:20:28.603Z', pickupDate: '2026-11-19' });
    expect(fix.pickupRef).toMatch(/^SH-2026-11-19-/);
    expect(collectedDateCorrection({ ...shipped, shippedAt: '2026-11-19T10:00:00.000Z' }, { collectedFromBusiness: '2026-11-19T16:20:28.603Z' })).toEqual({});
    const rto = { type: { code: 20, value: 'Return to Origin' }, collectedFromBusiness: '2026-09-05T15:32:31.906Z' };
    expect(collectedDateCorrection(sale({ pickupStatus: 'Shipped', bostaStatus: 'RETURNED', shippedAt: '2026-08-01T06:42:25.265Z' }), rto)).toEqual({});
  });

  it('collection time falls back to the timeline, then the delivery time', () => {
    expect(courierCollectedAt({}, { timeline: [{ code: 21, date: '2026-11-20T08:00:00.000Z' }] }, 'x')).toBe('2026-11-20T08:00:00.000Z');
    expect(courierCollectedAt({ deliveredAt: '2026-11-21T12:00:00.000Z' }, {}, 'x')).toBe('2026-11-21T12:00:00.000Z');
  });

  it('flags stuck orders for the repair, and only those', () => {
    expect(courierCollectedButOnBoard(sale({ pickupStatus: 'Ready', bostaStatus: 'DELIVERED' }))).toBe(true);
    expect(courierCollectedButOnBoard(sale({ pickupStatus: undefined, bostaStatus: 'DELIVERED' }))).toBe(true);
    expect(courierCollectedButOnBoard(sale({ pickupStatus: 'Ready', bostaStatus: 'CREATED' }))).toBe(false);
    expect(courierCollectedButOnBoard(sale({ pickupStatus: 'Shipped', bostaStatus: 'DELIVERED' }))).toBe(false);
    expect(courierCollectedButOnBoard(sale({ pickupStatus: 'Ready', bostaStatus: 'DELIVERED', cancelled: true }))).toBe(false);
    expect(courierHasParcel('delivered')).toBe(true);
  });

  it('an exchange waybill (type 30) gives its pickup time; the case history is the fallback', () => {
    expect(bostaCollectedAt({ type: { code: 30, value: 'Exchange' }, collectedFromBusiness: '2026-10-27T15:27:37.000Z' })).toBe('2026-10-27T15:27:37.000Z');
    const workflow = { history: [
      { action: 'carrier-status', at: '2026-10-27T14:19:47.000Z', eventId: 'carrier:c1:2026-10-27T14:19:47.000Z:10:CREATED' },
      { action: 'carrier-status', at: '2026-10-27T21:33:31.000Z', eventId: 'carrier:c1:2026-10-27T21:33:31.000Z:24:IN_TRANSIT' },
      { action: 'carrier-status', at: '2026-10-27T15:27:37.000Z', eventId: 'carrier:c1:2026-10-27T15:27:37.000Z:21:PICKED_UP' },
    ] };
    expect(afterSalesCollectedAt(workflow)).toBe('2026-10-27T15:27:37.000Z');
    expect(afterSalesCollectedAt({ shipment: { collectedAt: '2026-10-26T10:00:00.000Z' }, ...workflow })).toBe('2026-10-26T10:00:00.000Z');
    expect(afterSalesCollectedAt({ history: [workflow.history[0]] })).toBe('');
  });
});
