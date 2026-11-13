/**
 * الشحن في التقارير — ثلاث أرقام منفصلة (Nov 13, 2026):
 *   • الشحن المحصَّل من العملاء  = shipCost − shippingDiscount
 *   • دعم الشحن (شحن مجاني تحمّلته الشركة) = shippingDiscount
 *   • تكلفة الشحن الفعلية لشركة الشحن = actualShipCost (+ رسوم المرتجع failedDelivery.returnShipCost)
 *
 * ⚠ ده عرض بس. الربح الإجمالي بيتحسب زي ما هو (shared/sale-discount.util.ts)، والتحصيل والخزنة وBosta
 *   بيقروا `shipCost` زي ما هو. `actualShipCost` هو الحقل الوحيد لتكلفة شركة الشحن — مفيش حقل جديد.
 * ⚠ التكلفة الفعلية معروفة بس للأوردرات اللي اتسوّت، فبترجع معاها عدد المعروف من الكل — ماينفعش
 *   تتعرض كإجمالي كأنها كاملة.
 */
import { invoiceShipCharged, invoiceShippingDiscount } from '../shared/sale-discount.util';

export const SHIPPING_DISCOUNT_SPLIT_KEY = 'shipping-discount-split';

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface ShippingBreakdown {
  /** الشحن اللي العملاء اتحاسبوا عليه فعلاً. */
  shippingCollected: number;
  /** الشحن المجاني اللي الشركة شالته (جزء من الربح الإجمالي، مش خصم منتجات). */
  shippingSubsidy: number;
  /** عدد الأوردرات اللي عليها دعم شحن. */
  shippingSubsidyOrders: number;
  /** تكلفة شركة الشحن المعروفة — `known` من `of` أوردر بس. */
  actualCarrierCost: { amount: number; known: number; of: number; returnLegFees: number };
}

export function shippingBreakdown(salesTx: any[]): ShippingBreakdown {
  let collected = 0, subsidy = 0, subsidyOrders = 0, actual = 0, known = 0, returnLeg = 0;
  for (const tx of salesTx || []) {
    collected += invoiceShipCharged(tx);
    const sd = invoiceShippingDiscount(tx);
    if (sd > 0) { subsidy += sd; subsidyOrders++; }
    const a = Number(tx?.actualShipCost) || 0;
    if (a > 0) { actual += a; known++; }
    returnLeg += Math.max(0, Number(tx?.failedDelivery?.returnShipCost) || 0);
  }
  return {
    shippingCollected: r2(collected),
    shippingSubsidy: r2(subsidy),
    shippingSubsidyOrders: subsidyOrders,
    actualCarrierCost: { amount: r2(actual + returnLeg), known, of: (salesTx || []).length, returnLegFees: r2(returnLeg) },
  };
}

/** يكتب تاريخ بدء التصنيف مرة واحدة بس (أول تشغيل للنسخة الجديدة) ومايتغيّرش بعد كده. */
export async function ensureClassificationEffectiveDate(db: any, build: string): Promise<void> {
  await db.collection('classificationchanges').updateOne(
    { key: SHIPPING_DISCOUNT_SPLIT_KEY },
    { $setOnInsert: { key: SHIPPING_DISCOUNT_SPLIT_KEY, effectiveAt: new Date().toISOString(), build: build || 'dev' } },
    { upsert: true },
  );
}

export interface ShippingClassificationStatus {
  /** امتى التصنيف الجديد بدأ يتكتب على الأوردرات الجديدة (null لو النسخة الجديدة ماشتغلتش لسه). */
  effectiveAt: string | null;
  /** أوردرات اتصنّفت وقت تأكيدها (بعد effectiveAt). */
  classifiedOnConfirm: number;
  /** أوردرات اتصنّفت بالتصحيح التاريخي (بعد موافقة). */
  classifiedByCorrection: number;
  /** هل اتطبّق أي تصحيح تاريخي؟ لو لأ، الأوردرات قبل effectiveAt لسه بالتصنيف القديم. */
  historyCorrected: boolean;
}

export async function shippingClassificationStatus(db: any, salesTx: any[]): Promise<ShippingClassificationStatus> {
  // A reporting panel must never take the whole report down — an unreadable status reads as unknown.
  let change: any = null, run: any = null;
  try {
    [change, run] = await Promise.all([
      db.collection('classificationchanges').findOne({ key: SHIPPING_DISCOUNT_SPLIT_KEY }),
      db.collection('financialcorrections').findOne({ kind: 'shipping-discount', rolledBackAt: null }),
    ]);
  } catch { /* status unknown */ }
  let onConfirm = 0, byCorrection = 0;
  for (const tx of salesTx || []) {
    const src = String(tx?.shippingDiscountSource || '');
    if (src === 'order') onConfirm++;
    else if (src.startsWith('correction:')) byCorrection++;
  }
  return { effectiveAt: change?.effectiveAt || null, classifiedOnConfirm: onConfirm, classifiedByCorrection: byCorrection, historyCorrected: !!run };
}
