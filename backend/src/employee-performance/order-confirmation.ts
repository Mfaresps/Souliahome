// A pending import can already be confirmed by a submitted or approved deposit.
export function needsOrderConfirmation(order: any): boolean {
  return order.status === 'pending' && !order.cancelled
    && order.confirmationApproved !== true && order.shipWithoutDeposit !== true
    && !(order.depositReceipts || []).some((receipt: any) => ['معتمد', 'معلق'].includes(receipt.status) && Number(receipt.amount) > 0);
}

export const needsOrderConfirmationExpression = {
  $and: [
    { $eq: ['$status', 'pending'] },
    { $ne: ['$cancelled', true] },
    { $ne: ['$confirmationApproved', true] },
    { $ne: ['$shipWithoutDeposit', true] },
    { $eq: [{ $size: { $filter: {
      input: { $ifNull: ['$depositReceipts', []] }, as: 'receipt',
      cond: { $and: [
        { $in: ['$$receipt.status', ['معتمد', 'معلق']] },
        { $gt: [{ $convert: { input: '$$receipt.amount', to: 'double', onError: 0, onNull: 0 } }, 0] },
      ] },
    } } }, 0] },
  ],
};
