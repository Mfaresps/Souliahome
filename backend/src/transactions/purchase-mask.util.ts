import { TransactionDocument } from './schemas/transaction.schema';

/**
 * Sensitive purchase (مشتريات) financial fields hidden from non-admin users.
 * Staff can still see that a purchase exists and its operational status
 * (ref, date, supplier name, items list, pickup/cancel state) — only cost,
 * payment, and profit-relevant amounts are stripped.
 */
const HIDDEN_PURCHASE_FIELDS = [
  'total',
  'itemsTotal',
  'deposit',
  'initialDeposit',
  'remaining',
  'discount',
  'manualDiscount',
  'discountCode',
  'discountCodeId',
  'discountCodeType',
  'manualDiscountType',
  'shipCost',
  'actualShipCost',
  'shipLoss',
  'deposits',
  'payments',
] as const;

const REDACTED = '••••';

function isPurchaseType(type: string | undefined): boolean {
  return type === 'مشتريات' || type === 'مرتجع مشتريات';
}

/** Strips price/qty-derived totals from item rows, keeping product identity/qty only. */
function maskItems(items: any[] | undefined): any[] {
  if (!Array.isArray(items)) return items as any;
  return items.map((it) => ({
    ...it,
    price: null,
    total: null,
  }));
}

/**
 * Masks purchase cost/profit fields on a single transaction-shaped object
 * for non-admin viewers. Non-purchase transactions and admin viewers pass
 * through unchanged. Accepts plain objects (post `.toObject()`/JSON) — never
 * mutates Mongoose documents directly.
 */
export function maskPurchaseFields<T extends Record<string, any>>(
  tx: T,
  role: string | undefined,
): T {
  if (role === 'admin') return tx;
  if (!isPurchaseType(tx?.type)) return tx;

  const masked: Record<string, any> = { ...tx };
  for (const field of HIDDEN_PURCHASE_FIELDS) {
    if (field in masked) masked[field] = null;
  }
  if (Array.isArray(masked.items)) masked.items = maskItems(masked.items);
  masked.purchaseDetailsHidden = true;
  return masked as T;
}

/** Converts a Mongoose document (or array) to plain objects, then masks. */
export function maskTransactionForRole<T extends TransactionDocument | Record<string, any>>(
  tx: T,
  role: string | undefined,
): Record<string, any> {
  const plain = typeof (tx as any)?.toObject === 'function' ? (tx as any).toObject() : tx;
  return maskPurchaseFields(plain as Record<string, any>, role);
}

export function maskTransactionsForRole<T extends TransactionDocument | Record<string, any>>(
  txs: T[],
  role: string | undefined,
): Record<string, any>[] {
  return (txs || []).map((tx) => maskTransactionForRole(tx, role));
}
