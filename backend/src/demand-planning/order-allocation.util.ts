/**
 * Order-level stock allocation for the demand window (Nov 22, 2026).
 *
 * Owner's rules:
 *  1. Oldest first — by the date the ORDER WAS CREATED (Shopify's created_at, else our
 *     createdAt), never by the last edit.
 *  2. All or nothing — an order is «ready» only when every one of its products is covered.
 *     An order that cannot be completed takes NOTHING, so it never starves a newer order
 *     that could ship (the old per-product allocation did exactly that).
 *  3. Recomputed from live data on every call — a cancelled order or a changed quantity
 *     simply changes the input, and the stock is redistributed by the same order.
 *  4. One unit, one order: an older order that was not selected still claims its share
 *     first; the selected orders only see what is left (no double reservation).
 *
 * Pure: no I/O. The caller decides what `sellable` means (balance minus damaged / lost /
 * awaiting-inspection pieces) — this file only shares it out.
 */

export interface QueueOrder {
  id: string;
  /** ISO creation date of the order — the priority key */
  createdAt: string;
  /** Part of the user's selection (shown) or only competing for the same stock */
  selected: boolean;
  /** Holds a line with no product link — can never be confirmed, claims nothing */
  unlinked: boolean;
  /** sku key → quantity */
  need: Map<string, number>;
}

export type AllocationState = 'ready' | 'short' | 'unlinked';

export interface OrderAllocation {
  state: AllocationState;
  /** 1-based place in the queue (oldest = 1) */
  position: number;
  /** sku key → what was still free when this order's turn came */
  freeAtTurn: Map<string, number>;
  /** sku key → units missing (only for «short») */
  missing: Map<string, number>;
}

export interface AllocationResult {
  orders: Map<string, OrderAllocation>;
  /** sku key → units claimed by NOT-selected orders that come before a selected order needing it */
  reservedOlder: Map<string, number>;
  /** sku key → units given to selected ready orders */
  allocatedSelected: Map<string, number>;
}

function timeOf(iso: string): number {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;   // undated orders go last
}

/** Stable queue order: creation date, then id — two runs on the same data agree. */
export function queueOrder(a: QueueOrder, b: QueueOrder): number {
  return timeOf(a.createdAt) - timeOf(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function allocateOrders(orders: QueueOrder[], sellable: Map<string, number>): AllocationResult {
  const queue = orders.slice().sort(queueOrder);
  const free = new Map<string, number>();
  sellable.forEach((v, k) => free.set(k, Math.max(0, Number(v) || 0)));

  // The last queue position at which a selected order needs each product: units an
  // unselected order takes BEFORE that point are what the selection lost to older orders.
  const lastSelectedPos = new Map<string, number>();
  queue.forEach((o, i) => {
    if (!o.selected) return;
    o.need.forEach((_q, k) => lastSelectedPos.set(k, i));
  });

  const result: AllocationResult = { orders: new Map(), reservedOlder: new Map(), allocatedSelected: new Map() };
  queue.forEach((o, i) => {
    const freeAtTurn = new Map<string, number>();
    o.need.forEach((_q, k) => freeAtTurn.set(k, free.get(k) || 0));
    if (o.unlinked) {
      result.orders.set(o.id, { state: 'unlinked', position: i + 1, freeAtTurn, missing: new Map() });
      return;
    }
    const missing = new Map<string, number>();
    o.need.forEach((q, k) => {
      const gap = q - (free.get(k) || 0);
      if (gap > 0) missing.set(k, gap);
    });
    if (missing.size) {
      result.orders.set(o.id, { state: 'short', position: i + 1, freeAtTurn, missing });
      return;
    }
    o.need.forEach((q, k) => {
      free.set(k, (free.get(k) || 0) - q);
      if (o.selected) result.allocatedSelected.set(k, (result.allocatedSelected.get(k) || 0) + q);
      else if (i < (lastSelectedPos.get(k) ?? -1)) result.reservedOlder.set(k, (result.reservedOlder.get(k) || 0) + q);
    });
    result.orders.set(o.id, { state: 'ready', position: i + 1, freeAtTurn, missing });
  });
  return result;
}
