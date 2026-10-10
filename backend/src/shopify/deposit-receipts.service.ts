import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import * as crypto from 'crypto';
import { DepositReceipt, ShopifyOrder, ShopifyOrderDocument } from './schemas/shopify-order.schema';
import { Transaction, TransactionDocument } from '../transactions/schemas/transaction.schema';
import { VaultService } from '../vault/vault.service';
import { SettingsService } from '../settings/settings.service';
import { EmployeeScoringService } from '../employee-performance/employee-scoring.service';
import { PresenceGateway } from '../auth/presence.gateway';
import { DepositReceiptOcrService } from './deposit-receipt-ocr.service';
import { MAX_STORED_RECEIPT_BYTES, receiptContentWarnings } from './receipt-upload-policy.util';
import { receiptImageKey } from './receipt-storage-path.util';
import { r2DeleteObject, r2GetObjectBuffer, r2ListObjects, r2PutObject } from '../shared/r2-uploader.util';
import {
  DEPOSIT_TOLERANCE,
  DEPOSIT_VAULT_METHODS,
  computeDepositFieldsFromReceipts,
  depositCapFor,
  isValidDepositAmount,
  receiptsIn,
  receiptBudgetExpr,
  round2,
} from './deposit-receipts.util';

export interface ReceiptActor {
  id: string;
  username: string;
  name: string;
  isAdmin: boolean;
}

