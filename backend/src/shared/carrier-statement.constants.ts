/**
 * Single source of truth for READING A CARRIER'S SETTLEMENT FILE.
 *
 * A carrier hands back a spreadsheet ("cash-out" / settlement report) listing, per shipment, what
 * it collected from the customer and what it deducted for itself. Settling those rows was a
 * per-order manual job: open the order, read the carrier's figure off a spreadsheet in another
 * window, type it into «تكلفة الشحن الفعلية», press تحصيل, repeat. This file is the parsing half
 * of automating that.
 *
 * ⚠ THIS FILE ONLY READS AND CLASSIFIES. It never settles, never touches the vault and never
 *   writes a transaction. Settlement stays in `TransactionsService.collect()`, which already owns
 *   the vault entry, the `payments[]` audit row and its `snapshotBefore` (the undo record).
 *   Keeping the split means an import can be re-parsed and re-previewed as often as you like
 *   with no financial effect whatsoever — the file is evidence, not an instruction.
 *
 * Same `code`-vs-label convention as CARRIERS / CANCEL_REASONS / PRODUCT_COLORS.name:
 *
 * ⚠ `MatchKey` and `RowStatus` values are STORED — they land in Mongo on the import record and in
 *   the shipping report's grouping. **Never rename one.** Add a new value and leave the old one
 *   so historical imports keep resolving to a label.
 *
 * ⚠ `frontend/public/index.html` carries a hand-kept mirror of the labels (not the parser). The
 *   backend re-parses and re-validates every uploaded file against **its own** copy — the client's
 *   preview is a convenience, never the authority. Same rule as CANCEL_REASONS.
 *
 * ── WHY THE COLUMN MAP IS A REGISTRY, NOT AN `if (bosta)` ──────────────────────────────────────
 * Bosta is the only integrated carrier today (`CARRIERS[].integration === 'bosta'`), but the
 * registry is keyed by carrier `code` so a second carrier is a new entry plus its header
 * synonyms — the matching engine, the review screen and the settlement loop stay untouched. This
 * mirrors `integration: 'bosta' | 'none'` in carriers.constants.ts: the system is multi-carrier,
 * not Bosta-with-extras.
 *
 * ── VERIFIED AGAINST A REAL FILE (28-08-2026, sheet «Cash Cycles», 36 columns) ─────────────────
 * Every rule below was measured against a genuine Bosta export and the live transaction data, not
 * assumed:
 *
 *   - `Total Fees` === Shipping + Insurance + VAT   ✓ in 3/3 rows
 *   - `COD − Total Fees` === `Net Value`            ✓ in 3/3 rows   → NET_VALUE_TOLERANCE
 *   - `Order Id` (the file's column name) matches our stored `bostaTrackingNumber`, NOT
 *     `bostaOrderId` — that one holds a different value entirely (e.g. "Qv1o6CKcuqGPvskTuvDW2").
 *     The column name is misleading; the mapping below is what was actually observed.
 *   - `Order Reference` arrives BOTH bare ("2432") and prefixed ("#2377"), while **zero** of the
 *     521 stored transactions carry a `#`. Stripping it is therefore required for matching, not
 *     cosmetic — see normalizeRef().
 */

/**
 * Which field a file row was matched to a transaction by.
 *
 * ⚠ ONLY `ref` AND `tracking` MAY SETTLE. Customer name and phone identify a PERSON, not an
 *   ORDER: measured on the live data, 26 customers have more than one order (one has three) and
 *   phone coverage is 497/497 sales — so a phone match is simultaneously the most available and
 *   the least specific signal. Settling on it would eventually pay off the wrong invoice of the
 *   right customer, which is the hardest error class to notice afterwards.
 *
 *   Name and phone are still read, but only ever to CONFIRM a ref/tracking match (see
 *   `identityMismatch` on ParsedRow). A mismatch there is the signal that the *reference itself*
 *   is wrong — which is exactly the check that catches a mistyped reference before money moves.
 */
