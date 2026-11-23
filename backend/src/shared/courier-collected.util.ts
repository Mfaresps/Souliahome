/**
 * Once Bosta has the parcel, the order belongs in «تم الشحن» on the pickup board —
 * whatever board stage it was left in.
 *
 * Why this exists: an order sent to Bosta from the prep workspace deliberately stays
 * 'Preparing' (bosta.service createOrder), and the status sync used to promote only
 * from 'Ready'. Such an order was picked up and delivered while the board still had it
 * in a prep group, and a later «نقل للجاهز» moved the delivered order into a new ready
 * group (#3198/#3201/#3204, Nov 2026).
 *
 * Board stage only: no money, stock or carrier call depends on this.
 */

/** Bosta states that mean the courier has (or had) the parcel. */
export const COURIER_HAS_PARCEL_STATUSES = [
  'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'CUSTOMER_POSTPONED',
  'FAILED_ATTEMPT', 'DELIVERED', 'RETURNED',
];

/** Board stages an order can be stuck in after the courier took it. */
export const BOARD_STAGES_BEFORE_COURIER = ['Pending', 'Preparing', 'Ready', 'Picked-Up'];

export function courierHasParcel(bostaStatus: unknown): boolean {
  return COURIER_HAS_PARCEL_STATUSES.includes(String(bostaStatus || '').trim().toUpperCase());
}

/** True when the board still shows the order before the courier although Bosta has it. */
export function courierCollectedButOnBoard(tx: any): boolean {
  if (!tx || tx.cancelled || tx.type !== 'مبيعات') return false;
  return courierHasParcel(tx.bostaStatus)
    && BOARD_STAGES_BEFORE_COURIER.includes(String(tx.pickupStatus || 'Pending'));
}

export function shippingReceivedRef(shipCo: unknown, date: string): string {
  const carrier = String(shipCo || 'Bosta');
  let hash = 0;
  for (let i = 0; i < carrier.length; i++) hash = ((hash * 31) + carrier.charCodeAt(i)) & 0xffff;
  return `SH-${date}-${hash.toString(36).toUpperCase().padStart(4, '0')}`;
}

const validIso = (v: unknown): string => {
  if (!v) return '';
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
};

/** Bosta's own pickup time (`collectedFromBusiness`, else timeline code 21/23), or ''. */
export function bostaCollectedAt(raw: any): string {
  const d = raw?.data || raw || {};
  // Only an outbound waybill — "Send" (10) or "Exchange" (30, the replacement leaves our
  // warehouse) — says when the courier took OUR parcel. A stored "Return to Origin" (20) or a
  // customer-return pickup record carries a different pickup (#2281).
  const typeCode = d?.type?.code ?? d?.type;
  if (typeCode !== undefined && typeCode !== null && typeCode !== ''
    && ![10, 30].includes(Number(typeCode)) && !/^(send|exchange)$/i.test(String(d?.type?.value || typeCode))) return '';
  const fromTimeline = (Array.isArray(d.timeline) ? d.timeline : [])
    .filter((e: any) => [21, 23].includes(Number(e?.code ?? e?.value)))
    .map((e: any) => validIso(e?.date || e?.time || e?.at))
    .filter(Boolean)
    .sort()[0];
  return validIso(d.collectedFromBusiness) || fromTimeline || '';
}

/** Calendar day in Cairo — the board's `_puDailyDay` reads days the same way. */
export function cairoDay(iso: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/**
 * When the courier actually collected the parcel: Bosta's own pickup time first
 * (`collectedFromBusiness`, else the timeline's code 21/23), then what we already
 * stored, then the delivery time, then `fallback`.
 */
export function courierCollectedAt(tx: any, raw: any, fallback: string): string {
  return bostaCollectedAt(raw) || validIso(tx?.shippedAt)
    || validIso(tx?.deliveredAt) || validIso(fallback) || new Date().toISOString();
}

/** The $set that moves the order to «تم الشحن», or {} when it does not apply. */
export function courierCollectedUpdate(tx: any, statusCode: string, raw: any, now: string): Record<string, any> {
  if (!courierHasParcel(statusCode)) return {};
  if (!BOARD_STAGES_BEFORE_COURIER.includes(String(tx?.pickupStatus || 'Pending'))) return {};
  // Bosta's pickup time wins over a stored shippedAt (which was "when we first heard").
  const at = courierCollectedAt(tx, raw, now);
  const day = cairoDay(at);
  return {
    pickupStatus: 'Shipped',
    shippedAt: at,
    pickupRef: shippingReceivedRef(tx?.shipCo, day),
    pickupDate: day,
  };
}

/**
 * The shipped column groups by the day the courier collected the parcel (shippedAt).
 * shippedAt used to be the moment our system first heard of the pickup — a late webhook
 * or sync put the parcel under the wrong day. When Bosta states its pickup time and the
 * stored one falls on another Cairo day, this returns the correction (and the SH- ticket
 * for a Shipped order); else {}.
 */
export function collectedDateCorrection(tx: any, raw: any): Record<string, any> {
  const at = bostaCollectedAt(raw);
  if (!at || !courierHasParcel(tx?.bostaStatus)) return {};
  const stored = validIso(tx?.shippedAt);
  if (!stored) return {};
  const day = cairoDay(at);
  if (cairoDay(stored) === day) return {};
  const out: Record<string, any> = { shippedAt: at };
  if (tx?.pickupStatus === 'Shipped' && /^SH-/.test(String(tx?.pickupRef || ''))) {
    out.pickupRef = shippingReceivedRef(tx?.shipCo, day);
    out.pickupDate = day;
  }
  return out;
}

/**
 * An exchange waybill lives on its after-sales case (returnrequests.workflow), not on the sale.
 * Its pickup time: what Bosta stated (`shipment.collectedAt`), else the first carrier event
 * whose status means the courier has the parcel (eventId «carrier:<case>:<at>:<code>:<STATUS>»).
 */
export function afterSalesCollectedAt(workflow: any): string {
  const stated = validIso(workflow?.shipment?.collectedAt);
  if (stated) return stated;
  return (Array.isArray(workflow?.history) ? workflow.history : [])
    .filter((e: any) => e?.action === 'carrier-status' && courierHasParcel(String(e.eventId || '').split(':').pop()))
    .map((e: any) => validIso(e.at))
    .filter(Boolean)
    .sort()[0] || '';
}
