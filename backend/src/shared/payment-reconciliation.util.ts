/**
 * Payment reconciliation for a sale — the ONE rule for "what has the customer paid, what is still
 * owed, and what was paid in excess". Pure: reads a transaction-shaped object, writes nothing.
 *
 * ⚠ Paid is derived from the payment LOGS, never from `deposit` alone:
 *   - `deposits[]` (non-reversed) — money taken before/at the sale (receipts, edit top-ups).
 *   - `payments[]` (non-reversed) — collections. `collect()` stores the VAULT NET in `deposit`
 *     (COD minus shipping) but the customer paid `collectedAmount`, so `total − deposit` would
 *     make every collected COD order look short by its shipping fee.
 *   - A legacy row with no deposits log still carries its initial deposit in the field, hence
 *     `max(log, deposit − vault part of payments)`.
 *   - `creditMoves[]` — overpayment refunds and transfers between orders (see order-credit.service):
 *     a completed refund or transfer-out lowers what this order has kept; a transfer-in raises it.
 *     A PENDING refund has not returned any money, so it does not lower the paid amount — it only
 *     reserves part of the overpayment so it cannot be refunded or transferred twice.
 *
 * ⚠ Editing an order never changes any of these inputs except `total`. That is the point: the
 * remaining balance and the overpayment follow the new total; the money history stays as it was.
 */

export const RECON_TOLERANCE = 0.005;
export const round2 = (n: number) => Math.round((Number(n) || 0) * 100 + Number.EPSILON) / 100;

export type CreditMoveKind = 'refund' | 'transfer-out' | 'transfer-in';
/** 'completing' = a refund claimed for payout whose vault entry is being written — still pending. */
export type CreditMoveStatus = 'pending' | 'completing' | 'completed' | 'cancelled';

export interface CreditMove {
  id: string;
  kind: CreditMoveKind;
  amount: number;
  status: CreditMoveStatus;
  /** transfer: the other order. */
  counterpartTxId?: string;
  counterpartRef?: string;
  method?: string;
  reference?: string;
  date?: string;
  reason?: string;
  requestKey?: string;
  customerApproved?: boolean;
  vaultTxNo?: string;
  vaultEntryId?: string;
  by?: string;
  at?: string;
  completedBy?: string;
  completedAt?: string;
  cancelledBy?: string;
  cancelledAt?: string;
  cancelReason?: string;
}

/** Overpayment handling chosen by a person. '' = nothing chosen (shown as pending resolution). */
export type OverpaymentMode = '' | 'credit' | 'unresolved';

export interface Reconciliation {
  total: number;
  /** Cash the customer actually handed over (deposits + collections). */
  cashPaid: number;
  creditIn: number;
  creditOut: number;
  refunded: number;
  refundPending: number;
  /** cashPaid + creditIn − creditOut − refunded */
  netPaid: number;
  remaining: number;
  overpayment: number;
  /** Overpayment not yet reserved by a pending refund — what can still be refunded or moved. */
  available: number;
  mode: OverpaymentMode;
  /** paid | due | credit | refund-pending | pending-resolution */
  state: 'paid' | 'due' | 'credit' | 'refund-pending' | 'pending-resolution';
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function customerCashPaid(tx: any): number {
  const deposits = (Array.isArray(tx?.deposits) ? tx.deposits : []).filter((d: any) => d && !d.reversed && num(d.amount) > 0);
  const payments = (Array.isArray(tx?.payments) ? tx.payments : []).filter((p: any) => p && !p.reversed);
  const depositLog = deposits.reduce((s: number, d: any) => s + num(d.amount), 0);
  const paymentsVault = payments.reduce((s: number, p: any) => s + num(p.amount), 0);
  const paymentsCollected = payments.reduce((s: number, p: any) => s + num(p.collectedAmount ?? p.amount), 0);
  const depositPart = Math.max(depositLog, num(tx?.deposit) - paymentsVault, 0);
  return round2(depositPart + paymentsCollected);
}

export function creditMovesOf(tx: any): CreditMove[] {
  return (Array.isArray(tx?.creditMoves) ? tx.creditMoves : []).filter((m: any) => m && num(m.amount) > 0);
}

export function reconcile(tx: any, newTotal?: number): Reconciliation {
  const total = round2(newTotal !== undefined ? newTotal : num(tx?.total));
  const moves = creditMovesOf(tx);
  const sum = (kind: CreditMoveKind, status: CreditMoveStatus) =>
    round2(moves.filter(m => m.kind === kind && m.status === status).reduce((s, m) => s + num(m.amount), 0));
  const cashPaid = customerCashPaid(tx);
  const creditIn = sum('transfer-in', 'completed');
  const creditOut = sum('transfer-out', 'completed');
  const refunded = sum('refund', 'completed');
  const refundPending = round2(sum('refund', 'pending') + sum('refund', 'completing'));
  const netPaid = round2(cashPaid + creditIn - creditOut - refunded);
  const remaining = round2(Math.max(0, total - netPaid));
  const overpayment = round2(Math.max(0, netPaid - total));
  const available = round2(Math.max(0, overpayment - refundPending));
  const mode: OverpaymentMode = ['credit', 'unresolved'].includes(tx?.overpaymentMode) ? tx.overpaymentMode : '';
  let state: Reconciliation['state'];
  if (overpayment <= RECON_TOLERANCE) state = remaining <= RECON_TOLERANCE ? 'paid' : 'due';
  else if (available <= RECON_TOLERANCE) state = 'refund-pending';
  else if (mode === 'credit') state = 'credit';
  else state = 'pending-resolution';
  return { total, cashPaid, creditIn, creditOut, refunded, refundPending, netPaid, remaining, overpayment, available, mode, state };
}

/** Customer identity used to keep credit inside one customer: phone digits first, else the name. */
export function customerKeyOf(tx: any): string {
  const digits = String(tx?.phone || '').replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/\D/g, '');
  const local = digits.startsWith('20') && digits.length === 12 ? '0' + digits.slice(2) : digits;
  if (local.length >= 8) return 'p:' + local;
  const name = String(tx?.client || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return name ? 'n:' + name : '';
}

/** A Bosta shipment that exists and was not deleted/cancelled — its COD is fixed at the carrier. */
export function hasLiveShipment(tx: any): boolean {
  if (!String(tx?.bostaOrderId || '').trim()) return false;
  const s = String(tx?.bostaStatus || '').trim().toUpperCase();
  return !['DELETED', 'CANCELED', 'CANCELLED', 'TERMINATED', 'REJECTED'].includes(s);
}
