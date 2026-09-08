import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ShopifyOrderDocument = HydratedDocument<ShopifyOrder>;

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

  // Deposit fields — parsed once from `notes` at approveOrder() time, never re-run
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
}

export const ShopifyOrderSchema = SchemaFactory.createForClass(ShopifyOrder);
