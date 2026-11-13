/**
 * shared/payment-reconciliation.util.ts — the one rule for paid / remaining / overpayment on a sale.
 * Scenarios A–F and H of the reconciliation spec, plus the inputs that broke the old
 * `total − deposit` arithmetic (collected COD stores the vault net in `deposit`).
 */
import { reconcile, customerCashPaid, customerKeyOf, hasLiveShipment } from '../../src/shared/payment-reconciliation.util';

export {};

const dep = (amount: number, extra: Record<string, any> = {}) => ({ id: 'd' + amount, amount, method: 'كاش', ...extra });
const sale = (o: Record<string, any> = {}) => ({ type: 'مبيعات', total: 1000, deposit: 500, deposits: [dep(500)], payments: [], ...o });

describe('reconcile — scenarios', () => {
  it('A: paid 500, total 1000 → 800: remaining 300, no overpayment', () => {
    const r = reconcile(sale(), 800);
    expect(r).toMatchObject({ netPaid: 500, remaining: 300, overpayment: 0, state: 'due' });
  });

  it('B: paid 500, total → 500: fully paid', () => {
    expect(reconcile(sale(), 500)).toMatchObject({ remaining: 0, overpayment: 0, state: 'paid' });
  });

  it('C: paid 500, total → 400: overpayment 100, pending resolution', () => {
    expect(reconcile(sale(), 400)).toMatchObject({ remaining: 0, overpayment: 100, available: 100, state: 'pending-resolution' });
  });

  it('C: kept as credit', () => {
    expect(reconcile(sale({ overpaymentMode: 'credit' }), 400).state).toBe('credit');
  });

  it('D: order reduced to zero → the whole 500 is overpayment', () => {
    expect(reconcile(sale(), 0)).toMatchObject({ remaining: 0, overpayment: 500 });
  });

  it('E: total raised to 1400 → remaining 900', () => {
    expect(reconcile(sale(), 1400)).toMatchObject({ remaining: 900, overpayment: 0 });
  });

  it('F: two payments 300 + 200 against 400 → overpayment 100', () => {
    const tx = sale({ deposit: 500, deposits: [dep(300), dep(200, { id: 'd2' })] });
    expect(reconcile(tx, 400)).toMatchObject({ cashPaid: 500, overpayment: 100 });
  });

  it('reversed deposits do not count', () => {
    const tx = sale({ deposit: 300, deposits: [dep(300), dep(200, { id: 'd2', reversed: true })] });
    expect(reconcile(tx, 400)).toMatchObject({ cashPaid: 300, remaining: 100 });
  });

  it('a collected COD counts what the customer paid, not the vault net in `deposit`', () => {
    // 500 deposit + COD 500 collected, 60 shipping kept by the carrier → deposit field 940.
    const tx = sale({ deposit: 940, payments: [{ id: 'p1', amount: 440, collectedAmount: 500 }] });
    expect(reconcile(tx, 1000)).toMatchObject({ cashPaid: 1000, remaining: 0, overpayment: 0 });
  });

  it('a legacy row with no deposits log reads its deposit field', () => {
    expect(customerCashPaid({ deposit: 700, deposits: [], payments: [] })).toBe(700);
  });

  it('H: a pending refund reserves, but has not returned money', () => {
    const tx = sale({ creditMoves: [{ id: 'r', kind: 'refund', amount: 60, status: 'pending' }] });
    expect(reconcile(tx, 400)).toMatchObject({ netPaid: 500, overpayment: 100, refundPending: 60, available: 40 });
  });

  it('a refund being paid out (completing) still reserves', () => {
    const tx = sale({ creditMoves: [{ id: 'r', kind: 'refund', amount: 100, status: 'completing' }] });
    expect(reconcile(tx, 400)).toMatchObject({ available: 0, state: 'refund-pending' });
  });

  it('completed refund lowers what the order kept; cancelled ones are ignored', () => {
    const tx = sale({ creditMoves: [
      { id: 'r1', kind: 'refund', amount: 60, status: 'completed' },
      { id: 'r2', kind: 'refund', amount: 40, status: 'cancelled' },
    ] });
    expect(reconcile(tx, 400)).toMatchObject({ refunded: 60, netPaid: 440, overpayment: 40, available: 40 });
  });

  it('transfers move paid amount between orders without cash', () => {
    const src = sale({ creditMoves: [{ id: 't', kind: 'transfer-out', amount: 100, status: 'completed' }] });
    const tgt = sale({ total: 300, deposit: 0, deposits: [], creditMoves: [{ id: 't', kind: 'transfer-in', amount: 100, status: 'completed' }] });
    expect(reconcile(src, 400)).toMatchObject({ overpayment: 0, cashPaid: 500 });
    expect(reconcile(tgt)).toMatchObject({ cashPaid: 0, creditIn: 100, remaining: 200 });
  });
});

describe('customer key / live shipment', () => {
  it('matches the same phone across formats', () => {
    expect(customerKeyOf({ phone: '+20 100 123 4567' })).toBe(customerKeyOf({ phone: '01001234567' }));
    expect(customerKeyOf({ phone: '٠١٠٠١٢٣٤٥٦٧' })).toBe('p:01001234567');
  });
  it('falls back to the name only without a phone', () => {
    expect(customerKeyOf({ client: '  Sara  Ali ' })).toBe('n:sara ali');
  });
  it('a deleted Bosta shipment is not live', () => {
    expect(hasLiveShipment({ bostaOrderId: 'x', bostaStatus: 'DELETED' })).toBe(false);
    expect(hasLiveShipment({ bostaOrderId: 'x', bostaStatus: 'PICKUP_REQUESTED' })).toBe(true);
    expect(hasLiveShipment({})).toBe(false);
  });
});
