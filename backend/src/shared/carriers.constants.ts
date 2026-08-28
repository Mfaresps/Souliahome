/**
 * Single source of truth for WHICH COMPANY ships an order.
 *
 * Before this file the shipping company was a free-text NAME (`tx.shipCo`) copied out of
 * `settings.shipCos[].name`, and the three paths that create a sales transaction disagreed
 * about it completely:
 *
 *   1. سجل المعاملات (manual) — a company was REQUIRED, picked from settings, and its tariff
 *      was read at save time and written into `shipCost` as a bare number.
 *   2. Shopify (`ShopifyService.approveOrder`) — wrote `shipCost` and `shipZone` and **never
 *      wrote `shipCo` at all**, so every confirmed Shopify sale carried no company.
 *   3. Bosta (`BostaService.createOrder`) — never read or wrote `shipCo`, so an order labelled
 *      «J&T Express» could be shipped through Bosta and nothing anywhere would disagree.
 *
 * Consequences this file exists to end:
 *   - `order-audit.service.ts` already groups shipping cost by company and reports the highest
 *     shipping order. That code works; its input was empty. Every Shopify order fell into the
 *     «غير محدد» bucket, which is most of the traffic — the panel measured nothing.
 *   - Renaming a company in Settings silently detached it from every historical transaction
 *     carrying the old name.
 *
 * The fix is the same split already used by CANCEL_REASONS, PRODUCT_COLORS.name and
 * JOB_TITLE_GROUPS: a stable `code` is stored and grouped on, `ar`/`en` are display only.
 *
 * ⚠ `code` is the stored value — it lands in Mongo (`tx.carrierCode`), in the reports breakdown
 *   and in the archive export. **Never rename one.** Add a new code and leave the old one in
 *   CARRIERS so historical rows keep resolving to a label.
 *
 * ⚠ `frontend/public/index.html` carries a hand-kept mirror of this list (`CARRIERS` /
 *   `CARRIER_INTEGRATIONS`). The backend validates every submitted code against **its own** copy,
 *   so a carrier added on one side only is either un-choosable or rejected at save. Same
 *   convention as CANCEL_REASONS and the global-search scorers.
 */

/**
 * Which API this carrier is actually wired to.
 *
 * This is the field that makes the system "aware of a connected carrier": it decides whether the
 * «إرسال إلى Bosta» button exists for an order, NOT whether the carrier may be selected. A carrier
 * with `integration: 'none'` is fully usable for recording and reporting — it is simply handed
 * over manually. Adding a second integrated carrier means adding its code here plus its own
 * service; no existing branch changes.
 */
export type CarrierIntegration = 'bosta' | 'none';

/** Pricing zone. Kept as the existing two-zone model — see ZONE note below. */
export type ShipZone = 'cairo' | 'gov';

export interface CarrierZoneTariff {
  zone: ShipZone;
  price: number;
}

export interface CarrierDef {
  /** Stored value. Immutable once shipped. */
  code: string;
  ar: string;
  en: string;
  integration: CarrierIntegration;
  /**
   * Seed tariff, used only when a carrier is first written into `settings.shipCos`. The live
   * price is always read from settings — this is a default, never the authority.
   */
  tariff: CarrierZoneTariff[];
}

export const SHIP_ZONES: { zone: ShipZone; ar: string; en: string }[] = [
  { zone: 'cairo', ar: 'القاهرة والجيزة', en: 'Cairo & Giza' },
  { zone: 'gov', ar: 'المحافظات', en: 'Governorates' },
];

/**
 * ⚠ The two-zone model is inherited from `cityToShipZone` (normalize-city.util.ts), which maps
 * Cairo/Giza → 'cairo' and everything else → 'gov'. It is deliberately NOT changed here: the city
 * picker stores a precise `shippingBostaCity`, so a finer zone table is possible later, but
 * changing the zone keys now would invalidate every stored `shipZone`. New zones are added by
 * extending SHIP_ZONES and cityToShipZone together, never by renaming these two.
 */

export const CARRIERS: CarrierDef[] = [
  {
    code: 'bosta',
    ar: 'بوسطة',
    en: 'Bosta',
    integration: 'bosta',
    tariff: [{ zone: 'cairo', price: 110 }, { zone: 'gov', price: 150 }],
  },
  {
    code: 'jt-express',
    ar: 'جيه آند تي إكسبريس',
    en: 'J&T Express',
    integration: 'none',
    tariff: [{ zone: 'cairo', price: 110 }, { zone: 'gov', price: 150 }],
  },
  {
    code: 'mylerz',
    ar: 'مايلرز',
    en: 'Mylerz',
    integration: 'none',
    tariff: [{ zone: 'cairo', price: 110 }, { zone: 'gov', price: 150 }],
  },
];

export const CARRIER_CODES = CARRIERS.map((c) => c.code);

const BY_CODE = new Map(CARRIERS.map((c) => [c.code, c]));

/**
 * Legacy rows carry a free-text name and no code. Reports bucket them under this code rather than
 * dropping them, so shipping totals still equal what actually shipped. A shrinking «غير محدد»
 * bucket is also the adoption metric — same rule as LEGACY_CANCEL_REASON_CODE.
 */
