/**
 * Reads what Bosta actually charged for one delivery, and decides what an automatic settlement
 * may do with it. Both functions are PURE — no database, no network — so every rule here is
 * testable against a real Bosta payload and nothing else.
 *
 * ── WHERE THE PRICE LIVES ─────────────────────────────────────────────────────────────────────
 * `GET /deliveries/:id` carries no top-level price. Bosta writes it into `log[]`:
 *   • a `pricing` object with `{before, after}` (the courier's closing entry), and
 *   • flattened keys such as `pricing_priceAfterVat: {before, after}` whenever the price changes
 *     mid-route — e.g. a hub coordinator reclassifying the parcel from Normal to Large.
 * The LAST entry that states `priceAfterVat` is the final figure. Measured on 341 delivered
 * orders: every one carries it. #2638: 114.00, matching Bosta's own dashboard line «مستحقات بوسطة».
 *
 * ⚠ `bostaMaterialFee` is deliberately NOT read. It holds 55 on every single order, is outside
 *   `priceAfterVat`, and does not appear on Bosta's dashboard — it describes the plan's packaging
 *   price, not a deduction. Booking it would invent 18,755 EGP of expenses across 341 orders.
 */

export interface BostaPriceChange {
  at: string;
  byRole: string;
  byName: string;
  priceBefore: number | null;
  priceAfter: number;
  sizeBefore: string;
  sizeAfter: string;
}

export interface BostaPricing {
  /** What Bosta deducts for this delivery — the figure every rule compares. */
  priceAfterVat: number;
  priceBeforeVat: number | null;
  shippingFee: number | null;
  sizeEffectCost: number | null;
  insurance: number | null;
  vatRate: number | null;
  sizeName: string;
  /** Cash Bosta says it collected from the customer. */
  cod: number;
  deliveredAt: string;
  isDelivered: boolean;
  priceChanges: BostaPriceChange[];
}

export const r2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};

/** `raw` may be the REST body (`{data:{…}}`) or the flat delivery object a webhook carries. */
export function parseBostaPricing(raw: any): BostaPricing | null {
  const d = raw && typeof raw === 'object' ? (raw.data && typeof raw.data === 'object' ? raw.data : raw) : null;
  if (!d) return null;
  const log: any[] = Array.isArray(d.log) ? d.log : [];

  let final: any = null;
  const changes: BostaPriceChange[] = [];

  for (const e of log) {
    const a = e?.actionsList;
    if (!a || typeof a !== 'object') continue;

    // Closing entry: a whole pricing object.
    const p = a.pricing;
    const pAfter = p && typeof p === 'object' ? (p.after && typeof p.after === 'object' ? p.after : p) : null;
    if (pAfter && num(pAfter.priceAfterVat) !== null) final = pAfter;

    // Mid-route change: flattened before/after keys.
    const fp = a.pricing_priceAfterVat;
    if (fp && typeof fp === 'object' && num(fp.after) !== null) {
      const sz = a.pricing_size_name || a.pricingPackageSize_name || {};
      changes.push({
        at: String(e.time || ''),
        byRole: String(e.takenBy?.userRole || ''),
        byName: String(e.takenBy?.userName || ''),
        priceBefore: num(fp.before),
        priceAfter: num(fp.after) as number,
        sizeBefore: String(sz.before || ''),
        sizeAfter: String(sz.after || ''),
      });
    }
  }

  if (!final) return null;

  const deliveredEv = Array.isArray(d.timeline)
    ? d.timeline.find((t: any) => t && (t.code === 45 || String(t.value).toLowerCase() === 'delivered') && t.date)
    : null;
  const stateCode = typeof d.state === 'object' ? d.state?.code : d.state;

  return {
    priceAfterVat: r2(Number(final.priceAfterVat)),
    priceBeforeVat: num(final.priceBeforeVat),
    shippingFee: num(final.shippingFee),
    sizeEffectCost: num(final.sizeEffectCost),
    insurance: num(final.insuranceFee?.amount),
    vatRate: num(final.vat),
    sizeName: String(final.size?.name || ''),
    cod: r2(Number(d.cod) || 0),
    deliveredAt: String(d.state?.deliveryTime || deliveredEv?.date || ''),
    isDelivered: Number(stateCode) === 45 || String(d.state?.value || '').toLowerCase() === 'delivered',
    priceChanges: changes,
  };
}

