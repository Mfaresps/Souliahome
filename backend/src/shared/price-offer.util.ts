/**
 * عروض أسعار البيع (Nov 12, 2026) — سعر مؤقت لفترة محددة على المنتج.
 *
 * - المنتج: `sellPrice` = السعر الأساسي (مايتغيّرش بالعرض). `priceOffers[]` = العروض.
 * - العرض شغال في يوم البيع لو `from ≤ اليوم ≤ to` (أيام القاهرة، YYYY-MM-DD، شاملة الطرفين)
 *   ومش ملغي. ⚠ مفيش cron: السعر الفعّال بيتحسب وقت الاستخدام، فالعرض بيبدأ ويخلص لوحده.
 * - سطر البيع بيتسجل عليه: `listPrice` (السعر الأساسي وقت البيع)، `priceSource`
 *   ('offer' | 'list' | 'manual' | 'shopify')، و`offerId` لو عرض. السعر نفسه (`price`) = اللي اتدفع.
 *   «قيمة العروض» في التقارير = Σ (listPrice − price) × الكمية.
 * ⚠ index.html فيه نسخة من `effectiveSellPrice` (`_effectiveSellPrice`) — لازم الاتنين يتفقوا.
 */
export interface PriceOffer {
  id: string;
  price: number;
  from: string;
  to: string;
  reason?: string;
  by?: string;
  createdAt?: string;
  endedAt?: string | null;
  /** Cairo day it was stopped — it no longer applies from that day on (sales before it keep it). */
  endedOn?: string;
  endedBy?: string;
  editedAt?: string;
  editedBy?: string;
  cancelled?: boolean;
}

/** What a priced sale line carries besides its own fields. */
export type PricedLine = { listPrice?: number; priceSource?: string; offerId?: string; offerName?: string };

// offerName is kept on the line (like discountCode on the invoice) so the invoice still names the
// offer after it ends or is renamed.
export const LINE_PRICE_FIELDS = ['listPrice', 'priceSource', 'offerId', 'offerName'] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function offerActiveOn(o: PriceOffer | null | undefined, day: string): boolean {
  return !!o && !o.cancelled && DAY.test(day) && o.from <= day && day <= o.to && !(o.endedOn && day >= o.endedOn);
}

export function activeOffer(product: { priceOffers?: PriceOffer[] } | null | undefined, day: string): PriceOffer | null {
  return (product?.priceOffers || []).find((o) => offerActiveOn(o, day)) || null;
}

/** السعر اللي البيعة في اليوم ده المفروض تاخده تلقائيًا. */
export function effectiveSellPrice(product: { sellPrice?: number; priceOffers?: PriceOffer[] } | null | undefined, day: string):
  { price: number; listPrice: number; offer: PriceOffer | null } {
  const listPrice = Number(product?.sellPrice) || 0;
  const offer = activeOffer(product, day);
  return { price: offer ? Number(offer.price) : listPrice, listPrice, offer };
}

/** حالة العرض في يوم: شغال / جاي / خلص / اتلغى. ⚠ صفحة العروض وكارت الصنف بيستخدموا ده الاتنين. */
export function offerStatusOn(o: PriceOffer, today: string): 'active' | 'upcoming' | 'ended' | 'cancelled' {
  if (o.cancelled) return 'cancelled';
  if (o.to < today || (o.endedOn && o.endedOn <= today)) return 'ended';
  return o.from > today ? 'upcoming' : 'active';
}

/** هل عرضين بيتقاطعوا في الأيام؟ */
export function offersOverlap(a: { from: string; to: string }, b: { from: string; to: string }): boolean {
  return a.from <= b.to && b.from <= a.to;
}

/**
 * سطور بيع جديدة: كل سطر لمنتج معروف ياخد listPrice/priceSource/offerId حسب يوم البيع.
 * ⚠ أي قيمة جاية من العميل بتتشال الأول — السيرفر هو اللي بيقرر (زي التكلفة بالظبط).
 * `productOf(code)` بيرجّع المنتج أو null. `source` = 'shopify' لطلبات Shopify.
 */
