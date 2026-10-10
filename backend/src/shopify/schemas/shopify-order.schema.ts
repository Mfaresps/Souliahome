import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ShopifyOrderDocument = HydratedDocument<ShopifyOrder>;

/**
 * A deposit receipt — the photo of one transfer a customer made, and its review.
 *
 * Statuses (Arabic, stored as-is, the same convention as `cancelRequest.status`):
 *   مسودة   uploaded and read by OCR, not yet submitted — invisible to everyone but its uploader
 *   معلق    submitted, awaiting a manager
 *   معتمد   approved — the money WAS booked into the vault at that moment (vaultEntryId)
 *   مرفوض   rejected — image deleted, nothing booked
 *   ملغي    the order was cancelled while this was still a draft / pending
 *   مُسترد   was approved, then refunded out of the vault (order cancelled or manager refund)
 *
 * ⚠ The vault is moved by APPROVAL and REFUND only, never by confirming the order. Anything that
 *   books a receipt's money a second time is the bug this structure exists to prevent.
 */
export interface DepositReceipt {
  id: string;
  status: 'مسودة' | 'معلق' | 'معتمد' | 'مرفوض' | 'ملغي' | 'مُسترد';
  imageKey: string;
  imageSha256: string;
  imageBytes: number;
  imageDeleted: boolean;
  amount: number;
  method: string;
  ocr: {
    amount: number | null;
    method: string;
    pattern: string;
    reference: string;
    dateText: string;
    confident: boolean;
    ran: boolean;
    ms: number;
  };
  needsReview: boolean;
  /** Non-blocking warnings shown to the manager (reused image / reused transfer reference). */
  warnings: Array<{ code: 'same-image' | 'same-reference' | 'not-transfer' | 'ocr-unavailable'; orderRef: string }>;
  warningAcknowledgedAt?: string;
  warningAcknowledgedById?: string;
  uploadedAt: string;
  submittedBy: string;
  submittedById: string;
  submittedAt: string;
  lastEditedBy?: string;
  lastEditedAt?: string;
  reviewedBy?: string;
  reviewedById?: string;
  reviewedAt?: string;
  rejectedReason?: string;
  vaultEntryId?: string;
  vaultTxNo?: string;
  refundedBy?: string;
  refundedAt?: string;
  refundReason?: string;
  refundVaultEntryId?: string;
  refundVaultTxNo?: string;
}

@Schema({ timestamps: true })
export class ShopifyOrder {
  @Prop({ required: true, unique: true })
  shopifyId: string;

  @Prop({ required: true })
  ref: string;

  @Prop({ default: '' })
  client: string;

  @Prop({ default: '' })
  phone: string;

  @Prop({ default: '' })
  notes: string;

  @Prop({ default: '' })
  payment: string;

  @Prop({ default: 0 })
  total: number;

  @Prop({ default: 0 })
  itemsTotal: number;

  @Prop({ default: 0 })
  shipCost: number;

  @Prop({ default: 0 })
  discount: number;

  @Prop({ default: '' })
  discountCode: string;

  @Prop({ default: '' })
  discountType: string; // 'percent' | 'fixed'

  @Prop({ default: 0 })
  discountValue: number;

  @Prop({ default: '' })
  financialStatus: string;

  @Prop({ default: '' })
  shopifyCreatedAt: string;

  @Prop({ type: [Object], default: [] })
  items: Array<{
    productId: string;
    code: string;
    name: string;
    qty: number;
    price: number;
    total: number;
    imageUrl: string;
    shopifyPrice: number;
    shopifyName: string;
  }>;

  @Prop({ default: 'pending' })
  status: string; // 'pending' | 'approved' | 'rejected'

  @Prop({ default: '' })
  pendingStatus: string; // '' | 'msg_sent' | 'awaiting_transfer' | 'no_reply'

  @Prop({ default: false })
  cancelled: boolean;

  @Prop({ default: '' })
  cancelledBy: string;

  @Prop({ default: '' })
  cancelledAt: string;

  /** Derived summary — `cancelReasonSummary(cancelReasonCode, cancelReasonNote)`. Rendered as-is. */
  @Prop({ default: '' })
  cancelReason: string;

  /**
   * The countable reason, one of `CANCEL_REASON_CODES` (shared/cancellation.constants.ts).
   * Empty on orders cancelled before this system existed.
   */
  @Prop({ default: '' })
  cancelReasonCode: string;

  /** Optional free-text detail. Required only when the code is `other`. */
  @Prop({ default: '' })
  cancelReasonNote: string;

