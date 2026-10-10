/**
 * Pure helpers over an order's deposit receipts — shared by the receipt service, approveOrder and
 * the tests, so "how much is approved" and "how much is still allowed" have exactly one answer.
 */
import type { DepositReceipt } from './schemas/shopify-order.schema';

/** The four vault segments, as the vault stores them. A receipt's method must be one of these. */
export const DEPOSIT_VAULT_METHODS = ['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي'] as const;

/** Rounding slack: line totals and transfers are whole piastres; float noise is not a breach. */
export const DEPOSIT_TOLERANCE = 0.005;

export const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

type WithReceipts = { depositReceipts?: DepositReceipt[] | null; total?: number };

const receipts = (o: WithReceipts): DepositReceipt[] => (Array.isArray(o?.depositReceipts) ? o.depositReceipts : []);

export function receiptsIn(o: WithReceipts, ...statuses: DepositReceipt['status'][]): DepositReceipt[] {
  return receipts(o).filter((r) => statuses.includes(r.status));
}

export function approvedDepositTotal(o: WithReceipts): number {
  return round2(receiptsIn(o, 'معتمد').reduce((s, r) => s + (Number(r.amount) || 0), 0));
}

/**
 * The most a NEW (or edited) receipt may claim: total − approved − every other pending receipt.
 * Pending ones count because each is a claim on the same balance; without them, two receipts
 * submitted before the manager looks could together exceed the order.
 */
export function depositCapFor(o: WithReceipts, excludeReceiptId?: string): number {
  const claimed = receiptsIn(o, 'معتمد', 'معلق')
    .filter((r) => r.id !== excludeReceiptId)
    .reduce((s, r) => s + (Number(r.amount) || 0), 0);
  return round2(Math.max(0, (Number(o?.total) || 0) - claimed));
}

/** Checks the budget in the SAME Mongo write as submit/edit, including concurrent claims. */
export function receiptBudgetExpr(amount: number, excludeReceiptId: string): Record<string, unknown> {
  return {
    $lte: [
      { $add: [amount, { $sum: { $map: {
        input: { $filter: {
          input: { $ifNull: ['$depositReceipts', []] }, as: 'r',
          cond: { $and: [
            { $in: ['$$r.status', ['معتمد', 'معلق']] },
            { $ne: ['$$r.id', excludeReceiptId] },
          ] },
        } },
        as: 'r', in: '$$r.amount',
      } } } ] },
      { $add: ['$total', DEPOSIT_TOLERANCE] },
    ],
  };
}

/** A draft is private to its uploader, including when an admin reads the order list. */
export function visibleReceipts<T extends WithReceipts>(order: T, actorId: string): T {
  return { ...order, depositReceipts: receipts(order).filter(r => r.status !== 'مسودة' || (!!actorId && r.submittedById === actorId)) };
}

export interface DerivedDepositFields {
  depositAmount: number;
  depositMethod: string;
  depositStatus: 'full' | 'partial' | 'none';
  depositPercentage: number;
}

/**
 * The order's deposit summary, from APPROVED receipts only. Feeds employee scoring and the staff
 * dashboard; a pending receipt is not money yet, so it does not count.
 * `depositMethod` is the method of the largest approved receipt (one field cannot hold several).
 */
export function computeDepositFieldsFromReceipts(o: WithReceipts): DerivedDepositFields {
  const approved = receiptsIn(o, 'معتمد');
  const amount = approvedDepositTotal(o);
  const total = Number(o?.total) || 0;
  const percentage = total > 0 ? Math.min(100, Math.round((amount / total) * 100)) : 0;
  const largest = approved.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))[0];
  return {
    depositAmount: amount,
    depositMethod: largest?.method || '',
    depositStatus: amount <= 0 ? 'none' : percentage >= 100 ? 'full' : 'partial',
    depositPercentage: percentage,
  };
}

/** Amount entered by a person: positive, finite, at most two decimals. */
export function isValidDepositAmount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && Math.abs(round2(n) - n) < 1e-9 && n <= 10_000_000;
}