export function stampSaleLinePrices<T extends Record<string, any>>(items: T[] | undefined, productOf: (code: string) => any, day: string,
  source: 'system' | 'shopify' = 'system'): Array<T & PricedLine> | undefined {
  if (!Array.isArray(items)) return items;
  return items.map((raw) => {
    const item: any = { ...raw };
    for (const f of LINE_PRICE_FIELDS) delete item[f];
    const p = productOf(String(item.code || '').trim());
    if (!p) return item;
    const eff = effectiveSellPrice(p, day);
    const price = Number(item.price) || 0;
    // Shopify lines carry the system price they were imported against (mapItems) — keep it.
    const list = source === 'shopify' && Number(raw.listPrice) > 0 ? Number(raw.listPrice) : eff.listPrice;
    item.listPrice = list;
    const atOffer = !!eff.offer && Math.abs(price - Number(eff.offer.price)) < 0.005;
    // A Shopify line keeps source 'shopify' (Shopify set the price) but still names a matching offer.
    if (atOffer) { item.offerId = eff.offer!.id; item.offerName = String(eff.offer!.reason || ''); }
    if (source === 'shopify') item.priceSource = 'shopify';
    else if (atOffer) item.priceSource = 'offer';
    else item.priceSource = Math.abs(price - list) < 0.005 ? 'list' : 'manual';
    return item;
  });
}

/** تعديل فاتورة: السطور القديمة تحتفظ بمصدر سعرها (نفس مطابقة carryLineCosts: lineId، وإلا كود فريد). */
export function carryLinePrices<T extends Record<string, any>>(stored: any[] | undefined, incoming: T[] | undefined): Array<T & PricedLine> | undefined {
  if (!Array.isArray(incoming)) return incoming;
  const old = Array.isArray(stored) ? stored : [];
  const count = (arr: any[], code: string) => arr.filter((i) => String(i?.code || '').trim() === code).length;
  return incoming.map((raw) => {
    const item: any = { ...raw };
    for (const f of LINE_PRICE_FIELDS) delete item[f];
    const code = String(item.code || '').trim();
    let match = item.lineId ? old.find((o) => o?.lineId && o.lineId === item.lineId && String(o.code || '').trim() === code) : null;
    if (!match && code && count(old, code) === 1 && count(incoming, code) === 1) match = old.find((o) => String(o?.code || '').trim() === code);
    // The stored source holds only while the price is unchanged; an edited price is a manual price.
    if (match && match.listPrice !== undefined && Math.abs((Number(match.price) || 0) - (Number(item.price) || 0)) < 0.005) {
      for (const f of LINE_PRICE_FIELDS) if (match[f] !== undefined) item[f] = match[f];
    } else if (match && match.listPrice !== undefined) {
      item.listPrice = match.listPrice;
      item.priceSource = 'manual';
    }
    return item;
  });
}

/** تصنيف سطر للتقرير: قيمة التخفيض عن السعر الأساسي حسب مصدره. */
export function lineMarkdown(item: any): { source: string; value: number } | null {
  const list = Number(item?.listPrice);
  if (!Number.isFinite(list) || list <= 0 || !item?.priceSource) return null;
  const qty = Number(item.qty) || 0;
  return { source: String(item.priceSource), value: Math.round((list - (Number(item.price) || 0)) * qty * 100) / 100 };
}

// ── شيل عرض من سطر في فاتورة واحدة (Nov 13, 2026) ──────────────────────────────────────────
/**
 * `offerRemoved` على سطر بيع = «العرض ده كان شغال على الصنف، واتشال من الفاتورة دي بالذات».
 * العرض نفسه مابيتلمسش — بيفضل شغال على باقي الأوردرات. السعر بيرجع للسعر الأساسي على السطر،
 * فالتقارير مابتعدّش السطر على العرض (التصنيف كله بالسعر، زي ما هو).
 *
 * ⚠ السيرفر هو اللي بيقرر: اسم الموظف والوقت من الجلسة، والعرض لازم يكون موجود فعلًا على الصنف،
 * والسطر لازم مايكونش بسعر العرض (وإلا التسجيل متناقض ويتشال). شيل جديد محتاج promotions-offers
 * (أو أدمن)؛ شيل متسجل قبل كده بيعدّي كما هو في أي تعديل تاني على الفاتورة.
 */
