import {
  Injectable,
  Inject,
  forwardRef,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import {
  Transaction,
  TransactionDocument,
} from './schemas/transaction.schema';
import {
  ReturnRequest,
  ReturnRequestDocument,
} from '../returns/schemas/return-request.schema';
import {
  SupplierReturnOrder,
  SupplierReturnOrderDocument,
} from '../supplier-returns/schemas/supplier-return.schema';
import {
  CreateTransactionDto,
  UpdateTransactionDto,
  CancelTransactionDto,
  CollectTransactionDto,
} from './dto/transaction.dto';
import { ProductsService } from '../products/products.service';
import { VaultService } from '../vault/vault.service';
import { PresenceGateway } from '../auth/presence.gateway';
import { MentionsService } from '../mentions/mentions.service';
import { DiscountOtpService } from '../discount-otp/discount-otp.service';
import { SettingsService } from '../settings/settings.service';
import { ShopifyAdminService } from '../shopify/shopify-admin.service';
import { SupplierLedgerService } from '../supplier-ledger/supplier-ledger.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import {
  InventoryMovementsService,
  RecordMovementEntry,
} from '../inventory-movements/inventory-movements.service';
import { InventoryMovementType } from '../inventory-movements/schemas/inventory-movement.schema';

export interface InventoryItem {
  _id: string;
  code: string;
  name: string;
  imageUrl: string;
  sellPrice: number;
  buyPrice: number;
  minStock: number;
  openingBalance: number;
  purchases: number;
  returnsToStock: number;
  returnRefs: string;
  returnDates: string;
  sales: number;
  current: number;
  status: 'ok' | 'low' | 'zero';
  isActive: boolean;
}

