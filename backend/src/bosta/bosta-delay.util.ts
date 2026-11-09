/** Bosta's delay flag is separate from the shipment's movement state. */
export function bostaDelayFlag(delivery: any, status: string): boolean | null {
  if (['DELIVERED', 'RETURNED', 'CANCELLED', 'DELETED'].includes(status)) return false;
  const delayed = delivery?.isDelayed;
  const exceeded = delivery?.sla?.orderSla?.isExceededOrderSla;
  if (delayed === true || exceeded === true) return true;
  if (delayed === false || exceeded === false) return false;
  // Bosta's status webhook does not normally include delay data. Keep the
  // latest value learned from the full delivery response until the next sync.
  return null;
}