export interface UploadedImage {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

const ACCEPTED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_RECEIPT_UPLOAD_BYTES = 4 * 1024 * 1024;
const R2_PREFIX = 'deposit-receipts/';
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const BUSINESS_TZ = process.env.BUSINESS_TZ || 'Africa/Cairo';

/** Statuses whose receipt is a live claim — a duplicate of one of these is worth a warning. */
const LIVE_STATUSES: DepositReceipt['status'][] = ['معلق', 'معتمد'];

function businessDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function cleanRef(ref: unknown): string {
  return String(ref || '').replace(/^#+/, '');
}

/**
 * Deposit receipts — the photo-verified replacement for reading the deposit out of Shopify notes.
 *
 *   upload → (OCR suggests) → submit → manager approves → THE VAULT MOVES HERE, once.
 *
 * Mirrors the cancelRequest quartet (request → approve / reject / withdraw).
 *
 * ⚠ SINGLE BOOKING. `approve` claims the receipt with one atomic findOneAndUpdate that only
 *   matches while it is still «معلق»; a second click (or a second manager) matches nothing. The
 *   vault entry is written only after the claim, and a failed write puts the receipt back to
 *   «معلق». Confirming the order later reads these figures and books nothing — see
 *   ShopifyService.approveOrder. Same guarantee as `carrierSettleLock`, without a lock field,
 *   and the same order of operations as approving a customer return.
 *
 * ⚠ Approve / reject / refund are `@Roles('admin')` at the route and are NOT a delegable perm: an
 *   uploader must never be able to approve their own receipt.
 */
@Injectable()
export class DepositReceiptsService {
  private readonly logger = new Logger(DepositReceiptsService.name);
  private imageLimitQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectModel(ShopifyOrder.name)
    private readonly orderModel: Model<ShopifyOrderDocument>,
    @InjectModel(Transaction.name)
    private readonly txModel: Model<TransactionDocument>,
    private readonly vaultService: VaultService,
    private readonly settingsService: SettingsService,
    private readonly ocr: DepositReceiptOcrService,
    private readonly employeeScoringService: EmployeeScoringService,
    private readonly presence: PresenceGateway,
  ) {}

  private emit(orderId: string, receiptId: string, status: string): void {
    try { this.presence?.emitEvent('shopify:deposit-changed', { orderId: String(orderId), receiptId, status }); } catch { /* swallow */ }
  }

  private async r2(): Promise<NonNullable<Awaited<ReturnType<SettingsService['getR2Config']>>>> {
    const cfg = await this.settingsService.getR2Config();
    if (!cfg) throw new BadRequestException('إعدادات Cloudflare R2 غير مكتملة — لا يمكن حفظ صورة الإيصال');
    return cfg;
  }

  /** Best-effort delete. A leftover object is collected by the nightly cleanup. */
  private async deleteImage(key: string): Promise<boolean> {
    if (!key) return true;
    try {
      const cfg = await this.settingsService.getR2Config();
      if (!cfg) return false;
      const res = await r2DeleteObject(cfg, key);
      if (!res.ok) this.logger.warn(`Receipt image delete failed (${key}): ${res.message}`);
      return res.ok;
    } catch (err) {
      this.logger.warn(`Receipt image delete failed (${key}): ${(err as Error).message}`);
      return false;
    }
  }

  private async loadPendingOrder(orderId: string): Promise<ShopifyOrderDocument> {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('الأوردر غير موجود');
    if (order.status !== 'pending' || order.cancelled || order.receiptCancelLock) {
      throw new BadRequestException('لا يمكن تعديل عربون أوردر غير معلّق — الأوردر مؤكد أو ملغي');
    }
    return order;
  }

  private findReceipt(order: { depositReceipts?: DepositReceipt[] }, id: string): DepositReceipt {
    const r = (order.depositReceipts || []).find((x) => x.id === id);
    if (!r) throw new NotFoundException('إيصال العربون غير موجود');
    return r;
  }

  private assertOwner(r: DepositReceipt, actor: ReceiptActor): void {
    if (actor.isAdmin) return;
    if (r.submittedById && actor.id && r.submittedById === actor.id) return;
    throw new ForbiddenException('هذا الإيصال رفعه موظف آخر');
  }

  private validateEntry(amount: unknown, method: unknown): { amount: number; method: string } {
    const n = typeof amount === 'string' ? Number(amount) : amount;
    if (!isValidDepositAmount(n)) {
      throw new BadRequestException('المبلغ غير صالح — يجب أن يكون رقماً موجباً بحد أقصى منزلتين عشريتين');
    }
    if (typeof method !== 'string' || !(DEPOSIT_VAULT_METHODS as readonly string[]).includes(method)) {
      throw new BadRequestException('الخزنة غير معروفة');
    }
    return { amount: round2(n), method };
  }

  private needsReviewFor(r: DepositReceipt, amount: number, method: string): boolean {
    const ocr = r.ocr;
    if (!ocr || !ocr.confident || ocr.amount == null) return true;
    if (Math.abs(ocr.amount - amount) > DEPOSIT_TOLERANCE) return true;
    if (ocr.method !== method) return true;
    return (r.warnings || []).length > 0;
  }

  /** Re-derives the order's deposit summary from approved receipts, then re-scores the assignee. */
  private async refreshDerived(orderId: string): Promise<void> {
    try {
      const order = await this.orderModel.findById(orderId).exec();
      if (!order) return;
      const f = computeDepositFieldsFromReceipts(order);
      order.depositAmount = f.depositAmount;
      order.depositMethod = f.depositMethod;
      order.depositStatus = f.depositStatus;
      order.depositPercentage = f.depositPercentage;
      order.depositDetectedAt = new Date().toISOString();
      await order.save();
      this.employeeScoringService.scoreDepositDetection(order).catch((err) =>
        this.logger.error(`Deposit re-scoring failed for order ${orderId}: ${(err as Error).message}`),
      );
    } catch (err) {
      this.logger.error(`Deposit summary refresh failed for order ${orderId}: ${(err as Error).message}`);
    }
  }

  /** Other live receipts carrying the same image or the same transfer reference. */
  private async findDuplicates(sha: string, reference: string, excludeId = ''): Promise<DepositReceipt['warnings']> {
    const warnings: DepositReceipt['warnings'] = [];
    const or: any[] = [{ depositReceipts: { $elemMatch: { imageSha256: sha, status: { $in: LIVE_STATUSES } } } }];
    if (reference) or.push({ depositReceipts: { $elemMatch: { 'ocr.reference': reference, status: { $in: LIVE_STATUSES } } } });
    const hits = await this.orderModel.find({ $or: or }).select('ref depositReceipts').lean().exec();
    for (const o of hits as any[]) {
      for (const r of (o.depositReceipts || []) as DepositReceipt[]) {
        if (!LIVE_STATUSES.includes(r.status) || r.id === excludeId) continue;
        if (r.imageSha256 === sha && !warnings.some((w) => w.code === 'same-image')) {
          warnings.push({ code: 'same-image', orderRef: cleanRef(o.ref) });
        } else if (reference && r.ocr?.reference === reference && !warnings.some((w) => w.code === 'same-reference')) {
          warnings.push({ code: 'same-reference', orderRef: cleanRef(o.ref) });
        }
      }
    }
    return warnings;
  }

  // ── Employee side ────────────────────────────────────────────────────────────────────────

  /**
   * Stores the image and reads it. The result is a «مسودة» only its uploader sees; nothing is a
   * claim on the order until `submit`. OCR runs HERE, on the server, so the suggestion the
   * manager later compares against cannot be edited by the browser.
   */
  async uploadDraft(orderId: string, file: UploadedImage | undefined, actor: ReceiptActor) {
    if (!file?.buffer?.length) throw new BadRequestException('لم يتم رفع صورة');
    if (!ACCEPTED_MIME.includes(file.mimetype)) throw new BadRequestException('الصورة يجب أن تكون JPG أو PNG أو WebP');
    if (Math.max(file.size || 0, file.buffer.length) > MAX_RECEIPT_UPLOAD_BYTES) throw new BadRequestException('حجم الصورة أكبر من 4 ميجا');

    const order = await this.loadPendingOrder(orderId);
    const cfg = await this.r2();

    let stored: Buffer;
    try {
      stored = await this.ocr.prepareForStorage(file.buffer);
    } catch {
      throw new BadRequestException('الصورة غير صالحة أو متحركة أو أبعادها كبيرة جداً، أو لا يمكن ضغطها بوضوح إلى 180 كيلوبايت. أرسل لقطة واضحة للإيصال فقط');
    }
    if (stored.length > MAX_STORED_RECEIPT_BYTES) throw new BadRequestException('حجم الصورة المحفوظة أكبر من 180 كيلوبايت');

    const id = `dr_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    const month = businessDate().slice(0, 7);
    const imageKey = receiptImageKey(order, month, id);
    const sha = crypto.createHash('sha256').update(stored).digest('hex');

    // ⚠ OCR reads the ORIGINAL upload, not the stored copy: measured on the 17 real receipts,
    //   the re-encoded JPEG lost one amount (16/17) that the original yields (17/17). Storage
    //   gets the small copy, the reader gets the sharp one.
    const [put, ocr] = await Promise.all([
      r2PutObject(cfg, imageKey, stored, 'image/jpeg'),
      this.ocr.read(file.buffer),
    ]);
    if (!put.ok) throw new BadRequestException(`تعذّر حفظ الصورة على التخزين السحابي: ${put.message}`);

    const warnings = [...receiptContentWarnings(ocr), ...await this.findDuplicates(sha, ocr.reference)];
    const now = new Date().toISOString();
    const draft: DepositReceipt = {
      id,
      status: 'مسودة',
      imageKey,
      imageSha256: sha,
      imageBytes: stored.length,
      imageDeleted: false,
      amount: 0,
      method: '',
      ocr: {
        amount: ocr.amount, method: ocr.method, pattern: ocr.pattern, reference: ocr.reference,
        dateText: ocr.dateText, confident: ocr.confident, ran: ocr.ran, ms: ocr.ms,
      },
      needsReview: true,
      warnings,
      uploadedAt: now,
      submittedBy: actor.name || actor.username,
      submittedById: actor.id,
      submittedAt: '',
    };

    // The uploader's earlier abandoned drafts on this order are replaced, not accumulated.
    const stale = receiptsIn(order, 'مسودة').filter((r) => r.submittedById === actor.id);
    const saved = await this.orderModel.findOneAndUpdate(
      { _id: order._id, status: 'pending', cancelled: { $ne: true }, receiptCancelLock: { $in: ['', null] } },
      { $push: { depositReceipts: draft } },
      { new: true },
    ).exec();
    if (!saved) {
      await this.deleteImage(imageKey);
      throw new BadRequestException('الأوردر لم يعد معلّقاً');
    }
    if (stale.length) {
      await this.orderModel.updateOne(
        { _id: order._id },
        { $pull: { depositReceipts: { id: { $in: stale.map((r) => r.id) }, status: 'مسودة' } } },
      ).exec();
      for (const r of stale) await this.deleteImage(r.imageKey);
    }

    // Serialize upload-triggered trimming so simultaneous uploads do not delete extra images.
    const trim = this.imageLimitQueue.then(() => this.runCleanup(new Date(), true));
    this.imageLimitQueue = trim.catch((err) => {
      this.logger.warn(`Receipt limit cleanup failed: ${(err as Error).message}`);
    });
    await this.imageLimitQueue;
    return { receipt: draft, cap: depositCapFor(saved) };
  }

  async submit(orderId: string, receiptId: string, body: { amount: unknown; method: unknown; acknowledgeImageWarning?: boolean }, actor: ReceiptActor) {
    const { amount, method } = this.validateEntry(body?.amount, body?.method);
    const order = await this.loadPendingOrder(orderId);
    const r = this.findReceipt(order, receiptId);
    if (r.status !== 'مسودة') throw new BadRequestException('هذا الإيصال أُرسل بالفعل');
    this.assertOwner(r, actor);

    const contentWarnings = receiptContentWarnings(r.ocr);
    if (contentWarnings.length && body.acknowledgeImageWarning !== true) {
      throw new BadRequestException('لم يتم التحقق من ملامح إيصال التحويل. أكّد تخطي التحذير لإرساله إلى المدير للمراجعة');
    }

    const cap = depositCapFor(order, receiptId);
    if (amount > cap + DEPOSIT_TOLERANCE) {
      throw new BadRequestException(`المبلغ أكبر من المتبقي المسموح على الطلب (${cap} ج)`);
    }

    const now = new Date().toISOString();
    const warnings = [...contentWarnings, ...await this.findDuplicates(r.imageSha256, r.ocr?.reference || '', receiptId)];
    const saved = await this.orderModel.findOneAndUpdate(
      { _id: order._id, status: 'pending', cancelled: { $ne: true }, receiptCancelLock: { $in: ['', null] }, $expr: receiptBudgetExpr(amount, receiptId), depositReceipts: { $elemMatch: { id: receiptId, status: 'مسودة' } } },
      {
        $set: {
          'depositReceipts.$.status': 'معلق',
          'depositReceipts.$.amount': amount,
          'depositReceipts.$.method': method,
          'depositReceipts.$.warnings': warnings,
          'depositReceipts.$.needsReview': this.needsReviewFor({ ...r, warnings }, amount, method),
          'depositReceipts.$.submittedAt': now,
          ...(contentWarnings.length ? {
            'depositReceipts.$.warningAcknowledgedAt': now,
            'depositReceipts.$.warningAcknowledgedById': actor.id,
          } : {}),
        },
      },
      { new: true },
    ).exec();
    if (!saved) throw new BadRequestException('تعذّر الإرسال — تغيّر الإيصال أو الأوردر، أعد المحاولة');

    this.emit(orderId, receiptId, 'معلق');
    return { success: true, receipt: this.findReceipt(saved, receiptId) };
  }

  async editPending(orderId: string, receiptId: string, body: { amount: unknown; method: unknown }, actor: ReceiptActor) {
    const { amount, method } = this.validateEntry(body?.amount, body?.method);
    const order = await this.loadPendingOrder(orderId);
    const r = this.findReceipt(order, receiptId);
    if (r.status !== 'معلق') throw new BadRequestException('لا يمكن تعديل إيصال تمت مراجعته');
    this.assertOwner(r, actor);

    const cap = depositCapFor(order, receiptId);
    if (amount > cap + DEPOSIT_TOLERANCE) {
      throw new BadRequestException(`المبلغ أكبر من المتبقي المسموح على الطلب (${cap} ج)`);
    }
    const saved = await this.orderModel.findOneAndUpdate(
      { _id: order._id, status: 'pending', cancelled: { $ne: true }, receiptCancelLock: { $in: ['', null] }, $expr: receiptBudgetExpr(amount, receiptId), depositReceipts: { $elemMatch: { id: receiptId, status: 'معلق' } } },
      {
        $set: {
          'depositReceipts.$.amount': amount,
          'depositReceipts.$.method': method,
          'depositReceipts.$.needsReview': this.needsReviewFor(r, amount, method),
          'depositReceipts.$.lastEditedBy': actor.name || actor.username,
          'depositReceipts.$.lastEditedAt': new Date().toISOString(),
        },
      },
      { new: true },
    ).exec();
    if (!saved) throw new BadRequestException('تعذّر التعديل — تمت مراجعة الإيصال');
    this.emit(orderId, receiptId, 'معلق');
    return { success: true, receipt: this.findReceipt(saved, receiptId) };
  }

  /** Removes a draft or a pending receipt — its owner's (or an admin's) change of mind. */
  async withdraw(orderId: string, receiptId: string, actor: ReceiptActor) {
    const order = await this.orderModel.findById(orderId).exec();
    if (!order) throw new NotFoundException('الأوردر غير موجود');
    const r = this.findReceipt(order, receiptId);
    if (r.status !== 'مسودة' && r.status !== 'معلق') throw new BadRequestException('لا يمكن سحب إيصال تمت مراجعته');
    this.assertOwner(r, actor);
    const res = await this.orderModel.updateOne(
      { _id: order._id },
      { $pull: { depositReceipts: { id: receiptId, status: { $in: ['مسودة', 'معلق'] } } } },
    ).exec();
    if (!res.modifiedCount) throw new BadRequestException('تمت مراجعة الإيصال قبل سحبه');
    await this.deleteImage(r.imageKey);
    if (r.status === 'معلق') this.emit(orderId, receiptId, 'محذوف');
    return { success: true };
  }

  // ── Manager side ─────────────────────────────────────────────────────────────────────────

  async approve(orderId: string, receiptId: string, admin: ReceiptActor) {
    if (!admin.isAdmin) throw new ForbiddenException('اعتماد العربون للمدير فقط');
    const now = new Date().toISOString();
    const claimed = await this.orderModel.findOneAndUpdate(
      {
        _id: orderId,
        status: 'pending',
        cancelled: { $ne: true },
        receiptCancelLock: { $in: ['', null] },
        depositReceipts: { $elemMatch: { id: receiptId, status: 'معلق' } },
      },
      {
        $set: {
          'depositReceipts.$.status': 'معتمد',
          'depositReceipts.$.reviewedBy': admin.name || admin.username,
          'depositReceipts.$.reviewedById': admin.id,
          'depositReceipts.$.reviewedAt': now,
        },
      },
      { new: true },
    ).exec();

    if (!claimed) {
      const current = await this.orderModel.findById(orderId).lean().exec();
      if (!current) throw new NotFoundException('الأوردر غير موجود');
      const r = (current.depositReceipts || []).find((x) => x.id === receiptId);
      if (!r) throw new NotFoundException('إيصال العربون غير موجود');
      if (r.status === 'معتمد') throw new BadRequestException('تم اعتماد هذا العربون بالفعل');
      if (current.status !== 'pending' || current.cancelled) throw new BadRequestException('الأوردر لم يعد معلّقاً');
      throw new BadRequestException('الإيصال ليس قيد المراجعة');
    }

    const r = this.findReceipt(claimed, receiptId);
    const revert = () =>
      this.orderModel.updateOne(
        { _id: claimed._id, depositReceipts: { $elemMatch: { id: receiptId, status: 'معتمد' } } },
        {
          $set: { 'depositReceipts.$.status': 'معلق' },
          $unset: {
            'depositReceipts.$.reviewedBy': '',
            'depositReceipts.$.reviewedById': '',
            'depositReceipts.$.reviewedAt': '',
          },
        },
      ).exec();

    // The order total may have moved (Shopify edit) since the receipt was submitted.
    const approvedOthers = receiptsIn(claimed, 'معتمد')
      .filter((x) => x.id !== receiptId)
      .reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const room = round2((Number(claimed.total) || 0) - approvedOthers);
    if (r.amount > room + DEPOSIT_TOLERANCE) {
      await revert();
      throw new BadRequestException(`المبلغ (${r.amount} ج) أكبر من المتبقي على الطلب (${Math.max(0, room)} ج) — عدّل الإيصال أو ارفضه`);
    }

    const ref = cleanRef(claimed.ref);
    let entry: any;
    try {
      entry = await this.vaultService.addSystemEntry(
        r.amount,
        r.method,
        `عربون مبيعات #${ref} — ${claimed.client || ''} (Shopify — إيصال تحويل)`,
        businessDate(),
        'ديبوزت مبيعات',
        ref,
        { customer: claimed.client },
        r.submittedBy,
        { receiptId, shopifyOrderId: String(claimed._id) },
      );
    } catch (err) {
      await revert();
      throw err;
    }

