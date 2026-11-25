/**
 * Where an incoming Shopify order stands in the confirmation flow — the buckets of the Shopify
 * KPI strip (frontend `shopify-kpis.js` `_spkBucket`). ⚠ Keep the three in step: that file, the
 * assistant (`intakeCounts`) and the external API all call this.
 *
 * First match wins, so the buckets always add up to «الواردة»:
 *   cancelled (cancelled, or rejected) → deposit (approved receipts, or a legacy deposit on an
 *   approved order) → nodep (ships without a deposit, or already recorded) → followup (an open
 *   follow-up) → open (no action yet).
 */
export type ConfirmationBucket = 'cancelled' | 'deposit' | 'nodep' | 'followup' | 'open';

export const FOLLOWUP_SETTLED_STATUSES = ['تم حل المشكلة', 'تمت المتابعة', 'تمت عملية التأكيد', 'العميل ألغى الطلب'];

export function approvedDepositOf(o: any): number {
  const rec = Array.isArray(o?.depositReceipts) ? o.depositReceipts : [];
  const approved = rec.filter((r: any) => r?.status === 'معتمد').reduce((x: number, r: any) => x + (Number(r.amount) || 0), 0);
  const legacy = o?.status === 'approved' && !rec.length ? Number(o.depositAmount) || 0 : 0;
  return approved + legacy;
}

export function confirmationBucket(o: any, hasOpenFollowUp: boolean): ConfirmationBucket {
  if (o?.cancelled || o?.status === 'rejected') return 'cancelled';
  if (approvedDepositOf(o) > 0) return 'deposit';
  if (o?.shipWithoutDeposit === true || o?.status === 'approved') return 'nodep';
  if (hasOpenFollowUp) return 'followup';
  return 'open';
}