  /**
   * Cancellation requested by a staff member, awaiting a manager's decision.
   *
   * Mirrors `Transaction.cancelRequest` field-for-field so the approvals page can render both
   * kinds through the same row shape. `type: Object` for the same reason it is there: this is a
   * single embedded document, and a nullable typed sub-schema would need its own class — see the
   * nullable-@Prop rule in CLAUDE.md.
   *
   * ⚠ The order is NOT cancelled while this is 'معلق'. `cancelled` stays false and the order
   *   keeps its normal status, so it continues to appear in the pending list — a request is not
   *   an outcome, and hiding the order before approval would let a staff member remove it from
   *   everyone's view without authority.
   */
  @Prop({ type: Object, default: null })
  cancelRequest: {
    requestedBy: string;
    requestedById?: string;
    requestedByUsername?: string;
    /** Derived summary of the code + note below. */
    reason: string;
    cancelReasonCode?: string;
    cancelReasonNote?: string;
    requestedAt: string;
    status: string; // 'معلق' | 'معتمد' | 'مرفوض'
    reviewedBy?: string;
    reviewedAt?: string;
    rejectedReason?: string;
  } | null;

  @Prop({ default: '' })
  reviewedBy: string;

  @Prop({ default: '' })
  reviewedAt: string;

  @Prop({ default: '' })
  rejectReason: string;

  @Prop({ default: '' })
  tags: string;

  /**
   * تغيّرت أصناف/قيمة أوردر مؤكد في شوبيفاي بعد إنشاء حركته.
   *
   * ⚠ الأصناف والإجماليات مجمَّدة بعد التأكيد (نفس قاعدة الإيداع)، لأن الحركة خصمت مخزوناً
   *   وحرّكت خزنة. تعديل القيمة هنا قرار مالي — يُعرض للموظف ولا يُطبَّق تلقائياً.
   *
   * `type: Object` إلزامي — @Prop كائنية بدونه تُسقط الـ API عند تحميل الموديول.
   */
  @Prop({ type: Object, default: null })
  valueChangeConflict: {
    oldTotal: number;
    newTotal: number;
    oldItemsCount: number;
    newItemsCount: number;
    detectedAt: string;
    resolved: boolean;
    resolvedBy?: string;
    resolvedAt?: string;
  } | null;

  @Prop({ default: '' })
  shippingAddress: string;

  @Prop({ default: '' })
  shippingCity: string;

  @Prop({ default: '' })
  shippingGov: string;

  @Prop({ default: '' })
  shippingBostaCity: string;

  @Prop({ default: '' })
  orderStatusUrl: string;

  @Prop({ type: Object })
  rawData: Record<string, unknown>;

  // Shift-based auto-assignment — routing metadata only, not a scoring gate
  @Prop({ default: '' })
  assignedTo: string; // User._id as string

  /**
   * The assignee, addressed by the identifier that survives a restore.
   *
   * ⚠ assignedTo is a User._id, which is regenerated when an account is recreated on
   * another machine — so a backup carried between the local and the online install
   * leaves every order pointing at an id that exists nowhere, and «أوردراتي» comes back
   * empty for everyone. assignedToName is only a display label (it is denormalised and
   * can hold spelling variants of the same person), so it cannot be used to re-link.
   * See EmployeePerformanceLog.employeeUsername for the full reasoning.
   *
   * Defaults to '' so every pre-existing order remains valid with no migration.
   */
  @Prop({ default: '', index: true })
  assignedToUsername: string;

  @Prop({ default: '' })
  assignedToName: string;

  @Prop({ default: '' })
  assignedAt: string; // ISO

  @Prop({ default: '' })
  assignmentReason: string; // 'shift' | 'on-call-fallback' | 'unassigned' | 'manual'

  // Append-only audit trail of assignment changes — reassignment updates assignedTo/
  // assignedToName above but never rewrites this history, and never touches reviewedBy/
  // reviewedAt/deposit fields or any EmployeePerformanceLog row (scoring stays untouched).
  @Prop({ type: [Object], default: [] })
  assignmentHistory: Array<{
    previousUserId: string;
    previousName: string;
    newUserId: string;
    newName: string;
    changedBy: string;
    reason: string;
    at: string; // ISO
  }>;

  /**
   * Transfer receipts for this order's deposit — see `DepositReceipt`. Several per order are
   * normal (a customer pays in installments), and several may be pending at once.
   *
   * ⚠ `type: [Object]` is mandatory (the nullable/array @Prop rule — without it the API dies at
   *   module load). Embedded rather than a separate collection because every reader already
   *   holds the full order list in memory (`GET /shopify/orders`).
   * ⚠ The Shopify webhook never writes this field — it is ours, like `manualDiscount`.
   */
  @Prop({ type: [Object], default: [] })
  depositReceipts: DepositReceipt[];

  /** Prevents receipt writes/confirmation from racing the pending-order refund sequence. */
  @Prop({ default: '' })
  receiptCancelLock: string;

  /**
   * The order was cancelled ON SHOPIFY while it carried approved deposit money.
   *
   * A webhook must not refund the vault on its own — a financial decision is never derived from
   * an event (the rule all Shopify webhooks follow). The order stays pending and this flag tells
   * staff to cancel it here, where the refund is shown and confirmed.
   */
  @Prop({ type: Object, default: null })
  shopifyCancelConflict: {
    at: string;
    note: string;
    approvedAmount: number;
    resolved: boolean;
    resolvedBy?: string;
    resolvedAt?: string;
  } | null;

