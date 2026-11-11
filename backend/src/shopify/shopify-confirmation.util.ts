import { approvedDepositTotal } from './deposit-receipts.util';

/** Shopify KPIs: approved deposit, explicit no-deposit approval, or registration. */
export function shopifyConfirmationBucket(order: any): 'cancelled' | 'deposit' | 'nodep' | null {
  if (order.cancelled || order.status === 'rejected') return 'cancelled';
  const receipts = Array.isArray(order.depositReceipts) ? order.depositReceipts : [];
  const legacy = order.status === 'approved' && !receipts.length ? Number(order.depositAmount) || 0 : 0;
  if (approvedDepositTotal({ depositReceipts: receipts }) + legacy > 0) return 'deposit';
  if (order.shipWithoutDeposit === true || order.status === 'approved') return 'nodep';
  return null;
}

/** The same confirmation rule, evaluated in Mongo before grouping a monthly cohort. */
export function mongoShopifyConfirmed(): Record<string, unknown> {
  return { $and: [
    { $ne: [{ $ifNull: ['$cancelled', false] }, true] },
    { $ne: [{ $ifNull: ['$status', ''] }, 'rejected'] },
    { $or: [
      { $eq: ['$status', 'approved'] },
      { $eq: ['$shipWithoutDeposit', true] },
      { $gt: [{ $sum: { $map: {
        input: { $filter: {
          input: { $cond: [{ $isArray: '$depositReceipts' }, '$depositReceipts', []] },
          as: 'receipt', cond: { $eq: ['$$receipt.status', 'معتمد'] },
        } },
        as: 'receipt', in: { $convert: { input: '$$receipt.amount', to: 'double', onError: 0, onNull: 0 } },
      } } }, 0] },
    ] },
  ] };
}
