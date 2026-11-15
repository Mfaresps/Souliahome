/**
 * Purchase-invoice settlement rules — pure, so the money math can be tested with numbers.
 *
 * The one fact everything here rests on: on a purchase, `collect()` ADDS every supplier payment to
 * `tx.deposit`. So `deposit` = opening deposit + every live payment, while `depMethod` names only
 * the opening deposit's vault. `total − remaining` additionally contains money that never left a
 * vault: supplier credit applied (`creditApplied`) and a supplier waiver (`writeOff.amount`).
 *
 *   total = deposit + creditApplied + writeOff + remaining        (for a consistent invoice)
 */

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface PurchasePaymentLike {
  amount?: number;
  method?: string;
  reversed?: boolean;
}

export interface PurchaseLike {
  total?: number;
  deposit?: number;
  remaining?: number;
  depMethod?: string;
  payment?: string;
  collectMethod?: string;
  creditApplied?: number;
  writeOff?: { amount?: number } | null;
  payments?: PurchasePaymentLike[];
  /** Supplier returns settled against this invoice («خصم من المديونية» allocated to it). */
  supplierReturnOffsets?: Array<{ amount?: number; reversedAt?: string | null }> | null;
}

export interface VaultRefund {
  method: string;
  amount: number;
  kind: 'opening-deposit' | 'payment' | 'legacy-payment';
}

export function writeOffAmountOf(tx: PurchaseLike): number {
  return Math.max(0, r2(tx?.writeOff?.amount || 0));
}

/** Active (not reversed) supplier-return value applied to this invoice's remaining. */
export function returnOffsetAmountOf(tx: PurchaseLike): number {
  return r2((tx?.supplierReturnOffsets || [])
    .filter((o) => o && !o.reversedAt)
    .reduce((s, o) => s + Math.max(0, r2(o.amount || 0)), 0));
}

function livePayments(tx: PurchaseLike): PurchasePaymentLike[] {
  return (tx.payments || []).filter((p) => !p?.reversed && r2(p?.amount || 0) > 0);
}

/**
 * The part of `deposit` that is the opening deposit (paid from `depMethod` when the invoice was
 * entered or edited) — i.e. `deposit` minus every live payment. Legacy rows whose payments were
 * not added into `deposit` fall back to the whole `deposit`.
 */
export function openingPurchaseDeposit(tx: PurchaseLike): number {
  const deposit = Math.max(0, r2(tx.deposit || 0));
  const liveSum = r2(livePayments(tx).reduce((s, p) => s + r2(p.amount || 0), 0));
  if (liveSum > 0 && liveSum <= deposit + 0.01) return Math.max(0, r2(deposit - liveSum));
  return deposit;
}

/**
 * Cash to put back into the vaults when a purchase is cancelled, one row per vault it came from.
 *
 * - The opening deposit goes back to `depMethod`.
 * - Each live payment goes back to the vault it was paid from (grouped by vault).
 * - Credit applied and a write-off are NEVER refunded as cash: no cash left for them.
 * - Legacy invoices whose payments were not added into `deposit` still get the unexplained paid
 *   amount refunded to `collectMethod`, exactly as before — so old data keeps its old result.
 */
export function purchaseCancellationRefunds(tx: PurchaseLike): VaultRefund[] {
  const deposit = Math.max(0, r2(tx.deposit || 0));
  const total = r2(tx.total || 0);
  const remaining = Math.max(0, r2(tx.remaining || 0));
  const credit = Math.max(0, r2(tx.creditApplied || 0));
  const waived = writeOffAmountOf(tx);
  const returned = returnOffsetAmountOf(tx);
  const depMethod = tx.depMethod || tx.payment || 'كاش';

  const live = livePayments(tx);
  const liveSum = r2(live.reduce((s, p) => s + r2(p.amount || 0), 0));

  const out: VaultRefund[] = [];
  const add = (method: string, amount: number, kind: VaultRefund['kind']) => {
    const a = r2(amount);
    if (!(a > 0)) return;
    const row = out.find((x) => x.method === method && x.kind === kind);
    if (row) row.amount = r2(row.amount + a);
    else out.push({ method, amount: a, kind });
  };

  if (liveSum > 0 && liveSum <= deposit + 0.01) {
    // Current data: deposit = opening deposit + live payments.
    add(depMethod, deposit - liveSum, 'opening-deposit');
    for (const p of live) add(String(p.method || tx.collectMethod || depMethod), r2(p.amount || 0), 'payment');
  } else {
    add(depMethod, deposit, 'opening-deposit');
  }

  // Paid on the invoice but explained by none of: deposit (cash), credit, write-off.
  // Only legacy rows (payments recorded outside `deposit`) produce this.
  const unexplained = r2(total - remaining - deposit - credit - waived - returned);
  if (unexplained > 0.01 && tx.collectMethod) add(tx.collectMethod, unexplained, 'legacy-payment');

  return out;
}

