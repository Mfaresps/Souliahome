import { notifyApproval } from '../notifications/admin-events';
import { FollowUpsService } from '../followups/followups.service';
import { DiscountOtpService } from '../discount-otp/discount-otp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Optional as PushOptional, Inject as PushInject } from '@nestjs/common';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { depositHistory, receiptSender } from './deposit-receipt-history.util';
import { DEPOSIT_NO_PENDING_REQUESTS, depositOrderConflict } from './deposit-order-conflict.util';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model, ClientSession } from 'mongoose';
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
import { ManualDepositReceipt, ManualDepositReceiptDocument } from './schemas/manual-deposit-receipt.schema';
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
  @PushOptional() @PushInject(FollowUpsService) private readonly followUpsService?: FollowUpsService;
  @PushOptional() @PushInject(NotificationsService) private readonly notifications?: NotificationsService;
  @PushOptional() @PushInject(DiscountOtpService) private readonly discountOtp?: DiscountOtpService;

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
    @InjectModel(ManualDepositReceipt.name)
    private readonly manualReceiptModel?: Model<ManualDepositReceiptDocument>,
  ) {}

  async history(query: Record<string, string>, actor: ReceiptActor) {
    if (!actor.isAdmin) throw new ForbiddenException('سجل العربون للمدير فقط');
    const [orders, transactions, manual] = await Promise.all([
      this.orderModel.find({ 'depositReceipts.0': { $exists: true } }).select('_id ref client depositReceipts').lean().exec(),
      this.txModel.find({ type: 'مبيعات', $or: [{ 'depositReceipts.0': { $exists: true } }, { 'deposits.0': { $exists: true } }] }).select('_id ref client cancelled depositReceipts deposits').lean().exec(),
      this.manualReceiptModel ? this.manualReceiptModel.find({ state: { $ne: 'draft' } }).select('_id ref client transactionId state receipt').lean().exec() : Promise.resolve([]),
    ]);
    return depositHistory(orders, transactions, manual, query);
  }

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
    const conflict = depositOrderConflict(order);
    if (conflict) throw new BadRequestException(conflict);
    if (order.status !== 'pending') throw new BadRequestException('الأوردر لم يعد معلقًا؛ راجع حالته قبل تغيير العربون');
    if (order.receiptCancelLock) throw new BadRequestException('إلغاء الأوردر قيد التنفيذ؛ لا يمكن تغيير العربون الآن');
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
    if (reference) or.push({ depositReceipts: { $elemMatch: { status: { $in: LIVE_STATUSES },
      $or: [{ transferReference: reference }, { 'ocr.reference': reference }] } } });
    const hits: any[] = await this.orderModel.find({ $or: or }).select('ref depositReceipts').lean().exec();
    if (this.manualReceiptModel) {
      const manualOr: any[] = [{ 'receipt.imageSha256': sha }];
      if (reference) manualOr.push({ 'receipt.transferReference': reference }, { 'receipt.ocr.reference': reference });
      const manual = await this.manualReceiptModel.find({ state: { $in: ['submitted', 'claiming', 'consumed'] },
        $or: manualOr }).select('ref receipt').lean().exec();
      hits.push(...manual.map(d => ({ ref: d.ref, depositReceipts: [d.receipt] })));
    }
    for (const o of hits as any[]) {
      for (const r of (o.depositReceipts || []) as DepositReceipt[]) {
        if (!LIVE_STATUSES.includes(r.status) || r.id === excludeId) continue;
        if (r.imageSha256 === sha && !warnings.some((w) => w.code === 'same-image')) {
          warnings.push({ code: 'same-image', orderRef: cleanRef(o.ref) });
        } else if (reference && (r.transferReference ?? r.ocr?.reference) === reference && !warnings.some((w) => w.code === 'same-reference')) {
          warnings.push({ code: 'same-reference', orderRef: cleanRef(o.ref) });
        }
      }
    }
    return warnings;
  }

  /** Mongo's unique _id prevents cross-order and cross-process image/transfer reuse. */
  private identities() {
    return this.orderModel.db.collection<{ _id: string; receiptId: string; createdAt: string; claimedAt?: string; phase?: 'claiming' | 'committed' }>('depositreceiptidentities');
  }

  /** Old versions reserved a fingerprint at upload. Only an unconfirmed draft may yield that lock. */
  private async releaseLegacyDraftIdentity(key: string, receiptId: string): Promise<boolean> {
    const held = await this.identities().findOne({ _id: key });
    if (!held || held.receiptId === receiptId || held.phase === 'committed') return false;
    if (held.phase === 'claiming' && Date.now() - Date.parse(held.claimedAt || held.createdAt) < 2 * 60_000) return false;
    const owner = held.receiptId;
    const order = await this.orderModel.findOne({ 'depositReceipts.id': owner }).select('depositReceipts').lean().exec();
    const orderReceipt = (order?.depositReceipts || []).find((r: DepositReceipt) => r.id === owner);
    const manual = this.manualReceiptModel && await this.manualReceiptModel.findOne({ receiptId: owner }).select('receipt').lean().exec();
    if (orderReceipt && orderReceipt.status !== 'مسودة') return false;
    if (manual?.receipt && manual.receipt.status !== 'مسودة') return false;
    const result = await this.identities().deleteOne({ _id: key, receiptId: owner,
      ...(held.phase ? { phase: held.phase, claimedAt: held.claimedAt } : { phase: { $exists: false } }) });
    return result.deletedCount > 0;
  }

  private async reserveIdentity(keys: string[], receiptId: string): Promise<void> {
    try {
      for (const key of [...new Set(keys)].sort()) {
        try {
          await this.identities().updateOne({ _id: key, receiptId },
            { $set: { phase: 'claiming', claimedAt: new Date().toISOString() }, $setOnInsert: { createdAt: new Date().toISOString() } }, { upsert: true });
        } catch (error) {
          if ((error as any)?.code !== 11000 || !await this.releaseLegacyDraftIdentity(key, receiptId)) throw error;
          await this.identities().updateOne({ _id: key, receiptId },
            { $set: { phase: 'claiming', claimedAt: new Date().toISOString() }, $setOnInsert: { createdAt: new Date().toISOString() } }, { upsert: true });
        }
      }
    } catch (error) {
      if ((error as any)?.code === 11000) throw new BadRequestException('صورة الإيصال أو رقم التحويل مستخدم بالفعل — لا يمكن تسجيل نفس العربون مرتين');
      throw error;
    }
  }

  private async releaseDraftIdentity(receiptId: string): Promise<void> {
    await this.identities().deleteMany({ receiptId, phase: { $ne: 'committed' } });
  }

  private async assertUploadNotCommitted(sha: string, rawSha: string): Promise<void> {
    const keys = [`image:${sha}`, `raw:${rawSha}`];
    const held = await this.identities().find({ _id: { $in: keys } }).toArray();
    for (const lock of held) {
      if (lock.phase === 'committed') throw new BadRequestException('هذه الصورة مستخدمة في إيصال عربون مؤكد بالفعل');
      const order = await this.orderModel.findOne({ 'depositReceipts.id': lock.receiptId }).select('depositReceipts').lean().exec();
      const receipt = (order?.depositReceipts || []).find((r: DepositReceipt) => r.id === lock.receiptId);
      const manual = this.manualReceiptModel && await this.manualReceiptModel.findOne({ receiptId: lock.receiptId }).select('receipt').lean().exec();
      if ((receipt && receipt.status !== 'مسودة') || (manual?.receipt && manual.receipt.status !== 'مسودة')) {
        throw new BadRequestException('هذه الصورة مستخدمة في إيصال عربون مؤكد بالفعل');
      }
    }
    const order = await this.orderModel.exists({ depositReceipts: { $elemMatch: {
      imageSha256: sha, status: { $ne: 'مسودة' } } } });
    const manual = this.manualReceiptModel && await this.manualReceiptModel.exists({
      'receipt.imageSha256': sha, 'receipt.status': { $ne: 'مسودة' },
    });
    if (order || manual) throw new BadRequestException('هذه الصورة مستخدمة في إيصال عربون مؤكد بالفعل');
  }

  private async reserveTransfer(r: DepositReceipt): Promise<void> {
    const duplicates = await this.findDuplicates(r.imageSha256, r.transferReference ?? r.ocr?.reference ?? '', r.id);
    if (duplicates.length) throw new BadRequestException('الإيصال أو رقم التحويل مستخدم في عربون آخر — لا يمكن اعتماده مرة ثانية');
    const reference = String(r.transferReference ?? r.ocr?.reference ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
    const keys = [`image:${r.imageSha256}`];
    if (r.rawSha256) keys.push(`raw:${r.rawSha256}`);
    if (reference) keys.push(`transfer:${crypto.createHash('sha256').update(reference).digest('hex')}`);
    try {
      // Submission already committed these unique identities. Keep the existing
      // reservation path for legacy or incomplete receipts.
      if (r.status === 'معتمد') {
        const uniqueKeys = [...new Set(keys)];
        const held = await this.identities().find({ _id: { $in: uniqueKeys }, receiptId: r.id, phase: 'committed' })
          .project({ _id: 1 }).toArray();
        if (held.length === uniqueKeys.length) return;
      }
      await this.reserveIdentity(keys, r.id);
      if (r.status !== 'مسودة') await this.commitIdentity(r.id);
    }
    catch (error) { await this.releaseClaimingIdentity(r.id); throw error; }
  }

  private async releaseClaimingIdentity(receiptId: string): Promise<void> {
    const order = await this.orderModel.findOne({ 'depositReceipts.id': receiptId }).select('depositReceipts').lean().exec();
    const receipt = (order?.depositReceipts || []).find((r: DepositReceipt) => r.id === receiptId);
    const manual = this.manualReceiptModel && await this.manualReceiptModel.findOne({ receiptId }).select('receipt').lean().exec();
    if (receipt && receipt.status !== 'مسودة') return;
    if (manual?.receipt && manual.receipt.status !== 'مسودة') return;
    await this.releaseDraftIdentity(receiptId);
  }

  private async commitIdentity(receiptId: string): Promise<void> {
    try {
      await this.identities().updateMany({ receiptId, phase: 'claiming' }, { $set: { phase: 'committed' } });
    } catch (error) {
      // The saved receipt already owns the unique fingerprint. Metadata must not make a successful confirmation look failed.
      this.logger.warn(`Receipt identity metadata update failed (${receiptId}): ${(error as Error).message}`);
    }
  }

  // ── Employee side ────────────────────────────────────────────────────────────────────────

  /** Upload and OCR happen before any amount is entered or any sale is created. */
  async scanManualReceipt(meta: { ref?: string; client?: string }, file: UploadedImage, actor: ReceiptActor) {
    if (!actor.id) throw new ForbiddenException('تعذّر تحديد الموظف');
    const stored = await this.prepareReceiptImage(file);
    const cfg = await this.r2();
    const id = `dr_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    const ref = String(meta.ref || '').slice(0, 60);
    const client = String(meta.client || '').slice(0, 120);
    const imageKey = receiptImageKey({ ref, client, _id: id }, businessDate().slice(0, 7), id);
    const ocr = await this.ocr.read(file.buffer);
    const sha = crypto.createHash('sha256').update(stored).digest('hex');
    const rawSha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    await this.assertUploadNotCommitted(sha, rawSha256);
    const warnings = [...receiptContentWarnings(ocr), ...await this.findDuplicates(sha, ocr.reference)];
    const put = await r2PutObject(cfg, imageKey, stored, 'image/jpeg', 30_000);
    if (!put.ok) throw new BadRequestException(`تعذّر حفظ الصورة على التخزين السحابي: ${put.message}`);
    const now = new Date().toISOString();
    const receipt: DepositReceipt = { id, status: 'مسودة', imageKey, imageSha256: sha, rawSha256,
      imageBytes: stored.length, imageDeleted: false, amount: 0, method: '', ocr,
      needsReview: true, warnings, uploadedAt: now, submittedAt: '',
      submittedBy: actor.name || actor.username, submittedById: actor.id };
    try {
      await this.manualReceiptModel!.create({ receiptId: id, ownerId: actor.id, ref, client, receipt,
        expiresAt: new Date(Date.now() + DRAFT_TTL_MS).toISOString() });
    } catch (error) { await this.deleteImage(imageKey); throw error; }
    void this.trimReceiptImages();
    return { receipt };
  }

  async confirmManualReceipt(id: string, body: { amount: unknown; method: unknown; total: number; confirmed: boolean; acknowledgeImageWarning?: boolean; senderName?: string; senderBank?: string; senderHandle?: string; senderPhone?: string; transferDateText?: string; transferReference?: string; screenshotTime?: string }, actor: ReceiptActor) {
    const draft = await this.manualReceiptModel!.findOne({ receiptId: id, ownerId: actor.id,
      state: { $in: ['draft', 'submitted'] }, expiresAt: { $gt: new Date().toISOString() } }).exec();
    if (!draft) throw new BadRequestException('الإيصال غير متاح — ارفع الصورة مجددًا');
    const { amount, method } = this.validateEntry(body.amount, body.method);
    if (body.confirmed !== true) throw new BadRequestException('راجع بيانات الإيصال وأكّدها أولًا');
    if (!Number.isFinite(body.total) || amount > body.total + DEPOSIT_TOLERANCE) throw new BadRequestException('الديبوزت يتجاوز إجمالي المعاملة');
    const r = draft.receipt;
    const details = receiptSender(r.status === 'مسودة' ? body :
      { ...body, transferReference: r.transferReference ?? r.ocr?.reference ?? '' }, r);
    const reviewed = { ...r, ...details };
    const contentWarnings = receiptContentWarnings(r.ocr);
    if (contentWarnings.length && body.acknowledgeImageWarning !== true && !r.warningAcknowledgedAt) throw new BadRequestException('أكّد مراجعة تحذير الصورة أولًا');
    const warnings = [...contentWarnings, ...await this.findDuplicates(r.imageSha256, reviewed.transferReference, r.id)];
    await this.reserveTransfer(reviewed);
    const now = new Date().toISOString();
    const receipt = { ...reviewed, status: 'معلق' as const, amount, method, warnings,
      needsReview: this.needsReviewFor({ ...r, warnings }, amount, method), submittedAt: r.submittedAt || now,
      ...(contentWarnings.length ? { warningAcknowledgedAt: now, warningAcknowledgedById: actor.id } : {}) };
    let saved: ManualDepositReceiptDocument | null;
    try {
      saved = await this.manualReceiptModel!.findOneAndUpdate({ _id: draft._id,
        state: { $in: ['draft', 'submitted'] } }, { $set: { receipt, state: 'submitted' } }, { new: true }).exec();
    } catch (error) { await this.releaseClaimingIdentity(id); throw error; }
    if (!saved) { await this.releaseClaimingIdentity(id); throw new BadRequestException('تغيّر الإيصال — أعد المحاولة'); }
    await this.commitIdentity(id);
    this.emit('', id, 'معلق');
    return { success: true, receipt: saved.receipt };
  }

  async withdrawManualReceipt(id: string, actor: ReceiptActor) {
    const draft = await this.manualReceiptModel!.findOneAndUpdate({ receiptId: id, ownerId: actor.id,
      state: { $in: ['draft', 'submitted'] } }, { $set: { state: 'withdrawn', 'receipt.imageDeleted': true } }, { new: true }).exec();
    if (!draft) throw new BadRequestException('الإيصال مستخدم أو غير متاح');
    if (draft.receipt.status === 'مسودة') await this.releaseDraftIdentity(id);
    await this.deleteImage(draft.receipt.imageKey);
    this.emit('', id, 'مسحوب');
    return { success: true };
  }

  async claimManualReceipt(id: string, tx: { type: string; ref?: string; client?: string; deposit?: number; depMethod?: string; total: number }, actor: ReceiptActor, session?: ClientSession): Promise<Transaction['depositReceipts'][number]> {
    if (tx.type !== 'مبيعات') throw new BadRequestException('إيصال الديبوزت متاح للمبيعات فقط');
    const { amount, method } = this.validateEntry(tx.deposit, tx.depMethod);
    if (amount > tx.total + DEPOSIT_TOLERANCE) throw new BadRequestException('الديبوزت يتجاوز إجمالي المعاملة');
    const draft = await this.manualReceiptModel!.findOneAndUpdate({ receiptId: id, ownerId: actor.id,
      state: 'submitted', expiresAt: { $gt: new Date().toISOString() }, 'receipt.amount': amount,
      'receipt.method': method }, { $set: { state: 'claiming', ref: tx.ref || '', client: tx.client || '' } }, { new: true, ...(session ? { session } : {}) }).exec();
    if (!draft) throw new BadRequestException('ارفع الإيصال وافحصه وأكّد المبلغ وطريقة الدفع قبل الحفظ');
    const r = draft.receipt;
    // Customer/reference may have been completed after upload; retain the shared final folder naming.
    const imageKey = receiptImageKey({ ...tx, _id: id }, r.imageKey.split('/')[1], id);
    // An atomic scanned sale keeps the already-uploaded key: R2 moves cannot be rolled back with MongoDB.
    if (!session && imageKey !== r.imageKey) {
      try {
        const cfg = await this.r2();
        const image = await r2GetObjectBuffer(cfg, r.imageKey);
        if (!image.ok) throw new BadRequestException('تعذّر قراءة صورة الإيصال');
        const put = await r2PutObject(cfg, imageKey, image.body, 'image/jpeg');
        if (!put.ok) throw new BadRequestException('تعذّر حفظ صورة الإيصال');
        const oldKey = r.imageKey;
        await this.manualReceiptModel!.updateOne({ _id: draft._id, state: 'claiming' }, { $set: { 'receipt.imageKey': imageKey } }).exec();
        r.imageKey = imageKey;
        await this.deleteImage(oldKey);
      } catch (error) { await this.releaseManualReceipt(id); throw error; }
    }
    return { id, amount, method, imageKey: r.imageKey, imageDeleted: false, needsReview: r.needsReview,
      submittedBy: r.submittedBy, submittedAt: r.submittedAt, reviewedBy: '', reviewedAt: '',
      vaultTxNo: '', senderName: r.senderName ?? r.ocr?.senderName ?? '', senderBank: r.senderBank ?? r.ocr?.senderBank ?? '',
      senderHandle: r.senderHandle ?? r.ocr?.senderHandle ?? '', senderPhone: r.senderPhone ?? r.ocr?.senderPhone ?? '',
      transferDateText: r.transferDateText ?? r.ocr?.dateText ?? '', transferReference: r.transferReference ?? r.ocr?.reference ?? '',
      screenshotTime: r.screenshotTime ?? r.ocr?.screenshotTime ?? '', screenshotTimeSource: r.screenshotTimeSource || r.ocr?.screenshotTimeSource || '', ocrAmount: r.ocr.amount, ocrMethod: r.ocr.method };
  }

  async releaseManualReceipt(id: string, session?: ClientSession): Promise<void> {
    await this.manualReceiptModel!.updateOne({ receiptId: id, state: 'claiming' }, { $set: { state: 'submitted' } }, ...(session ? [{ session }] as const : [] as const)).exec();
  }

  async consumeManualReceipt(id: string, transactionId: string, session?: ClientSession): Promise<void> {
    await this.manualReceiptModel!.updateOne({ receiptId: id, state: 'claiming' }, { $set: { state: 'consumed', transactionId } }, ...(session ? [{ session }] as const : [] as const)).exec();
  }

  private async prepareReceiptImage(file: UploadedImage | undefined): Promise<Buffer> {
    if (!file?.buffer?.length) throw new BadRequestException('لم يتم رفع صورة');
    if (!ACCEPTED_MIME.includes(file.mimetype)) throw new BadRequestException('الصورة يجب أن تكون JPG أو PNG أو WebP');
    if (Math.max(file.size || 0, file.buffer.length) > MAX_RECEIPT_UPLOAD_BYTES) throw new BadRequestException('حجم الصورة أكبر من 4 ميجا');
    let stored: Buffer;
    try { stored = await this.ocr.prepareForStorage(file.buffer); }
    catch { throw new BadRequestException('الصورة غير صالحة أو متحركة أو أبعادها كبيرة جداً، أو لا يمكن ضغطها بوضوح إلى 180 كيلوبايت. أرسل لقطة واضحة للإيصال فقط'); }
    if (stored.length > MAX_STORED_RECEIPT_BYTES) throw new BadRequestException('حجم الصورة المحفوظة أكبر من 180 كيلوبايت');
    return stored;
  }

  private async trimReceiptImages(staleKeys: string[] = []): Promise<void> {
    const trim = this.imageLimitQueue.then(async () => {
      for (const key of staleKeys) await this.deleteImage(key);
      return this.runCleanup(new Date(), true);
    });
    this.imageLimitQueue = trim.catch((err) => {
      this.logger.warn(`Receipt limit cleanup failed: ${(err as Error).message}`);
    });
    await this.imageLimitQueue;
  }

  /** Stores and reads the image as a private draft until submission. */
  async uploadDraft(orderId: string, file: UploadedImage | undefined, actor: ReceiptActor) {
    if (!actor.id) throw new ForbiddenException('تعذّر تحديد الموظف');
    if (!file?.buffer?.length) throw new BadRequestException('لم يتم رفع صورة');
    const order = await this.loadPendingOrder(orderId);
    const stored = await this.prepareReceiptImage(file);
    if (order.shipWithoutDeposit && !receiptsIn(order, 'معلق', 'معتمد').length) throw new BadRequestException('أوقف خيار شحن بدون عربون قبل إضافة إيصال');
    const cfg = await this.r2();

    const id = `dr_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    const month = businessDate().slice(0, 7);
    const imageKey = receiptImageKey(order, month, id);
    const sha = crypto.createHash('sha256').update(stored).digest('hex');
    const rawSha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
    await this.assertUploadNotCommitted(sha, rawSha256);

    // ⚠ OCR reads the ORIGINAL upload, not the stored copy: measured on the 17 real receipts,
    //   the re-encoded JPEG lost one amount (16/17) that the original yields (17/17). Storage
    //   gets the small copy, the reader gets the sharp one.
    const [put, ocr] = await Promise.all([
      r2PutObject(cfg, imageKey, stored, 'image/jpeg', 30_000),
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
      rawSha256,
      imageBytes: stored.length,
      imageDeleted: false,
      amount: 0,
      method: '',
      ocr: {
        amount: ocr.amount, amountConfidence: ocr.amountConfidence, method: ocr.method, pattern: ocr.pattern, reference: ocr.reference,
        senderName: ocr.senderName, senderBank: ocr.senderBank, senderHandle: ocr.senderHandle, senderPhone: ocr.senderPhone, screenshotTime: ocr.screenshotTime, screenshotTimeSource: ocr.screenshotTimeSource, dateText: ocr.dateText, confident: ocr.confident, ran: ocr.ran, ms: ocr.ms,
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
      { _id: order._id, status: 'pending', cancelled: { $ne: true }, ...DEPOSIT_NO_PENDING_REQUESTS, receiptCancelLock: { $in: ['', null] } },
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
    }

    // Serialize upload-triggered trimming so simultaneous uploads do not delete extra images.
    const removedStale: string[] = [];
    for (const r of stale) {
      if (!await this.orderModel.exists({ 'depositReceipts.id': r.id })) {
        await this.releaseDraftIdentity(r.id);
        removedStale.push(r.imageKey);
      }
    }
    void this.trimReceiptImages(removedStale);
    return { receipt: draft, cap: depositCapFor(saved) };
  }

  async submit(orderId: string, receiptId: string, body: { amount: unknown; method: unknown; acknowledgeImageWarning?: boolean; senderName?: string; senderBank?: string; senderHandle?: string; senderPhone?: string; transferDateText?: string; transferReference?: string; screenshotTime?: string }, actor: ReceiptActor) {
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
    const details = receiptSender(body, r);
    const reviewed = { ...r, ...details };
    const warnings = [...contentWarnings, ...await this.findDuplicates(r.imageSha256, details.transferReference, receiptId)];
    await this.reserveTransfer(reviewed);
    let saved: ShopifyOrderDocument | null;
    try { saved = await this.orderModel.findOneAndUpdate(
      { _id: order._id, status: 'pending', cancelled: { $ne: true }, ...DEPOSIT_NO_PENDING_REQUESTS, receiptCancelLock: { $in: ['', null] }, $expr: receiptBudgetExpr(amount, receiptId), depositReceipts: { $elemMatch: { id: receiptId, status: 'مسودة' } } },
      {
        $set: {
          'depositReceipts.$.status': 'معلق',
          'depositReceipts.$.senderName': details.senderName,
          'depositReceipts.$.senderBank': details.senderBank,
          'depositReceipts.$.senderHandle': details.senderHandle,
          'depositReceipts.$.senderPhone': details.senderPhone,
          'depositReceipts.$.transferDateText': details.transferDateText,
          'depositReceipts.$.transferReference': details.transferReference,
          'depositReceipts.$.screenshotTime': details.screenshotTime,
          'depositReceipts.$.screenshotTimeSource': details.screenshotTimeSource,
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
    ).exec(); } catch (error) { await this.releaseClaimingIdentity(receiptId); throw error; }
    if (!saved) { await this.releaseClaimingIdentity(receiptId); throw new BadRequestException('تعذّر الإرسال — تغيّر الإيصال أو الأوردر، أعد المحاولة'); }
    await this.commitIdentity(receiptId);

    await this.followUpsService?.closeConfirmationForDeposit(saved, actor.name || actor.username);

    await this.notifications?.enqueue('deposit', 'deposit:receipt:' + receiptId, saved.ref, 'shopify:' + orderId, undefined, undefined,
      { actorName: r.submittedBy || actor.name || actor.username, amount, pendingApproval: true, vaultName: method, receiptId });
    this.emit(orderId, receiptId, 'معلق');
    await notifyApproval(this.notifications, 'approval:receipt:' + receiptId + ':pending', saved.ref, 'shopify:' + orderId, { actorName: this.findReceipt(saved, receiptId).submittedBy, actionKey: 'deposit', status: 'pending', receiptId });
    return { success: true, receipt: this.findReceipt(saved, receiptId) };
  }

  /**
   * «إضافة عربون بدون صورة تحويل» — the same record as an image receipt after `submit`
   * (status «معلق», waiting for the manager's approval, which is what moves the vault), only
   * without a photo. Who may use it:
   *   - admin, or a holder of `shopify-deposit-no-image` → directly;
   *   - a holder of `shopify-deposit-no-image-otp` → with a manager OTP bound to this order,
   *     amount and vault, unless `settings.depositNoImageSkipOtp` is on.
   * ⚠ `needsReview` is always true, so auto-approve never books it — a manager looks at it.
   */
  async createWithoutImage(
    orderId: string,
    body: { amount: unknown; method: unknown; reason?: string; otpId?: string },
    actor: ReceiptActor,
    access: { role?: string; perms?: string[] },
  ) {
    if (!actor.id) throw new ForbiddenException('تعذّر تحديد الموظف');
    const perms = access.perms || [];
    const direct = actor.isAdmin || access.role === 'admin' || perms.includes('shopify-deposit-no-image');
    const viaOtp = !direct && perms.includes('shopify-deposit-no-image-otp');
    if (!direct && !viaOtp) throw new ForbiddenException('لا تملك صلاحية إضافة عربون بدون صورة');

    const { amount, method } = this.validateEntry(body?.amount, body?.method);
    const reason = String(body?.reason || '').replace(/[ -‪-‮⁦-⁩]/g, ' ').trim().slice(0, 300);
    const order = await this.loadPendingOrder(orderId);
    if (order.shipWithoutDeposit && !receiptsIn(order, 'معلق', 'معتمد').length) throw new BadRequestException('أوقف خيار شحن بدون عربون قبل إضافة عربون');
    const cap = depositCapFor(order);
    if (amount > cap + DEPOSIT_TOLERANCE) throw new BadRequestException(`المبلغ أكبر من المتبقي المسموح على الطلب (${cap} ج)`);

    const id = `dr_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    let auth: string = actor.isAdmin || access.role === 'admin' ? 'admin' : 'direct';
    let releaseOtp: (() => Promise<void>) | null = null;
    let otpId = '';
    if (viaOtp) {
      const settings: any = await this.settingsService.getSettings();
      if (settings?.depositNoImageSkipOtp === true) auth = 'otp-skipped';
      else {
        if (!this.discountOtp) throw new BadRequestException('نظام كود التحقق غير متاح الآن');
        otpId = String(body?.otpId || '');
        releaseOtp = await this.discountOtp.consumeDepositNoImageOtp(otpId, String(order._id), amount, method, id);
        auth = 'otp';
      }
    }

    const now = new Date().toISOString();
    const receipt: DepositReceipt = {
      id,
      status: 'معلق',
      noImage: true,
      noImageReason: reason,
      noImageAuth: auth,
      ...(otpId ? { noImageOtpId: otpId } : {}),
      imageKey: '',
      // Per-receipt placeholder: the duplicate checks and the unique identity lock key on this,
      // so an empty value would make every no-image receipt look like the same image.
      imageSha256: `no-image:${id}`,
      imageBytes: 0,
      imageDeleted: false,
      amount,
      method,
      ocr: { amount: null, method: '', pattern: '', reference: '', dateText: '', confident: false, ran: false, ms: 0 },
      needsReview: true,
      warnings: [],
      uploadedAt: now,
      submittedBy: actor.name || actor.username,
      submittedById: actor.id,
      submittedAt: now,
    };

    let saved: ShopifyOrderDocument | null = null;
    try {
      saved = await this.orderModel.findOneAndUpdate(
        { _id: order._id, status: 'pending', cancelled: { $ne: true }, ...DEPOSIT_NO_PENDING_REQUESTS, receiptCancelLock: { $in: ['', null] }, $expr: receiptBudgetExpr(amount, id) },
        { $push: { depositReceipts: receipt } },
        { new: true },
      ).exec();
    } catch (error) {
      if (releaseOtp) await releaseOtp().catch(() => undefined);
      throw error;
    }
    if (!saved) {
      if (releaseOtp) await releaseOtp().catch(() => undefined);
      throw new BadRequestException('تعذّر التسجيل — تغيّر الأوردر أو تجاوز المبلغ المتبقي، أعد المحاولة');
    }

    await this.followUpsService?.closeConfirmationForDeposit(saved, actor.name || actor.username);
    await this.notifications?.enqueue('deposit', 'deposit:receipt:' + id, saved.ref, 'shopify:' + orderId, undefined, undefined,
      { actorName: receipt.submittedBy, amount, pendingApproval: true, vaultName: method, receiptId: id });
    this.emit(orderId, id, 'معلق');
    await notifyApproval(this.notifications, 'approval:receipt:' + id + ':pending', saved.ref, 'shopify:' + orderId, { actorName: receipt.submittedBy, actionKey: 'deposit', status: 'pending', receiptId: id });
    return { success: true, receipt: this.findReceipt(saved, id) };
  }

  async editPending(orderId: string, receiptId: string, body: { amount: unknown; method: unknown; senderName?: string; senderBank?: string; senderHandle?: string; senderPhone?: string; transferDateText?: string; transferReference?: string; screenshotTime?: string }, actor: ReceiptActor) {
    const { amount, method } = this.validateEntry(body?.amount, body?.method);
    const order = await this.loadPendingOrder(orderId);
    const r = this.findReceipt(order, receiptId);
    if (r.status !== 'معلق') throw new BadRequestException('لا يمكن تعديل إيصال تمت مراجعته');
    this.assertOwner(r, actor);
    // The manager's OTP approved exactly this amount and vault — an edit would bypass it.
    if (r.noImage && r.noImageAuth === 'otp' && !actor.isAdmin) {
      throw new ForbiddenException('هذا العربون سُجّل بكود من المدير — اسحبه وأضفه من جديد لتغيير المبلغ أو الخزنة');
    }

    const cap = depositCapFor(order, receiptId);
    if (amount > cap + DEPOSIT_TOLERANCE) {
      throw new BadRequestException(`المبلغ أكبر من المتبقي المسموح على الطلب (${cap} ج)`);
    }
    const details = receiptSender({ ...body, transferReference: r.transferReference ?? r.ocr?.reference ?? '' }, r);
    const saved = await this.orderModel.findOneAndUpdate(
      { _id: order._id, status: 'pending', cancelled: { $ne: true }, ...DEPOSIT_NO_PENDING_REQUESTS, receiptCancelLock: { $in: ['', null] }, $expr: receiptBudgetExpr(amount, receiptId), depositReceipts: { $elemMatch: { id: receiptId, status: 'معلق' } } },
      {
        $set: {
          'depositReceipts.$.amount': amount,
          'depositReceipts.$.method': method,
          'depositReceipts.$.needsReview': this.needsReviewFor(r, amount, method),
          'depositReceipts.$.senderName': details.senderName,
          'depositReceipts.$.senderBank': details.senderBank,
          'depositReceipts.$.senderHandle': details.senderHandle,
          'depositReceipts.$.senderPhone': details.senderPhone,
          'depositReceipts.$.transferDateText': details.transferDateText,
          'depositReceipts.$.transferReference': details.transferReference,
          'depositReceipts.$.screenshotTime': details.screenshotTime,
          'depositReceipts.$.screenshotTimeSource': details.screenshotTimeSource,
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
      { _id: order._id, depositReceipts: { $elemMatch: { id: receiptId, status: r.status } } },
      r.status === 'مسودة' ? { $pull: { depositReceipts: { id: receiptId, status: 'مسودة' } } } :
        { $set: { 'depositReceipts.$.status': 'مسحوب', 'depositReceipts.$.imageDeleted': true, 'depositReceipts.$.withdrawnAt': new Date().toISOString(), 'depositReceipts.$.withdrawnBy': actor.name || actor.username } },
    ).exec();
    if (!res.modifiedCount) throw new BadRequestException('تمت مراجعة الإيصال قبل سحبه');
    if (r.status === 'مسودة') await this.releaseDraftIdentity(receiptId);
    await this.deleteImage(r.imageKey);
    if (r.status === 'معلق') this.emit(orderId, receiptId, 'محذوف');
    return { success: true };
  }

  // ── Manager side ─────────────────────────────────────────────────────────────────────────

  async approve(orderId: string, receiptId: string, admin: ReceiptActor) {
    if (!admin.isAdmin) throw new ForbiddenException('اعتماد العربون للمدير فقط');
    const now = new Date().toISOString();
    let claimed = await this.orderModel.findOneAndUpdate(
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
      if (r.status === 'معتمد' && !r.vaultEntryId) {
        // Recover a crashed booking only after its lease expires; active clicks still lose.
        claimed = await this.orderModel.findOneAndUpdate({
          _id:orderId, status:'pending', cancelled:{$ne:true}, receiptCancelLock:{$in:['',null]},
          depositReceipts:{$elemMatch:{id:receiptId,status:'معتمد',vaultEntryId:{$in:['',null]},reviewedAt:{$lte:new Date(Date.now()-30000).toISOString()}}},
        }, {$set:{'depositReceipts.$.reviewedAt':now}}, {new:true}).exec();
      }
      if (!claimed && r.status === 'معتمد') throw new BadRequestException('تم اعتماد هذا العربون بالفعل أو يجري تسجيله الآن');
      if (current.status !== 'pending' || current.cancelled) throw new BadRequestException('الأوردر لم يعد معلّقاً');
      if (!claimed) throw new BadRequestException('الإيصال ليس قيد المراجعة');
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
    if (r.amount > room + DEPOSIT_TOLERANCE && !await this.vaultService.receiptOperationApplied?.(receiptId, 'approve')) {
      if (!await this.vaultService.receiptOperationStarted?.(receiptId, 'approve')) await revert();
      throw new BadRequestException(`المبلغ (${r.amount} ج) أكبر من المتبقي على الطلب (${Math.max(0, room)} ج) — عدّل الإيصال أو ارفضه`);
    }

    const ref = cleanRef(claimed.ref);
    let entry: any;
    try {
      this.validateEntry(r.amount, r.method);
      await this.reserveTransfer(r);
      entry = await this.vaultService.addSystemEntry(
        r.amount,
        r.method,
        `عربون مبيعات #${ref} — ${claimed.client || ''} (Shopify — ${r.noImage ? 'بدون صورة تحويل' : 'إيصال تحويل'})`,
        businessDate(),
        'ديبوزت مبيعات',
        ref,
        { customer: claimed.client },
        r.submittedBy,
        { receiptId, shopifyOrderId: String(claimed._id) },
      );
    } catch (err) {
      // If the balance write succeeded but its response was lost, keep the receipt frozen.
      let applied = true;
      try { applied = await this.vaultService.receiptOperationStarted?.(receiptId, 'approve') || false; } catch { /* fail closed */ }
      if (!applied) await revert();
      throw err;
    }

    await this.orderModel.updateOne(
      { _id: claimed._id, 'depositReceipts.id': receiptId },
      { $set: { 'depositReceipts.$.vaultEntryId': String(entry?._id || ''), 'depositReceipts.$.vaultTxNo': entry?.txNo || '' } },
    ).exec();

    // These post-booking tasks touch separate records and have no financial
    // dependency on each other. Keep awaiting all of them before responding.
    await Promise.all([
      this.refreshDerived(String(claimed._id)),
      this.followUpsService?.closeConfirmationForDeposit(claimed, admin.name || admin.username),
      notifyApproval(this.notifications, 'approval:receipt:' + receiptId + ':approved', claimed.ref, 'shopify:' + orderId, { actorName: r.submittedBy, actionKey: 'deposit', status: 'approved', receiptId }, r.submittedById),
    ]);
    this.emit(orderId, receiptId, 'معتمد');
    return { success: true, vaultEntryId: String(entry?._id || ''), vaultTxNo: entry?.txNo || '' };
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
    await notifyApproval(this.notifications, 'approval:receipt:' + receiptId + ':rejected', saved.ref, 'shopify:' + orderId, { actorName: r.submittedBy, actionKey: 'deposit', status: 'rejected', receiptId }, r.submittedById);
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
      { _id: orderId, status: 'pending', cancelled: { $ne: true }, receiptCancelLock: cancelLock || { $in: ['', null] }, depositReceipts: { $elemMatch: { id: receiptId, vaultEntryId: { $nin: ['', null] }, $or:[
        {status:'معتمد'}, {status:'مُسترد',refundVaultEntryId:{$in:['',null]},refundedAt:{$lte:new Date(Date.now()-30000).toISOString()}},
      ] } } },
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
      let applied = true;
      try { applied = await this.vaultService.receiptOperationStarted?.(receiptId, 'refund') || false; } catch { /* fail closed */ }
      if (!applied) await this.orderModel.updateOne(
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
    const tx = order ? null : await this.txModel
      .findOne({ 'depositReceipts.id': receiptId }, { depositReceipts: { $elemMatch: { id: receiptId } } })
      .lean().exec();
    const manual = !order && !tx && this.manualReceiptModel ? await this.manualReceiptModel
      .findOne({ receiptId, state: { $in: ['draft', 'submitted'] }, expiresAt: { $gt: new Date().toISOString() } })
      .lean().exec() : null;
    if (manual && manual.ownerId !== actor.id && !(actor.isAdmin && manual.state === 'submitted')) throw new ForbiddenException('الإيصال خاص بالموظف الذي رفعه');
    const r = order?.depositReceipts?.[0] || tx?.depositReceipts?.[0] || manual?.receipt;
    if (!r) throw new NotFoundException('إيصال العربون غير موجود');
    if ('status' in r && r.status === 'مسودة' && (!actor.id || r.submittedById !== actor.id)) {
      throw new ForbiddenException('مسودة الإيصال خاصة بموظفها');
    }
    if ((r as any).noImage) throw new NotFoundException('هذا العربون مسجّل بدون صورة تحويل');
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
    if (this.manualReceiptModel) {
      const expired = await this.manualReceiptModel.find({ state: { $in: ['draft', 'submitted', 'withdrawn'] },
        expiresAt: { $lt: now.toISOString() }, $or: [{ 'receipt.imageDeleted': { $ne: true } }, { 'receipt.submittedAt': { $in: ['', null] } }] }).lean().exec();
      for (const d of expired) {
        const filter = { _id: d._id, state: d.state, expiresAt: { $lt: now.toISOString() } };
        const result = d.receipt.submittedAt
          ? await this.manualReceiptModel.updateOne(filter, { $set: { state: 'withdrawn', 'receipt.imageDeleted': true } }).exec()
          : await this.manualReceiptModel.deleteOne(filter).exec();
        if (!('modifiedCount' in result ? result.modifiedCount : result.deletedCount)) continue;
        if (d.receipt.status === 'مسودة') await this.releaseDraftIdentity(d.receiptId);
        await this.deleteImage(d.receipt.imageKey);
        if (d.receipt.submittedAt) this.emit('', d.receiptId, 'مسحوب');
        summary.drafts++;
      }
    }
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
      for (const r of old) {
        if (await this.orderModel.exists({ 'depositReceipts.id': r.id })) continue;
        await this.releaseDraftIdentity(r.id);
        await this.deleteImage(r.imageKey);
        summary.drafts++;
      }
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
    // Manual sales have no Shopify order. Count their images once and protect them from orphan cleanup.
    const transactions = await this.txModel.find({ 'depositReceipts.0': { $exists: true } })
      .select('depositReceipts').lean().exec();
    const seen = new Set(stored.map(x => x.r.id));
    for (const tx of transactions as any[]) {
      for (const r of tx.depositReceipts || []) {
        if (r.imageDeleted || !r.imageKey || seen.has(r.id)) continue;
        seen.add(r.id);
        stored.push({ orderId: '', r: { ...r, status: 'معتمد', uploadedAt: r.submittedAt } });
      }
    }
    if (this.manualReceiptModel) {
      const manual = await this.manualReceiptModel.find({ state: { $in: ['draft', 'submitted', 'claiming'] } })
        .select('receipt').lean().exec();
      for (const d of manual) {
        if (!d.receipt.imageDeleted && d.receipt.imageKey && !seen.has(d.receipt.id)) {
          seen.add(d.receipt.id);
          // Unconsumed manual uploads are evidence awaiting confirmation, never cap candidates.
          stored.push({ orderId: '', r: { ...d.receipt, status: 'معلق' } });
        }
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
    if (orderId) await this.orderModel.updateOne(
      { _id: orderId, 'depositReceipts.id': receiptId },
      { $set: { 'depositReceipts.$.imageDeleted': true } },
    ).exec();
    await this.txModel.updateMany(
      { 'depositReceipts.id': receiptId },
      { $set: { 'depositReceipts.$.imageDeleted': true } },
    ).exec();
  }
}