export const LEGACY_CARRIER_CODE = 'unspecified';
export const LEGACY_CARRIER_AR = 'غير محدد';

export function carrierDef(code: string): CarrierDef | undefined {
  return BY_CODE.get(String(code || '').trim());
}

export function isValidCarrier(code: string): boolean {
  return BY_CODE.has(String(code || '').trim());
}

/** Display label. Falls back to the raw stored value so an unknown/legacy code still renders. */
export function carrierLabel(code: string, lang: 'ar' | 'en' = 'ar'): string {
  const c = String(code || '').trim();
  // ⚠ The sentinel must resolve too, not just the empty string. Reports bucket unresolved rows
  //   under LEGACY_CARRIER_CODE, so without this branch an Arabic report prints the raw English
  //   code 'unspecified' as if it were a company name.
  if (!c || c === LEGACY_CARRIER_CODE) return lang === 'en' ? 'Unspecified' : LEGACY_CARRIER_AR;
  const def = BY_CODE.get(c);
  if (!def) return c;
  return lang === 'en' ? def.en : def.ar;
}

/** True when this carrier is wired to a shipping API (currently only Bosta). */
export function carrierIntegration(code: string): CarrierIntegration {
  return BY_CODE.get(String(code || '').trim())?.integration || 'none';
}

/**
 * Resolves a legacy free-text company name to a code.
 *
 * `settings.shipCos[].name` and every historical `tx.shipCo` hold a display name, not a code, so
 * migration and any un-coded caller need this bridge. Matching is case-insensitive and ignores
 * surrounding whitespace; both the Arabic and English labels are accepted because the name stored
 * depends on which language the operator's Settings page was in.
 *
 * Returns '' when nothing matches — the caller must then treat the carrier as unspecified rather
 * than inventing one, since guessing would file real shipments under the wrong company.
 */
export function carrierCodeFromName(name: string): string {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  if (BY_CODE.has(n)) return n;
  for (const c of CARRIERS) {
    if (c.ar.toLowerCase() === n || c.en.toLowerCase() === n || c.code === n) return c.code;
  }
  return '';
}

/**
 * Resolves the carrier of a transaction FOR READING — the code if it was stored, otherwise
 * inferred from the legacy free-text name.
 *
 * ⚠ THIS IS A READ-SIDE BRIDGE, NOT A WRITE PATH. `resolveCarrierForWrite` remains the only
 *   place a carrier is decided when saving; this exists because `carrierCode` was added after
 *   the fact and **no historical row carries it**. Measured on the live backup: 0 of 484 sales
 *   have a `carrierCode`, while `shipCo` holds 'Bosta' (78), 'bosta +' (219) and '' (180). A
 *   report keyed on the code alone would therefore file 84% of real shipments under «غير محدد»
 *   and show an empty per-carrier breakdown — the exact failure `carriers.constants.ts` was
 *   written to end.
 *
 * Returns '' when nothing resolves. The caller buckets those under LEGACY_CARRIER_CODE rather
 * than guessing, so the per-carrier totals still add up to what actually shipped.
 */
export function resolveCarrierForRead(tx: {
  carrierCode?: string;
  shipCo?: string;
}): string {
  const stored = String(tx?.carrierCode || '').trim();
  if (stored) return stored;
  return carrierCodeFromLooseName(tx?.shipCo || '');
}

/**
 * Like `carrierCodeFromName` but tolerant of the decorations operators actually type into
 * `settings.shipCos[].name`: a plan/tier suffix ('bosta +'), punctuation, emoji, or a
 * parenthetical. It matches on the longest registry label CONTAINED in the name, so 'bosta +'
 * and 'Bosta Express' both resolve to `bosta`.
 *
 * ⚠ Deliberately NOT used by the write path. On save an unknown code must be REJECTED so the
 *   operator fixes it while still on screen (see resolveCarrierForWrite); guessing there would
 *   file a shipment under the wrong company silently. Here the alternative to guessing is an
 *   unreadable report, and the guess is auditable because the bucket is named.
 *
 * ⚠ Longest-match, not first-match: a shorter label that is a substring of another would
 *   otherwise win arbitrarily depending on CARRIERS order.
 */
export function carrierCodeFromLooseName(name: string): string {
  const exact = carrierCodeFromName(name);
  if (exact) return exact;
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  let best = '';
  let bestLen = 0;
  for (const c of CARRIERS) {
    for (const label of [c.code, c.en.toLowerCase(), c.ar.toLowerCase()]) {
      if (label && label.length > bestLen && n.includes(label)) {
        best = c.code;
        bestLen = label.length;
      }
    }
  }
  return best;
}

/**
 * Seed tariff for a carrier/zone, used when settings carry no price for it.
 *
 * ⚠ Returns `undefined`, never 0, when the carrier is unknown. A missing price and a genuinely
 * free shipment (0) are different facts, and collapsing them is exactly the `||` falsy bug that
 * made a zero-priced carrier silently inherit the global default price.
 */
export function carrierSeedPrice(code: string, zone: ShipZone): number | undefined {
  const def = BY_CODE.get(String(code || '').trim());
  if (!def) return undefined;
  return def.tariff.find((t) => t.zone === zone)?.price;
}
