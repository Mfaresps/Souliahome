/**
 * The money of an after-sales document as its case knows it today.
 *
 * A return document (RT-…) is written once at receipt with deposit 0, remaining 0, «مكتمل» — but the
 * customer's money moves later, in its case: a refund paid from a vault, a return credit applied to the
 * replacement, a refund still due. The replacement sale's own fields stay current (deposit = return credit
 * + deposits on the difference + what was collected). This turns the case into the three figures the
 * Movements table shows: paid, remaining, status.
 */
const money = (v: unknown) => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

export type AfterSalesMoneyState =
  | 'settled'          // nothing left to pay either way
  | 'refunded'         // the customer was paid back
  | 'refund-due'       // we owe the customer (refund or cheaper replacement)
  | 'due'              // the customer owes the rest of the difference
  | 'with-carrier';    // the rest of the difference rides the exchange waybill

export interface AfterSalesMoney {
  role: 'return' | 'replacement';
  kind: 'return' | 'exchange';
  caseRef: string;
  /** What is settled: refund paid, credit applied to the replacement, money received. */
  paid: number;
  /** What is still open: a refund we owe, or the difference the customer owes. */
  remaining: number;
  /** Which way `remaining` flows: 'to-customer' (we pay) or 'from-customer' (we collect). */
  direction: 'to-customer' | 'from-customer' | '';
  state: AfterSalesMoneyState;
  /** Effective «معلق» / «مكتمل» for filters and counts. */
  payStatus: 'معلق' | 'مكتمل';
  creditApplied: number;
  refunded: number;
  fee: number;
  replacementRef: string;
}

export function afterSalesMoneyOf(tx: any, row: any): AfterSalesMoney | null {
  const role = tx?.afterSales?.role;
  const w = row?.workflow;
  if (!w?.quote || !['return', 'replacement'].includes(role) || String(row._id) !== String(tx.afterSales.caseId)) return null;
  const q = w.quote, kind: 'return' | 'exchange' = row.requestKind === 'exchange' ? 'exchange' : 'return';
  const refunded = money(w.refund?.amount);
  const base = { role, kind, caseRef: String(w.ref || tx.afterSales.caseRef || ''), fee: money(q.customerFee),
    creditApplied: money(q.creditApplied), refunded, replacementRef: String(w.replacementRef || '') };
  if (role === 'return') {
    // Exchange: the credit is settled by the replacement; only a cheaper replacement leaves a refund.
    const paid = money((kind === 'exchange' ? Number(q.creditApplied || 0) : 0) + refunded);
    const remaining = money(Math.max(0, Number(q.refundDue || 0) - refunded));
    const state: AfterSalesMoneyState = remaining > 0 ? 'refund-due' : refunded > 0 ? 'refunded' : 'settled';
    return { ...base, role: 'return', paid, remaining, direction: remaining > 0 ? 'to-customer' : '', state, payStatus: remaining > 0 ? 'معلق' : 'مكتمل' };
  }
  // Replacement: the sale's own figures are current (credit + deposits on the difference + collection).
  const remaining = tx.cancelled ? 0 : money(Math.max(0, Number(tx.remaining || 0)));
  const paid = money(Number(tx.deposit || 0));
  const state: AfterSalesMoneyState = remaining <= 0 ? 'settled' : w.shipment && w.fulfillmentChannel !== 'direct' ? 'with-carrier' : 'due';
  return { ...base, role: 'replacement', paid, remaining, direction: remaining > 0 ? 'from-customer' : '', state, payStatus: remaining > 0 ? 'معلق' : 'مكتمل' };
}

/** Attach `afterSalesMoney` to every after-sales document whose case is known. Returns the rows. */
export function attachAfterSalesMoney<T extends Record<string, any>>(transactions: T[], cases: any[]): T[] {
  const byId = new Map(cases.filter(c => c?.workflow?.version === 2).map(c => [String(c._id), c]));
  for (const tx of transactions) {
    const caseId = tx?.afterSales?.caseId;
    if (!caseId) continue;
    const money = afterSalesMoneyOf(tx, byId.get(String(caseId)));
    if (money) (tx as any).afterSalesMoney = money;
  }
  return transactions;
}

/** The status the Movements page filters and counts on: the case's for an after-sales document. */
export function effectivePayStatus(tx: any): string {
  return tx?.afterSalesMoney?.payStatus || tx?.payStatus || '';
}