export interface DashboardData {
  totalProducts: number;
  lowStockCount: number;
  totalSales: number;
  /** Net of settled supplier returns. `grossPurchases - supplierReturnsTotal`. */
  totalPurchases: number;
  grossPurchases: number;
  supplierReturnsTotal: number;
  /** Customer receivables + supplier payables (the latter from the ledger, not tx.remaining). */
  totalRemaining: number;
  customerReceivables: number;
  supplierPayables: number;
  totalExpenses: number;
  grossProfit: number;
  netProfit: number;
  totalShipping: number;
  totalShipLoss: number;
  returnCount: number;
  totalReturns: number;
  totalDiscounts: number;
  totalDeposit: number;
  lowStockItems: InventoryItem[];
  recentTransactions: TransactionDocument[];
  topSellers: { name: string; qty: number }[];
  lowSellers: { name: string; qty: number }[];
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(ReturnRequest.name)
    private readonly returnRequestModel: Model<ReturnRequestDocument>,
    @InjectModel(SupplierReturnOrder.name)
    private readonly supplierReturnModel: Model<SupplierReturnOrderDocument>,
    private readonly productsService: ProductsService,
    private readonly vaultService: VaultService,
    private readonly presence: PresenceGateway,
    private readonly mentionsService: MentionsService,
    private readonly discountOtpService: DiscountOtpService,
    private readonly settingsService: SettingsService,
    private readonly shopifyAdmin: ShopifyAdminService,
    private readonly supplierLedgerService: SupplierLedgerService,
    private readonly suppliersService: SuppliersService,
    @Inject(forwardRef(() => InventoryMovementsService))
    private readonly inventoryMovementsService: InventoryMovementsService,
  ) {}

  // ── Concurrent edit lock: txId → { user, since } ──
  private readonly _editLocks = new Map<string, { user: string; since: number }>();
  private readonly _LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes auto-expire

  tryAcquireEditLock(txId: string, user: string, userId?: string): { ok: boolean; lockedBy?: string } {
    const existing = this._editLocks.get(txId);
    if (existing && Date.now() - existing.since < this._LOCK_TTL_MS && existing.user !== user) {
      return { ok: false, lockedBy: existing.user };
    }
    this._editLocks.set(txId, { user, since: Date.now() });
    const initials = user.trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('');
    this.emit('tx:editing', { txId, user, initials, userId });
    return { ok: true };
  }

  acquireEditLock(txId: string, user: string, userId?: string): void {
    this._editLocks.set(txId, { user, since: Date.now() });
    const initials = user.trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('');
    this.emit('tx:editing', { txId, user, initials, userId });
  }

  releaseEditLock(txId: string): void {
    this._editLocks.delete(txId);
    this.emit('tx:editing-done', { txId });
  }

  getEditLockStatus(txId: string): { locked: boolean; user?: string } {
    const existing = this._editLocks.get(txId);
    if (!existing || Date.now() - existing.since >= this._LOCK_TTL_MS) {
      if (existing) this._editLocks.delete(txId);
      return { locked: false };
    }
    return { locked: true, user: existing.user };
  }

  // ── Duplicate submission guard: fingerprint → timestamp ──
  private readonly _recentSubmissions = new Map<string, number>();
  private readonly _SUBMIT_DEDUP_MS = 15000; // 15 seconds

  private assertNotDuplicateSubmission(type: string, ref: string, clientName: string, total: number, user: string): void {
    const key = `${user}|${type}|${ref}|${clientName}|${total}`;
    const lastAt = this._recentSubmissions.get(key);
    if (lastAt && Date.now() - lastAt < this._SUBMIT_DEDUP_MS) {
      throw new BadRequestException(
        'تم رصد إرسال مكرر — تم تسجيل نفس المعاملة للتو. انتظر لحظة قبل إعادة المحاولة'
      );
    }
    this._recentSubmissions.set(key, Date.now());
    // Prune old entries to prevent unbounded growth
    if (this._recentSubmissions.size > 500) {
      const cutoff = Date.now() - this._SUBMIT_DEDUP_MS * 2;
      this._recentSubmissions.forEach((ts, k) => { if (ts < cutoff) this._recentSubmissions.delete(k); });
    }
  }

  private emit(event: string, payload: unknown): void {
    try { this.presence?.emitEvent(event, payload); } catch { /* swallow */ }
  }

  /**
   * Notes written when a pending return/exchange request is approved (ReturnsService).
   * If a row was wrongly stored as مشتريات, inventory and purchase totals still treat it as إرجاع للمخزن.
   */
  private isApprovedReturnInboundNotes(notes: string | undefined): boolean {
    const n = String(notes || '');
    return (
      n.includes('مرتجع معتمد (طلب كان معلقاً)') ||
      n.startsWith('استبدال — مرتجع:')
    );
  }

  private isCustomerReturnToStockType(type: string): boolean {
    return type === 'مرتجع مبيعات' || type === 'مرتجع';
  }

  /** Inbound qty for المخزن from عميل — not شراء من مورد. */
  private transactionAddsReturnToStock(tx: TransactionDocument): boolean {
    if (this.isCustomerReturnToStockType(tx.type)) {
      return true;
    }
    const ref = String(tx.ref || '').trim();
    if (
      tx.type === 'مشتريات' &&
      (/-RET$/i.test(ref) || this.isApprovedReturnInboundNotes(tx.notes))
    ) {
      return true;
    }
    return false;
  }

  /**
   * Quantity a returned line contributes to sellable stock.
   *
   * A unit returned as تالف is refunded to the customer but never becomes sellable again, so it
   * contributes 0. Before this, `تلف الشحنة` returns went straight back into available stock — the
   * warehouse showed damaged goods as on-hand and the loss was never recognised anywhere.
   *
   * Both derived-inventory loops (`getAvailableQtyByProductCode` and `getInventory`) must go
   * through this. They are the only two places stock is computed, and if they disagree the
   * oversell guard and the inventory screen show different numbers for the same product.
   */
  private returnedItemQtyForStock(item: { qty?: number; condition?: string }): number {
    if (String(item.condition || '').trim() === 'تالف') {
      return 0;
    }
    return Number(item.qty) || 0;
  }

  /**
   * Profit given up by approved customer returns — subtracted from gross profit.
   *
   * A سليم unit costs us the margin only: we refund the price but the goods come back, so the cost
   * is recovered as inventory. A تالف unit costs us the **whole price** — it is refunded and never
   * re-enters stock (`returnedItemQtyForStock` returns 0 for it), so the cost is lost too. Valuing
   * both at the margin would understate the loss on damaged goods by exactly their cost.
   *
   * Shared by getDashboard() and getReports(), which carried byte-identical copies of this loop.
   */
  private computeReturnedProfitLoss(
    approvedReturns: ReturnRequestDocument[],
    products: { code: string; buyPrice: number }[],
  ): number {
    let lost = 0;
    for (const ret of approvedReturns) {
      for (const item of (ret.items || []) as {
        code?: string;
        price?: number;
        qty?: number;
        condition?: string;
      }[]) {
        const product = products.find((p) => p.code === item.code);
        const cost = product ? Number(product.buyPrice) || 0 : 0;
        const price = Number(item.price) || 0;
        const qty = Number(item.qty) || 0;
        const damaged = String(item.condition || '').trim() === 'تالف';
        lost += (damaged ? price : price - cost) * qty;
      }
    }
    return lost;
  }

  /** A customer return created by approving a ReturnRequest — not a supplier return. */
  private isCustomerReturnTransaction(tx: TransactionDocument): boolean {
    if (this.isCustomerReturnToStockType(tx.type)) {
      return true;
    }
    return (
      tx.type === 'مشتريات' && /-RET(-\d+)?$/i.test(String(tx.ref || '').trim())
    );
  }

  /**
   * Flags the ReturnRequest behind a cancelled return transaction as reversed.
   *
   * Matches on the stored link first, then on the ref, because `returnTxId` is written in a second
   * save after the transaction is created and may be absent on rows written before that field
   * existed. Never throws: a cancellation whose money has already moved must not fail because the
   * back-reference could not be updated.
   */
  private async markReturnRequestReversed(
    tx: TransactionDocument,
    reason: string,
    cancelledBy: string,
  ): Promise<void> {
    const ref = String(tx.ref || '').trim();
    const or: Record<string, unknown>[] = [{ returnTxId: String(tx._id) }];
    if (ref) {
      or.push({ returnTxRef: ref });
    }
    try {
      const updated = await this.returnRequestModel
        .findOneAndUpdate(
          { status: 'معتمد', reversedAt: null, $or: or },
          {
            $set: {
              reversedAt: new Date().toISOString(),
              reversedBy: cancelledBy,
              reversalReason: reason || 'إلغاء معاملة المرتجع',
            },
          },
        )
        .exec();
      if (!updated) {
        this.logger.warn(
          `[performCancellation] RETURN_REQUEST_NOT_LINKED tx=${ref || String(tx._id)} — لم يُعثر على طلب استرجاع معتمد مرتبط؛ راجع التقارير يدوياً`,
        );
      }
    } catch (e) {
      this.logger.error(
        `[performCancellation] RETURN_REVERSAL_FLAG_FAILED tx=${ref || String(tx._id)}: ${(e as Error).message}`,
      );
    }
  }

  /** True only for supplier purchases (رقم مرجعي أرقام فقط في الواجهة؛ لا يشمل إرجاع العميل). */
  private transactionAddsSupplierPurchases(tx: TransactionDocument): boolean {
    if (tx.type !== 'مشتريات') {
      return false;
    }
    const ref = String(tx.ref || '').trim();
    if (/-RET$/i.test(ref) || this.isApprovedReturnInboundNotes(tx.notes)) {
      return false;
    }
    return true;
  }

  /**
   * Total value of settled supplier returns in a date window — the amount to subtract from gross
   * purchases so the KPI reports what was actually bought and kept.
   *
   * Read from SupplierReturnOrder, NOT from the 'مرتجع مشتريات' transactions, deliberately: that
   * transaction is created with `total: refundAmount` (see SupplierReturnsService.complete) — only
   * the CASH-refund slice. A return settled as debt-offset or supplier credit produces a
   * transaction with total 0, so netting from the transaction stream would subtract nothing for
   * exactly the returns that matter most. `r.total` on the order is the full economic value.
   *
   * Only 'مكتمل' returns count, and reversed ones are excluded — a reversal undoes the inventory,
   * vault and ledger effects, so its value must not stay deducted. NOTE: a reversed return KEEPS
   * status 'مكتمل' (the `reversal` field is what marks it), so the status check alone is not enough.
   */
  private async getSettledSupplierReturns(
    from?: string,
    to?: string,
  ): Promise<SupplierReturnOrderDocument[]> {
    const query: Record<string, unknown> = {
      status: 'مكتمل',
      $or: [{ reversal: null }, { reversal: { $exists: false } }],
    };
    if (from || to) {
      query.returnDate = {
        ...(from ? { $gte: from } : {}),
        ...(to ? { $lte: to } : {}),
      };
    }
    return this.supplierReturnModel.find(query).exec();
  }

  /** Convenience sum over the above — the figure subtracted from gross purchases. */
  private async getSettledSupplierReturnsTotal(
    from?: string,
    to?: string,
  ): Promise<number> {
    const rows = await this.getSettledSupplierReturns(from, to);
    return rows.reduce((sum, r) => sum + (Number(r.total) || 0), 0);
  }

  /**
   * What we currently owe all suppliers, per the supplier ledger — the authoritative payable.
   * Suppliers in credit (negative balance) contribute 0 rather than offsetting someone else's
   * debt: a prepayment with supplier A is not a reduction of what we owe supplier B.
   * Falls back to 0 if the ledger is unreachable, so a dashboard never fails to render.
   */
  private async getTotalSupplierDebt(): Promise<number> {
    try {
      const balances = await this.supplierLedgerService.getAllBalances();
      return Object.values(balances).reduce(
        (sum, b) => sum + Math.max(0, Number(b.debt) || 0),
        0,
      );
    } catch {
      return 0;
    }
  }

  /**
   * Classifies a transaction's inventory-movement type + sign for the Inventory Movement Log.
   * `sign` is the direction stock moves when this transaction is CREATED (+1 = stock in, -1 = stock out);
   * callers reversing an effect (cancellation) flip the sign themselves.
   * Returns null for transaction types that never affect stock.
   */
  private classifyInventoryMovement(
    tx: TransactionDocument,
  ): { type: InventoryMovementType; sign: 1 | -1 } | null {
    if (this.transactionAddsSupplierPurchases(tx)) return { type: 'مشتريات', sign: 1 };
    if (this.transactionAddsReturnToStock(tx)) return { type: 'مرتجع مبيعات', sign: 1 };
    if (tx.type === 'مبيعات') return { type: 'مبيعات', sign: -1 };
    if (tx.type === 'مرتجع مشتريات') return { type: 'مرتجع مشتريات', sign: -1 };
    return null;
  }

  /** Resolves a supplierId for ledger posting — prefers an explicit id, falls back to name matching. Never throws. */
  private async resolveSupplierIdForLedger(
    explicitSupplierId: string | undefined,
    clientName: string,
  ): Promise<string> {
    if (explicitSupplierId) return explicitSupplierId;
    if (!clientName) return '';
    try {
      const suppliers = await this.suppliersService.findAll();
      const match = suppliers.find(
        (s) => s.name.trim().toLowerCase() === clientName.trim().toLowerCase(),
      );
      return match ? String(match._id) : '';
    } catch {
      return '';
    }
  }

  /**
   * Posts a correcting supplier-ledger entry when a purchase invoice's PAYABLE changes outside the
   * payment flow — i.e. on edit and on cancellation.
   *
   * Why this exists: `create()` posts a purchase-debt entry of (total - deposit) and `collect()`
   * posts payments, but `update()` and `cancel()` historically posted NOTHING. So editing an
   * invoice's total, or cancelling it outright, left the original debt standing in the ledger
   * forever while the invoice itself said something different. Every such divergence had to be
   * found by reconciling against a supplier statement and patched by hand — which is exactly the
   * incident that motivated this method.
   *
   * `delta` is the change in what we owe: negative reduces the payable (a discount, a
   * cancellation), positive increases it (an invoice corrected upward). Zero is a no-op.
   *
   * Posted as a 'manual-adjustment' with `sourceType:'transaction'` and the transaction's id, so
   * the entry is traceable back to the invoice that caused it and reads clearly in the ledger.
   * Never throws — the vault and the invoice are already committed by the time this runs, and a
   * ledger failure must not roll those back. It is logged as CRITICAL for manual correction.
   */
  private async adjustSupplierLedgerForPayableChange(
    tx: TransactionDocument,
    delta: number,
    by: string,
    reason: string,
  ): Promise<void> {
    if (tx.type !== 'مشتريات') return;
    const amount = Number(delta) || 0;
    if (!amount) return;
    // Stock-return transactions (ref ending -RET) are inventory bookkeeping, not supplier trade —
    // they never post a purchase-debt entry, so they must not post a correction either.
    if (!this.transactionAddsSupplierPurchases(tx)) return;
    const txRef = tx.ref || String(tx._id);
    try {
      const supplierId = await this.resolveSupplierIdForLedger(
        tx.supplierId,
        tx.client || '',
      );
      if (!supplierId) {
        this.logger.warn(
          `adjustSupplierLedgerForPayableChange: no supplierId resolvable for #${txRef} — ledger left untouched (delta ${amount})`,
        );
        return;
      }
      await this.supplierLedgerService.postManualAdjustment({
        supplierId,
        supplierName: tx.client || '',
        date: new Date().toISOString().split('T')[0],
        amount,
        reason,
        employee: by,
      });
    } catch (err) {
      this.logger.error(
        `CRITICAL: purchase #${txRef} changed by ${amount} ج but the supplier-ledger correction failed — the supplier balance is now out of sync and needs a manual adjustment.`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /**
   * Closes the unpaid remainder of a purchase invoice the supplier has waived — a credit memo.
   *
   * The invoice's `total` and `items` are deliberately LEFT UNTOUCHED: it is a document exchanged
   * with the supplier, and rewriting its value makes our copy disagree with theirs while burying
   * the reason inside a changed number. Instead `remaining` goes to 0, the status becomes مكتمل,
   * and a matching 'invoice-write-off' entry cancels the payable in the ledger. Both sides move
   * together, so the invoice list and the supplier balance can never disagree afterwards.
   *
   * Unlike the fire-and-forget ledger corrections elsewhere in this service, the ledger entry is
   * posted FIRST and its failure aborts the whole operation: closing the invoice without cancelling
   * the debt would leave the supplier balance overstated with no invoice left to explain it — the
   * precise failure this feature exists to prevent.
   */
  async writeOffRemaining(
    id: string,
    reason: string,
    by: string,
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (tx.type !== 'مشتريات') {
      throw new BadRequestException('إقفال المتبقي متاح لفواتير المشتريات فقط');
    }
    if (tx.cancelled) {
      throw new BadRequestException('لا يمكن إقفال متبقي معاملة ملغاة');
    }
    if (!reason || !reason.trim()) {
      throw new BadRequestException('يجب إدخال سبب إقفال المتبقي');
    }
    const remaining = Number(tx.remaining) || 0;
    if (remaining <= 0) {
      throw new BadRequestException('لا يوجد متبقٍ على هذه الفاتورة');
    }
    if (!this.transactionAddsSupplierPurchases(tx)) {
      throw new BadRequestException('هذه المعاملة ليست فاتورة مشتريات من مورد');
    }

    const supplierId = await this.resolveSupplierIdForLedger(
      tx.supplierId,
      tx.client || '',
    );
    if (!supplierId) {
      throw new BadRequestException(
        'تعذّر تحديد المورد لهذه الفاتورة — لا يمكن إقفال المتبقي دون تسجيله في سجل المديونية',
      );
    }

    // Ledger first: if this throws, the invoice is untouched and nothing is inconsistent.
    await this.supplierLedgerService.postInvoiceWriteOff({
      supplierId,
      supplierName: tx.client || '',
      transactionId: String(tx._id),
      transactionRef: tx.ref || String(tx._id),
      date: new Date().toISOString().split('T')[0],
      amount: remaining,
      reason: reason.trim(),
      employee: by,
    });

    tx.remaining = 0;
    tx.payStatus = 'مكتمل';
    (tx as unknown as { writeOff?: unknown }).writeOff = {
      amount: remaining,
      reason: reason.trim(),
      by,
      at: new Date().toISOString(),
    };
    const saved = await tx.save();
    this.emit('tx:updated', { tx: saved, action: 'write-off-remaining' });
    return saved;
  }

  /**
   * Reverses the supplier-ledger 'payment' entry that `collect()` posted for a purchase payment.
   *
   * Every path that undoes a purchase payment MUST call this. The vault side was always reversed,
   * but the ledger side was not — so an undone payment stayed deducted from the supplier balance
   * forever, understating what we owe. That is exactly how the Talla Home balance drifted: three
   * payments were undone in the vault, their ledger entries survived, and the balance had to be
   * patched by hand with two manual adjustments.
   *
   * Matched on (sourceType:'transaction', sourceId, entryType:'payment', reversed:false) and always
   * takes the NEWEST such entry, mirroring the LIFO order in which payments are undone. Never
   * throws: a reversal that fails must not roll back an already-committed vault reversal, so the
   * failure is logged loudly for manual correction instead.
   */
  private async reverseSupplierPaymentLedgerEntry(
    tx: TransactionDocument,
    by: string,
    reason: string,
  ): Promise<void> {
    if (tx.type !== 'مشتريات') return;
    const txRef = tx.ref || String(tx._id);
    try {
      const supplierId = await this.resolveSupplierIdForLedger(
        tx.supplierId,
        tx.client || '',
      );
      if (!supplierId) {
        this.logger.warn(
          `reverseSupplierPaymentLedgerEntry: no supplierId resolvable for #${txRef} — ledger left untouched`,
        );
        return;
      }
      const entries = await this.supplierLedgerService.findBySupplier(supplierId);
      const target = entries
        .filter(
          (e) =>
            e.sourceType === 'transaction' &&
            String(e.sourceId) === String(tx._id) &&
            e.entryType === 'payment' &&
            !e.reversed,
        )
        .pop();
      if (!target) {
        this.logger.warn(
          `reverseSupplierPaymentLedgerEntry: no open payment entry for #${txRef} — nothing to reverse`,
        );
        return;
      }
      await this.supplierLedgerService.reverseEntry(String(target._id), by, reason);
    } catch (err) {
      this.logger.error(
        `CRITICAL: vault reversal for purchase #${txRef} succeeded but the supplier-ledger reversal failed — the supplier balance is now understated and needs a manual adjustment.`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  /** Non-cancelled مشتريات transactions for a supplier that contain the given product code, oldest-first. Used by supplier-return allocation (FIFO/average). */
  async findPurchasesBySupplierForCode(
    supplierId: string,
    supplierName: string,
    code: string,
  ): Promise<TransactionDocument[]> {
    const orConds: Record<string, unknown>[] = [];
    if (supplierId) orConds.push({ supplierId });
    if (supplierName) orConds.push({ client: supplierName });
    if (!orConds.length) return [];
    return this.transactionModel
      .find({
        type: 'مشتريات',
        cancelled: { $ne: true },
        $or: orConds,
        'items.code': code,
      })
      .sort({ date: 1 })
      .exec();
  }

  /** All (any type, including cancelled — caller filters) transactions matching a supplier by id or name. Used by the supplier-ledger backfill. */
  async findAllBySupplierName(
    supplierName: string,
  ): Promise<TransactionDocument[]> {
    if (!supplierName) return [];
    return this.transactionModel
      .find({ client: supplierName })
      .sort({ date: 1 })
      .exec();
  }

  async findAll(page?: number, limit?: number): Promise<TransactionDocument[]> {
    const query = this.transactionModel
      .find({ archived: { $ne: true } })
      .sort({ createdAt: -1 });
    if (limit && limit > 0) {
      const skip = ((page || 1) - 1) * limit;
      query.skip(skip).limit(limit);
    }
    return query.exec();
  }

  async findArchived(): Promise<TransactionDocument[]> {
    return this.transactionModel
      .find({ archived: true })
      .sort({ archivedAt: -1 })
      .exec();
  }

  async hardDelete(id: string, deletedBy: string): Promise<void> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) {
      throw new NotFoundException('المعاملة غير موجودة');
    }
    if (!tx.archived) {
      throw new BadRequestException('يمكن حذف المعاملات المجمدة فقط');
    }
    await this.transactionModel.findByIdAndDelete(id).exec();
    this.emit('tx:deleted', { id, deletedBy, type: tx.type, date: tx.date });
  }

  async findById(id: string): Promise<TransactionDocument> {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('معرّف المعاملة غير صالح');
    }
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) {
      throw new NotFoundException('المعاملة غير موجودة');
    }
    return tx;
  }

  async findByRef(ref: string, type?: string): Promise<TransactionDocument> {
    const query: Record<string, unknown> = { ref: Number(ref) || ref };
    if (type) query.type = type;
    const tx = await this.transactionModel.findOne(query).exec();
    if (!tx) throw new NotFoundException('الفاتورة غير موجودة');
    return tx;
  }

  async create(dto: CreateTransactionDto, callerRole?: string): Promise<TransactionDocument> {
    const employee = (dto as unknown as { employee?: string }).employee || '';
    // High-value discount OTP enforcement (admin is exempt; skip entirely when otpEnabled=false)
    const discountAmt = Number((dto as unknown as { discount?: number }).discount) || 0;
    if (discountAmt > 0 && callerRole !== 'admin') {
      const settings = await this.settingsService.getSettings();
      const otpEnabled = settings.otpEnabled !== false; // default true
      if (otpEnabled) {
        const limit = Number(settings.highValueDiscountLimit ?? 200);
        if (discountAmt > limit) {
          const otpId = (dto as unknown as { highValueDiscountOtpId?: string }).highValueDiscountOtpId || '';
          await this.discountOtpService.assertOtpForTransaction(otpId, discountAmt);
        }
      }
    }
    this.assertNotDuplicateSubmission(
      dto.type,
      String(dto.ref ?? ''),
      String((dto as unknown as { client?: string }).client ?? ''),
      Number((dto as unknown as { total?: number }).total) || 0,
      employee,
    );
    await this.assertRetailRefForPersist(dto.type, dto.ref, undefined);
    await this.assertOutboundWithinAvailableStock(dto.type, dto.items);
    // Purchase OTP enforcement (staff only, when purchaseOtpEnabled=true)
    if (dto.type === 'مشتريات' && callerRole !== 'admin') {
      const purchaseSettings = await this.settingsService.getSettings();
      if (purchaseSettings.purchaseOtpEnabled) {
        await this.discountOtpService.assertPurchaseOtp(dto.purchaseOtpId || '');
      }
    }
    // For purchases: check vault balance covers the deposit/upfront payment
    if (dto.type === 'مشتريات') {
      const depositPaid = (dto as unknown as { deposit?: number }).deposit || 0;
      if (depositPaid > 0) {
        const method = (dto as unknown as { depMethod?: string }).depMethod || 'كاش';
        await this.vaultService.assertSufficientBalance(method, depositPaid);
      }
      // Applying standing supplier credit: verify it's actually available right before acting —
      // matches this codebase's existing check-then-act posture for stock/vault checks above,
      // no locking infra introduced.
      const creditApplied = Number((dto as unknown as { creditApplied?: number }).creditApplied) || 0;
      if (creditApplied > 0) {
        const supplierId = await this.resolveSupplierIdForLedger(
          dto.supplierId,
          (dto as unknown as { client?: string }).client || '',
        );
        if (!supplierId) {
          throw new BadRequestException('لا يمكن تطبيق رصيد آجل بدون تحديد المورد');
        }
        const { credit } = await this.supplierLedgerService.getBalanceSummary(supplierId);
        if (creditApplied > credit) {
          throw new BadRequestException(
            `الرصيد الآجل المتاح (${credit} ج) أقل من المبلغ المطلوب تطبيقه (${creditApplied} ج)`,
          );
        }
      }
    }
    // Pre-creation stock snapshot for the Inventory Movement Log — taken BEFORE the transaction
    // exists so this transaction's own items don't pollute their own "before" balance.
    const _invSnapshotBefore = await this.getInventory();

    const tx = await this.transactionModel.create(dto);

    // Link discount OTP to created transaction (audit trail)
    const otpIdForLink = (dto as unknown as { highValueDiscountOtpId?: string }).highValueDiscountOtpId || '';
    if (otpIdForLink && discountAmt > 0) {
      try {
        await this.discountOtpService.attachToTransaction(otpIdForLink, String(tx._id), tx.ref || '');
      } catch {
        // non-fatal
      }
    }
    // Link purchase OTP to created transaction (audit trail)
    if (dto.purchaseOtpId && dto.type === 'مشتريات') {
      try {
        await this.discountOtpService.attachToTransaction(dto.purchaseOtpId, String(tx._id), tx.ref || '');
      } catch {
        // non-fatal
      }
    }

    // Record initial deposit if paid
    const deposit = (dto as unknown as { deposit?: number }).deposit || 0;
    const depMethod = (dto as unknown as { depMethod?: string }).depMethod || 'كاش';

    if (deposit > 0) {
      if (!tx.deposits) tx.deposits = [];
      tx.deposits.push({
        id: this.genPaymentId(),
        amount: deposit,
        method: depMethod,
        note: 'ديبوزت أول - عند إنشاء المعاملة',
        date: new Date().toISOString(),
        by: employee,
      });
      await tx.save();
    }

    await this.recordVaultForTransaction(tx);

    if (tx.type === 'مشتريات' && this.transactionAddsSupplierPurchases(tx)) {
      const supplierId = await this.resolveSupplierIdForLedger(
        tx.supplierId,
        tx.client || '',
      );
      const creditApplied = Number((dto as unknown as { creditApplied?: number }).creditApplied) || 0;
      if (supplierId) {
        await this.supplierLedgerService.postPurchaseDebt({
          supplierId,
          supplierName: tx.client || '',
          transactionId: String(tx._id),
          transactionRef: tx.ref || String(tx._id),
          date: this.formatTxDateForVault(tx),
          total: Number(tx.total) || 0,
          // Both cash paid now AND credit applied reduce the NEW debt this purchase posts —
          // credit itself is separately consumed via postCreditUsed below.
          upfrontDeposit: (Number(tx.deposit) || 0) + creditApplied,
          employee,
        });
        if (creditApplied > 0) {
          await this.supplierLedgerService.postCreditUsed({
            supplierId,
            supplierName: tx.client || '',
            transactionId: String(tx._id),
            transactionRef: tx.ref || String(tx._id),
            date: this.formatTxDateForVault(tx),
            amount: creditApplied,
            employee,
          });
        }
      }
    }
    try {
      const movementInfo = this.classifyInventoryMovement(tx);
      if (movementInfo) {
        const byCodeBefore = new Map(_invSnapshotBefore.map((r) => [String(r.code).trim(), r]));
        const movementEntries: RecordMovementEntry[] = [];
        for (const item of tx.items || []) {
          const code = String(item.code || '').trim();
          const invRow = byCodeBefore.get(code);
          if (!invRow) continue;
          const qtyBefore = invRow.current;
          const qtyDelta = movementInfo.sign * (Number(item.qty) || 0);
          movementEntries.push({
            productId: invRow._id,
            productCode: code,
            productName: item.name || invRow.name,
            type: movementInfo.type,
            qtyDelta,
            qtyBefore,
            qtyAfter: qtyBefore + qtyDelta,
            sourceTransactionId: String(tx._id),
            sourceTransactionRef: tx.ref || String(tx._id),
            sourceType: 'transaction-create',
            by: employee || 'مستخدم',
          });
        }
        await this.inventoryMovementsService.record(movementEntries);
      }
    } catch (err) {
      this.logger.error(
        `[create] inventory movement logging failed for tx ${tx._id}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
    this.emit('tx:created', { tx, by: employee });
    this.emit('inventory:changed', {
      reason: 'tx:created',
      txId: String(tx._id),
      txType: tx.type,
      items: (tx.items || []).map((it) => ({ name: it.name, qty: it.qty })),
    });
    // vault:changed is already emitted by vaultService.addSystemEntry with full payload (amount, seg, balances)
    return tx;
  }

  /**
   * For مبيعات / مشتريات: ref must be digits-only when set; unique among non-cancelled txs.
   */
  private async assertRetailRefForPersist(
    type: string,
    refRaw: string | undefined,
    excludeId?: string,
  ): Promise<void> {
    if (type !== 'مبيعات' && type !== 'مشتريات') {
      return;
    }
    const ref = String(refRaw ?? '').trim();
    if (!ref) {
      if (type === 'مبيعات') {
        throw new BadRequestException('الرقم المرجعي مطلوب');
      }
      if (type === 'مشتريات') {
        throw new BadRequestException('رقم الفاتورة مطلوب للمشتريات');
      }
      return;
    }
    if (!/^\d+$/.test(ref)) {
      throw new BadRequestException('الرقم المرجعي يقبل أرقاماً فقط');
    }
    const conflictQuery: Record<string, unknown> = {
      ref,
      cancelled: { $ne: true },
    };
    if (excludeId) {
      conflictQuery._id = { $ne: excludeId };
    }
    const exists = await this.transactionModel.findOne(conflictQuery).exec();
    if (exists) {
      throw new BadRequestException(
        'هذا الرقم المرجعي مسجّل مسبقاً في معاملة أخرى',
      );
    }
  }

  private doesTransactionTypeConsumeStock(type: string): boolean {
    return type === 'مبيعات' || type === 'مرتجع مشتريات';
  }

  private aggregateOutboundQtyByCode(
    items: { code: string; qty: number }[],
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const it of items || []) {
      const codeNorm = String(it.code || '').trim();
      const qty = Number(it.qty) || 0;
      if (!codeNorm || qty <= 0) {
        continue;
      }
      map.set(codeNorm, (map.get(codeNorm) || 0) + qty);
    }
    return map;
  }

  private async getAvailableQtyByProductCode(
    excludeTransactionId?: string,
  ): Promise<Map<string, number>> {
    const products = await this.productsService.findAll();
    const transactions = await this.transactionModel
      .find({ cancelled: { $ne: true }, archived: { $ne: true } })
      .exec();
    const txs = excludeTransactionId
      ? transactions.filter((t) => String(t._id) !== excludeTransactionId)
      : transactions;
    const result = new Map<string, number>();
    for (const product of products) {
      const productCodeNorm = String(product.code || '').trim();
      if (!productCodeNorm) {
        continue;
      }
      let purchases = 0;
      let sales = 0;
      let returnsToStock = 0;
      txs.forEach((tx) => {
        (tx.items || []).forEach((item) => {
          if (String(item.code || '').trim() !== productCodeNorm) {
            return;
          }
          if (this.transactionAddsSupplierPurchases(tx)) {
            purchases += Number(item.qty) || 0;
          } else if (this.transactionAddsReturnToStock(tx)) {
            returnsToStock += this.returnedItemQtyForStock(item);
          } else if (tx.type === 'مبيعات' || tx.type === 'مرتجع مشتريات') {
            sales += Number(item.qty) || 0;
          }
        });
      });
      const openingBal = Math.max(
        0,
        Math.floor(Number(product.openingBalance) || 0),
      );
      result.set(
        productCodeNorm,
        openingBal + purchases + returnsToStock - sales,
      );
    }
    return result;
  }

  private async assertOutboundWithinAvailableStock(
    type: string,
    items: { code: string; qty: number }[],
    excludeTransactionId?: string,
  ): Promise<void> {
    if (!this.doesTransactionTypeConsumeStock(type)) {
      return;
    }
    const needed = this.aggregateOutboundQtyByCode(items);
    if (needed.size === 0) {
      throw new BadRequestException(
        'لا توجد كميات صالحة في الأصناف لهذه المعاملة',
      );
    }
    const available = await this.getAvailableQtyByProductCode(
      excludeTransactionId,
    );
    const shortages: string[] = [];
    needed.forEach((qty, code) => {
      const have = available.get(code);
      if (have === undefined) {
        shortages.push(`${code} (غير مسجل كصنف)`);
        return;
      }
      if (qty > have) {
        shortages.push(`${code}: المطلوب ${qty} — المتاح في المخزن ${have}`);
      }
    });
    if (shortages.length > 0) {
      throw new BadRequestException(
        'لا يُسمح ببيع أو خصم كمية أكبر من المخزون — ' +
          shortages.join('؛ '),
      );
    }
  }

  /**
   * Blocks edit/cancel/delete for exchange replacement sales that still owe the company.
   */
  private assertNotExchangePendingCollect(tx: TransactionDocument): void {
    const ref = String(tx.ref || '');
    const remaining = tx.remaining || 0;
    const isLocked =
      tx.type === 'مبيعات' &&
      /-EXC$/i.test(ref) &&
      tx.payStatus === 'معلق' &&
      remaining > 0 &&
      !tx.cancelled;
    if (isLocked) {
      throw new BadRequestException(
        'معاملة استبدال عليها متبقي لصالح الشركة — لا يُسمح بالتعديل أو الإلغاء أو الحذف قبل تحصيل المبلغ من العميل',
      );
    }
  }

  /**
   * The edit lock is a FULFILLMENT rule, not a payment one.
   *
   * `payStatus === 'مكتمل'` only says the money settled. For a prepaid/Instapay
   * order that is true from the first minute, while the goods may sit in the
   * warehouse for days — so gating edits on it locked precisely the orders most
   * likely to still need a correction. It also contradicted this service, whose
   * update() already handles a completed sale by posting `totalDelta` to the vault.
   *
   * Mirrors `txFulfillmentStage()` / `txEditGate()` in the frontend —
   * ⚠ keep the two in sync; the client gate is UX, this one is the authority.
   *
   * 'Picked-Up' means handed to OUR pickup courier — the goods are gone, so it is
   * terminal. Bosta's PICKED_UP is the opposite (they collected it from us and it
   * is now moving), hence it lands in the non-terminal branch. Don't merge them.
   */
  private assertEditableByFulfillment(
    tx: TransactionDocument,
    callerRole = '',
  ): void {
    if (tx.type !== 'مبيعات') return;
    const bosta = String(tx.bostaStatus || '')
      .trim()
      .toUpperCase();
    const pickup = String(tx.pickupStatus || '').trim();

    // سُلّمت للعميل أو خرجت مع مندوب البيك أب → الأوردر منتهٍ. حتى المدير لا يعدّل؛
    // التصحيح الوحيد المقبول محاسبياً هو مرتجع.
    if (
      bosta === 'DELIVERED' ||
      pickup === 'Delivered' ||
      pickup === 'Picked-Up'
    ) {
      throw new BadRequestException(
        'الأوردر تم تسليمه — لا يمكن تعديله. لأي تصحيح استخدم مرتجعاً',
      );
    }

    const inTransit =
      ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY'].includes(bosta) ||
      pickup === 'Shipped' ||
      tx.deliverySource === 'MANUAL';
    if (inTransit && callerRole !== 'admin') {
      throw new BadRequestException(
        'الأوردر في الطريق مع المندوب — التعديل متاح للمدير فقط',
      );
    }
  }

  async update(
    id: string,
    dto: UpdateTransactionDto,
    editedBy = '',
    approvedBy = '',
    callerRole = '',
  ): Promise<TransactionDocument> {
    const existing = await this.transactionModel.findById(id).exec();
    if (!existing) {
      throw new NotFoundException('المعاملة غير موجودة');
    }
    this.assertNotExchangePendingCollect(existing);
    this.assertEditableByFulfillment(existing, callerRole);
    if (dto.ref !== undefined) {
      await this.assertRetailRefForPersist(
        existing.type,
        dto.ref,
        String(existing._id),
      );
    }
    if (dto.items !== undefined) {
      await this.assertOutboundWithinAvailableStock(
        existing.type,
        dto.items,
        String(existing._id),
      );
    }

    const oldDeposit = existing.deposit || 0;
    const oldTotal = existing.total || 0;
    // Captured BEFORE any mutation — the supplier-ledger correction below is computed against it.
    const previousRemaining = existing.remaining || 0;
    const oldDiscount = existing.discount || 0;
    const oldShipCost = existing.shipCost || 0;
    const oldTransactionDate = (existing as unknown as { transactionDate?: string }).transactionDate || '';

    // 📊 حساب الفروقات
    const newTotal = dto.total !== undefined ? (Number(dto.total) || 0) : oldTotal;
    const newDeposit = dto.deposit !== undefined ? (Number(dto.deposit) || 0) : oldDeposit;
    const newDiscount = dto.discount !== undefined ? (Number(dto.discount) || 0) : oldDiscount;
    const newShipCost = dto.shipCost !== undefined ? (Number(dto.shipCost) || 0) : oldShipCost;
    const newTransactionDate = (dto as unknown as { transactionDate?: string }).transactionDate ?? oldTransactionDate;

    const totalDelta = newTotal - oldTotal;
    const depositDelta = newDeposit - oldDeposit;
    const discountDelta = newDiscount - oldDiscount;
    const shipCostDelta = newShipCost - oldShipCost;

    // 📝 بناء رسالة التعديل
    const changes = [];
    if (totalDelta !== 0) changes.push(`الإجمالي: ${oldTotal} ← ${newTotal}`);
    if (depositDelta !== 0) changes.push(`الديبوزت: ${oldDeposit} ← ${newDeposit}`);
    if (discountDelta !== 0) changes.push(`الخصم: ${oldDiscount} ← ${newDiscount}`);
    if (shipCostDelta !== 0) changes.push(`الشحن: ${oldShipCost} ← ${newShipCost}`);
    if (newTransactionDate && newTransactionDate !== oldTransactionDate)
      changes.push(`تاريخ المعاملة: ${oldTransactionDate || '—'} ← ${newTransactionDate}`);

    const historyEntry = {
      editedAt: new Date().toISOString(),
      editedBy,
      approvedBy,
      action: 'تعديل شامل',
      before: {
        client: existing.client,
        phone: existing.phone,
        ref: existing.ref,
        deposit: existing.deposit,
        remaining: existing.remaining,
        notes: existing.notes,
        items: existing.items,
        total: existing.total,
        itemsTotal: existing.itemsTotal,
        discount: existing.discount,
        shipCost: existing.shipCost,
        shipCo: existing.shipCo,
        shipZone: existing.shipZone,
        payment: existing.payment,
        payStatus: existing.payStatus,
        transactionDate: oldTransactionDate,
      },
      after: {
        total: newTotal,
        deposit: newDeposit,
        discount: newDiscount,
        shipCost: newShipCost,
        items: dto.items || existing.items,
        transactionDate: newTransactionDate,
      },
      changes,
      totalDelta,
      depositDelta,
      discountDelta,
      shipCostDelta,
    };

    const editHistory = [...(existing.editHistory || []), historyEntry];
    const tx = await this.transactionModel
      .findByIdAndUpdate(id, { ...dto, editHistory }, { new: true })
      .exec();

    // 📋 Record additional deposit if deposit increased during edit
    if (depositDelta > 0 && tx) {
      const depMethod = String(existing.depMethod || '').trim() || 'كاش';
      if (!tx.deposits) tx.deposits = [];
      tx.deposits.push({
        id: this.genPaymentId(),
        amount: depositDelta,
        method: depMethod,
        note: `ديبوزت إضافي - من تعديل المعاملة (${oldDeposit} → ${newDeposit})`,
        date: new Date().toISOString(),
        by: editedBy || 'مجهول',
      });
    }

    // 💰 Vault adjustment: synchronize vault with monetary changes on save
    if (!existing.cancelled && tx) {
      const txDate = this.formatTxDateForVault(existing);
      const txRef = existing.ref || String(existing._id);
      const depMethod = String(existing.depMethod || existing.payment || '').trim();
      const isCompleted = existing.payStatus === 'مكتمل';

      if (existing.type === 'مبيعات') {
        // حركة مكتملة: العميل دفع الإجمالي كاملاً → تغيير الإجمالي يؤثر على الخزنة
        if (isCompleted && totalDelta !== 0 && depMethod) {
          const direction = totalDelta > 0 ? 'زيادة إجمالي مبيعات' : 'تخفيض إجمالي مبيعات';
          const vaultNote = `${direction} فاتورة #${txRef} — ${existing.client || ''} | قبل: ${oldTotal} ج — بعد: ${newTotal} ج | ${changes.join(' | ')} | بواسطة: ${editedBy}`;
          await this.vaultService.addSystemEntry(
            totalDelta,
            depMethod,
            vaultNote,
            txDate,
            'تعديل مبيعات',
            txRef,
          );
        } else if (!isCompleted && depositDelta !== 0 && depMethod) {
          // حركة معلقة: فقط الديبوزت دخل الخزنة
          const direction = depositDelta > 0 ? 'إضافة ديبوزت' : 'خصم ديبوزت';
          const vaultNote = `${direction} فاتورة #${txRef} — ${existing.client || ''} | قبل: ${oldDeposit} ج — بعد: ${newDeposit} ج | ${changes.join(' | ')} | بواسطة: ${editedBy}`;
          await this.vaultService.addSystemEntry(
            depositDelta,
            depMethod,
            vaultNote,
            txDate,
            'تعديل مبيعات',
            txRef,
          );
        }
      } else if (
        existing.type === 'مشتريات' &&
        this.transactionAddsSupplierPurchases(existing)
      ) {
        // حركة مكتملة: دُفع للمورد كاملاً → تغيير الإجمالي يؤثر على الخزنة
        if (isCompleted && totalDelta !== 0 && depMethod) {
          const direction = totalDelta > 0 ? 'زيادة إجمالي مشتريات' : 'تخفيض إجمالي مشتريات';
          const vaultNote = `${direction} #${txRef} — ${existing.client || ''} | قبل: ${oldTotal} ج — بعد: ${newTotal} ج | ${changes.join(' | ')} | بواسطة: ${editedBy}`;
          await this.vaultService.addSystemEntry(
            -totalDelta, // مشتريات: زيادة الإجمالي = خصم إضافي من الخزنة
            depMethod,
            vaultNote,
            txDate,
            'تعديل مشتريات',
            txRef,
          );
        } else if (!isCompleted && depositDelta !== 0 && depMethod) {
          // حركة معلقة: فقط العربون خرج من الخزنة
          const direction = depositDelta > 0 ? 'زيادة عربون مشتريات' : 'تخفيض عربون مشتريات';
          const vaultNote = `${direction} #${txRef} — ${existing.client || ''} | قبل: ${oldDeposit} ج — بعد: ${newDeposit} ج | ${changes.join(' | ')} | بواسطة: ${editedBy}`;
          await this.vaultService.addSystemEntry(
            -depositDelta,
            depMethod,
            vaultNote,
            txDate,
            'تعديل مشتريات',
            txRef,
          );
        }

        // إعادة حساب المتبقي وحالة الدفع
        const newRemaining = Math.max(0, newTotal - newDeposit);
        if (tx) {
          tx.remaining = newRemaining;
          tx.payStatus = newRemaining <= 0 ? 'مكتمل' : 'معلق';
          await tx.save();
        }

        // The payable moved, so the ledger must move with it. Measured on `remaining` (what we
        // still owe), NOT on `total`: a total change absorbed entirely by the deposit — the money
        // already left the vault — changes nothing about the outstanding debt. Without this, a
        // discount like #012's (20,880 → 19,488) silently left 1,392 of phantom debt in the ledger.
        const remainingDelta = newRemaining - previousRemaining;
        if (remainingDelta !== 0) {
          await this.adjustSupplierLedgerForPayableChange(
            tx || existing,
            remainingDelta,
            editedBy,
            `تعديل فاتورة مشتريات #${txRef} — ${changes.join(' | ') || `الإجمالي: ${oldTotal} ← ${newTotal}`}`,
          );
        }
      }
    }

    if (dto.items !== undefined && tx) {
      try {
        const movementInfo = this.classifyInventoryMovement(existing);
        if (movementInfo) {
          const beforeByCode = new Map<string, number>();
          (existing.items || []).forEach((it) => {
            const code = String(it.code || '').trim();
            beforeByCode.set(code, (beforeByCode.get(code) || 0) + (Number(it.qty) || 0));
          });
          const afterByCode = new Map<string, number>();
          (dto.items || []).forEach((it) => {
            const code = String(it.code || '').trim();
            afterByCode.set(code, (afterByCode.get(code) || 0) + (Number(it.qty) || 0));
          });
          const allCodes = new Set([...beforeByCode.keys(), ...afterByCode.keys()]);
          const invSnapshot = await this.getInventory();
          const invByCode = new Map(invSnapshot.map((r) => [String(r.code).trim(), r]));
          const movementEntries: RecordMovementEntry[] = [];
          for (const code of allCodes) {
            const beforeQty = beforeByCode.get(code) || 0;
            const afterQty = afterByCode.get(code) || 0;
            const lineDelta = afterQty - beforeQty;
            if (lineDelta === 0) continue;
            const invRow = invByCode.get(code);
            if (!invRow) continue;
            const qtyDelta = movementInfo.sign * lineDelta;
            const currentStock = invRow.current; // post-update stock — getInventory() ran after findByIdAndUpdate
            movementEntries.push({
              productId: invRow._id,
              productCode: code,
              productName: invRow.name,
              /**
               * ⚠ 'تسوية مخزون' — NOT `movementInfo.type`.
               *
               * `movementInfo.type` names the transaction ('مبيعات'), and on create() that is
               * right: the row IS the sale. Here the row is a CORRECTION to a sale already
               * logged, and half of these corrections move stock the opposite way — removing a
               * line puts goods BACK. Stamping those 'مبيعات' produced rows reading
               * «بيع +1» on invoice #33223: a sale that increased stock, which cannot happen.
               *
               * That also broke the log's own filter — filtering by «مبيعات» returned rows that
               * were not sales, and no filter could isolate edit corrections at all, even
               * though 'تسوية مخزون' existed in the enum for exactly this.
               *
               * `qtyDelta` was always correct; only the label contradicted it. Don't "fix" a
               * future +/- oddity here by flipping the sign — check the type first.
               */
              type: 'تسوية مخزون',
              qtyDelta,
              qtyBefore: currentStock - qtyDelta,
              qtyAfter: currentStock,
              sourceTransactionId: String(tx._id),
              sourceTransactionRef: tx.ref || String(tx._id),
              sourceType: 'transaction-update',
              by: editedBy || 'مستخدم',
              // ⚠ الأرقام هنا مُعزولة بـ <bdi> عند العرض، لا مُبدَّلة في المصدر. النص المخزَّن
              // يبقى «القديم ← الجديد» منطقياً؛ بدون العزل تُرتَّب الأرقام اللاتينية LTR داخل
              // الفقرة العربية فيظهر «0 ← 1» لبند نزل من 1 إلى 0. نفس قاعدة حوار الإقفال:
              // تُصلَح بالعزل عند العرض، ولا تُصلَح أبداً بقلب البيانات المخزَّنة.
              notes: `تعديل بنود المعاملة: ${beforeQty} ← ${afterQty}`,
            });
          }
          await this.inventoryMovementsService.record(movementEntries);
        }
      } catch (err) {
        this.logger.error(
          `[update] inventory movement logging failed for tx ${id}: ${(err as Error).message}`,
          (err as Error).stack,
        );
      }
    }

    return tx!;
  }

  async cancel(
    id: string,
    dto: CancelTransactionDto,
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) {
      throw new NotFoundException('المعاملة غير موجودة');
    }
    if (tx.cancelled) {
      throw new BadRequestException('المعاملة ملغية بالفعل');
    }
    this.assertNotExchangePendingCollect(tx);
    return this.performCancellation(tx, dto.cancelReason, dto.cancelledBy);
  }

  private async performCancellation(
    tx: TransactionDocument,
    reason: string,
    cancelledBy: string,
  ): Promise<TransactionDocument> {
    const previousDeposit = tx.deposit || 0;
    const previousTotal = tx.total || 0;
    const previousRemaining = tx.remaining || 0;
    const previousPayStatus = tx.payStatus;
    const previousCollectMethod = tx.collectMethod;

    tx.cancelled = true;
    tx.cancelReason = reason;
    tx.cancelledBy = cancelledBy;
    tx.cancelledAt = new Date().toISOString();

    // عند الإلغاء: إرجاع حالة الحركة إلى ما كانت عليه أصلاً
    // لا نضع "ملغي" مباشرة، بل نرجع الحالة الأصلية
    // (معلق للحركات المعلقة، مكتملة للحركات المكتملة، إلخ)
    // الحركة الملغاة تُعتبر نهائية
    tx.payStatus = 'ملغي';

    // استرجاع الرصيد المحجوز إلى القيمة الأصلية عند الإلغاء الكامل
    tx.remaining = previousTotal;

    const saved = await tx.save();

    // ── COD reversal: if COD was already collected, reverse the vault entry ──
    // This covers both admin-direct cancel and approve-cancel flows.
    const codCollectionStatus = (tx as any).codCollectionStatus || '';
    if (
      tx.type === 'مبيعات' &&
      codCollectionStatus === 'Collected' &&
      !(tx as any).codReversalVaultEntryId // not already reversed
    ) {
      const codAmount =
        ((tx as any).bostaOriginalCod && (tx as any).bostaOriginalCod > 0)
          ? (tx as any).bostaOriginalCod
          : ((tx as any).codCollectedAmount || 0);
      const codMethod = (tx as any).codCollectionMethod || 'كاش';
      const bostaRef  = (tx as any).bostaTrackingNumber || (tx as any).bostaOrderId || '';
      if (codAmount > 0) {
        try {
          const reversalEntry = await this.vaultService.addSystemEntry(
            -codAmount,
            codMethod,
            `عكس تحصيل COD — إلغاء طلب #${tx.ref || String(tx._id)}${bostaRef ? ` | Bosta: ${bostaRef}` : ''} — ${reason}`,
            new Date().toISOString().split('T')[0],
            'إلغاء',
            tx.ref || String(tx._id),
            { customer: tx.client || '' },
            cancelledBy,
            { linkedTransactionId: String(tx._id), bostaRef, reversalOf: (tx as any).codVaultEntryId },
          );
          await this.transactionModel.findByIdAndUpdate(tx._id, {
            $set: {
              codCollectionStatus: 'ReversedCollection',
              codReversalVaultEntryId: String(reversalEntry._id),
              codReversedAt: new Date().toISOString(),
              codReversedBy: cancelledBy,
            },
            $push: {
              codCollectionHistory: {
                action: 'reversed',
                by: cancelledBy,
                at: new Date().toISOString(),
                amount: -codAmount,
                method: codMethod,
                note: `إلغاء المعاملة — ${reason}`,
                vaultEntryId: String(reversalEntry._id),
                bostaRef,
              },
            },
          });
        } catch (err: any) {
          // Log but don't block cancellation — reversal failure should be flagged manually
          this.logger.error(
            `[performCancellation] COD_REVERSAL_FAILED tx=${tx.ref || tx._id} codAmount=${codAmount}: ${err.message}`,
          );
        }
      }
    }

    // A cancelled customer-return transaction has already had its stock and vault effects undone
    // (stock is derived from non-cancelled transactions; the vault reversal happens below). What was
    // NOT undone was the ReturnRequest behind it: it stayed 'معتمد', so both report queries kept
    // subtracting its value from net sales forever. Marked reversed here so those queries skip it —
    // the same guard the supplier-return side has carried all along.
    if (this.isCustomerReturnTransaction(tx)) {
      await this.markReturnRequestReversed(tx, reason, cancelledBy);
    }

    const vaultMethod = tx.depMethod || tx.payment || 'كاش';
    if (tx.type === 'مشتريات') {
      // Calculate total actually paid = total - remaining at time of cancel
      const totalPaidToSupplier = previousTotal - previousRemaining;
      // Refund deposit portion (paid at creation) to deposit vault account
      if (previousDeposit > 0) {
        await this.vaultService.addSystemEntry(
          previousDeposit,
          vaultMethod,
          `إلغاء مشتريات — رد العربون #${tx.ref || tx._id} — ${tx.client || ''} (بواسطة: ${cancelledBy})`,
          new Date().toISOString().split('T')[0],
          'إلغاء',
          tx.ref || String(tx._id),
        );
      }
      // Refund any additional payments made via collect (partial or full)
      const additionalPaid = totalPaidToSupplier - previousDeposit;
      if (additionalPaid > 0 && previousCollectMethod) {
        await this.vaultService.addSystemEntry(
          additionalPaid,
          previousCollectMethod,
          `إلغاء مشتريات — رد المسدد #${tx.ref || tx._id} — ${tx.client || ''} (بواسطة: ${cancelledBy})`,
          new Date().toISOString().split('T')[0],
          'إلغاء',
          tx.ref || String(tx._id),
        );
      }
      // A cancelled invoice is not owed. The vault refunds above undo the CASH side; this undoes
      // the DEBT side, which was previously left standing in the ledger forever — a cancelled
      // 28,460 ج invoice kept inflating the supplier balance with no invoice to explain it.
      // Netted on what was still outstanding (previousRemaining), since anything already paid is
      // handled by the refunds above and was never part of the payable.
      if (previousRemaining > 0) {
        await this.adjustSupplierLedgerForPayableChange(
          tx,
          -previousRemaining,
          cancelledBy,
          `إلغاء فاتورة مشتريات #${tx.ref || tx._id}${reason ? ` — ${reason}` : ''}`,
        );
      }
    } else if (tx.type === 'مرتجع مشتريات') {
      // Reverses the positive vault entry recordVaultForTransaction posted at completion time
      // (cash received back from the supplier) — this transaction always has deposit:0 (set by
      // SupplierReturnsService.complete()), so it would otherwise fall through both branches above
      // and silently leave the refunded cash unreclaimed.
      if (previousTotal > 0) {
        await this.vaultService.addSystemEntry(
          -previousTotal,
          vaultMethod,
          `عكس مرتجع مشتريات — استرجاع الرد النقدي #${tx.ref || tx._id} — ${tx.client || ''} (بواسطة: ${cancelledBy})`,
          new Date().toISOString().split('T')[0],
          'إلغاء',
          tx.ref || String(tx._id),
        );
      }
    } else if (previousDeposit > 0) {
      // مبيعات / مرتجع: refund deposit to client — deduct from vault
      await this.vaultService.addSystemEntry(
        -previousDeposit,
        vaultMethod,
        `إلغاء معاملة #${tx.ref || tx._id} — ${tx.client || ''} (بواسطة: ${cancelledBy})`,
        new Date().toISOString().split('T')[0],
        'إلغاء',
        tx.ref || String(tx._id),
      );
    }
    try {
      const movementInfo = this.classifyInventoryMovement(saved);
      if (movementInfo) {
        const invSnapshot = await this.getInventory();
        const invByCode = new Map(invSnapshot.map((r) => [String(r.code).trim(), r]));
        const movementEntries: RecordMovementEntry[] = [];
        for (const item of saved.items || []) {
          const code = String(item.code || '').trim();
          const invRow = invByCode.get(code);
          if (!invRow) continue;
          const qtyDelta = -movementInfo.sign * (Number(item.qty) || 0); // reverse of the original effect
          const currentStock = invRow.current; // post-cancellation stock — getInventory() reflects cancelled:true already
          movementEntries.push({
            productId: invRow._id,
            productCode: code,
            productName: item.name || invRow.name,
            type: movementInfo.type,
            qtyDelta,
            qtyBefore: currentStock - qtyDelta,
            qtyAfter: currentStock,
            sourceTransactionId: String(saved._id),
            sourceTransactionRef: saved.ref || String(saved._id),
            sourceType: 'transaction-cancel',
            by: cancelledBy || 'مستخدم',
            reason,
          });
        }
        await this.inventoryMovementsService.record(movementEntries);
      }
    } catch (err) {
      this.logger.error(
        `[performCancellation] inventory movement logging failed for tx ${saved._id}: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
    this.emit('tx:cancelled', { tx: saved, by: cancelledBy });

    // ── إلغاء الطلب في شوبيفاي تلقائياً ──────────────────────────────────────
    const shopifyOrderId = (saved as any).shopifyOrderId || '';
    if (shopifyOrderId && saved.type === 'مبيعات') {
      this.shopifyAdmin.cancelOrder(shopifyOrderId, 'other', false)
        .then(r => {
          if (r.success) {
            this.logger.log(`Shopify order ${shopifyOrderId} cancelled (tx cancel)`);
          } else {
            this.logger.warn(`Shopify cancel skipped for ${shopifyOrderId}: ${r.error}`);
          }
        })
        .catch(e => this.logger.error(`Shopify cancel error for ${shopifyOrderId}: ${e.message}`));
    }

    this.emit('inventory:changed', {
      reason: 'tx:cancelled',
      txId: String(saved._id),
      txType: saved.type,
      items: (saved.items || []).map((it) => ({ name: it.name, qty: it.qty })),
    });
    this.emit('vault:changed', { reason: 'tx:cancelled', txId: String(saved._id) });
    return saved;
  }

  async requestCancel(
    id: string,
    reason: string,
    requestedBy: string,
    requestedById?: string,
    requestedByUsername?: string,
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (tx.cancelled) throw new BadRequestException('المعاملة ملغية بالفعل');
    if (tx.archived) throw new BadRequestException('المعاملة مجمدة');
    if (tx.payStatus !== 'معلق') {
      throw new BadRequestException(
        'طلب الإلغاء مسموح فقط للمعاملات المعلقة — المعاملة المكتملة لا يمكن إلغاؤها',
      );
    }
    if (tx.cancelRequest && tx.cancelRequest.status === 'معلق') {
      throw new BadRequestException('يوجد طلب إلغاء معلق بالفعل لهذه المعاملة');
    }
    this.assertNotExchangePendingCollect(tx);
    const updated = await this.transactionModel
      .findByIdAndUpdate(
        id,
        {
          cancelRequest: {
            requestedBy,
            requestedById: requestedById || '',
            requestedByUsername: requestedByUsername || '',
            reason,
            requestedAt: new Date().toISOString(),
            status: 'معلق',
          },
        },
        { new: true },
      )
      .exec();
    return updated!;
  }

  async approveCancel(
    id: string,
    reviewedBy: string,
    vaultAccount?: string,
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (!tx.cancelRequest || tx.cancelRequest.status !== 'معلق') {
      throw new BadRequestException('لا يوجد طلب إلغاء معلق لهذه المعاملة');
    }
    if (tx.cancelled) throw new BadRequestException('المعاملة ملغية بالفعل');
    // Override deposit method with admin-selected vault account (refund/deduction account)
    const chosenVault = (vaultAccount || '').trim();
    if (chosenVault) {
      tx.depMethod = chosenVault;
      await tx.save();
    }
    // Capture requester info before mutating cancelRequest
    const requester = tx.cancelRequest as unknown as {
      requestedBy?: string;
      requestedById?: string;
      requestedByUsername?: string;
      reason?: string;
    };
    const reqId = requester.requestedById || '';
    const reqUsername = requester.requestedByUsername || '';
    const reqName = requester.requestedBy || '';
    // Mark cancel request as approved
    await this.transactionModel
      .findByIdAndUpdate(id, {
        'cancelRequest.status': 'معتمد',
        'cancelRequest.reviewedBy': reviewedBy,
        'cancelRequest.reviewedAt': new Date().toISOString(),
      })
      .exec();
    // Perform actual cancellation + vault debit
    const reason = requester.reason || 'موافقة المدير';
    const requestedBy = reqName || reviewedBy;
    const result = await this.performCancellation(tx, reason, requestedBy);
    // Notify requester (if known)
    if (reqId || reqUsername) {
      try {
        await this.mentionsService.create({
          targetUserId: reqId || '',
          targetUsername: (reqUsername || '').toLowerCase(),
          targetName: reqName,
          fromUserId: 'system',
          fromName: reviewedBy || 'مدير',
          txId: String(tx._id),
          txRef: tx.ref || '',
          commentId: 0,
          commentText: `تمت الموافقة على طلب إلغاء معاملة #${tx.ref || tx._id}${chosenVault ? (tx.type === 'مشتريات' ? ` — تم الرد إلى خزنة ${chosenVault}` : ` — تم الخصم من خزنة ${chosenVault}`) : ''}`,
        });
        this.emit('mentions:changed', { targetUserId: reqId, targetUsername: reqUsername });
      } catch { /* swallow */ }
    }
    return result;
  }

  async rejectCancel(
    id: string,
    reviewedBy: string,
    rejectedReason?: string,
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (!tx.cancelRequest || tx.cancelRequest.status !== 'معلق') {
      throw new BadRequestException('لا يوجد طلب إلغاء معلق لهذه المعاملة');
    }
    const requester = tx.cancelRequest as unknown as {
      requestedBy?: string;
      requestedById?: string;
      requestedByUsername?: string;
    };
    const reqId = requester.requestedById || '';
    const reqUsername = requester.requestedByUsername || '';
    const reqName = requester.requestedBy || '';
    // Mark as rejected — preserve the record for history, transaction stays unchanged
    const updated = await this.transactionModel
      .findByIdAndUpdate(
        id,
        {
          'cancelRequest.status': 'مرفوض',
          'cancelRequest.reviewedBy': reviewedBy || 'مدير',
          'cancelRequest.reviewedAt': new Date().toISOString(),
          ...(rejectedReason ? { 'cancelRequest.rejectedReason': rejectedReason } : {}),
        },
        { new: true },
      )
      .exec();
    // Notify requester
    if (reqId || reqUsername) {
      try {
        await this.mentionsService.create({
          targetUserId: reqId || '',
          targetUsername: (reqUsername || '').toLowerCase(),
          targetName: reqName,
          fromUserId: 'system',
          fromName: reviewedBy || 'مدير',
          txId: String(tx._id),
          txRef: tx.ref || '',
          commentId: 0,
          commentText: `تم رفض طلب إلغاء معاملة #${tx.ref || tx._id}${rejectedReason ? ` — السبب: ${rejectedReason}` : ''}`,
        });
        this.emit('mentions:changed', { targetUserId: reqId, targetUsername: reqUsername });
      } catch { /* swallow */ }
    }
    return updated!;
  }

  async collect(
    id: string,
    dto: CollectTransactionDto,
    by = 'مستخدم',
    callerRole = '',
    callerPerms: string[] = [],
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) {
      throw new NotFoundException('المعاملة غير موجودة');
    }
    if (tx.cancelled) {
      throw new BadRequestException('لا يمكن تحصيل معاملة ملغية');
    }
    if (tx.payStatus === 'مكتمل') {
      throw new BadRequestException('المعاملة محصلة بالفعل');
    }
    const totalRemaining = tx.remaining || 0;
    const isPurchase = tx.type === 'مشتريات';

    // Paying a SUPPLIER moves cash out of a vault. This route had no authorization check of any
    // kind — any authenticated user could settle any purchase invoice. It cannot be a route-level
    // @RequirePerms because the same endpoint collects from CUSTOMERS (money coming in), which is
    // a different operation with a different audience; only the transaction type tells them apart.
    if (isPurchase && callerRole !== 'admin' && !callerPerms.includes('suppliers-pay')) {
      throw new ForbiddenException('ليست لديك صلاحية سداد مبالغ للموردين');
    }

    // Partial payment support for purchases
    let payAmount: number;
    if (isPurchase && dto.collectAmount !== undefined && dto.collectAmount > 0) {
      if (dto.collectAmount > totalRemaining) {
        throw new BadRequestException(
          `المبلغ المدخل (${dto.collectAmount} ج) أكبر من المتبقي (${totalRemaining} ج)`
        );
      }
      payAmount = dto.collectAmount;
    } else {
      payAmount = totalRemaining;
    }

    const newRemaining = Math.max(0, totalRemaining - payAmount);
    const isFullyPaid = newRemaining === 0;

    // ===== التحقق الحاسم: الرصيد كافٍ؟ (للمشتريات فقط) =====
    if (isPurchase && payAmount > 0) {
      await this.vaultService.assertSufficientBalance(dto.collectMethod, payAmount);
    }

    // ===== التحقق من OTP لسداد المورد (للمشتريات فقط — يُتجاوز للمدير) =====
    if (isPurchase && callerRole !== 'admin') {
      // For bulk payments, otpTotalAmount is the OTP-registered total; fall back to per-invoice payAmount
      const otpCheckAmount = dto.otpTotalAmount != null ? dto.otpTotalAmount : payAmount;
      await this.discountOtpService.assertSupplierPayOtp(dto.otpId || '', otpCheckAmount);
    }

    // لقطة الحالة قبل التحصيل — تُحفظ في سجل الدفعة لاستخدامها في التراجع (UNDO)
    const snapshotBefore = {
      deposit: Number(tx.deposit) || 0,
      remaining: Number(tx.remaining) || 0,
      payStatus: tx.payStatus || 'معلق',
      collectMethod: tx.collectMethod || '',
      collectNote: tx.collectNote || '',
      collectedAt: tx.collectedAt || '',
      actualShipCost: Number(tx.actualShipCost) || 0,
      shipLoss: Number(tx.shipLoss) || 0,
    };

    // حساب الشحن للمبيعات
    const billedShip = !isPurchase ? (Number(tx.shipCost) || 0) : 0;
    let shipExtra = 0; // الزيادة في الشحن الفعلي عن المحصل
    if (!isPurchase && dto.actualShipCost !== undefined && dto.actualShipCost > 0) {
      const actualShipCost = Number(dto.actualShipCost);
      shipExtra = Math.max(0, actualShipCost - billedShip);
      tx.actualShipCost = actualShipCost;
      tx.shipLoss = (Number(tx.shipLoss) || 0) + shipExtra;
    }

    // الشحن يُخصم من التحصيل الأول فقط - تحقق من التحصيلات السابقة
    const alreadyDeductedShip = !isPurchase ? (tx.payments || []).reduce((sum, p: any) => sum + Math.min(billedShip, Math.max(0, ((p.collectedAmount || p.amount) - (p.amount || 0)))), 0) : 0;
    const remainingShipToDeduct = Math.max(0, billedShip - alreadyDeductedShip);

    // الخزنة = المتبقي - الشحن المحصل (الجزء المتبقي فقط) - زيادة الشحن
    // الشحن المحصل لا يدخل الخزنة (شركة الشحن تأخذه)
    // الزيادة = خسارة إضافية على الشركة
    const netVaultAmount = isPurchase ? payAmount : Math.max(0, payAmount - remainingShipToDeduct - shipExtra);

    tx.remaining = newRemaining;
    tx.payStatus = isFullyPaid ? 'مكتمل' : 'معلق';
    // المدفوع = الرقم الحقيقي الي دخل الخزنة
    tx.deposit = (tx.deposit || 0) + (isPurchase ? payAmount : netVaultAmount);
    tx.collectMethod = dto.collectMethod;
    tx.collectNote = dto.collectNote || '';
    // COD orders collected via the generic collect flow (not the Bosta-specific
    // confirm-collection endpoint) should still be reflected as Collected —
    // never regress an already-finalized Collected/FailedCollection status.
    // The who/when must be stamped here too: confirmCodCollection writes all three fields,
    // so setting only the status here left codCollectedBy/At empty and made the collection
    // step vanish from the order-handling log, which gates its row on codCollectedBy.
    if (!isPurchase && isFullyPaid && tx.codCollectionStatus === 'CODWaitingCollection') {
      tx.codCollectionStatus = 'Collected';
      tx.codCollectedBy = by || tx.employee || '';
      tx.codCollectedAt = new Date().toISOString();
      tx.codCollectionMethod = dto.collectMethod;
    }
    if (isFullyPaid) {
      tx.collectedAt = new Date().toISOString().split('T')[0];
    }

    // سجل السدادات
    if (!tx.payments) tx.payments = [];
    const vaultDelta = isPurchase ? -payAmount : netVaultAmount;
    const paymentDate = (dto.collectDate && /^\d{4}-\d{2}-\d{2}/.test(dto.collectDate))
      ? new Date(dto.collectDate).toISOString()
      : new Date().toISOString();
    tx.payments.push({
      id: this.genPaymentId(),
      amount: isPurchase ? payAmount : netVaultAmount,
      method: dto.collectMethod,
      note: dto.collectNote || (shipExtra > 0 ? `زيادة شحن: ${shipExtra} ج` : ''),
      date: paymentDate,
      by: by || tx.employee || '',
      remaining: totalRemaining,
      collectedAmount: payAmount,
      // لقطة لاستخدام التراجع (UNDO) — ترجع كل شيء كما كان قبل التحصيل
      vaultDelta,
      shipExtra,
      snapshotBefore,
    } as any);

    const saved = await tx.save();
    if (payAmount > 0) {
      const vaultAmount = isPurchase ? -payAmount : netVaultAmount;
      await this.vaultService.addSystemEntry(
        vaultAmount,
        dto.collectMethod,
        isPurchase
          ? `سداد مشتريات #${tx.ref || tx._id} — ${tx.client || ''}${!isFullyPaid ? ` (جزئي — متبقي: ${newRemaining} ج)` : ' (مكتمل)'}`
          : `تحصيل #${tx.ref || tx._id} — صافي: ${netVaultAmount} ج${billedShip > 0 ? ` (شحن: ${billedShip} ج${shipExtra > 0 ? ` + زيادة: ${shipExtra} ج` : ''})` : ''}`,
        paymentDate.split('T')[0],
        isPurchase ? 'مشتريات' : 'تحصيل',
        tx.ref || String(tx._id),
        isPurchase ? { supplier: tx.client || '' } : { customer: tx.client || '' },
        tx.employee || '',
        { txId: String(saved._id), isPurchase, payAmount, isPartial: !isFullyPaid, newRemaining, client: tx.client || '' },
      );
      if (isPurchase) {
        const supplierId = await this.resolveSupplierIdForLedger(
          saved.supplierId,
          saved.client || '',
        );
        if (supplierId) {
          await this.supplierLedgerService.postPayment({
            supplierId,
            supplierName: saved.client || '',
            transactionId: String(saved._id),
            transactionRef: saved.ref || String(saved._id),
            date: paymentDate.split('T')[0],
            amount: payAmount,
            employee: by || saved.employee || '',
          });
        }
      }
    }
    this.emit('tx:updated', { tx: saved, action: 'collect' });
    if (isPurchase && isFullyPaid) {
      // purchase fully paid — inventory was already committed at creation, just notify
      this.emit('inventory:changed', {
        reason: 'tx:collect:completed',
        txId: String(saved._id),
        txType: saved.type,
        items: (saved.items || []).map((it) => ({ name: it.name, qty: it.qty })),
      });
    }
    return saved;
  }

  async reverseCollect(
    id: string,
    _reversedBy: string,
  ): Promise<{ tx: TransactionDocument; reversedAmount: number; vaultMethod: string }> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (tx.cancelled) throw new BadRequestException('لا يمكن التراجع على معاملة ملغية');

    const payments = tx.payments || [];
    if (!payments.length) throw new BadRequestException('لا يوجد تحصيل مسجل لهذه المعاملة');

    // آخر عملية تحصيل
    const lastPayment: any = payments[payments.length - 1];
    const isPurchase = tx.type === 'مشتريات';
    const txRef = tx.ref || String(tx._id);

    // المبلغ الذي دخل/خرج من الخزنة فعلياً عند التحصيل
    const reversedAmount = Number(lastPayment.amount) || 0;
    const vaultMethod = String(lastPayment.method || tx.collectMethod || 'كاش');

    // اللقطة المحفوظة وقت التحصيل — مصدر الحقيقة للتراجع
    // (للسجلات القديمة قبل إضافة اللقطة، نُعيد الحساب من البيانات المتاحة)
    const snap = lastPayment.snapshotBefore as undefined | {
      deposit: number;
      remaining: number;
      payStatus: string;
      collectMethod: string;
      collectNote: string;
      collectedAt: string;
      actualShipCost: number;
      shipLoss: number;
    };

    // عكس المبيعات = إرجاع المال للخزنة (لا خصم) — لا حاجة للتحقق من الرصيد
    // عكس المشتريات = خصم ما أُعيد للخزنة — نتحقق من الرصيد
    if (isPurchase && reversedAmount > 0) {
      await this.vaultService.assertSufficientBalance(vaultMethod, reversedAmount);
    }

    // ===== UNDO كامل: إعادة كل الحقول كما كانت قبل التحصيل =====
    if (snap) {
      tx.deposit = snap.deposit;
      tx.remaining = snap.remaining;
      tx.payStatus = snap.payStatus;
      tx.collectMethod = snap.collectMethod;
      tx.collectNote = snap.collectNote;
      tx.actualShipCost = snap.actualShipCost;
      tx.shipLoss = snap.shipLoss;
      if (snap.collectedAt) {
        tx.collectedAt = snap.collectedAt;
      } else {
        tx.set('collectedAt', undefined);
      }
    } else {
      // مسار توافقي للسجلات القديمة (قبل إضافة snapshotBefore)
      const remainingBefore = typeof lastPayment.remaining === 'number'
        ? lastPayment.remaining
        : (tx.remaining || 0) + reversedAmount;
      tx.remaining = remainingBefore;
      tx.payStatus = remainingBefore > 0 ? 'معلق' : 'مكتمل';
      // إنقاص ما أُضيف فعلياً للـ deposit وقت التحصيل = reversedAmount
      tx.deposit = Math.max(0, (Number(tx.deposit) || 0) - reversedAmount);
      if (tx.payStatus === 'معلق') {
        tx.set('collectedAt', undefined);
      }
    }

    // حذف آخر دفعة — UNDO صامت بلا أي سجل (كأن التحصيل لم يحدث)
    tx.payments = payments.slice(0, -1);

    const saved = await tx.save();

    // حذف آخر سجل تحصيل من الخزنة (بدون إضافة سجل عكسي)
    await this.vaultService.deleteLastEntryByRef(txRef);

    // نفس المنطق في الخزنة يجب أن ينعكس في دفتر المورد، وإلا بقيت الدفعة مخصومة من المديونية.
    await this.reverseSupplierPaymentLedgerEntry(
      saved,
      _reversedBy || saved.employee || '',
      `تراجع عن تحصيل #${txRef}`,
    );

    this.emit('tx:updated', { tx: saved, action: 'reverse-collect' });
    this.emit('vault:changed', { reason: 'tx:reverse-collect', txId: String(saved._id) });
    return { tx: saved, reversedAmount, vaultMethod };
  }

  /** Generate a stable id for a payment/deposit entry. */
  private genPaymentId(): string {
    return `pay_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Lazily backfill ids on legacy deposits/payments so old records can be targeted by Undo.
   * Returns true if any change was made.
   */
  private backfillPaymentIds(tx: TransactionDocument): boolean {
    let changed = false;
    (tx.deposits || []).forEach((d: any) => {
      if (!d.id) { d.id = this.genPaymentId(); changed = true; }
    });
    (tx.payments || []).forEach((p: any) => {
      if (!p.id) { p.id = this.genPaymentId(); changed = true; }
    });
    if (changed) {
      tx.markModified('deposits');
      tx.markModified('payments');
    }
    return changed;
  }

  /**
   * Undo a specific payment OR deposit by id.
   * - If targeting the most recent non-reversed payment, performs the full snapshot restore (same as reverseCollect).
   * - Otherwise, performs a partial reversal: subtracts amount from deposit, adds to remaining,
   *   marks the entry as reversed (kept for audit), and writes a reverse vault entry.
   * Concurrency: uses Mongoose document version (__v) for optimistic locking.
   */
  async undoSpecificPayment(
    txId: string,
    paymentId: string,
    undoBy: string,
    reason?: string,
    callerRole = '',
    callerPerms: string[] = [],
  ): Promise<{ tx: TransactionDocument; reversedAmount: number; vaultMethod: string; mode: 'full' | 'partial' | 'deposit' }> {
    const tx = await this.transactionModel.findById(txId).exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (tx.cancelled) throw new BadRequestException('لا يمكن التراجع على معاملة ملغاة');

    // Route-level @RequirePerms('suppliers-reverse') already let the caller in. That perm only
    // covers PURCHASE payments, so a non-purchase reversal still needs the original admin rule —
    // otherwise granting the supplier perm would silently widen into sales collections too.
    if (tx.type !== 'مشتريات' && callerRole !== 'admin') {
      throw new ForbiddenException('التراجع عن تحصيل المبيعات متاح للمدير فقط');
    }
    if (tx.type === 'مشتريات' && callerRole !== 'admin' && !callerPerms.includes('suppliers-reverse')) {
      throw new ForbiddenException('ليست لديك صلاحية التراجع عن دفعات الموردين');
    }

    this.backfillPaymentIds(tx);

    const payments = (tx.payments || []) as any[];
    const deposits = (tx.deposits || []) as any[];

    const paymentIdx = payments.findIndex((p) => p.id === paymentId);
    const depositIdx = paymentIdx === -1 ? deposits.findIndex((d) => d.id === paymentId) : -1;

    if (paymentIdx === -1 && depositIdx === -1) {
      throw new NotFoundException('الدفعة المستهدفة غير موجودة');
    }

    const isPurchase = tx.type === 'مشتريات';
    const txRef = tx.ref || String(tx._id);
    const expectedVersion = (tx as any).__v;

    // ---------- DEPOSIT UNDO ----------
    if (depositIdx !== -1) {
      const dep = deposits[depositIdx];
      if (dep.reversed) throw new BadRequestException('هذه الدفعة سبق التراجع عنها');
      const amount = Number(dep.amount) || 0;
      const method = String(dep.method || tx.depMethod || 'كاش');

      // Sales deposit: money was added to vault → undoing removes it (need balance check)
      // Purchase deposit: money was deducted from vault → undoing returns it (no check)
      if (!isPurchase && amount > 0) {
        await this.vaultService.assertSufficientBalance(method, amount);
      }

      tx.deposit = Math.max(0, (Number(tx.deposit) || 0) - amount);
      tx.remaining = (Number(tx.remaining) || 0) + amount;
      tx.payStatus = tx.remaining > 0 ? 'معلق' : 'مكتمل';
      dep.reversed = true;
      dep.reversedAt = new Date().toISOString();
      dep.reversedBy = undoBy;
      if (reason) dep.reversalReason = reason;
      tx.markModified('deposits');

      const saved = await this.saveWithVersion(tx, expectedVersion);

      // Reverse vault entry (audit trail). Sales deposit was +amount → record -amount; purchase was -amount → record +amount.
      const reverseAmount = isPurchase ? amount : -amount;
      if (amount > 0) {
        await this.vaultService.addSystemEntry(
          reverseAmount,
          method,
          `تراجع عن ديبوزت — ${tx.type} #${txRef}${reason ? ` — ${reason}` : ''}`,
          new Date().toISOString().split('T')[0],
          'إلغاء',
          txRef,
          isPurchase ? { supplier: tx.client || '' } : { customer: tx.client || '' },
          undoBy,
          { txId: String(saved._id), undoOf: paymentId, kind: 'deposit-undo' },
        );
      }

      this.emit('tx:updated', { tx: saved, action: 'undo-payment' });
      return { tx: saved, reversedAmount: amount, vaultMethod: method, mode: 'deposit' };
    }

    // ---------- PAYMENT UNDO ----------
    const pay = payments[paymentIdx];
    if (pay.reversed) throw new BadRequestException('هذه الدفعة سبق التراجع عنها');

    const amount = Number(pay.amount) || 0;
    const method = String(pay.method || tx.collectMethod || 'كاش');
    const isLastActive =
      paymentIdx === payments.length - 1 ||
      payments.slice(paymentIdx + 1).every((p) => p.reversed);

    // Purchase payment: money was deducted from vault → undoing returns it (no check)
    // Sales collection: money was added to vault → undoing removes it (need balance check)
    if (!isPurchase && amount > 0) {
      await this.vaultService.assertSufficientBalance(method, amount);
    }

    if (isLastActive && pay.snapshotBefore) {
      // Full snapshot restore — most recent live payment
      const snap = pay.snapshotBefore;
      tx.deposit = snap.deposit;
      tx.remaining = snap.remaining;
      tx.payStatus = snap.payStatus;
      tx.collectMethod = snap.collectMethod;
      tx.collectNote = snap.collectNote;
      tx.actualShipCost = snap.actualShipCost;
      tx.shipLoss = snap.shipLoss;
      if (snap.collectedAt) tx.collectedAt = snap.collectedAt;
      else tx.set('collectedAt', undefined);
    } else {
      // Partial reversal — older payment, do not touch later payments
      tx.deposit = Math.max(0, (Number(tx.deposit) || 0) - amount);
      tx.remaining = (Number(tx.remaining) || 0) + amount;
      tx.payStatus = tx.remaining > 0 ? 'معلق' : 'مكتمل';
      if (tx.payStatus === 'معلق') tx.set('collectedAt', undefined);
    }

    pay.reversed = true;
    pay.reversedAt = new Date().toISOString();
    pay.reversedBy = undoBy;
    if (reason) pay.reversalReason = reason;
    tx.markModified('payments');

    const saved = await this.saveWithVersion(tx, expectedVersion);

    // Reverse vault entry (audit trail). Purchase payment was -amount → record +amount; sales was +amount → record -amount.
    const reverseAmount = isPurchase ? amount : -amount;
    if (amount > 0) {
      await this.vaultService.addSystemEntry(
        reverseAmount,
        method,
        `تراجع عن دفعة — ${tx.type} #${txRef}${reason ? ` — ${reason}` : ''}`,
        new Date().toISOString().split('T')[0],
        'إلغاء',
        txRef,
        isPurchase ? { supplier: tx.client || '' } : { customer: tx.client || '' },
        undoBy,
        { txId: String(saved._id), undoOf: paymentId, kind: 'payment-undo' },
      );
    }

    // Mirror the vault reversal in the supplier ledger, or the undone payment stays deducted
    // from the supplier balance forever.
    await this.reverseSupplierPaymentLedgerEntry(
      saved,
      undoBy,
      `تراجع عن دفعة #${txRef}${reason ? ` — ${reason}` : ''}`,
    );

    this.emit('tx:updated', { tx: saved, action: 'undo-payment' });
    this.emit('vault:changed', { reason: 'tx:undo-payment', txId: String(saved._id) });
    return { tx: saved, reversedAmount: amount, vaultMethod: method, mode: isLastActive ? 'full' : 'partial' };
  }

  /** Save with optimistic concurrency check on document version. */
  private async saveWithVersion(
    tx: TransactionDocument,
    expectedVersion: number | undefined,
  ): Promise<TransactionDocument> {
    if (expectedVersion !== undefined) {
      const fresh = await this.transactionModel.findById(tx._id).select('__v').lean().exec();
      if (fresh && (fresh as any).__v !== expectedVersion) {
        throw new BadRequestException('تم تعديل المعاملة من جلسة أخرى — أعد التحميل وحاول مرة أخرى');
      }
    }
    return tx.save();
  }


  async addComments(id: string, comments: Array<any>): Promise<TransactionDocument> {
    // Update ONLY comments field - without triggering editHistory
    const tx = await this.transactionModel.findByIdAndUpdate(
      id,
      { comments },
      { new: true }
    ).exec();
    if (!tx) {
      throw new NotFoundException('المعاملة غير موجودة');
    }
    return tx;
  }

  async updateTags(id: string, tags: string[]): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findByIdAndUpdate(
      id,
      { tags },
      { new: true }
    ).exec();
    if (!tx) {
      throw new NotFoundException('المعاملة غير موجودة');
    }
    this.presence.emitEvent('tx:updated', {
      txId: id,
      action: 'tags',
      tx,
    });
    return tx;
  }

  async remove(id: string, archivedBy?: string): Promise<void> {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('معرّف المعاملة غير صالح');
    }
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) {
      throw new NotFoundException('المعاملة غير موجودة');
    }
    // Freeze is only allowed for cancelled transactions (archiving purposes)
    if (!tx.cancelled) {
      throw new BadRequestException('🔒 تجميد يقتصر على المعاملات الملغاة فقط');
    }
    this.assertNotExchangePendingCollect(tx);
    // Archive the cancelled transaction — does NOT reverse vault entries
    // Freezing is just archiving for organization, not affecting vault
    await this.transactionModel
      .findByIdAndUpdate(id, {
        archived: true,
        archivedAt: new Date().toISOString(),
        archivedBy: archivedBy || '',
      })
      .exec();
  }

  async bulkRemove(ids: string[], archivedBy?: string): Promise<number> {
    if (!ids.length) {
      return 0;
    }
    const docs = await this.transactionModel
      .find({ _id: { $in: ids }, archived: { $ne: true } })
      .exec();

    // Enforce: only cancelled transactions can be frozen
    const nonCancelledTx = docs.find(tx => !tx.cancelled);
    if (nonCancelledTx) {
      throw new BadRequestException('تجميد يقتصر على المعاملات الملغاة فقط');
    }

    for (const tx of docs) {
      this.assertNotExchangePendingCollect(tx);
    }

    // Archive all cancelled transactions — does NOT reverse vault entries
    // Freezing is just archiving for organization, not affecting vault
    const result = await this.transactionModel
      .updateMany(
        { _id: { $in: ids } },
        {
          archived: true,
          archivedAt: new Date().toISOString(),
          archivedBy: archivedBy || '',
        },
      )
      .exec();

    return result.modifiedCount;
  }

  async restore(id: string, restoredBy = ''): Promise<TransactionDocument> {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('معرّف المعاملة غير صالح');
    }
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) {
      throw new NotFoundException('المعاملة غير موجودة');
    }
    if (!tx.archived) {
      throw new BadRequestException('المعاملة ليست مجمدة');
    }
    // Unarchive first — guaranteed
    const restored = await this.transactionModel
      .findByIdAndUpdate(
        id,
        { archived: false, archivedAt: undefined, archivedBy: undefined },
        { new: true },
      )
      .exec();
    // Re-record vault entries — non-blocking so restore always completes
    this.recordVaultForTransaction(restored!).catch((err) =>
      console.error(`[restore] vault re-record failed for ${id}:`, err),
    );
    // Re-apply inventory movement log (inverse of cancellation) — same non-blocking posture as vault re-record above.
    this.recordRestoreInventoryMovement(restored!, restoredBy).catch((err) =>
      this.logger.error(`[restore] inventory movement logging failed for ${id}: ${(err as Error).message}`, (err as Error).stack),
    );
    return restored!;
  }

  private async recordRestoreInventoryMovement(restored: TransactionDocument, restoredBy: string): Promise<void> {
    const movementInfo = this.classifyInventoryMovement(restored);
    if (!movementInfo) return;
    const invSnapshot = await this.getInventory();
    const invByCode = new Map(invSnapshot.map((r) => [String(r.code).trim(), r]));
    const movementEntries: RecordMovementEntry[] = [];
    for (const item of restored.items || []) {
      const code = String(item.code || '').trim();
      const invRow = invByCode.get(code);
      if (!invRow) continue;
      const qtyDelta = movementInfo.sign * (Number(item.qty) || 0);
      const currentStock = invRow.current;
      movementEntries.push({
        productId: invRow._id,
        productCode: code,
        productName: item.name || invRow.name,
        type: movementInfo.type,
        qtyDelta,
        qtyBefore: currentStock - qtyDelta,
        qtyAfter: currentStock,
        sourceTransactionId: String(restored._id),
        sourceTransactionRef: restored.ref || String(restored._id),
        sourceType: 'transaction-restore',
        by: restoredBy || 'مستخدم',
      });
    }
    await this.inventoryMovementsService.record(movementEntries);
  }

  async clearAll(): Promise<void> {
    await this.transactionModel.deleteMany({}).exec();
  }

  async getInventory(): Promise<InventoryItem[]> {
    const products = await this.productsService.findAll();
    const transactions = await this.transactionModel
      .find({ cancelled: { $ne: true }, archived: { $ne: true } })
      .exec();
    return products.map((product) => {
      let purchases = 0;
      let sales = 0;
      let returnsToStock = 0;
      const returnRefSet = new Set<string>();
      const returnDateSet = new Set<string>();
      const productCodeNorm = String(product.code || '').trim();
      transactions.forEach((tx) => {
        tx.items.forEach((item) => {
          if (String(item.code || '').trim() !== productCodeNorm) {
            return;
          }
          if (this.transactionAddsSupplierPurchases(tx)) {
            // Supplier purchases: add to purchases count
            purchases += item.qty;
          } else if (this.transactionAddsReturnToStock(tx)) {
            // Customer returns: add to stock
            // Formula: current = opening + purchases + returns - sales
            // where sales = direct sales only (not reduced by returns)
            // A تالف unit contributes 0 — see returnedItemQtyForStock.
            returnsToStock += this.returnedItemQtyForStock(item);
            const refStr = String(tx.ref || '').trim();
            if (refStr) {
              returnRefSet.add(refStr);
            }
            const dateStr = tx.date ? String(tx.date).split('T')[0] : '';
            if (dateStr) {
              returnDateSet.add(dateStr);
            }
          } else if (tx.type === 'مبيعات' || tx.type === 'مرتجع مشتريات') {
            // Sales / supplier returns (stock leaving the warehouse back to the supplier):
            // both consume stock the same way.
            sales += item.qty;
          }
        });
      });
      const openingBal = Math.max(
        0,
        Math.floor(Number(product.openingBalance) || 0),
      );
      const current = openingBal + purchases + returnsToStock - sales;
      let status: 'ok' | 'low' | 'zero' = 'ok';
      if (current <= 0) {
        status = 'zero';
      } else if (current <= (product.minStock || 10)) {
        status = 'low';
      }
      return {
        _id: product._id.toString(),
        code: product.code,
        name: product.name,
        imageUrl: (product as { imageUrl?: string }).imageUrl || '',
        sellPrice: product.sellPrice,
        buyPrice: product.buyPrice,
        minStock: product.minStock,
        openingBalance: openingBal,
        purchases,
        returnsToStock,
        returnRefs: [...returnRefSet].sort().join('، '),
        returnDates: [...returnDateSet].sort().join('، '),
        sales,
        current,
        status,
        isActive: (product as { isActive?: boolean }).isActive !== false,
      };
    });
  }

  async getDashboard(expenseTotal = 0): Promise<DashboardData> {
    const inventory = await this.getInventory();
    const transactions = await this.transactionModel
      .find({ archived: { $ne: true } })
      .exec();
    const activeTx = transactions.filter((t) => !t.cancelled);
    const lowStockCount = inventory.filter((p) => p.status !== 'ok').length;
    const salesTx = activeTx.filter((t) => t.type === 'مبيعات');

    // احسب المرتجعات المقبولة (مرة واحدة فقط)
    let totalReturns = 0;
    let returnedProfit = 0;
    let approvedReturns: ReturnRequestDocument[] = [];
    try {
      // `reversedAt` must be filtered on, not just `status`: a reversed return KEEPS status 'معتمد'
      // (mirroring SupplierReturnOrder), so the status check alone would keep subtracting a return
      // whose stock and cash were already given back.
      approvedReturns = await this.returnRequestModel
        .find({
          status: 'معتمد',
          $or: [{ reversedAt: null }, { reversedAt: { $exists: false } }],
        })
        .exec();
      totalReturns = approvedReturns.reduce((s, r) => s + (Number(r.total) || 0), 0);
    } catch (e) {
      totalReturns = 0;
      approvedReturns = [];
    }

    const totalShipping = salesTx.reduce((s, t) => s + (Number(t.shipCost) || 0), 0);
    const totalShipLoss = salesTx.reduce((s, t) => s + (Number(t.shipLoss) || 0), 0);
    const grossProductSales = salesTx.reduce((s, t) => s + (Number(t.itemsTotal) || t.total - (Number(t.shipCost) || 0)), 0);
    const totalSales = Math.max(0, grossProductSales - totalReturns);
    // Purchases are reported NET of settled supplier returns — goods sent back are not spend we
    // kept. Mirrors totalSales being net of customer returns above. No date window here: the
    // dashboard is all-time.
    const grossPurchases = activeTx
      .filter((t) => this.transactionAddsSupplierPurchases(t))
      .reduce((sum, t) => sum + t.total, 0);
    const supplierReturnsTotal = await this.getSettledSupplierReturnsTotal();
    const totalPurchases = Math.max(0, grossPurchases - supplierReturnsTotal);
    // "المتبقي / الديون" mixes money owed TO us and money we owe. The supplier half can no longer
    // be read from tx.remaining: supplier-return debt offsets and manual ledger adjustments move
    // what we owe WITHOUT touching any invoice's remaining (verified — neither SupplierReturnsService
    // nor SupplierLedgerService writes tx.remaining). Summing invoices therefore over-reports
    // supplier debt by exactly the value of every settled return and correction ever made.
    // The ledger is authoritative for the payable side, so take it from there.
    const customerReceivables = activeTx
      .filter((t) => t.type === 'مبيعات')
      .reduce((sum, t) => sum + (t.remaining || 0), 0);
    // Returns/exchanges that still carry a balance — neither a sale nor a supplier purchase.
    const otherRemaining = activeTx
      .filter((t) => t.type !== 'مبيعات' && t.type !== 'مشتريات')
      .reduce((sum, t) => sum + (t.remaining || 0), 0);
    const supplierPayables = await this.getTotalSupplierDebt();
    const totalRemaining =
      customerReceivables + otherRemaining + supplierPayables;
    const totalDiscounts = salesTx.reduce((s, t) => {
      // Use stored discount if present; otherwise infer from itemsTotal vs total
      const stored = Number(t.discount) || 0;
      if (stored > 0) return s + stored;
      const items = Number(t.itemsTotal) || 0;
      const ship  = Number(t.shipCost)   || 0;
      if (items > 0) {
        const inferred = Math.max(0, items - (t.total - ship));
        return s + inferred;
      }
      return s;
    }, 0);
    const totalDeposit = salesTx.reduce((s, t) => s + (Number(t.deposit) || 0), 0);
    const products = await this.productsService.findAll();
    let grossProfit = 0;
    salesTx.forEach((tx) => {
      tx.items.forEach((item) => {
        const product = products.find((p) => p.code === item.code);
        grossProfit +=
          (item.price - (product ? product.buyPrice : 0)) * item.qty;
      });
    });

    // اخصم ربح المنتجات المرتجعة من الربح الإجمالي (استخدم البيانات المجلوبة بالفعل)
    try {
      returnedProfit = this.computeReturnedProfitLoss(approvedReturns, products);
    } catch (e) {
      returnedProfit = 0;
    }

    grossProfit = Math.max(0, grossProfit - returnedProfit - totalShipLoss);
    const netProfit = grossProfit - expenseTotal;
    const salesMap: Record<string, number> = {};
    salesTx.forEach((tx) => {
      tx.items.forEach((item) => {
        salesMap[item.name] = (salesMap[item.name] || 0) + item.qty;
      });
    });
    const sorted = Object.entries(salesMap)
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty);
    const topSellers = sorted.slice(0, 5);
    const lowSellers =
      sorted.length > 5 ? sorted.slice(-5).reverse() : [...sorted].reverse();
    const lowStockItems = inventory
      .filter((p) => p.status !== 'ok')
      .slice(0, 8);
    const recentTransactions = await this.transactionModel
      .find()
      .sort({ createdAt: -1 })
      .limit(8)
      .exec();
    return {
      totalProducts: inventory.length,
      lowStockCount,
      totalSales,
      totalPurchases,
      // Breakdown behind the netted figure, so the UI can show "gross − returns".
      grossPurchases,
      supplierReturnsTotal,
      totalRemaining,
      // Breakdown of the mixed debts figure — receivable vs payable are opposite-signed in
      // accounting terms, so the split is what a user actually needs to act on.
      customerReceivables,
      supplierPayables,
      totalExpenses: expenseTotal,
      grossProfit,
      netProfit,
      totalShipping,
      totalShipLoss,
      returnCount: approvedReturns.length,
      totalReturns,
      totalDiscounts,
      totalDeposit,
      lowStockItems,
      recentTransactions,
      topSellers,
      lowSellers,
    };
  }

  async getReports(
    from?: string,
    to?: string,
    expenseTotal = 0,
  ): Promise<Record<string, unknown>> {
    let transactions = await this.transactionModel
      .find({ cancelled: { $ne: true }, archived: { $ne: true } })
      .exec();
    // Unfiltered handle, captured before the two filters below rebind `transactions` to a
    // narrowed array. «آخر بيع» in the stagnant-stock panel is a lifetime fact about the
    // product — scoping it to the selected period would report every product as never-sold
    // whenever the user picks "اليوم".
    const allTx = transactions;
    if (from) transactions = transactions.filter((t) => t.date >= from);
    if (to) transactions = transactions.filter((t) => t.date <= to);
    const salesTx = transactions.filter((t) => t.type === 'مبيعات');
    const pursTx = transactions.filter((t) =>
      this.transactionAddsSupplierPurchases(t),
    );

    // احسب المرتجعات المقبولة (مرة واحدة فقط)
    let totalReturns = 0;
    let returnedProfit = 0;
    let approvedReturns: ReturnRequestDocument[] = [];
    try {
      // Same reversal guard as getDashboard() — see the comment there.
      const returnQuery: any = {
        status: 'معتمد',
        $or: [{ reversedAt: null }, { reversedAt: { $exists: false } }],
      };
      if (from || to) {
        returnQuery.createdAt = {};
        if (from) returnQuery.createdAt.$gte = new Date(from + 'T00:00:00.000Z');
        if (to) returnQuery.createdAt.$lte = new Date(to + 'T23:59:59.999Z');
      }
      approvedReturns = await this.returnRequestModel.find(returnQuery).exec();
      console.log(`[getReports] Found ${approvedReturns.length} approved returns`);
      totalReturns = approvedReturns.reduce((s, r) => s + (Number(r.total) || 0), 0);
      console.log(`[getReports] totalReturns: ${totalReturns}`);
    } catch (e) {
      console.error('[getReports] Error fetching returns:', e);
      totalReturns = 0;
      approvedReturns = [];
    }

    // الشحن: المحصل من العملاء والفرق المتحمل من الشركة
    const totalShipping = salesTx.reduce((s, t) => s + (Number(t.shipCost) || 0), 0);
    const totalShipLoss = salesTx.reduce((s, t) => s + (Number(t.shipLoss) || 0), 0);
    // صافي المبيعات = إجمالي المنتجات فقط (بدون شحن) - المرتجعات
    const grossProductSales = salesTx.reduce((s, t) => s + (Number(t.itemsTotal) || t.total - (Number(t.shipCost) || 0)), 0);
    const totalSales = Math.max(0, grossProductSales - totalReturns);
    // Purchases are reported NET of settled supplier returns — goods sent back are not spend we
    // kept. Mirrors how totalSales is net of customer returns just above.
    const grossPurchases = pursTx.reduce((s, t) => s + t.total, 0);
    const settledSupplierReturns = await this.getSettledSupplierReturns(
      from,
      to,
    );
    const supplierReturnsTotal = settledSupplierReturns.reduce(
      (s, r) => s + (Number(r.total) || 0),
      0,
    );
    const totalPurchases = Math.max(0, grossPurchases - supplierReturnsTotal);
    const totalDeposit = salesTx.reduce((s, t) => s + (t.deposit || 0), 0);
    const totalRemaining = salesTx.reduce(
      (s, t) => s + (t.remaining || 0),
      0,
    );
    const products = await this.productsService.findAll();
    let grossProfit = 0;
    const prodProfitMap: Record<
      string,
      { qty: number; rev: number; cost: number; profit: number }
    > = {};
    salesTx.forEach((tx) => {
      tx.items.forEach((item) => {
        const p = products.find((x) => x.code === item.code);
        const cost = p ? p.buyPrice : 0;
        const profit = (item.price - cost) * item.qty;
        grossProfit += profit;
        if (!prodProfitMap[item.name]) {
          prodProfitMap[item.name] = { qty: 0, rev: 0, cost: 0, profit: 0 };
        }
        prodProfitMap[item.name].qty += item.qty;
        prodProfitMap[item.name].rev += item.total;
        prodProfitMap[item.name].cost += cost * item.qty;
        prodProfitMap[item.name].profit += profit;
      });
    });

    // اخصم ربح المنتجات المرتجعة من الربح الإجمالي (استخدم البيانات المجلوبة بالفعل)
    try {
      returnedProfit = this.computeReturnedProfitLoss(approvedReturns, products);
    } catch (e) {
      console.error('[getReports] Error calculating returned profit:', e);
      returnedProfit = 0;
    }

    grossProfit = Math.max(0, grossProfit - returnedProfit - totalShipLoss);
    console.log(`[getReports] Final grossProfit: ${grossProfit}`);
    const netProfit = grossProfit - expenseTotal;

    const orderCount = salesTx.length;
    const avgOrderValue = orderCount > 0 ? Math.round(grossProductSales / orderCount) : 0;
    const productProfits = Object.entries(prodProfitMap)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.profit - a.profit);
    const bestByQty = [...productProfits].sort((a, b) => (b.qty || 0) - (a.qty || 0))[0];
    const bestSellingProduct = bestByQty
      ? { name: bestByQty.name, qty: bestByQty.qty, revenue: bestByQty.rev }
      : null;

    // Series purchases must be netted the same way as the KPI, or the daily chart contradicts the
    // headline figure it sits beside.
    const series = this.buildDailySeries(
      salesTx,
      pursTx,
      from,
      to,
      settledSupplierReturns,
    );

    const customerMap: Record<string, { orders: number; revenue: number }> = {};
    salesTx.forEach((tx) => {
      const name = String(tx.client || '').trim() || 'بدون اسم';
      if (!customerMap[name]) customerMap[name] = { orders: 0, revenue: 0 };
      customerMap[name].orders += 1;
      customerMap[name].revenue += Number(tx.itemsTotal) || (tx.total - (Number(tx.shipCost) || 0));
    });
    const topCustomers = Object.entries(customerMap)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const stagnantStock = await this.buildStagnantStock(salesTx, allTx);

    return {
      totalSales,
      totalPurchases,
      // Breakdown behind the netted figure, so the UI can show "gross − returns" instead of an
      // unexplained number that no longer matches the invoices list.
      grossPurchases,
      supplierReturnsTotal,
      totalDeposit,
      totalRemaining,
      grossProfit,
      netProfit,
      expenseTotal,
      totalShipping,
      totalShipLoss,
      returnCount: approvedReturns.length,
      totalReturns,
      transactionCount: transactions.length,
      orderCount,
      avgOrderValue,
      bestSellingProduct,
      series,
      topCustomers,
      from: from || '',
      to: to || '',
      productProfits,
      stagnantStock,
      salesMap: salesTx.reduce(
        (acc: Record<string, number>, tx) => {
          tx.items.forEach((it) => {
            acc[it.name] = (acc[it.name] || 0) + it.qty;
          });
          return acc;
        },
        {},
      ),
    };
  }

  /**
   * Stock that did not move in the reporting period, and what it costs to hold it.
   *
   * The reports page used to answer "what isn't selling?" from `productProfits`, which is
   * accumulated from sold line items — so a product with zero sales could never appear in it.
   * The genuinely dead stock was structurally invisible, and the panel showed the ten
   * *least*-sold-but-still-sold products instead (usually ten identical bars of qty 1).
   *
   * The list therefore starts from inventory, not from sales. Stock is read through
   * `getInventory()` rather than recomputed here — it and `getAvailableQtyByProductCode` are
   * the only two places stock is derived, and a third would drift from both.
   *
   * @param salesTx sales in the selected period — decides what counts as "did not move".
   * @param allTx   every transaction, unfiltered — «آخر بيع» is a lifetime fact.
   */
  private async buildStagnantStock(
    salesTx: TransactionDocument[],
    allTx: TransactionDocument[],
  ): Promise<{
    items: Array<{
      code: string;
      name: string;
      stock: number;
      buyPrice: number;
      frozenValue: number;
      lastSale: string;
      daysSinceSale: number | null;
    }>;
    count: number;
    totalValue: number;
    neverSold: number;
  }> {
    const empty = { items: [], count: 0, totalValue: 0, neverSold: 0 };
    try {
      const inventory = await this.getInventory();

      const soldInPeriod = new Set<string>();
      salesTx.forEach((tx) =>
        tx.items.forEach((it) => {
          const code = String(it.code || '').trim();
          if (code && (Number(it.qty) || 0) > 0) soldInPeriod.add(code);
        }),
      );

      const lastSaleByCode: Record<string, string> = {};
      allTx.forEach((tx) => {
        if (tx.type !== 'مبيعات') return;
        const day = tx.date ? String(tx.date).split('T')[0] : '';
        if (!day) return;
        tx.items.forEach((it) => {
          const code = String(it.code || '').trim();
          if (!code) return;
          if (!lastSaleByCode[code] || day > lastSaleByCode[code]) {
            lastSaleByCode[code] = day;
          }
        });
      });

      // Both sides are plain YYYY-MM-DD, so Date.parse reads them as UTC midnight and the
      // difference is a whole number of days with no timezone drift.
      const todayMs = Date.parse(new Date().toISOString().slice(0, 10));
      const rows = inventory
        // Stock on hand is the whole point: a discontinued item at zero stock ties up no cash
        // and needs no decision. Inactive products are excluded for the same reason.
        .filter((p) => p.isActive !== false && p.current > 0)
        .filter((p) => !soldInPeriod.has(String(p.code || '').trim()))
        .map((p) => {
          const code = String(p.code || '').trim();
          const lastSale = lastSaleByCode[code] || '';
          const lastMs = lastSale ? Date.parse(lastSale) : NaN;
          return {
            code,
            name: p.name,
            stock: p.current,
            buyPrice: p.buyPrice || 0,
            frozenValue: Math.round((p.current || 0) * (p.buyPrice || 0)),
            lastSale,
            daysSinceSale: Number.isNaN(lastMs)
              ? null
              : Math.max(0, Math.round((todayMs - lastMs) / 86400000)),
          };
        })
        // Ordered by capital at risk, not by how long it sat: the decision the panel exists to
        // support is "which pile of dead stock do I clear first", and that is a money question.
        .sort((a, b) => b.frozenValue - a.frozenValue);

      return {
        items: rows.slice(0, 12),
        count: rows.length,
        totalValue: rows.reduce((s, r) => s + r.frozenValue, 0),
        neverSold: rows.filter((r) => !r.lastSale).length,
      };
    } catch (e) {
      // A reporting panel must never take the whole report down with it.
      console.error('[getReports] Error building stagnant stock:', e);
      return empty;
    }
  }

  /**
   * Daily-bucketed series of sales/purchases/profit between from..to (inclusive).
   * If from/to omitted, covers min..max of input transactions; empty if no data.
   */
  private buildDailySeries(
    salesTx: TransactionDocument[],
    pursTx: TransactionDocument[],
    from?: string,
    to?: string,
    supplierReturns: SupplierReturnOrderDocument[] = [],
  ): Array<{ date: string; sales: number; purchases: number; orders: number }> {
    const dayKey = (d: string | Date | undefined): string => {
      if (!d) return '';
      if (d instanceof Date) return d.toISOString().slice(0, 10);
      const s = String(d);
      return s.includes('T') ? s.slice(0, 10) : s.slice(0, 10);
    };
    const allKeys = [
      ...salesTx.map((t) => dayKey(t.date)),
      ...pursTx.map((t) => dayKey(t.date)),
      ...supplierReturns.map((r) => dayKey(r.returnDate)),
    ].filter(Boolean);
    if (!from && !to && allKeys.length === 0) return [];
    const minDay = from || allKeys.sort()[0];
    const maxDay = to || allKeys.sort().slice(-1)[0];
    if (!minDay || !maxDay) return [];

    const buckets: Record<string, { sales: number; purchases: number; orders: number }> = {};
    const start = new Date(minDay + 'T00:00:00.000Z');
    const end = new Date(maxDay + 'T00:00:00.000Z');
    // Cap series length at 366 days to keep payload bounded
    const MAX_DAYS = 366;
    let dayCount = 0;
    for (let d = new Date(start); d <= end && dayCount < MAX_DAYS; d.setUTCDate(d.getUTCDate() + 1)) {
      const k = d.toISOString().slice(0, 10);
      buckets[k] = { sales: 0, purchases: 0, orders: 0 };
      dayCount++;
    }
    salesTx.forEach((tx) => {
      const k = dayKey(tx.date);
      if (buckets[k]) {
        const itemsTotal = Number(tx.itemsTotal) || (tx.total - (Number(tx.shipCost) || 0));
        buckets[k].sales += itemsTotal;
        buckets[k].orders += 1;
      }
    });
    pursTx.forEach((tx) => {
      const k = dayKey(tx.date);
      if (buckets[k]) {
        buckets[k].purchases += Number(tx.total) || 0;
      }
    });
    // Net settled supplier returns out of the day they were settled on, matching the headline KPI.
    // Clamped per-day: a return can be settled on a day with no purchases of its own, which would
    // otherwise render a negative bar.
    supplierReturns.forEach((r) => {
      const k = dayKey(r.returnDate);
      if (buckets[k]) {
        buckets[k].purchases = Math.max(
          0,
          buckets[k].purchases - (Number(r.total) || 0),
        );
      }
    });
    return Object.entries(buckets)
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private sumTransactionItemsLineTotal(tx: TransactionDocument): number {
    return Math.round(
      (tx.items || []).reduce(
        (sum, it) => sum + (Number(it.total) || 0),
        0,
      ),
    );
  }

  /**
   * مبلغ خصم الخزنة عند مرتجع: الأفضلية لـ total (استرجاع معتمد).
   * حركة استبدال تُنشأ بـ total=0 عمداً؛ الرد النقدي يمر عبر تحصيل الفرق أو مصروف.
   */
  private resolveReturnRefundVaultAmount(tx: TransactionDocument): number {
    const roundedTotal = Math.round(Number(tx.total) || 0);
    if (roundedTotal > 0) {
      return roundedTotal;
    }
    if (String(tx.notes || '').includes('استبدال')) {
      return 0;
    }
    const itemsTotal = Math.round(Number(tx.itemsTotal) || 0);
    if (itemsTotal > 0) {
      return itemsTotal;
    }
    return this.sumTransactionItemsLineTotal(tx);
  }

  private formatTxDateForVault(tx: TransactionDocument): string {
    const d = tx.date as string | Date | undefined;
    if (d == null || d === '') {
      return new Date().toISOString().split('T')[0];
    }
    if (d instanceof Date) {
      return d.toISOString().split('T')[0];
    }
    const s = String(d);
    return s.includes('T') ? s.split('T')[0] : s.slice(0, 10);
  }

  async applyPostDiscount(
    id: string,
    amount: number,
    vaultAccount: string,
    appliedBy: string,
    notes = '',
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (tx.cancelled) throw new BadRequestException('لا يمكن تطبيق خصم على معاملة ملغية');
    if (tx.type !== 'مبيعات') throw new BadRequestException('الخصم البعدي يُطبَّق على فواتير المبيعات فقط');
    const discountAmount = Math.round(amount);
    if (discountAmount <= 0) throw new BadRequestException('مبلغ الخصم يجب أن يكون أكبر من صفر');
    
    // Check vault balance before applying discount
    await this.vaultService.assertSufficientBalance(vaultAccount, discountAmount);
    
    const historyEntry = {
      editedAt: new Date().toISOString(),
      editedBy: appliedBy,
      action: 'خصم بعدي',
      before: { discount: tx.discount, total: tx.total, remaining: tx.remaining },
      discountApplied: discountAmount,
      vaultAccount,
      notes,
    };
    tx.discount = Math.round((tx.discount || 0) + discountAmount);
    tx.total = Math.max(0, Math.round(tx.total - discountAmount));
    tx.remaining = Math.max(0, Math.round((tx.remaining || 0) - discountAmount));
    if (tx.remaining <= 0) tx.payStatus = 'مكتمل';
    tx.editHistory = [...(tx.editHistory || []), historyEntry];
    const saved = await tx.save();
    const txDate = this.formatTxDateForVault(tx);
    await this.vaultService.addSystemEntry(
      -discountAmount,
      vaultAccount,
      `خصم بعدي على فاتورة #${tx.ref || tx._id} — ${tx.client || ''}${notes ? ' — ' + notes : ''}`,
      txDate,
      'خصم بعدي',
      tx.ref || String(tx._id),
    );
    return saved;
  }

  private async recordVaultForTransaction(
    tx: TransactionDocument,
  ): Promise<void> {
    const txRef = tx.ref || String(tx._id);
    const txDate = this.formatTxDateForVault(tx);
    const emp = (tx as unknown as { employee?: string }).employee || '';
    const entityCtx = tx.client
      ? (tx.type === 'مشتريات' ? { supplier: tx.client } : { customer: tx.client })
      : undefined;
    if (tx.type === 'مبيعات' && (tx.deposit || 0) > 0) {
      await this.vaultService.addSystemEntry(
        tx.deposit,
        tx.depMethod || 'كاش',
        `ديبوزت مبيعات #${txRef} — ${tx.client || ''}`,
        txDate,
        'ديبوزت مبيعات',
        txRef,
        entityCtx,
        emp,
      );
      // If collected, also record the collected remaining
      if (
        tx.payStatus === 'مكتمل' &&
        tx.collectMethod &&
        (tx.deposit || 0) < (tx.total || 0)
      ) {
        const collectedAmount = (tx.total || 0) - (tx.deposit || 0);
        if (collectedAmount > 0) {
          await this.vaultService.addSystemEntry(
            collectedAmount,
            tx.collectMethod,
            `تحصيل مُستعاد #${txRef} — ${tx.client || ''}`,
            txDate,
            'تحصيل',
            txRef,
            entityCtx,
            emp,
          );
        }
      }
    } else if (tx.type === 'مشتريات') {
      if (this.transactionAddsSupplierPurchases(tx)) {
        const depositPaid = Number(tx.deposit) || 0;
        if (depositPaid > 0) {
          await this.vaultService.addSystemEntry(
            -depositPaid,
            tx.depMethod || 'كاش',
            `مشتريات #${txRef} — ${tx.client || ''}${depositPaid < (tx.total || 0) ? ' (عربون)' : ''}`,
            txDate,
            'مشتريات',
            txRef,
            entityCtx,
            emp,
          );
        }
        if (
          tx.payStatus === 'مكتمل' &&
          tx.collectMethod &&
          (tx.total || 0) > depositPaid
        ) {
          const remainingPaid = (tx.total || 0) - depositPaid;
          await this.vaultService.addSystemEntry(
            -remainingPaid,
            tx.collectMethod,
            `دفع متبقي مشتريات #${txRef} — ${tx.client || ''}`,
            txDate,
            'دفع مشتريات',
            txRef,
            entityCtx,
            emp,
          );
        }
      } else {
        const refundAmount = this.resolveReturnRefundVaultAmount(tx);
        if (refundAmount <= 0) {
          return;
        }
        await this.vaultService.addSystemEntry(
          -refundAmount,
          tx.depMethod || 'كاش',
          `رد مرتجع للعميل #${txRef} — ${tx.client || ''}`,
          txDate,
          'رد مرتجع',
          txRef,
          entityCtx,
          emp,
        );
      }
    } else if (tx.type === 'مرتجع' || tx.type === 'مرتجع مبيعات') {
      const refundAmount = this.resolveReturnRefundVaultAmount(tx);
      if (refundAmount <= 0) {
        return;
      }
      await this.vaultService.addSystemEntry(
        -refundAmount,
        tx.depMethod || 'كاش',
        `رد مرتجع للعميل #${txRef} — ${tx.client || ''}`,
        txDate,
        'رد مرتجع',
        txRef,
        entityCtx,
        emp,
      );
    } else if (tx.type === 'مرتجع مشتريات') {
      const refundAmount = Number(tx.total) || 0;
      if (refundAmount <= 0) {
        return;
      }
      await this.vaultService.addSystemEntry(
        refundAmount,
        tx.depMethod || 'كاش',
        `رد مرتجع مشتريات #${txRef} — ${tx.client || ''}`,
        txDate,
        'مرتجع مشتريات',
        txRef,
        entityCtx,
        emp,
      );
    }
  }

  /**
   * Reverses all vault entries that were originally recorded for this transaction.
   * Used when archiving — so the vault balance is correctly adjusted back.
   */
  private async reverseVaultForTransaction(
    tx: TransactionDocument,
    reason: string,
  ): Promise<void> {
    const txRef = tx.ref || String(tx._id);
    const today = new Date().toISOString().split('T')[0];

    if (tx.cancelled) {
      // Cancelled transactions already had their deposit reversed — nothing to undo
      return;
    }

    if (tx.type === 'مبيعات') {
      const deposit = tx.deposit || 0;
      if (deposit > 0 && tx.depMethod) {
        await this.vaultService.addSystemEntry(
          -deposit,
          tx.depMethod,
          `${reason} — عكس ديبوزت #${txRef} — ${tx.client || ''}`,
          today,
          'تجميد',
          txRef,
        );
      }
      // If already collected (remaining=0, مكتمل), also reverse the collected amount
      if (tx.payStatus === 'مكتمل' && tx.collectMethod) {
        // collected = total - deposit (what was paid at collect time)
        const collectedAmount = (tx.total || 0) - deposit;
        if (collectedAmount > 0) {
          await this.vaultService.addSystemEntry(
            -collectedAmount,
            tx.collectMethod,
            `${reason} — عكس تحصيل #${txRef} — ${tx.client || ''}`,
            today,
            'تجميد',
            txRef,
          );
        }
      }
    } else if (tx.type === 'مشتريات') {
      if (this.transactionAddsSupplierPurchases(tx)) {
        // Reverse deposit (upfront payment). 0 = nothing was paid upfront.
        const depositPaid = Number(tx.deposit) || 0;
        if (depositPaid > 0 && tx.depMethod) {
          await this.vaultService.addSystemEntry(
            depositPaid, // positive: reverses the negative deposit entry
            tx.depMethod,
            `${reason} — عكس مشتريات #${txRef} — ${tx.client || ''}`,
            today,
            'تجميد',
            txRef,
          );
        }
        // If remaining was already collected (paid to supplier), reverse that too
        if (
          tx.payStatus === 'مكتمل' &&
          tx.collectMethod &&
          (tx.total || 0) > depositPaid
        ) {
          const remainingPaid = (tx.total || 0) - depositPaid;
          await this.vaultService.addSystemEntry(
            remainingPaid, // positive: reverses the negative remaining-paid entry
            tx.collectMethod,
            `${reason} — عكس دفع متبقي مشتريات #${txRef} — ${tx.client || ''}`,
            today,
            'تجميد',
            txRef,
          );
        }
      } else {
        const refundAmount = this.resolveReturnRefundVaultAmount(tx);
        if (refundAmount > 0 && tx.depMethod) {
          await this.vaultService.addSystemEntry(
            refundAmount, // positive: reverses the negative refund entry
            tx.depMethod,
            `${reason} — عكس رد مرتجع #${txRef} — ${tx.client || ''}`,
            today,
            'تجميد',
            txRef,
          );
        }
      }
    } else if (tx.type === 'مرتجع' || tx.type === 'مرتجع مبيعات') {
      const refundAmount = this.resolveReturnRefundVaultAmount(tx);
      if (refundAmount > 0 && tx.depMethod) {
        await this.vaultService.addSystemEntry(
          refundAmount, // positive: reverses the negative refund entry
          tx.depMethod,
          `${reason} — عكس رد مرتجع #${txRef} — ${tx.client || ''}`,
          today,
          'تجميد',
          txRef,
        );
      }
    } else if (tx.type === 'مرتجع مشتريات') {
      const refundAmount = Number(tx.total) || 0;
      if (refundAmount > 0 && tx.depMethod) {
        await this.vaultService.addSystemEntry(
          -refundAmount, // negative: reverses the positive inflow entry
          tx.depMethod,
          `${reason} — عكس رد مرتجع مشتريات #${txRef} — ${tx.client || ''}`,
          today,
          'تجميد',
          txRef,
        );
      }
    }
  }

  // ─── Pick-Up Management ───────────────────────────────────────────────────

  /** Return all sales transactions eligible for pick-up tracking */
  async findPickupOrders(): Promise<TransactionDocument[]> {
    return this.transactionModel
      .find({ type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true } })
      .sort({ createdAt: -1 })
      .exec();
  }

  /** Generate a unified group reference: RRR-DDMON (e.g. 104-08MAY) */
  private genPickupRef(): string {
    const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const now   = new Date();
    const day   = String(now.getDate()).padStart(2, '0');
    const month = MONTHS[now.getMonth()];
    const rnd   = Math.floor(100 + Math.random() * 900);
    return `${rnd}-${day}${month}`;
  }

  /** Move orders into Preparing state (entering a prep group) */
  async setPickupPreparing(
    ids: string[],
    by: string,
    prepRef: string,
    meta?: { note?: string; shipCo?: string; createdAt?: string; createdBy?: string },
  ): Promise<{ updated: number }> {
    const validIds = ids.filter(id => isValidObjectId(id));
    if (!validIds.length) return { updated: 0 };
    const now = new Date().toISOString().slice(0, 10);
    const result = await this.transactionModel.updateMany(
      { _id: { $in: validIds }, type: 'مبيعات', cancelled: { $ne: true }, pickupStatus: { $in: ['Pending', null] } },
      {
        $set: {
          pickupStatus: 'Preparing',
          pickupRef: prepRef,
          prepNote:      meta?.note      || '',
          prepShipCo:    meta?.shipCo    || '',
          prepCreatedAt: meta?.createdAt || now,
          prepCreatedBy: meta?.createdBy || by,
        },
        $push: { pickupHistory: { action: 'preparing', date: now, by, pickupRef: prepRef } },
      },
    );
    this.emit('pickup:updated', { ids: validIds, action: 'preparing', pickupRef: prepRef, by });
    return { updated: result.modifiedCount };
  }

  /** Confirm pick-up for one or more transaction IDs — moves to Ready */
  async confirmPickup(ids: string[], by: string, date?: string, suggestedRef?: string): Promise<{ updated: number; pickupRef: string }> {
    const validIds = ids.filter(id => isValidObjectId(id));
    if (!validIds.length) return { updated: 0, pickupRef: '' };
    const now = date || new Date().toISOString().slice(0, 10);
    const batchRef = suggestedRef || this.genPickupRef();
    const historyEntry = { action: 'ready', date: now, by, pickupRef: batchRef };
    const result = await this.transactionModel.updateMany(
      { _id: { $in: validIds }, type: 'مبيعات', cancelled: { $ne: true }, pickupStatus: { $ne: 'Delivered' } },
      {
        $set: { pickupStatus: 'Ready', pickupDate: now, pickupBy: by, pickupRef: batchRef },
        $push: { pickupHistory: historyEntry },
      },
    );
    this.emit('pickup:updated', { ids: validIds, action: 'ready', pickupRef: batchRef });

    return { updated: result.modifiedCount, pickupRef: batchRef };
  }

  /** Undo pick-up for one or more transaction IDs — reverts Ready or Preparing → Pending */
  async undoPickup(ids: string[], by: string): Promise<{ updated: number }> {
    const validIds = ids.filter(id => isValidObjectId(id));
    if (!validIds.length) return { updated: 0 };
    const now = new Date().toISOString().slice(0, 10);
    const historyEntry = { action: 'undo', date: now, by };
    const result = await this.transactionModel.updateMany(
      { _id: { $in: validIds }, type: 'مبيعات', pickupStatus: { $in: ['Ready', 'Preparing'] } },
      {
        $set: { pickupStatus: 'Pending', pickupDate: null, pickupBy: null, pickupRef: null },
        $push: { pickupHistory: historyEntry },
      },
    );
    this.emit('pickup:updated', { ids: validIds, action: 'undo' });
    return { updated: result.modifiedCount };
  }

  /** Add a single pending order to an existing pickup run (directly to Ready) */
  async addToPickupRun(id: string, pickupRef: string, by: string, date?: string): Promise<{ updated: number }> {
    if (!isValidObjectId(id) || !pickupRef) return { updated: 0 };
    const now = date || new Date().toISOString().slice(0, 10);
    const historyEntry = { action: 'ready', date: now, by, pickupRef };
    const result = await this.transactionModel.updateOne(
      { _id: id, type: 'مبيعات', cancelled: { $ne: true }, pickupStatus: { $in: ['Pending', null] } },
      {
        $set: { pickupStatus: 'Ready', pickupDate: now, pickupBy: by, pickupRef },
        $push: { pickupHistory: historyEntry },
      },
    );
    this.emit('pickup:updated', { ids: [id], action: 'ready', pickupRef });
    return { updated: result.modifiedCount };
  }

  /** Mark pick-up orders as delivered — called only when Bosta/manual delivery
   *  confirms the shipment actually arrived. Accepts either 'Ready' or 'Shipped'
   *  as the prior state — a normal Bosta-tracked order is 'Shipped' by the time
   *  Bosta reports DELIVERED, not still 'Ready'. Payment status must never drive
   *  this transition — a fully-paid order can still be sitting unshipped. */
  async markPickupDelivered(id: string, by: string): Promise<void> {
    const now = new Date().toISOString().slice(0, 10);
    await this.transactionModel.updateOne(
      { _id: id, pickupStatus: { $in: ['Ready', 'Picked-Up', 'Shipped'] } },
      {
        $set: { pickupStatus: 'Delivered' },
        $push: { pickupHistory: { action: 'delivered', date: now, by } },
      },
    );
    this.emit('pickup:updated', { ids: [id], action: 'delivered' });
  }

  /** Toggle the per-order preparation tick inside a prep group */
  async setPrepChecked(id: string, prepChecked: boolean): Promise<{ ok: boolean }> {
    if (!isValidObjectId(id)) return { ok: false };
    await this.transactionModel.updateOne({ _id: id }, { $set: { prepChecked } });
    const tx = await this.transactionModel.findById(id).select('pickupRef').lean();
    this.emit('pickup:updated', { ids: [id], action: 'prepCheck', prepChecked, pickupRef: tx?.pickupRef || null });
    return { ok: true };
  }

  /** Revert delivered → Ready when payment is reversed */
  async revertPickupDelivered(id: string, by: string): Promise<void> {
    const now = new Date().toISOString().slice(0, 10);
    await this.transactionModel.updateOne(
      { _id: id, pickupStatus: 'Delivered' },
      {
        $set: { pickupStatus: 'Ready' },
        $push: { pickupHistory: { action: 'revert-delivered', date: now, by } },
      },
    );
    this.emit('pickup:updated', { ids: [id], action: 'revert-delivered' });
  }
}
