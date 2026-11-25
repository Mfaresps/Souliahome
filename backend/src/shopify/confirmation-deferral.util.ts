/**
 * «تأجيل التواصل» — a Shopify order whose customer asked to be contacted later,
 * before confirming. Distinct from the shipping postponement (after confirmation).
 *
 * ⚠ `code` is stored. Mirrored in frontend/public/shopify-confirm-deferral.js
 * (`SCD_REASONS`) — add a code on both sides, never rename one.
 */
export const CONFIRMATION_DEFERRAL_REASONS = ['call_later', 'no_answer', 'consulting', 'awaiting_payment', 'busy', 'other'];

/** Arabic wording written into the follow-up comment (stored text, like every follow-up comment). */
export const CONFIRMATION_DEFERRAL_LABELS: Record<string, string> = {
  call_later: 'طلب العميل الاتصال لاحقًا', no_answer: 'لا يرد على الهاتف', consulting: 'يستشير شخصًا آخر',
  awaiting_payment: 'ينتظر موعد الدفع', busy: 'العميل مشغول الآن', other: 'سبب آخر',
};

/**
 * Not confirmed yet (owner, Nov 25, 2026: the feature is for unconfirmed orders only):
 * pending, not cancelled, no deposit recorded (approved or in review), not «ship without
 * deposit», not marked confirmed. ⚠ Mirrored by `awaitsConfirmation` in shopify-confirm-deferral.js.
 */
export function orderAwaitsConfirmation(order: any): boolean {
  if (!order || order.status !== 'pending' || order.cancelled || order.shopifyCancelled) return false;
  if (order.shipWithoutDeposit === true || order.confirmationApproved) return false;
  const receipts = Array.isArray(order.depositReceipts) ? order.depositReceipts : [];
  if (receipts.some((r: any) => ['معتمد', 'معلق'].includes(r?.status) && Number(r?.amount) > 0)) return false;
  const tags = String(order.tags || '').toLowerCase().split(',').map((x: string) => x.trim());
  return !tags.includes('confirmed');
}

/** Active = still awaiting confirmation, deferral scheduled or due. Ends by itself once confirmed/cancelled. */
export function confirmationDeferralActive(order: any): boolean {
  return orderAwaitsConfirmation(order) && ['scheduled', 'due'].includes(order.confirmationDeferral?.status);
}