  /**
   * Deposit summary — DERIVED from the approved `depositReceipts` (computeDepositFieldsFromReceipts).
   * Kept because employee scoring and the staff dashboard read them. They used to be parsed from
   * the Shopify note text; that path was removed with the receipt workflow.
   */
  @Prop({ default: 0 })
  depositAmount: number;

  @Prop({ default: '' })
  depositMethod: string;

  @Prop({ default: '' })
  depositStatus: string; // 'full' | 'partial' | 'none'

  @Prop({ default: 0 })
  depositPercentage: number; // 0-100

  @Prop({ default: '' })
  depositDetectedAt: string; // ISO

  /**
   * خصم يدوي إضافي يضيفه الموظف — منفصل تماماً عن `discount` (خصم شوبيفاي).
   *
   * ⚠ الفصل مقصود وهو ما يجعل هذا آمناً: `handleOrderUpdate` يكتب فوق `discount`
   *   في كل مرة يصل فيها orders/updated، فلو كان الخصم اليدوي يُخزَّن في نفس الحقل
   *   لاختفى بصمت عند أول تحديث من شوبيفاي — وهو بالضبط سبب استبعاد تعديل العنوان.
   *   الويب هوك لا يلمس هذه الحقول إطلاقاً.
   *
   * نفس تقسيم `Transaction.discount` / `Transaction.manualDiscount`.
   */
  @Prop({ default: 0 })
  manualDiscount: number;

  /**
   * 'percent' | 'fixed'. النسبة تُحوَّل إلى مبلغ ثابت وقت التطبيق (مثل applyDiscount في
   * سجل المعاملات)، فهذا الحقل يسجّل ما اختاره الموظف لا طريقة حساب مستمرة.
   */
  @Prop({ default: 'fixed' })
  manualDiscountType: string;

  /** معرّفات أكواد الخصم المطبَّقة، مفصولة بفاصلة — نفس ترميز Transaction.discountCodeId. */
  @Prop({ default: '' })
  discountCodeId: string;

  /**
   * قيمة خصم الأكواد المطبَّقة (بالجنيه). محسوبة وقت التطبيق من نوع/قيمة كل كود.
   * تُخزَّن مستقلة عن `discount` لنفس سبب `manualDiscount` أعلاه.
   */
  @Prop({ default: 0 })
  codesDiscount: number;

  /** معرّف OTP الموافقة على الخصم العالي، للتدقيق. */
  @Prop({ default: '' })
  highValueDiscountOtpId: string;

  /**
   * تعليقات الموظفين على الأوردر. نفس شكل `Transaction.comments` حرفياً، لأن
   * `approveOrder` يرحّلها إلى الحركة عند التأكيد فتبقى مقروءة بنفس العارض.
   *
   * ⚠ تُكتب عبر endpoint منفصل لا يسجّل تعديلاً — التعليق ليس تغييراً في قيمة
   *   الأوردر، ونفس قاعدة TransactionsService.addComments.
   */
  /**
   * تمييز يدوي للأوردر — نجمة بجانب رقمه.
   *
   * ⚠ لا يحمل أي معنى في المنطق: لا يغيّر حالة ولا أولوية ولا يدخل في أي تقرير.
   *   هو علامة بصرية يضعها الموظف ليعود إليها، ولذلك يجوز لأي أحد وضعها ورفعها —
   *   لا صلاحية ولا موافقة. جعله حقلاً ذا معنى لاحقاً يحتاج قراراً منفصلاً.
   */
  @Prop({ default: false })
  starred: boolean;

  /** من وضع النجمة آخر مرة — للعرض عند المرور فوقها فقط. */
  @Prop({ default: '' })
  starredBy: string;

  @Prop({ default: '' })
  starredAt: string;

  @Prop({ type: [Object], default: [] })
  comments: Array<{
    id: number;
    text: string;
    type: string;
    employee: string;
    timestamp: string;
    createdAt: string;
  }>;

  /**
   * سجل التعديلات. نفس شكل `Transaction.editHistory` ليُعرض بنفس منطق العارض.
   *
   * ⚠ `type: [Object]` إلزامي — @Prop بمصفوفة كائنات بدون type صريح يرمي
   *   CannotDetermineTypeError وقت تحميل الموديول فيسقط الـ API كله، و`nest build`
   *   لا يمسك ذلك. انظر قاعدة الـ @Prop في CLAUDE.md.
   */
  @Prop({ type: [Object], default: [] })
  editHistory: Array<{
    editedAt: string;
    editedBy: string;
    action: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    changes: string[];
  }>;
}

export const ShopifyOrderSchema = SchemaFactory.createForClass(ShopifyOrder);
// The receipt-image route and the duplicate checks look a receipt up by id / hash across orders.
ShopifyOrderSchema.index({ 'depositReceipts.id': 1 });
ShopifyOrderSchema.index({ 'depositReceipts.imageSha256': 1 });