export type MatchKey = 'ref' | 'tracking' | 'none';

/** Human label for the key a row matched on. Display only. */
export const MATCH_KEY_AR: Record<MatchKey, string> = {
  ref: 'رقم المرجع',
  tracking: 'رقم التتبع',
  none: 'لم يتطابق',
};

/**
 * The outcome of classifying one file row.
 *
 * These are deliberately NOT collapsed into ok/failed. Each one needs a different human decision,
 * and merging any two of them hides a real money problem:
 *
 *   matched          – ref/tracking found, COD equals `remaining`. The only status selected by
 *                      default.
 *   amount_mismatch  – found, but the carrier collected a different amount than we are owed.
 *                      NEVER auto-selected: it is a discrepancy to decide on, not a rounding
 *                      artefact.
 *   already_settled  – found, but `payStatus === 'مكتمل'` (or nothing remains). Skipped. This is
 *                      the re-upload guard at row level and the single most likely real-world
 *                      case, because re-uploading the same file is normal behaviour.
 *   fee_only         – `Net Value` is NEGATIVE: the carrier deducted fees while collecting
 *                      nothing (a returned shipment). Real money LEAVES us, so it cannot be
 *                      settled as a collection and must not be silently dropped either — it is
 *                      surfaced on its own. Observed in the sample file: ref «#2377», Net −114.
 *   not_found        – neither ref nor tracking resolved to a transaction.
 *   conflict         – ref points at one transaction and tracking at another. Never guess:
 *                      picking either would settle a real invoice on a coin flip.
 *   not_deliverable  – the carrier's own `Order Status` is not a delivered state, so there is
 *                      nothing to collect yet.
 *   invalid          – the row itself is unusable (no identifier, unparseable amount, or its
 *                      arithmetic contradicts `Net Value` — see NET_VALUE_TOLERANCE).
 */
export type RowStatus =
  | 'matched'
  | 'amount_mismatch'
  | 'already_settled'
  | 'fee_only'
  | 'not_found'
  | 'conflict'
  | 'not_deliverable'
  | 'invalid';

export const ROW_STATUS_AR: Record<RowStatus, string> = {
  matched: 'مطابق',
  amount_mismatch: 'فرق في المبلغ',
  already_settled: 'محصَّل مسبقاً',
  fee_only: 'خصم بدون تحصيل',
  not_found: 'غير موجود',
  conflict: 'تعارض في المطابقة',
  not_deliverable: 'لم يُسلَّم',
  invalid: 'صف غير صالح',
};

/**
 * The ONLY status that may be settled without a human overriding it.
 *
 * `amount_mismatch` is deliberately absent: it is selectable in the review screen, but never
 * pre-selected, so settling a discrepancy is always a decision somebody made on purpose.
 */
export const AUTO_SELECTABLE: RowStatus[] = ['matched'];

/**
 * Money comparisons are on values the carrier rounds independently of us, so exact equality is
 * the wrong test.
 *
 * NET_VALUE_TOLERANCE guards the file's own internal arithmetic (`COD − Total Fees === Net
 * Value`). ⚠ This is the load-bearing check that we mapped the columns correctly at all: if it
 * fails, the safe conclusion is that our understanding of the file is wrong — so the row is
 * marked `invalid` rather than settled on a figure we cannot reproduce.
 *
 * AMOUNT_TOLERANCE guards COD against the invoice's `remaining`.
 */
export const NET_VALUE_TOLERANCE = 0.5;
export const AMOUNT_TOLERANCE = 0.5;

/**
 * Shipping-variance severity — the carrier-audit half of this feature.
 *
 * ⚠ TWO THRESHOLDS, NOT ONE, AND EITHER CAN TRIP IT. A flat cash threshold calls 20 EGP on a
 *   300 EGP shipment an incident; a pure percentage calls 20 EGP on a 99 EGP shipment noise.
 *   Both are wrong in the other's case, so a row escalates on whichever fires first.
 *
 * Calibrated against the real spread (206 orders carrying an actual cost): 110 differ by 1–20,
 * 50 by 21–50, and 14 by more than 50 — with a single worst case of 746.94 on ref 1835.
 */
