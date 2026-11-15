/**
 * Merging one «جاهز للشحن» group into another (drag a ready card onto another).
 *
 * A ready group is the set of orders sharing a `pickupRef`; it is what the courier
 * collects together. Moving orders between groups changes only that grouping —
 * never the Bosta shipment, the pickup request membership, money or stock. So the
 * merge is refused whenever the two groups could NOT physically leave together:
 *   - an order of the dragged group is already with the courier (or was handed over);
 *   - the carriers differ (two couriers never share one collection);
 *   - the warehouses differ (one pickup = one warehouse);
 *   - each group is covered by a DIFFERENT Bosta pickup request (the card would then
 *     describe two collections on two days as one).
 * Pure: the service loads the rows, this decides. Mirrored by `_puReadyMergeBlock`
 * in index.html (UX only — the server is the authority).
 */
import { warehouseCode } from '../warehouses/warehouse-storage';

export interface ReadyMergeOrder {
  _id: unknown;
  pickupStatus?: string;
  bostaStatus?: string;
  bostaOrderId?: string;
  bostaTrackingNumber?: string;
  shippedAt?: unknown;
  shipCo?: string;
  carrierCode?: string;
  warehouseCode?: string;
}
export interface ReadyMergeRequest { id: string; orderIds: string[] }

/** Bosta states in which the parcel is still in our warehouse. */
const NOT_COLLECTED = new Set(['', 'CREATED', 'VALIDATION_ERROR', 'DELETED', 'CANCELLED']);

export function readyOrderCollected(o: ReadyMergeOrder): boolean {
  if (String(o.pickupStatus || '') !== 'Ready') return true; // Picked-Up / Shipped = handed over
  if (o.shippedAt) return true;
  return !NOT_COLLECTED.has(String(o.bostaStatus || '').trim().toUpperCase());
}

/** '' = unknown carrier (never blocks). Bosta in any spelling, or any order with a Bosta shipment, is 'bosta'. */
export function readyOrderCarrier(o: ReadyMergeOrder): string {
  if (o.bostaOrderId || o.bostaTrackingNumber) return 'bosta';
  const code = String(o.carrierCode || '').trim().toLowerCase();
  if (code) return code;
  const name = String(o.shipCo || '').trim().toLowerCase();
  if (/^(bosta|بوسطة|بوسطه)$/.test(name)) return 'bosta';
  return name;
}

export type ReadyMergeBlock =
  | { code: 'COLLECTED'; refs: string[] }
  | { code: 'CARRIER'; source: string; target: string }
  | { code: 'WAREHOUSE'; source: string; target: string }
  | { code: 'PICKUP_REQUEST' };

export function readyMergeBlock(
  source: ReadyMergeOrder[], target: ReadyMergeOrder[], requests: ReadyMergeRequest[],
  refOf: (o: ReadyMergeOrder) => string = o => String(o._id),
): ReadyMergeBlock | null {
  const collected = source.filter(readyOrderCollected);
  if (collected.length) return { code: 'COLLECTED', refs: collected.map(refOf) };

  const carriers = (rows: ReadyMergeOrder[]) => [...new Set(rows.map(readyOrderCarrier).filter(Boolean))];
  const sc = carriers(source), tc = carriers(target);
  if (sc.length && tc.length && (sc.length > 1 || tc.length > 1 || sc[0] !== tc[0])) {
    return { code: 'CARRIER', source: sc.join(', '), target: tc.join(', ') };
  }

  const warehouses = (rows: ReadyMergeOrder[]) => [...new Set(rows.map(o => warehouseCode(o.warehouseCode)))];
  const sw = warehouses(source), tw = warehouses(target);
  if (sw.length > 1 || tw.length > 1 || sw[0] !== tw[0]) return { code: 'WAREHOUSE', source: sw.join(', '), target: tw.join(', ') };

  const requestsOf = (rows: ReadyMergeOrder[]) => {
    const ids = new Set(rows.map(o => String(o._id)));
    return new Set(requests.filter(r => (r.orderIds || []).some(id => ids.has(String(id)))).map(r => r.id));
  };
  const sr = requestsOf(source), tr = requestsOf(target);
  if (sr.size && tr.size && [...sr].some(id => !tr.has(id))) return { code: 'PICKUP_REQUEST' };
  return null;
}

export function readyMergeBlockMessage(block: ReadyMergeBlock): string {
  switch (block.code) {
    case 'COLLECTED': return `لا يمكن الدمج: الطلب ${block.refs.join('، ')} خرج مع شركة الشحن بالفعل`;
    case 'CARRIER': return `لا يمكن الدمج: شركة الشحن مختلفة (${block.source} / ${block.target})`;
    case 'WAREHOUSE': return `لا يمكن الدمج: المجموعتان من مخزنين مختلفين (${block.source} / ${block.target})`;
    case 'PICKUP_REQUEST': return 'لا يمكن الدمج: كل مجموعة مرتبطة بطلب استلام مختلف في بوسطة';
  }
}
