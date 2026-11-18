/**
 * Pieces stuck on «prepared» (Nov 15, 2026).
 *
 * A piece becomes `prepared` when its order is prepared. Nothing moves the piece on when the order is
 * handed to the carrier or delivered, so most prepared pieces belong to orders that left long ago.
 * This decides, from the ORDER's own state, what a stuck piece should say. Nothing is changed
 * automatically: an admin reviews the list and approves each correction (InventoryUnitsService
 * `correctStalePrepared`), which writes `shipped` / `delivered` events into the piece history.
 *
 *   proposal 'delivered' — the order is delivered
 *   proposal 'shipped'   — the order is with the carrier
 *   proposal null        — needs a person: order missing/cancelled/returned, or the line is gone
 *   kind 'active'        — the order has not left yet: the piece is correctly prepared (not listed)
 */
export const IN_TRANSIT_BOSTA = ['PICKED_UP', 'IN_TRANSIT', 'RECEIVED_AT_WAREHOUSE', 'OUT_FOR_DELIVERY',
  'CUSTOMER_POSTPONED', 'FAILED_ATTEMPT', 'DELIVERY_FAILED', 'EXCEPTION'];
export const RETURNED_BOSTA = ['RETURNED', 'RETURNED_TO_BUSINESS', 'RETURNED_TO_ORIGIN'];

export type StaleReview = 'order-missing' | 'order-cancelled' | 'line-missing' | 'order-returned';
export interface StaleClassification {
  kind: 'active' | 'stale';
  proposal: 'shipped' | 'delivered' | null;
  review: StaleReview | null;
}

export function classifyStalePrepared(unit: { assignment?: { transactionId?: string; lineId?: string } | null },
  order: any): StaleClassification {
  const review = (r: StaleReview): StaleClassification => ({ kind: 'stale', proposal: null, review: r });
  if (!order) return review('order-missing');
  if (order.cancelled) return review('order-cancelled');
  const lineId = unit.assignment?.lineId;
  if (!lineId || !(order.items || []).some((line: any) => line?.lineId === lineId)) return review('line-missing');
  const bosta = String(order.bostaStatus || '').toUpperCase();
  const pickup = String(order.pickupStatus || '');
  if (RETURNED_BOSTA.includes(bosta) || pickup === 'Returned' || ['open', 'awaiting'].includes(String(order.shipIssueState || ''))) {
    return review('order-returned');
  }
  if (pickup === 'Delivered' || bosta === 'DELIVERED' || order.deliveredAt) return { kind: 'stale', proposal: 'delivered', review: null };
  if (pickup === 'Shipped' || order.shippedAt || IN_TRANSIT_BOSTA.includes(bosta)) return { kind: 'stale', proposal: 'shipped', review: null };
  return { kind: 'active', proposal: null, review: null };
}

/** The order facts stored with each correction, so the history says what it was based on. */
export function staleOrderSnapshot(order: any) {
  return {
    ref: String(order?.ref || ''), pickupStatus: order?.pickupStatus || null, bostaStatus: order?.bostaStatus || null,
    shippedAt: order?.shippedAt || null, deliveredAt: order?.deliveredAt || null, cancelled: !!order?.cancelled,
  };
}