export interface VarianceLevel {
  code: 'ok' | 'notable' | 'high';
  ar: string;
  /** Absolute EGP over the billed tariff at which this level starts. */
  minDiff: number;
  /** …or this fraction of the billed tariff, whichever trips first. */
  minPct: number;
}

export const VARIANCE_LEVELS: VarianceLevel[] = [
  { code: 'high', ar: 'فرق كبير', minDiff: 40, minPct: 0.25 },
  { code: 'notable', ar: 'يستحق المراجعة', minDiff: 15, minPct: 0.1 },
  { code: 'ok', ar: 'ضمن المتوقع', minDiff: 0, minPct: 0 },
];

/**
 * Classifies how far the carrier's actual deduction is from the tariff we billed the customer.
 * `billed` of 0 falls back to the absolute test alone — a percentage of zero is meaningless and
 * would otherwise flag every free-shipping order as an infinite overrun.
 */
export function varianceLevel(billed: number, actual: number): VarianceLevel {
  const diff = Number(actual || 0) - Number(billed || 0);
  if (diff <= 0) return VARIANCE_LEVELS[VARIANCE_LEVELS.length - 1];
  const pct = billed > 0 ? diff / billed : 0;
  for (const lv of VARIANCE_LEVELS) {
    if (lv.code === 'ok') continue;
    if (diff >= lv.minDiff || pct >= lv.minPct) return lv;
  }
  return VARIANCE_LEVELS[VARIANCE_LEVELS.length - 1];
}

/**
 * One carrier's settlement-file dialect.
 *
 * Every field is a list of ACCEPTED HEADER SYNONYMS rather than one exact string: carriers rename
 * columns between report versions and account types, and a rename must degrade into "column not
 * recognised" (which the recognition summary states out loud) instead of a silently-zero amount.
 */
export interface CarrierStatementFormat {
  /** Carrier code from CARRIERS. The registry key. */
  carrier: string;
  /** Sheet names to prefer, in order. Empty ⇒ first sheet. */
  sheets: string[];
  /**
   * Headers that must ALL be present for a file to be recognised as this carrier's. Kept to the
   * few that carry the settlement's meaning, so an extra or reordered column never rejects a
   * valid file.
   */
  required: string[];
  columns: {
    ref: string[];
    tracking: string[];
    status: string[];
    cod: string[];
    totalFees: string[];
    netValue: string[];
    /** Fee breakdown — reported, never used to settle. */
    shippingFees: string[];
    insuranceFees: string[];
    vat: string[];
    codFees: string[];
    /** Confirmation only. NEVER a match key — see MatchKey. */
    customerName: string[];
    customerPhone: string[];
    /** Context for the report. */
    dropoffCity: string[];
    deliveredAt: string[];
    payoutId: string[];
  };
  /** `Order Status` values that represent a completed delivery, lowercased. */
  deliveredStatuses: string[];
}

/**
 * Bosta — "Cash Cycles" export.
 *
 * ⚠ `tracking` maps from the column literally headed «Order Id». Verified against live data: its
 *   values match our stored `bostaTrackingNumber`. Do not "correct" this to bostaOrderId.
 */