export type OfferRemoval = { offerId: string; offerName: string; reason: string; by: string; at: string };

const clipText = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, ' ').trim().slice(0, n);

/** شكل نظيف من اللي جاي من العميل — أو null. by/at بيتحفظوا هنا بس عشان المقارنة بالمخزّن. */
export function cleanOfferRemoval(raw: any): OfferRemoval | null {
  if (!raw || typeof raw !== 'object') return null;
  const offerId = clipText(raw.offerId, 40);
  if (!offerId) return null;
  return { offerId, offerName: clipText(raw.offerName, 200), reason: clipText(raw.reason, 200), by: clipText(raw.by, 80), at: clipText(raw.at, 40) };
}

export class OfferRemovalError extends Error {
  constructor(message: string, readonly kind: 'forbidden' | 'invalid') { super(message); }
}

function matchStored(stored: any[], item: any, incoming: any[]): any | null {
  const code = String(item?.code || '').trim();
  if (item?.lineId) {
    const byId = stored.find((o) => o?.lineId && o.lineId === item.lineId);
    if (byId) return byId;
  }
  const count = (arr: any[]) => arr.filter((i) => String(i?.code || '').trim() === code).length;
  return code && count(stored) === 1 && count(incoming) === 1 ? stored.find((o) => String(o?.code || '').trim() === code) : null;
}

/**
 * يثبّت `offerRemoved` على كل سطر بعد التسعير. بيرجع السطور + اللي اتشال جديد (للسجل).
 * `productOf(line)` بيرجع الصنف بعروضه (priceOffers) أو null.
 */
export function settleOfferRemovals<T extends Record<string, any>>(items: T[] | undefined, stored: any[] | undefined,
  ctx: { actor: string; allowed: boolean; productOf: (line: any) => any; now?: string }):
  { items: T[] | undefined; added: Array<{ code: string; name: string; offerName: string; reason: string }> } {
  const added: Array<{ code: string; name: string; offerName: string; reason: string }> = [];
  if (!Array.isArray(items)) return { items, added };
  const old = Array.isArray(stored) ? stored : [];
  const out = items.map((raw) => {
    const item: any = { ...raw };
    const r = cleanOfferRemoval(item.offerRemoved);
    delete item.offerRemoved;
    if (!r) return item;
    const p = ctx.productOf(item);
    const offer = ((p?.priceOffers || []) as PriceOffer[]).find((o) => o.id === r.offerId) || null;
    const price = Number(item.price) || 0;
    // The line is at the offer price again — "removed" would contradict the line itself.
    if (offer && Math.abs(price - Number(offer.price)) < 0.005) return item;
    const prev = cleanOfferRemoval(matchStored(old, item, items)?.offerRemoved);
    const unchanged = prev && prev.offerId === r.offerId && prev.reason === r.reason && prev.at === r.at;
    if (unchanged) {
      item.offerRemoved = prev;
    } else {
      if (!ctx.allowed) throw new OfferRemovalError('إزالة عرض من الفاتورة تتطلب صلاحية «عروض الأسعار»', 'forbidden');
      if (!offer) throw new OfferRemovalError('العرض المطلوب إزالته غير موجود على هذا الصنف', 'invalid');
      if (r.reason.length < 2) throw new OfferRemovalError('اكتب سبب إزالة العرض من الفاتورة', 'invalid');
      item.offerRemoved = { offerId: offer.id, offerName: String(offer.reason || r.offerName || ''), reason: r.reason, by: ctx.actor, at: ctx.now || new Date().toISOString() };
      added.push({ code: String(item.code || ''), name: String(item.name || ''), offerName: item.offerRemoved.offerName, reason: r.reason });
    }
    // Not at the offer: the line names no offer, and a line back at the base price is a list sale.
    delete item.offerId; delete item.offerName;
    if (item.priceSource === 'manual' && Number(item.listPrice) > 0 && Math.abs(price - Number(item.listPrice)) < 0.005) item.priceSource = 'list';
    return item;
  });
  return { items: out as T[], added };
}
