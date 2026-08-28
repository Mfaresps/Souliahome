/**
 * Single source of truth for WHY an order gets cancelled.
 *
 * There are two cancellation paths in the system and they were never related to each other:
 *   1. A Shopify order cancelled on the Shopify page, before it ever becomes a transaction
 *      (ShopifyService.cancelOrder) — free-text `reason`, optional, usually empty.
 *   2. A transaction cancelled in سجل المعاملات (TransactionsService.performCancellation,
 *      reached directly by an admin or through the request→approve flow) — free-text
 *      `cancelReason`, required but unconstrained.
 *
 * Free text on both sides means the two can never be counted together: «العميل غير مستجيب»,
 * «عميل مش راد» and «لا يرد» are three rows in any report that groups by reason. This file makes
 * the reason a CODE (stable, machine-countable) with the Arabic label derived at render time —
 * the same "code is stored, `ar` is display" split used by PRODUCT_COLORS and JOB_TITLE_GROUPS.
 *
 * ⚠ The codes are the stored value and appear in reports, exports and the audit trail.
 *   Never rename one — add a new code and leave the old one in CANCEL_REASONS so historical rows
 *   keep resolving to a label. CANCEL_REASON_CODES is what the DTOs validate against.
 */

export type CancelStage = 'shopify' | 'transaction';

export interface CancelReasonDef {
  /** Stored value. Immutable once shipped. */
  code: string;
  ar: string;
  en: string;
  /**
   * Where this reason may be selected. A Shopify order has not shipped and has no vault or stock
   * movement yet, so «فشل التوصيل» is meaningless there; conversely a transaction that has already
   * moved cash is not a «طلب تجريبي». Reasons valid at both stages list both.
   */
  stages: CancelStage[];
  /**
   * لا يُعرض في قوائم الاختيار — يكتبه النظام وحده (حالياً webhook إلغاء شوبيفاي).
   * الواجهة تصفّي عليه، بينما التحقق يقبله كرمز صالح لأن النظام هو من أرسله.
   */
  systemOnly?: boolean;
  /** Buckets the reason in the reports breakdown. */
  group: 'customer' | 'operations' | 'inventory' | 'payment' | 'other';
  /** «سبب آخر» — the free-text note becomes required. */
  requiresNote?: boolean;
}

export const CANCEL_REASON_GROUPS = [
  { key: 'customer', ar: 'من العميل', en: 'Customer' },
  { key: 'operations', ar: 'تشغيلي / شحن', en: 'Operations & shipping' },
  { key: 'inventory', ar: 'المخزون', en: 'Inventory' },
  { key: 'payment', ar: 'الدفع', en: 'Payment' },
  { key: 'other', ar: 'أخرى', en: 'Other' },
] as const;