/**
 * Ledger movement when a purchase is cancelled. The invoice's net ledger effect is
 * `remaining + creditApplied` (the opening debt was posted net of deposit AND credit, and the
 * credit was booked as a separate +credit-used row), so cancelling must take both off —
 * otherwise the supplier credit the invoice consumed is lost for good.
 */
export function purchaseCancellationLedgerDelta(tx: PurchaseLike): number {
  const remaining = Math.max(0, r2(tx.remaining || 0));
  const credit = Math.max(0, r2(tx.creditApplied || 0));
  const total = r2(remaining + credit);
  return total > 0 ? -total : 0;
}

/**
 * What a purchase owes after an edit. Deposit, supplier credit and supplier returns settled
 * against it are real value: if the new total drops below them the difference is owed BACK
 * (`owed` < 0 → returns to the supplier's credit through the ledger). A waiver (`writeOff`) only
 * covers what is still open — it can never push the invoice into credit, and it never turns back
 * into debt because someone edited a note.
 */
export function purchaseOwedAfterEdit(args: {
  newTotal: number;
  newDeposit: number;
  credit: number;
  returnOffset?: number;
  writeOff: number;
}): { owed: number; remaining: number } {
  const beforeWaiver = r2(args.newTotal - args.newDeposit - Math.max(0, args.credit) - Math.max(0, args.returnOffset || 0));
  const owed = beforeWaiver > 0 ? r2(beforeWaiver - Math.min(Math.max(0, r2(args.writeOff)), beforeWaiver)) : beforeWaiver;
  return { owed, remaining: Math.max(0, owed) };
}

export interface OpenInvoice {
  id: string;
  ref: string;
  remaining: number;
  date?: string;
  createdAt?: string;
}

/**
 * Spreads a supplier return's «خصم من المديونية» over the supplier's open invoices:
 *  1) the invoices the goods came from, each up to the returned value from it (`linkedCaps`);
 *  2) then every open invoice, oldest first.
 * What no invoice can absorb (debt that exists only in the ledger — opening balance, manual
 * charge) stays ledger-only and is returned as `unallocated`.
 */
export function allocateReturnOffset(
  amount: number,
  invoices: OpenInvoice[],
  linkedCaps: Array<{ id: string; cap: number }> = [],
): { rows: Array<{ id: string; ref: string; amount: number }>; unallocated: number } {
  let left = Math.max(0, r2(amount));
  const room = new Map(invoices.map((i) => [i.id, Math.max(0, r2(i.remaining))]));
  const byId = new Map(invoices.map((i) => [i.id, i]));
  const taken = new Map<string, number>();
  const take = (id: string, max: number) => {
    if (left < 0.005) return;
    const a = r2(Math.min(left, room.get(id) || 0, Math.max(0, max)));
    if (!(a > 0)) return;
    room.set(id, r2((room.get(id) || 0) - a));
    taken.set(id, r2((taken.get(id) || 0) + a));
    left = r2(left - a);
  };
  for (const l of linkedCaps) if (byId.has(l.id)) take(l.id, l.cap);
  const key = (i: OpenInvoice) => `${String(i.date || '').slice(0, 10)}|${i.createdAt || ''}`;
  for (const i of [...invoices].sort((a, b) => key(a).localeCompare(key(b)))) take(i.id, Infinity);
  const rows = [...taken.entries()].map(([id, a]) => ({ id, ref: byId.get(id)?.ref || '', amount: a }));
  return { rows, unallocated: left };
}