export const BOSTA_STATEMENT: CarrierStatementFormat = {
  carrier: 'bosta',
  sheets: ['Cash Cycles'],
  required: ['order reference', 'cod', 'total fees', 'net value'],
  columns: {
    ref: ['order reference', 'business reference', 'reference'],
    tracking: ['order id', 'tracking number', 'awb', 'delivery id'],
    status: ['order status', 'status'],
    cod: ['cod', 'cod amount', 'cash on delivery'],
    totalFees: ['total fees', 'total fee'],
    netValue: ['net value', 'net amount', 'net'],
    shippingFees: ['shipping fees', 'shipping fee'],
    insuranceFees: ['insurance fees', 'insurance fee'],
    vat: ['vat', 'tax'],
    codFees: ['cod fees', 'cod fee'],
    customerName: ['customer name', 'consignee name', 'receiver name'],
    customerPhone: ['customer phone', 'consignee phone', 'receiver phone'],
    dropoffCity: ['dropoff city', 'destination city', 'city'],
    deliveredAt: ['completed at', 'delivered at', 'confirmed at'],
    payoutId: ['cash-out id', 'cashout id', 'payout id'],
  },
  deliveredStatuses: ['delivered', 'completed', 'تم التسليم'],
};

export const CARRIER_STATEMENT_FORMATS: CarrierStatementFormat[] = [BOSTA_STATEMENT];

export function statementFormat(carrier: string): CarrierStatementFormat | undefined {
  const c = String(carrier || '').trim().toLowerCase();
  return CARRIER_STATEMENT_FORMATS.find((f) => f.carrier === c);
}

/** Header text → comparable key. Collapses case, whitespace, NBSP and BOM. */
export function normalizeHeader(h: unknown): string {
  return String(h ?? '')
    .replace(/﻿/g, '')
    .replace(/ /g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Order reference → the form stored in `transactions.ref`.
 *
 * ⚠ Strips a leading `#`, Arabic-Indic digits and surrounding whitespace. Measured: the sample
 *   file carries both "2432" and "#2377", while **no** stored transaction has a `#`. Without this
 *   the prefixed rows report as «غير موجود» while the order sits right there — a false negative
 *   that reads like missing data.
 *
 * Returns '' for anything left empty, which callers treat as "no reference on this row" rather
 * than as a reference that happens to be blank.
 */
export function normalizeRef(v: unknown): string {
  let s = String(v ?? '').trim();
  if (!s) return '';
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  s = s.replace(/^[#\s]+/, '').trim();
  return s;
}

/** Tracking number → digits only, so formatting differences never break a match. */
export function normalizeTracking(v: unknown): string {
  const s = normalizeRef(v);
  const digits = s.replace(/[^0-9]/g, '');
  return digits || '';
}

/**
 * Money cell → number.
 *
 * ⚠ Returns `null`, never 0, when a value cannot be read. A cell reading "N/A" or "—" is UNKNOWN;
 *   coercing it to 0 would silently claim the carrier deducted nothing and quietly overstate what
 *   entered the vault. Callers mark the row `invalid` instead.
 */
export function parseMoney(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  // Parenthesised negatives are an accounting convention: (114) === -114
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) s = '-' + paren[1];
  s = s.replace(/[^\d.\-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Phone → comparable form (local, no country code). Confirmation only, never a match key. */
export function normalizePhone(v: unknown): string {
  const d = String(v ?? '').replace(/[^0-9]/g, '');
  if (!d) return '';
  return d.replace(/^20/, '').replace(/^0/, '');
}

/**
 * Loose name comparison for the confirmation check.
 *
 * Deliberately forgiving — it must not cry wolf on «هاجر علوي -» vs «هاجر علوي» (a real value in
 * the sample file). It answers "is this plausibly the same person?", never "which order is this?".
 */
export function namesLookAlike(a: unknown, b: unknown): boolean {
  const norm = (x: unknown) =>
    String(x ?? '')
      .replace(/[ـ]/g, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/[ىي]/g, 'ي')
      .replace(/ة/g, 'ه')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .toLowerCase();
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return true; // nothing to contradict
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const ax = new Set(x.split(' ').filter(Boolean));
  const by = y.split(' ').filter(Boolean);
  const shared = by.filter((w) => ax.has(w)).length;
  return shared >= Math.min(2, Math.min(ax.size, by.length));
}