export const CANCEL_REASONS: CancelReasonDef[] = [
  // ── من العميل ────────────────────────────────────────────────────────────
  { code: 'customer-request', ar: 'العميل طلب الإلغاء', en: 'Customer requested cancellation', stages: ['shopify', 'transaction'], group: 'customer' },
  { code: 'customer-unreachable', ar: 'تعذّر الوصول للعميل', en: 'Customer unreachable', stages: ['shopify', 'transaction'], group: 'customer' },
  { code: 'customer-changed-mind', ar: 'العميل غيّر رأيه', en: 'Customer changed their mind', stages: ['shopify', 'transaction'], group: 'customer' },
  { code: 'customer-found-cheaper', ar: 'العميل وجد سعراً أفضل', en: 'Customer found a better price', stages: ['shopify', 'transaction'], group: 'customer' },
  { code: 'wrong-order', ar: 'العميل طلب صنفاً خاطئاً', en: 'Customer ordered the wrong item', stages: ['shopify', 'transaction'], group: 'customer' },

  // ── تشغيلي / شحن ─────────────────────────────────────────────────────────
  { code: 'duplicate-order', ar: 'طلب مكرر', en: 'Duplicate order', stages: ['shopify', 'transaction'], group: 'operations' },
  { code: 'test-order', ar: 'طلب تجريبي', en: 'Test order', stages: ['shopify'], group: 'operations' },
  { code: 'fake-order', ar: 'طلب وهمي / بيانات غير صحيحة', en: 'Fake order or invalid data', stages: ['shopify', 'transaction'], group: 'operations' },
  { code: 'address-unserviceable', ar: 'العنوان خارج نطاق التغطية', en: 'Address outside coverage', stages: ['shopify', 'transaction'], group: 'operations' },
  { code: 'delivery-failed', ar: 'فشل التوصيل / مرتجع من الشحن', en: 'Delivery failed or returned by courier', stages: ['transaction'], group: 'operations' },
  { code: 'data-entry-error', ar: 'خطأ في إدخال الحركة', en: 'Data-entry mistake', stages: ['transaction'], group: 'operations' },
  // ⚠ يُكتب تلقائياً من webhook «orders/cancelled» فقط — لا يُعرض في أي قائمة اختيار.
  //   الإلغاء وقع بالفعل في شوبيفاي؛ النظام يسجّل واقعة لا يتخذ قراراً. وجوده كرمز مستقل
  //   يجعل «أُلغي من شوبيفاي» قابلاً للعدّ في تقرير الإلغاءات بدل أن يختلط بإلغاء يدوي.
  { code: 'shopify-cancelled', ar: 'أُلغي من شوبيفاي', en: 'Cancelled on Shopify', stages: ['shopify', 'transaction'], group: 'operations', systemOnly: true },

  // ── المخزون ──────────────────────────────────────────────────────────────
  { code: 'out-of-stock', ar: 'الصنف غير متوفر', en: 'Item out of stock', stages: ['shopify', 'transaction'], group: 'inventory' },
  { code: 'item-damaged', ar: 'الصنف تالف', en: 'Item damaged', stages: ['shopify', 'transaction'], group: 'inventory' },
  { code: 'pricing-error', ar: 'خطأ في التسعير', en: 'Pricing error', stages: ['shopify', 'transaction'], group: 'inventory' },

  // ── الدفع ────────────────────────────────────────────────────────────────
  { code: 'payment-failed', ar: 'فشل الدفع', en: 'Payment failed', stages: ['shopify', 'transaction'], group: 'payment' },
  { code: 'payment-not-received', ar: 'لم يتم استلام المبلغ', en: 'Payment never received', stages: ['shopify', 'transaction'], group: 'payment' },
  { code: 'supplier-cancelled', ar: 'المورد ألغى التوريد', en: 'Supplier cancelled the supply', stages: ['transaction'], group: 'payment' },

  // ── أخرى ─────────────────────────────────────────────────────────────────
  { code: 'other', ar: 'سبب آخر', en: 'Other reason', stages: ['shopify', 'transaction'], group: 'other', requiresNote: true },
];

export const CANCEL_REASON_CODES = CANCEL_REASONS.map((r) => r.code);

const BY_CODE = new Map(CANCEL_REASONS.map((r) => [r.code, r]));

/**
 * الرمز الذي يكتبه webhook إلغاء شوبيفاي. ثابت مستقل لأنه يُشار إليه من الكود لا من قائمة
 * اختيار — وإعادة تسميته تكسر كل صف تاريخي، كما تنص قاعدة code-vs-label.
 */
export const SHOPIFY_CANCELLED_CODE = 'shopify-cancelled';

export function cancelReasonDef(code: string): CancelReasonDef | undefined {
  return BY_CODE.get(String(code || '').trim());
}

/** Reasons offered at a given stage, in declaration order (already grouped). */
export function cancelReasonsFor(stage: CancelStage): CancelReasonDef[] {
  return CANCEL_REASONS.filter((r) => r.stages.includes(stage));
}

export function isValidCancelReason(code: string, stage?: CancelStage): boolean {
  const def = cancelReasonDef(code);
  if (!def) return false;
  return stage ? def.stages.includes(stage) : true;
}

/**
 * Human-readable one-line summary, written into the free-text fields that existing consumers still
 * read (tx.cancelReason renders verbatim in the invoice view, the archive export and the vault
 * note). Keeping that string populated is what makes the structured fields additive rather than a
 * migration: nothing that read cancelReason before has to change.
 */
export function cancelReasonSummary(code: string, note?: string): string {
  const def = cancelReasonDef(code);
  const label = def ? def.ar : String(code || '').trim();
  const n = String(note || '').trim();
  if (!label) return n;
  return n ? `${label} — ${n}` : label;
}

/**
 * Legacy rows carry only free text and no code. Reports bucket them under this code rather than
 * dropping them, so the totals still add up to the number of cancellations that actually happened.
 */
export const LEGACY_CANCEL_REASON_CODE = 'unspecified';
export const LEGACY_CANCEL_REASON_AR = 'غير محدد (قبل تطبيق النظام)';
