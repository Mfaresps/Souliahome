/** Keep aligned with _dashShipStatus / _dashIsOpenIssue in the shipping dashboard. */
export function isOpenShippingIssue(tx: any): boolean {
  if (!tx || tx.cancelled || tx.type !== 'مبيعات' || tx.deliveredAt || tx.bostaStatus === 'DELIVERED') return false;
  if (['closed', 'reshipped'].includes(tx.shipIssueState)) return false;
  const stages = ['CREATED', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURNED', 'FAILED_ATTEMPT', 'DELIVERY_FAILED'];
  const hasShippingStage = stages.includes(tx.bostaStatus) || tx.deliverySource === 'MANUAL' || ['Ready', 'Picked-Up', 'Shipped', 'Delivered'].includes(tx.pickupStatus);
  if (!hasShippingStage) return false;
  if (['open', 'awaiting'].includes(tx.shipIssueState)) return true;
  return ['RETURNED', 'FAILED_ATTEMPT', 'DELIVERY_FAILED'].includes(tx.bostaStatus);
}
