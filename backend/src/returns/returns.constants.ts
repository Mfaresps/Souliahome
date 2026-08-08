/**
 * Single source of truth for the returns module's enums and vault-label normalisation.
 *
 * These lived in three places before (returns.service.ts, returns.controller.ts and
 * dto/return-request.dto.ts), and the reason lists had already drifted apart: the DTO accepted six
 * reasons while the service only accepted three, so the three exchange reasons passed DTO
 * validation and were then rejected by the service with a generic message. Keeping them here makes
 * that class of drift impossible.
 */

/** Reasons valid for a plain return (requestKind: 'return'). */
export const RETURN_ONLY_REASONS = [
  'تلف الشحنة',
  'شحنة خاطئة',
  'سبب آخر',
] as const;

/**
 * Reasons that only make sense for an exchange (requestKind: 'exchange').
 * Kept separate rather than merged: a plain refund justified by "رغبة العميل بصنف آخر" is a
 * contradiction — there is no other item in a refund. Wired up by the exchange module.
 */
export const EXCHANGE_ONLY_REASONS = [
  'مقاس أو لون مختلف',
  'رغبة العميل بصنف آخر',
  'عيب مصنع',
] as const;

/** What the DTO accepts. The service narrows this per requestKind. */
export const ALL_RETURN_REASONS = [
  ...RETURN_ONLY_REASONS,
  ...EXCHANGE_ONLY_REASONS,
] as const;

export type ReturnReason = (typeof ALL_RETURN_REASONS)[number];

/**
 * Physical condition of a returned unit.
 *
 * `تالف` is load-bearing, not a label: a damaged unit must NOT re-enter sellable stock.
 * `TransactionsService` reads this off the return transaction's items when it derives inventory —
 * see `returnedItemQtyForStock`. Renaming these strings changes stock behaviour.
 */
export const RETURN_ITEM_CONDITIONS = ['سليم', 'تالف'] as const;

export type ReturnItemCondition = (typeof RETURN_ITEM_CONDITIONS)[number];

export const RETURN_CONDITION_SOUND: ReturnItemCondition = 'سليم';
export const RETURN_CONDITION_DAMAGED: ReturnItemCondition = 'تالف';

/** Advisory window. `daysRemaining` may go negative and is stored/displayed, never enforced. */
export const MAX_RETURN_DAYS = 14;

/**
 * Refund amounts are compared against a computed ceiling. Line totals are rounded independently
 * of the invoice total, so an exact-to-the-pound comparison rejects legitimate full refunds.
 */
export const REFUND_ROUNDING_TOLERANCE = 1;

export const VAULT_AR_LABELS = [
  'كاش',
  'فودافون كاش',
  'Instapay',
  'تحويل بنكي',
] as const;

export type VaultArLabel = (typeof VAULT_AR_LABELS)[number];

const VAULT_CODE_TO_AR: Record<string, VaultArLabel> = {
  cash: 'كاش',
  vodafone: 'فودافون كاش',
  instapay: 'Instapay',
  bank: 'تحويل بنكي',
};

/** Accepts the Arabic label or the header code (cash, bank, …) so the refund leaves the chosen segment. */
export function normalizeVaultAccountLabel(
  v: string | undefined | null,
): VaultArLabel | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  const t = String(v).trim();
  if (!t) {
    return undefined;
  }
  if ((VAULT_AR_LABELS as readonly string[]).includes(t)) {
    return t as VaultArLabel;
  }
  return VAULT_CODE_TO_AR[t.toLowerCase()];
}

/** Statuses that still reserve stock/quantity against the original invoice. */
export const ACTIVE_RETURN_STATUSES = ['معلق', 'معتمد'] as const;

/**
 * Excludes reversed requests from any aggregate. A reversed return had its transaction cancelled,
 * which already gave the stock and the cash back — leaving it in the totals subtracts it twice.
 */
export const NOT_REVERSED_FILTER = {
  $or: [{ reversedAt: null }, { reversedAt: { $exists: false } }],
};