// ── The decision ────────────────────────────────────────────────────────────────────────────

export type SettleOutcome = 'settle' | 'review' | 'skip';
export type SettleReason =
  | ''
  | 'no-pricing'
  | 'not-delivered'
  | 'cod-mismatch'
  | 'open-conflict'
  | 'prior-payment'
  | 'variance-over-limit';
export type VarianceKind = 'match' | 'saving' | 'over-small' | 'over-large' | 'not-billed';

export interface SettleInput {
  /** What the customer still owes on our invoice. */
  remaining: number;
  /** shipCost on the invoice — the tariff we expected the carrier to take. */
  billedShip: number;
  pricing: BostaPricing | null;
  hasOpenConflict: boolean;
  /** A collection already sits in payments[] — the netting below assumes there is none. */
  hasPriorCollection: boolean;
  reviewLimit: number;
  /** Set by an approver: an over-limit variance no longer stops the settlement. */
  allowOverLimit?: boolean;
}

export interface SettleDecision {
  outcome: SettleOutcome;
  reason: SettleReason;
  fees: number;
  variance: number;
  varianceKind: VarianceKind | '';
  /** remaining − fees. Negative = Bosta took more than it collected; the gap leaves the vault. */
  net: number;
  /** Cash that enters the vault through collect(). */
  collectNet: number;
  /** Cash that leaves the vault because fees exceed what Bosta collected. */
  shortfall: number;
  shipLossAdd: number;
  shipSavingAdd: number;
}

/** Below this, a variance is rounding — the order still settles on the exact figures. */
export const MATCH_TOLERANCE = 1;
/** Bosta's COD and our remaining are both money; anything above half a pound is a real disagreement. */
export const COD_TOLERANCE = 0.5;

export function decideSettlement(input: SettleInput): SettleDecision {
  const remaining = r2(input.remaining);
  const billed = r2(input.billedShip);
  const p = input.pricing;
  const base = (outcome: SettleOutcome, reason: SettleReason): SettleDecision => ({
    outcome, reason, fees: 0, variance: 0, varianceKind: '', net: 0, collectNet: 0, shortfall: 0, shipLossAdd: 0, shipSavingAdd: 0,
  });

  if (!p) return base('skip', 'no-pricing');
  if (!p.isDelivered) return base('skip', 'not-delivered');

  const fees = r2(p.priceAfterVat);
  const variance = r2(fees - billed);
  const net = r2(remaining - fees);
  const varianceKind: VarianceKind =
    billed <= 0 ? 'not-billed'
      : Math.abs(variance) < MATCH_TOLERANCE ? 'match'
      : variance < 0 ? 'saving'
      : variance <= input.reviewLimit ? 'over-small'
      : 'over-large';

  const full: SettleDecision = {
    outcome: 'settle', reason: '', fees, variance, varianceKind, net,
    collectNet: Math.max(0, net),
    shortfall: r2(Math.max(0, -net)),
    shipLossAdd: r2(Math.max(0, variance)),
    shipSavingAdd: billed > 0 ? r2(Math.max(0, -variance)) : 0,
  };

  // Order matters: data that disagrees is a stop before any judgement about the price.
  if (Math.abs(r2(p.cod) - remaining) > COD_TOLERANCE) return { ...full, outcome: 'review', reason: 'cod-mismatch' };
  if (input.hasOpenConflict) return { ...full, outcome: 'review', reason: 'open-conflict' };
  if (input.hasPriorCollection) return { ...full, outcome: 'review', reason: 'prior-payment' };
  if (varianceKind === 'over-large' && !input.allowOverLimit) return { ...full, outcome: 'review', reason: 'variance-over-limit' };
  return full;
}
