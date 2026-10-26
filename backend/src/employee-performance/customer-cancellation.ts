import { Types } from 'mongoose';

/** A customer's cancellation closes confirmation work, without changing financial records. */
export const CUSTOMER_CANCELLATION_QUERY = {
  reason: 'عملية تأكيد الطلب', status: 'العميل ألغى الطلب',
  cancelled: { $ne: true }, autoSource: { $ne: 'shipping-issue' },
  orderOutcome: { $in: ['', null] },
};

interface CancellationLink { shopifyOrderId?: string; transactionId?: string; orderRef?: string }
const refOf = (value: unknown) => String(value || '').trim().replace(/^#+/, '');

export function customerCancellationExclusions(rows: CancellationLink[]) {
  const ids = [...new Set(rows.map(row => String(row.shopifyOrderId || '')).filter(Boolean))];
  const txIds = [...new Set(rows.map(row => String(row.transactionId || '')).filter(Boolean))];
  const refs = [...new Set(rows.map(row => refOf(row.orderRef)).filter(Boolean))];
  const refValues = refs.flatMap(ref => [ref, '#' + ref]);
  const orderLinks: Record<string, unknown>[] = [];
  const followUpLinks: Record<string, unknown>[] = [];
  if (ids.length) {
    orderLinks.push({ shopifyId: { $in: ids } });
    const localIds = ids.filter(id => Types.ObjectId.isValid(id)).map(id => new Types.ObjectId(id));
    if (localIds.length) orderLinks.push({ _id: { $in: localIds } });
    followUpLinks.push({ shopifyOrderId: { $in: ids } });
  }
  if (txIds.length) followUpLinks.push({ transactionId: { $in: txIds } });
  if (refs.length) {
    orderLinks.push({ ref: { $in: refValues } });
    followUpLinks.push({ orderRef: { $in: refValues } });
  }
  return {
    orders: orderLinks.length ? { $nor: orderLinks } : {},
    followUps: followUpLinks.length ? { $nor: [{ reason: 'عملية تأكيد الطلب', autoSource: { $ne: 'shipping-issue' }, $or: followUpLinks }] } : {},
    isCancelledOrder: (order: { _id?: unknown; shopifyId?: string; ref?: string }) =>
      ids.includes(String(order._id || '')) || (!!order.shopifyId && ids.includes(String(order.shopifyId))) || (!!refOf(order.ref) && refs.includes(refOf(order.ref))),
  };
}
