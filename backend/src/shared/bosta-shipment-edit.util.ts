import { normalizeCity } from './normalize-city.util';

/**
 * Editing an order whose Bosta shipment exists but has NOT been picked up yet.
 *
 * Bosta lets a business change a delivery while it is in «Created» (its help centre:
 * «Orders modifications»): COD, receiver, drop-off address, notes. After pickup only Bosta's
 * own staff can, and once it is out for delivery nobody can. Endpoint — Bosta's official SDKs
 * (bosta-python `Delivery.update`, bosta-nodejs `updateDelivery`): PUT /deliveries/{_id} with
 * any of `cod`, `receiver`, `dropOffAddress`, `notes`.
 *
 * Pure rules only; BostaService does the calls.
 */

/** Bosta states (our internal vocabulary) in which the business itself may edit the delivery. */
export const BOSTA_EDITABLE_STATES = ['CREATED'];

/** Local pickup stages after which the parcel is with the courier, whatever Bosta says. */
const HANDED_OVER = ['Picked-Up', 'Shipped', 'Delivered'];

export interface ShipmentFields {
  cod: number;
  firstName: string;
  lastName: string;
  phone: string;
  city: string;
  firstLine: string;
  notes: string;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** What the order would send to Bosta — the same rules as BostaService.createOrder. */
export function shipmentFieldsOf(tx: any): ShipmentFields {
  const nameParts = String(tx?.client || '').trim().split(/\s+/).filter(Boolean);
  const bostaCity = String(tx?.shippingBostaCity || '').trim();
  const gov = String(tx?.shippingGov || '').trim();
  const cityPart = String(tx?.shippingCity || '').trim().split(/\s*[—–\-]\s*/)[0].trim();
  return {
    cod: round2(Math.max(0, Number(tx?.remaining) || 0)),
    firstName: nameParts[0] || '',
    lastName: nameParts.slice(1).join(' ') || '-',
    phone: String(tx?.phone || '').replace(/\D/g, ''),
    city: bostaCity || ((gov || cityPart) ? normalizeCity(gov || cityPart) : ''),
    firstLine: String(tx?.shippingAddress || '').replace(/^العنوان:\s*/, '').trim(),
    notes: String(tx?.notes || ''),
  };
}

export type ShipmentEditField = 'cod' | 'receiver' | 'address' | 'notes';

/**
 * The PUT body for what changed between two versions of the order, or null when nothing the
 * shipment carries changed. An address is only sent when both its city and its line are known —
 * a half address would be worse than the old one.
 */
export function shipmentEditPayload(before: any, after: any): { payload: Record<string, unknown>; fields: ShipmentEditField[]; next: ShipmentFields } | null {
  const a = shipmentFieldsOf(before);
  const b = shipmentFieldsOf(after);
  const payload: Record<string, unknown> = {};
  const fields: ShipmentEditField[] = [];
  if (Math.abs(a.cod - b.cod) > 0.005) { payload.cod = b.cod; fields.push('cod'); }
  if (b.firstName && (a.firstName !== b.firstName || a.lastName !== b.lastName || a.phone !== b.phone)) {
    payload.receiver = { firstName: b.firstName, lastName: b.lastName, ...(b.phone ? { phone: b.phone } : {}) };
    fields.push('receiver');
  }
  if (b.city && b.firstLine && (a.city !== b.city || a.firstLine !== b.firstLine || a.phone !== b.phone)) {
    payload.dropOffAddress = { city: b.city, firstLine: b.firstLine, ...(b.phone ? { phone: b.phone } : {}) };
    fields.push('address');
  }
  if (a.notes !== b.notes) { payload.notes = b.notes; fields.push('notes'); }
  return fields.length ? { payload, fields, next: b } : null;
}

/** Locally, may this shipment still be edited at Bosta? (Bosta's live state is checked too.) */
export function shipmentLocallyEditable(tx: any): boolean {
  if (!String(tx?.bostaOrderId || '').trim()) return false;
  if (tx?.afterSales?.caseId) return false;
  if (HANDED_OVER.includes(String(tx?.pickupStatus || ''))) return false;
  if (tx?.shippedAt) return false;
  return BOSTA_EDITABLE_STATES.includes(String(tx?.bostaStatus || '').trim().toUpperCase());
}