    await this.orderModel.updateOne(
      { _id: claimed._id, 'depositReceipts.id': receiptId },
      { $set: { 'depositReceipts.$.vaultEntryId': String(entry?._id || ''), 'depositReceipts.$.vaultTxNo': entry?.txNo || '' } },
    ).exec();

    await this.refreshDerived(String(claimed._id));
    this.emit(orderId, receiptId, 'معتمد');
    return { success: true, vaultTxNo: entry?.txNo || '' };
  }

  async reject(orderId: string, receiptId: string, admin: ReceiptActor, reason = '') {
    if (!admin.isAdmin) throw new ForbiddenException('مراجعة العربون للمدير فقط');
    const saved = await this.orderModel.findOneAndUpdate(
      { _id: orderId, depositReceipts: { $elemMatch: { id: receiptId, status: 'معلق' } } },
      {
        $set: {
          'depositReceipts.$.status': 'مرفوض',
          'depositReceipts.$.reviewedBy': admin.name || admin.username,
          'depositReceipts.$.reviewedById': admin.id,
          'depositReceipts.$.reviewedAt': new Date().toISOString(),
          'depositReceipts.$.rejectedReason': String(reason || '').slice(0, 300),
        },
      },
      { new: true },
    ).exec();
    if (!saved) throw new BadRequestException('الإيصال ليس قيد المراجعة');
    const r = this.findReceipt(saved, receiptId);
    if (await this.deleteImage(r.imageKey)) {
      await this.orderModel.updateOne(
        { _id: saved._id, 'depositReceipts.id': receiptId },
        { $set: { 'depositReceipts.$.imageDeleted': true } },
      ).exec();
    }
    this.emit(orderId, receiptId, 'مرفوض');
    return { success: true };
  }

  /**
   * Takes approved money back out of the vault, from the segment it came into. Used by a manager
   * on a pending order, and by cancellation. ⚠ Only while the order is still pending: once it is
   * a transaction, the deposit belongs to that transaction and is reversed through its own
   * cancellation (`performCancellation`).
   */
  async refundApproved(orderId: string, receiptId: string, admin: ReceiptActor, reason = '') {
    if (!admin.isAdmin) throw new ForbiddenException('رد العربون للمدير فقط');
    const res = await this.refundOne(orderId, receiptId, admin.name || admin.username, reason);
    await this.refreshDerived(orderId);
    return { success: true, ...res };
  }

  private async refundOne(orderId: string, receiptId: string, by: string, reason: string, cancelLock = '') {
    const now = new Date().toISOString();
    const claimed = await this.orderModel.findOneAndUpdate(
      { _id: orderId, status: 'pending', cancelled: { $ne: true }, receiptCancelLock: cancelLock || { $in: ['', null] }, depositReceipts: { $elemMatch: { id: receiptId, status: 'معتمد', vaultEntryId: { $nin: ['', null] } } } },
      {
        $set: {
          'depositReceipts.$.status': 'مُسترد',
          'depositReceipts.$.refundedBy': by,
          'depositReceipts.$.refundedAt': now,
          'depositReceipts.$.refundReason': String(reason || '').slice(0, 300),
        },
      },
      { new: true },
    ).exec();
    if (!claimed) throw new BadRequestException('العربون غير معتمد أو الأوردر لم يعد معلّقاً');
    const r = this.findReceipt(claimed, receiptId);
    const ref = cleanRef(claimed.ref);
    let entry: any;
    try {
      entry = await this.vaultService.addSystemEntry(
        -r.amount,
        r.method,
        `رد عربون #${ref} — ${claimed.client || ''} (Shopify)${reason ? ` — ${reason}` : ''}`,
        businessDate(),
        // The existing reversal source: the vault log, its labels and the journal already know it.
        'إلغاء',
        ref,
        { customer: claimed.client },
        by,
        { receiptId, shopifyOrderId: String(claimed._id) },
      );
    } catch (err) {
      await this.orderModel.updateOne(
        { _id: claimed._id, depositReceipts: { $elemMatch: { id: receiptId, status: 'مُسترد' } } },
        {
          $set: { 'depositReceipts.$.status': 'معتمد' },
          $unset: { 'depositReceipts.$.refundedBy': '', 'depositReceipts.$.refundedAt': '', 'depositReceipts.$.refundReason': '' },
        },
      ).exec();
      throw err;
    }
    await this.orderModel.updateOne(
      { _id: claimed._id, 'depositReceipts.id': receiptId },
      { $set: { 'depositReceipts.$.refundVaultEntryId': String(entry?._id || ''), 'depositReceipts.$.refundVaultTxNo': entry?.txNo || '' } },
    ).exec();
    this.emit(orderId, receiptId, 'مُسترد');
    return { amount: r.amount, method: r.method, vaultTxNo: entry?.txNo || '' };
  }

  /**
   * Called by both Shopify cancel paths BEFORE the order is marked cancelled.
   * Drafts / pending receipts are voided (nothing moved); approved ones are refunded.
   * ⚠ A refund that fails (segment balance too low) throws and the order is NOT cancelled —
   *   cancelling while keeping the customer's money would be the silent version of this failure.
   *   Refunds already done stay done, so a retry continues from where it stopped.
   */
  async settleOnCancel(orderId: string, by: string, reason: string) {
    const lock = crypto.randomUUID();
    const order = await this.orderModel.findOneAndUpdate(
      { _id: orderId, status: 'pending', cancelled: { $ne: true }, receiptCancelLock: { $in: ['', null] },
        $nor: [
          { depositReceipts: { $elemMatch: { status: 'معتمد', vaultEntryId: { $in: ['', null] } } } },
          { depositReceipts: { $elemMatch: { status: 'مُسترد', refundVaultEntryId: { $in: ['', null] } } } },
        ] },
      { $set: { receiptCancelLock: lock } }, { new: true },
    ).lean().exec();
    if (!order) throw new BadRequestException('تغيّر الأوردر أو تسجيل العربون لم يكتمل — حدّث البيانات وأعد المحاولة');
    const refunded: Array<{ amount: number; method: string; vaultTxNo: string }> = [];
    try {
      for (const r of receiptsIn(order as any, 'معتمد')) {
        refunded.push(await this.refundOne(orderId, r.id, by, reason || 'إلغاء الأوردر', lock));
      }
      let voided = 0;
      for (const r of receiptsIn(order as any, 'مسودة', 'معلق')) {
        const res = await this.orderModel.updateOne(
          { _id: orderId, depositReceipts: { $elemMatch: { id: r.id, status: r.status } } },
          { $set: { 'depositReceipts.$.status': 'ملغي' } },
        ).exec();
        if (res.modifiedCount) {
          voided++;
          if (await this.deleteImage(r.imageKey)) {
            await this.orderModel.updateOne(
              { _id: orderId, 'depositReceipts.id': r.id },
              { $set: { 'depositReceipts.$.imageDeleted': true } },
            ).exec();
          }
        }
      }
      await this.orderModel.updateOne(
        { _id: orderId, receiptCancelLock: lock },
        { $set: { cancelled: true, receiptCancelLock: '' } },
      ).exec();
      return { refunded, voided };
    } finally {
      await this.orderModel.updateOne({ _id: orderId, receiptCancelLock: lock }, { $set: { receiptCancelLock: '' } }).exec();
      if (refunded.length) await this.refreshDerived(orderId);
    }
  }

  /** Drafts left on an order at confirmation are abandoned uploads — removed with their images. */
  async discardDrafts(orderId: string): Promise<void> {
    try {
      const order = await this.orderModel.findById(orderId).select('depositReceipts').lean().exec();
      const drafts = receiptsIn((order || {}) as any, 'مسودة');
      if (!drafts.length) return;
      await this.orderModel.updateOne({ _id: orderId }, { $pull: { depositReceipts: { status: 'مسودة' } } }).exec();
      for (const r of drafts) await this.deleteImage(r.imageKey);
    } catch (err) {
      this.logger.warn(`discardDrafts failed for ${orderId}: ${(err as Error).message}`);
    }
  }

  async getImage(receiptId: string, actor: ReceiptActor): Promise<Buffer> {
    const order = await this.orderModel
      .findOne({ 'depositReceipts.id': receiptId }, { depositReceipts: { $elemMatch: { id: receiptId } } })
      .lean()
      .exec();
    const r = order?.depositReceipts?.[0];
    if (!r) throw new NotFoundException('إيصال العربون غير موجود');
    if (r.status === 'مسودة' && (!actor.id || r.submittedById !== actor.id)) {
      throw new ForbiddenException('مسودة الإيصال خاصة بموظفها');
    }
    if (r.imageDeleted) throw new NotFoundException('صورة الإيصال حُذفت من التخزين');
    const cfg = await this.r2();
    const res = await r2GetObjectBuffer(cfg, r.imageKey);
    if (!res.ok) throw new NotFoundException('تعذّر تحميل صورة الإيصال');
    return res.body;
  }

  // ── Storage housekeeping ─────────────────────────────────────────────────────────────────

  /**
   * 04:30 — clear of the 03:00 backup and the 07:00 order audit. Never throws.
   *   1. drafts older than 24h (abandoned uploads) → removed with their images
   *   2. rejected / voided receipts whose image is still stored → image deleted
   *   3. over `r2ReceiptsMax` → oldest approved / refunded images deleted first.
   *      ⚠ A pending receipt's image is never deleted: it is the evidence a decision is waiting on.
   *   4. objects under deposit-receipts/ that no receipt references, older than 24h → deleted
   */
  @Cron('0 30 4 * * *', { name: 'deposit-receipts-cleanup', timeZone: BUSINESS_TZ })
  async nightlyCleanup(): Promise<void> {
    try {
      const summary = await this.runCleanup();
      this.logger.log(`Deposit receipt cleanup: ${JSON.stringify(summary)}`);
    } catch (err) {
      this.logger.error(`Deposit receipt cleanup failed: ${(err as Error).message}`);
    }
  }

  async runCleanup(now = new Date(), capOnly = false) {
    const cfg = await this.settingsService.getR2Config();
    const summary = { drafts: 0, rejectedImages: 0, capped: 0, orphans: 0 };
    if (!cfg) return summary;
    const cutoff = new Date(now.getTime() - DRAFT_TTL_MS).toISOString();

    if (!capOnly) {
    // 1. Abandoned drafts.
    const withDrafts = await this.orderModel
      .find({ depositReceipts: { $elemMatch: { status: 'مسودة', uploadedAt: { $lt: cutoff } } } })
      .select('depositReceipts')
      .lean()
      .exec();
    for (const o of withDrafts as any[]) {
      const old = (o.depositReceipts as DepositReceipt[]).filter((r) => r.status === 'مسودة' && r.uploadedAt < cutoff);
      await this.orderModel.updateOne(
        { _id: o._id },
        { $pull: { depositReceipts: { id: { $in: old.map((r) => r.id) }, status: 'مسودة' } } },
      ).exec();
      for (const r of old) { await this.deleteImage(r.imageKey); summary.drafts++; }
    }

    // 2. Images of rejected / voided receipts.
    const deadImages = await this.orderModel
      .find({ depositReceipts: { $elemMatch: { status: { $in: ['مرفوض', 'ملغي'] }, imageDeleted: { $ne: true } } } })
      .select('depositReceipts')
      .lean()
      .exec();
    for (const o of deadImages as any[]) {
      for (const r of o.depositReceipts as DepositReceipt[]) {
        if ((r.status === 'مرفوض' || r.status === 'ملغي') && !r.imageDeleted && (await this.deleteImage(r.imageKey))) {
          await this.markImageDeleted(String(o._id), r.id);
          summary.rejectedImages++;
        }
      }
    }

    }

    // 3. Cap.
    const s: any = await this.settingsService.getSettings();
    const max = Math.max(1, Number(s?.r2ReceiptsMax) || 2000);
    const all = await this.orderModel
      .find({ 'depositReceipts.0': { $exists: true } })
      .select('depositReceipts')
      .lean()
      .exec();
    const stored: Array<{ orderId: string; r: DepositReceipt }> = [];
    for (const o of all as any[]) {
      for (const r of o.depositReceipts as DepositReceipt[]) {
        if (!r.imageDeleted && r.imageKey) stored.push({ orderId: String(o._id), r });
      }
    }
    let excess = stored.length - max;
    if (excess > 0) {
      const removable = stored
        .filter((x) => x.r.status === 'معتمد' || x.r.status === 'مُسترد')
        .sort((a, b) => String(a.r.uploadedAt || a.r.reviewedAt).localeCompare(String(b.r.uploadedAt || b.r.reviewedAt)));
      for (const x of removable) {
        if (excess <= 0) break;
        if (await this.deleteImage(x.r.imageKey)) {
          await this.markImageDeleted(x.orderId, x.r.id);
          summary.capped++;
          excess--;
        }
      }
    }

    if (capOnly) return summary;

    // 4. Orphans.
    const known = new Set(stored.map((x) => x.r.imageKey));
    const listed = await r2ListObjects(cfg, R2_PREFIX);
    if (listed.ok) {
      for (const obj of listed.objects) {
        if (known.has(obj.key)) continue;
        if (obj.lastModified && new Date(obj.lastModified).toISOString() > cutoff) continue;
        if (await this.deleteImage(obj.key)) summary.orphans++;
      }
    }
    return summary;
  }

  private async markImageDeleted(orderId: string, receiptId: string): Promise<void> {
    await this.orderModel.updateOne(
      { _id: orderId, 'depositReceipts.id': receiptId },
      { $set: { 'depositReceipts.$.imageDeleted': true } },
    ).exec();
    await this.txModel.updateMany(
      { 'depositReceipts.id': receiptId },
      { $set: { 'depositReceipts.$.imageDeleted': true } },
    ).exec();
  }
}
