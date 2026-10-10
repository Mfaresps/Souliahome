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
import { bostaCashoutDueAt } from '../shared/bosta-cashout.util';
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
  ShopifyOrder,
  ShopifyOrderDocument,
} from '../shopify/schemas/shopify-order.schema';
import {
  CarrierImport,
  CarrierImportDocument,
} from './schemas/carrier-import.schema';
import {
  CreateTransactionDto,
  UpdateTransactionDto,
  CancelTransactionDto,
  CollectTransactionDto,
} from './dto/transaction.dto';
import { ProductsService } from '../products/products.service';
import { VaultService } from '../vault/vault.service';
import { resolveVaultSegmentFromPaymentMethod } from '../vault/vault-segment.util';
import { PresenceGateway } from '../auth/presence.gateway';
import { MentionsService } from '../mentions/mentions.service';
import { DiscountOtpService } from '../discount-otp/discount-otp.service';
import { SettingsService } from '../settings/settings.service';
import { ShopifyAdminService } from '../shopify/shopify-admin.service';
import { DepositReceiptsService, ReceiptActor } from '../shopify/deposit-receipts.service';
import { SupplierLedgerService } from '../supplier-ledger/supplier-ledger.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import {
  InventoryMovementsService,
  RecordMovementEntry,
} from '../inventory-movements/inventory-movements.service';
import { InventoryMovementType } from '../inventory-movements/schemas/inventory-movement.schema';
import { FollowUpsService } from '../followups/followups.service';
import {
  CancelStage,
  cancelReasonDef,
  cancelReasonSummary,
  CANCEL_REASON_GROUPS,
  LEGACY_CANCEL_REASON_AR,
  LEGACY_CANCEL_REASON_CODE,
} from '../shared/cancellation.constants';
import { inDateWindow, dateWindowQuery, normalizeDateOnly } from '../shared/date-window.util';
import { normalizeCity } from '../shared/normalize-city.util';
import {
  ShipZone,
  carrierDef,
  carrierLabel,
  carrierCodeFromName,
  carrierSeedPrice,
  isValidCarrier,
  resolveCarrierForRead,
  carrierCodeFromLooseName,
  LEGACY_CARRIER_CODE,
} from '../shared/carriers.constants';

/** Tariff snapshot frozen onto a transaction — see Transaction.shipTariff. */
type TxShipTariff = {
  zone: string;
  price: number;
  source: 'settings' | 'manual' | 'shopify';
  at: string;
};

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
  /** Net of admin manual stock corrections (تسوية مخزون). Signed: negative when stock was written down. */
  adjustments: number;
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
  /** Carrier took less than the invoice tariff (automatic Bosta settlement only). */
  totalShipSaving?: number;
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
    // Read-only, for the cancellations report — orders cancelled on the Shopify page never become
    // a transaction, so they are invisible to every other query in this service.
    @InjectModel(ShopifyOrder.name)
    private readonly shopifyOrderModel: Model<ShopifyOrderDocument>,
    // Schema-only, same pattern and reason as ShopifyOrder above: fee-only carrier deductions
    // never become a transaction, so they are invisible to every other query in this service.
    @InjectModel(CarrierImport.name)
    private readonly carrierImportModel: Model<CarrierImportDocument>,
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
    // Closing a failed delivery must also close its follow-up ticket, or the
    // order says "done" while the ticket keeps escalating on somebody's screen.
    @Inject(forwardRef(() => FollowUpsService))
    private readonly followUpsService: FollowUpsService,
    private readonly depositReceiptsService: DepositReceiptsService,
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
    // Day-window bounds — see date-window.util.ts for why `$lte` is widened rather than exact.
    const window = dateWindowQuery(from, to);
    if (window) query.returnDate = window;
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

  /**
   * الحقول التقيلة اللي **بتتشال من قوائم** المعاملات.
   *
   * ⚠ `bostaRawResponse` كان **٧.٢٦ ميجا من أصل ٩.٤٥ ميجا (٧٧٪)** في `GET /transactions`
   *   على ٥٨٧ صف — ردّ خام من API شركة الشحن بيتخزن كامل لكل شحنة. بيتقرا في **شاشة
   *   واحدة بس** (مسار الطلب في `renderInvoiceViewPage`)، والقايمة عمرها ما لمسته،
   *   فكل مستخدم كان بيحمّله بالكامل في كل فتح للتطبيق.
   *
   * ⚠ ده استبعاد من **القراءات القائمية فقط**. `findById` بيرجع الدوكيومنت كامل،
   *   وصفحة الفاتورة بتجيب السجل الكامل عند الفتح (`_ivHydrateFull`). أي شاشة
   *   محتاجة الحقول دي لازم تعدّي على `GET /transactions/:id` — **متشيلهاش من هنا**.
   *
   * ⚠ متضيفش حقل جديد تقيل (raw/debug/log) للقوائم من غير ما تقيس نصيبه من الحمولة.
   */
  private static readonly LIST_EXCLUDED_FIELDS = {
    bostaRawResponse: 0,
    bostaStatusIgnoredEvents: 0,
  } as const;

  async findAll(page?: number, limit?: number): Promise<TransactionDocument[]> {
    const query = this.transactionModel
      .find({ archived: { $ne: true } })
      .select(TransactionsService.LIST_EXCLUDED_FIELDS)
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
      .select(TransactionsService.LIST_EXCLUDED_FIELDS)
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

  /**
   * Resolves the carrier for a transaction being written and freezes its tariff.
   *
   * This is the ONLY place a carrier code is validated and a tariff snapshot is built. Every write
   * path — manual create, edit, and Shopify's approveOrder — goes through it, so the three cannot
   * drift the way they did when each hand-assembled its own shipping fields.
   *
   * Rules:
   *   - Only sales carry a carrier. A purchase or a return has no outbound shipment, and writing
   *     one would put supplier invoices into the shipping report.
   *   - The code is validated against the backend's own carrier list, never trusted from the
   *     client, and an unknown code is REJECTED rather than silently dropped: a rejected save
   *     leaves the operator on screen to fix it, whereas dropping it files the shipment under
   *     «غير محدد» with nobody aware.
   *   - A caller that sends only a legacy `shipCo` name still works — the name is resolved to a
   *     code where possible. This is what keeps the change additive.
   *   - `shipCo` is DERIVED from the code so the many consumers that render it verbatim keep
   *     working untouched.
   *   - `source` records where the price came from, so a manual override is visible in reports
   *     instead of being indistinguishable from the configured tariff.
   */
  private async resolveCarrierForWrite(input: {
    type?: string;
    carrierCode?: string;
    shipCo?: string;
    shipZone?: string;
    shipCost?: number;
    /**
     * Forces `shipTariff.source`, bypassing the on/off-tariff comparison.
     *
     * Set to 'shopify' for an order whose shipping amount came from the storefront: that figure
     * is what the CUSTOMER paid, it is not derived from any carrier tariff, and measuring it
     * against one would misreport every such order as a manual override.
     */
    priceOrigin?: TxShipTariff['source'];
  }): Promise<{ carrierCode: string; shipCo: string; shipTariff: TxShipTariff | null }> {
    const rawCode = String(input.carrierCode || '').trim();
    const rawName = String(input.shipCo || '').trim();

    // Non-sales never carry a carrier.
    if (input.type && input.type !== 'مبيعات') {
      return { carrierCode: '', shipCo: rawName, shipTariff: null };
    }

    if (rawCode && !isValidCarrier(rawCode)) {
      throw new BadRequestException('شركة الشحن غير معروفة');
    }

    // Fall back to resolving the legacy free-text name; '' when it matches nothing.
    const code = rawCode || carrierCodeFromName(rawName);

    if (!code) {
      // No carrier identified — keep whatever name was sent (possibly '') and record no tariff.
      // Reports bucket this under LEGACY_CARRIER_CODE rather than dropping the row.
      return { carrierCode: '', shipCo: rawName, shipTariff: null };
    }

    const zone: ShipZone = input.shipZone === 'cairo' ? 'cairo' : 'gov';
    const price = Number(input.shipCost);
    const hasPrice = Number.isFinite(price);

    // Configured tariff wins as the reference point; the seed value only covers a carrier that was
    // never given a price in Settings. `??` not `||` — a genuinely free (0) shipment is a real
    // tariff, and treating it as missing is the falsy bug this registry exists to avoid.
    const configured = await this.carrierTariffFromSettings(code, zone);
    const reference = configured ?? carrierSeedPrice(code, zone);

    const source: TxShipTariff['source'] =
      input.priceOrigin ??
      (hasPrice && reference !== undefined && Math.round(price) !== Math.round(reference)
        ? 'manual'
        : 'settings');

    return {
      carrierCode: code,
      shipCo: this.carrierDisplayName(code),
      shipTariff: {
        zone,
        price: hasPrice ? price : (reference ?? 0),
        source,
        at: new Date().toISOString(),
      },
    };
  }

  /**
   * The carrier's configured price for a zone, or undefined when Settings holds none.
   *
   * ⚠ Matches on `code` first and only then on the display name — a settings row written before
   * the registry existed has no code until SettingsService backfills it.
   */
  private async carrierTariffFromSettings(code: string, zone: ShipZone): Promise<number | undefined> {
    try {
      const settings = await this.settingsService.getSettings();
      const cos: any[] = Array.isArray((settings as any).shipCos) ? (settings as any).shipCos : [];
      const row = cos.find((c) => (c?.code || carrierCodeFromName(c?.name || '')) === code);
      if (!row) return undefined;
      const v = zone === 'cairo' ? row.cairo : row.gov;
      return Number.isFinite(Number(v)) ? Number(v) : undefined;
    } catch {
      // Settings being unreadable must not fail a sale — fall back to the seed tariff.
      return undefined;
    }
  }

  /** Display name for a carrier: the Settings name if the operator renamed it, else the registry label. */
  private carrierDisplayName(code: string): string {
    return carrierDef(code)?.en || carrierLabel(code, 'ar');
  }

  async create(dto: CreateTransactionDto, callerRole?: string,
    receiptUpload?: { draftId: string; actor: ReceiptActor }): Promise<TransactionDocument> {
    if (dto.manualDepositReceiptId && !receiptUpload) throw new BadRequestException('أكّد فحص الإيصال قبل حفظ المعاملة');
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

    const carrier = await this.resolveCarrierForWrite({
      type: dto.type,
      carrierCode: (dto as unknown as { carrierCode?: string }).carrierCode,
      shipCo: (dto as unknown as { shipCo?: string }).shipCo,
      shipZone: (dto as unknown as { shipZone?: string }).shipZone,
      shipCost: (dto as unknown as { shipCost?: number }).shipCost,
    });

    // ⚠ `date` is normalised to YYYY-MM-DD rather than stored as the client sent it. Sending a
    //   full ISO timestamp is what produced 326 of 521 rows in the mixed state that made the
    //   last day of every report period drop those rows (see date-window.util.ts). The window
    //   helpers tolerate both formats; this stops new rows joining them.
    const receipt = receiptUpload
      ? await this.depositReceiptsService.claimManualReceipt(receiptUpload.draftId, dto, receiptUpload.actor)
      : undefined;
    let tx: TransactionDocument;
    try {
      tx = await this.transactionModel.create({
        ...dto,
        ...carrier,
        ...(receipt ? { depositReceipts: [receipt] } : {}),
        ...(dto.date ? { date: normalizeDateOnly(dto.date) } : {}),
      });
    } catch (error) {
      if (receipt) await this.depositReceiptsService.releaseManualReceipt(receipt.id);
      throw error;
    }
    if (receipt) await this.depositReceiptsService.consumeManualReceipt(receipt.id, String(tx._id));

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
        id: receipt?.id || this.genPaymentId(),
        ...(receipt ? { source: 'deposit-receipt', receiptId: receipt.id } : {}),
        amount: deposit,
        method: depMethod,
        note: 'ديبوزت أول - عند إنشاء المعاملة',
        date: new Date().toISOString(),
        by: employee,
      });
      await tx.save();
    }

    await this.recordVaultForTransaction(tx, receipt?.id);

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
    // Must mirror getInventory() exactly — this map is the oversell guard, and stock the admin
    // wrote down manually is stock that cannot be sold.
    const adjustmentsByCode =
      await this.inventoryMovementsService.getManualAdjustmentQtyByProductCode();
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
        openingBal +
          purchases +
          returnsToStock -
          sales +
          (adjustmentsByCode.get(productCodeNorm) || 0),
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
    if ((existing as any).carrierSettlement?.payoutId) {
      throw new BadRequestException('الطلب مرتبط بدفعة بوسطة؛ يلزم مراجعة تسوية الدفعة قبل تعديل قيم الطلب');
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
    const receiptDeposits = (existing.deposits || []).filter((d: any) => d.source === 'deposit-receipt' && !d.reversed);
    const vaultCorrections = this.planDepositVaultCorrections(existing, dto);
    if (receiptDeposits.length && dto.deposit !== undefined && Number(dto.deposit) !== oldDeposit) {
      throw new BadRequestException('مبالغ الإيصالات المعتمدة ثابتة — استخدم إجراءات العربون لتسجيل دفعة أو استرداد');
    }
    if (receiptDeposits.length && dto.depMethod !== undefined && dto.depMethod !== existing.depMethod) {
      throw new BadRequestException('صحّح خزنة كل دفعة على حدة، بدل نقل إجمالي العربون إلى خزنة واحدة');
    }
    if (vaultCorrections.length && dto.total !== undefined && Number(dto.total) !== Number(existing.total)) {
      throw new BadRequestException('احفظ تعديل إجمالي الفاتورة أولًا، ثم صحّح خزن الدفعات');
    }
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

    // خزنة العربون: القيمة القديمة والجديدة. `payment` احتياطي فقط لأن قيد الخزنة
    // الأصلي كُتب من `depMethod || 'كاش'` (recordVaultForTransaction) — فالمقارنة يجب
    // أن تتم على نفس الأساس، وإلا اعتُبرت معاملة قديمة بلا depMethod تغييراً وهمياً.
    const oldDepMethod = String(existing.depMethod || '').trim();
    const newDepMethod =
      (dto as unknown as { depMethod?: string }).depMethod !== undefined
        ? String((dto as unknown as { depMethod?: string }).depMethod || '').trim()
        : oldDepMethod;
    // تحويل خزنة حقيقي فقط عند وجود عربون مدفوع وتغيّر فعلي في الخزنة.
    // يُقاس على العربون **القديم** لأنه المبلغ المُقيَّد فعلاً في الخزنة القديمة؛
    // فرق المبلغ (depositDelta) يُعالَج بشكل منفصل أدناه على الخزنة الجديدة.
    const depMethodChanged =
      !!oldDepMethod &&
      !!newDepMethod &&
      oldDepMethod !== newDepMethod &&
      oldDeposit > 0 &&
      !existing.cancelled;

    // 📝 بناء رسالة التعديل
    const changes = [];
    if (totalDelta !== 0) changes.push(`الإجمالي: ${oldTotal} ← ${newTotal}`);
    if (depositDelta !== 0) changes.push(`الديبوزت: ${oldDeposit} ← ${newDeposit}`);
    if (depMethodChanged) changes.push(`خزنة العربون: ${oldDepMethod} ← ${newDepMethod}`);
    for (const c of vaultCorrections) changes.push(`خزنة الدفعة ${c.id} (${c.amount}): ${c.from} ← ${c.to}`);
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
        depMethod: oldDepMethod,
      },
      after: {
        total: newTotal,
        deposit: newDeposit,
        discount: newDiscount,
        shipCost: newShipCost,
        items: dto.items || existing.items,
        transactionDate: newTransactionDate,
        depMethod: newDepMethod,
      },
      changes,
      totalDelta,
      depositDelta,
      discountDelta,
      shipCostDelta,
    };

    const editHistory = [...(existing.editHistory || []), historyEntry];

    // Re-freeze the tariff on edit: changing the carrier, the zone or the amount all change what
    // this shipment costs and why, so a stale snapshot would describe the pre-edit invoice. Fields
    // absent from the DTO fall back to the stored values so an unrelated edit (e.g. the client
    // name) leaves the shipping record exactly as it was.
    const editCarrier = await this.resolveCarrierForWrite({
      type: existing.type,
      carrierCode:
        (dto as unknown as { carrierCode?: string }).carrierCode ?? (existing as any).carrierCode,
      shipCo: (dto as unknown as { shipCo?: string }).shipCo ?? existing.shipCo,
      shipZone: (dto as unknown as { shipZone?: string }).shipZone ?? existing.shipZone,
      shipCost: newShipCost,
      // ⚠ A Shopify order's shipping amount is what the customer paid at checkout — it is not
      // drawn from any carrier tariff, so comparing it against one is meaningless. Without this,
      // editing an unrelated field (the client's name) on such an order re-ran the tariff check,
      // found the Shopify figure differed from the configured price, and relabelled it 'manual'
      // — fabricating an operator override that never happened and corrupting the one signal the
      // reports use to spot genuine off-tariff pricing.
      priceOrigin: (existing as any).source === 'shopify' ? 'shopify' : undefined,
    });

    const { depositVaultCorrections: _corrections, ...writeDto } = dto;
    let tx: TransactionDocument | null;
    if (vaultCorrections.length) {
      const moved: typeof vaultCorrections = [];
      try {
        for (const c of vaultCorrections) {
          await this.transferDepositVaultSegment(existing,c.from,c.to,c.amount,this.formatTxDateForVault(existing),existing.ref || id,editedBy);
          moved.push(c);
        }
        const methods = new Map(vaultCorrections.map(c=>[c.id,c.to]));
        const deposits = (existing.deposits || []).map((d: any)=>methods.has(d.id)
          ? {...d,method:methods.get(d.id),note:`${d.note || ''} | تصحيح الخزنة: ${d.method} ← ${methods.get(d.id)}`} : d);
        const depositReceipts = (existing.depositReceipts || []).map((r: any)=>methods.has(r.id) ? {...r,method:methods.get(r.id)} : r);
        const primary = [...deposits].filter((d: any)=>!d.reversed && Number(d.amount)>0).sort((a: any,b: any)=>Number(b.amount)-Number(a.amount))[0];
        Object.assign(historyEntry.before, {depositVaults: vaultCorrections.map(c=>({id:c.id,amount:c.amount,method:c.from}))});
        Object.assign(historyEntry.after, {depMethod:primary?.method || existing.depMethod,depositVaults:vaultCorrections.map(c=>({id:c.id,amount:c.amount,method:c.to}))});
        tx = await this.transactionModel.findOneAndUpdate(
          {_id:id,cancelled:{$ne:true},deposits:existing.deposits,depositReceipts:existing.depositReceipts,deposit:oldDeposit},
          {...writeDto,...editCarrier,editHistory,deposits,depositReceipts,depMethod:primary?.method || existing.depMethod},
          {new:true},
        ).exec();
        if (!tx) throw new BadRequestException('تغيّرت الفاتورة أثناء تصحيح الخزن — أعد تحميلها');
      } catch(error) {
        for (const c of moved.reverse()) {
          await this.transferDepositVaultSegment(existing,c.to,c.from,c.amount,this.formatTxDateForVault(existing),existing.ref || id,editedBy);
        }
        throw error;
      }
    } else {
      tx = await this.transactionModel.findByIdAndUpdate(id, {...writeDto,...editCarrier,editHistory}, {new:true}).exec();
    }

    // يُرفع عند أي تعديل على `deposits`، ليقرر الحفظ الختامي أسفل الدالة.
    let depositsTouched = false;

    // 📋 سجل المدفوعات يتبع الخزنة المصححة: تركه على الخزنة القديمة يجعل «سجل
    // المدفوعات» يناقض قيد الخزنة الذي صُحِّح للتو على نفس الشاشة.
    if (depMethodChanged && tx && Array.isArray(tx.deposits)) {
      for (const d of tx.deposits) {
        const dep = d as unknown as { method?: string; note?: string };
        if (String(dep.method || '').trim() === oldDepMethod) {
          dep.method = newDepMethod;
          dep.note = `${dep.note || ''} | تصحيح الخزنة: ${oldDepMethod} ← ${newDepMethod}`.trim();
          depositsTouched = true;
        }
      }
      if (depositsTouched && typeof tx.markModified === 'function') {
        tx.markModified('deposits');
      }
    }

    // 📋 Record additional deposit if deposit increased during edit
    if (depositDelta > 0 && tx) {
      depositsTouched = true;
      // الخزنة المصححة، لا القديمة — الفرق يدخل حيث ذهب المال فعلاً.
      const depMethod = (depMethodChanged ? newDepMethod : oldDepMethod) || 'كاش';
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
      // ⚠ تصحيح خزنة العربون يسبق قيود الفروقات عمداً: بعده تُنشر أي فروقات مبلغ
      // على الخزنة **الجديدة**، وهو السلوك الصحيح لأن العربون كله انتقل إليها.
      if (depMethodChanged) {
        await this.transferDepositVaultSegment(
          existing,
          oldDepMethod,
          newDepMethod,
          oldDeposit,
          txDate,
          txRef,
          editedBy,
        );
      }
      /**
       * خزنة القيد. الترتيب مقصود:
       *  1) بعد التحويل صار العربون كله في الخزنة الجديدة، فالفروقات تُنشر عليها.
       *  2) `newDepMethod` قبل `existing`: معاملة بلا خزنة سابقة يُضاف لها عربون الآن
       *     تحمل خزنتها في الـDTO وحده — والقراءة من `existing` كانت تُرجع '' فيسقط
       *     القيد بالكامل عند فحص `&& depMethod`، فيدخل المال المخزن بلا أثر في الخزنة.
       *  3) `payment` احتياطي أخير (طريقة دفع المتبقي) كما كان.
       */
      const depMethod =
        (depMethodChanged ? newDepMethod : '') ||
        newDepMethod ||
        String(existing.depMethod || existing.payment || '').trim();
      /**
       * ⚠ «مكتملة» تُقاس بالمال الذي تحرَّك فعلاً (`deposit`)، لا بـ `payStatus`.
       *
       * `payStatus` مُشتَقّ من `remaining <= 0`، و`remaining = max(0, total - deposit)`.
       * لذلك فاتورة إجماليها **صفر** تُحفَظ «مكتمل» بينما `deposit = 0` — لا لأن أحداً
       * دفع، بل لأنه لا يوجد مبلغ أصلاً. القراءة القديمة (`payStatus === 'مكتمل'`) لم
       * تكن تفرّق بين «سُدِّدت بالكامل» و«لا مبلغ لها»، فكان تعديل الإجمالي لاحقاً
       * (0 ← 7,940) يُقيَّد على الخزنة كأن الفرق نقدٌ خرج/دخل فعلاً.
       *
       * الحادثة: مشتريات #900001 — أُنشئت بإجمالي 0 (فحُفظت «مكتمل» و`deposit = 0`)،
       * ثم عُدِّل إجماليها إلى 7,940 فخُصمت 7,940 من الخزنة مقابل دفعة لم تحدث،
       * بينما ظلّت الفاتورة نفسها تقول `deposit = 0` و`remaining = 7,940` أي دَيْن كامل.
       *
       * القاعدة المحاسبية: **لا يتحرك مال في الخزنة إلا بمقدار ما تحرَّك فعلاً.**
       * القيد على فرق الإجمالي مشروط بوجود سداد سابق حقيقي (`oldDeposit > 0`)؛
       * وعندها تُقيَّد الحصة النقدية فقط — انظر `cashSettledDelta` أدناه.
       */
      const oldCashSettled = oldDeposit > 0;
      const isCompleted = oldCashSettled && oldTotal > 0 && previousRemaining <= 0;

      /**
       * الحصة النقدية من التعديل — القيمة الوحيدة المسموح بتقييدها على الخزنة.
       *
       * الثابت المحاسبي: الخزنة تعكس ما دُفع فعلاً (`deposit`)، لا ما هو مستحق (`total`).
       * الفاتورة المكتملة السداد حالة خاصة فقط لأن `deposit` يلاحق `total` فيها ضمنياً:
       * لو ارتفع الإجمالي على فاتورة مسدَّدة بالكامل ولم يُسجَّل سداد جديد، فالفرق
       * **دَيْن جديد** لا نقدٌ تحرَّك — يُقيَّد في سجل المديونية أدناه، لا في الخزنة.
       *
       * لذلك يُقاس القيد دائماً على `newDeposit - oldDeposit`، مع سقف على الفاتورة
       * المكتملة: لا يتجاوز السداد إجماليها الجديد (لا يُدفع أكثر من قيمة الفاتورة).
       */
      const effOldDeposit = isCompleted ? Math.min(oldDeposit, oldTotal) : oldDeposit;
      const effNewDeposit = isCompleted
        ? Math.min(Math.max(newDeposit, 0), Math.max(newTotal, 0))
        : newDeposit;
      // تقريب لقرشين: يمنع فرقاً عائماً مثل 1e-13 من فتح قيد خزنة بصفر فعلي.
      const cashSettledDelta =
        Math.round((effNewDeposit - effOldDeposit) * 100) / 100;

      if (existing.type === 'مبيعات') {
        // يدخل الخزنة ما حصَّلناه فعلاً من العميل — بموجب فرق السداد لا فرق الإجمالي.
        if (cashSettledDelta !== 0 && depMethod) {
          const direction =
            cashSettledDelta > 0 ? 'إضافة تحصيل مبيعات' : 'خصم تحصيل مبيعات';
          const vaultNote = `${direction} فاتورة #${txRef} — ${existing.client || ''} | المحصَّل قبل: ${effOldDeposit} ج — بعد: ${effNewDeposit} ج | ${changes.join(' | ')} | بواسطة: ${editedBy}`;
          await this.vaultService.addSystemEntry(
            cashSettledDelta,
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
        // يخرج من الخزنة ما سدَّدناه فعلاً للمورد — بموجب فرق السداد لا فرق الإجمالي.
        if (cashSettledDelta !== 0 && depMethod) {
          const direction =
            cashSettledDelta > 0 ? 'زيادة سداد مشتريات' : 'تخفيض سداد مشتريات';
          const vaultNote = `${direction} #${txRef} — ${existing.client || ''} | المسدَّد قبل: ${effOldDeposit} ج — بعد: ${effNewDeposit} ج | ${changes.join(' | ')} | بواسطة: ${editedBy}`;
          await this.vaultService.addSystemEntry(
            -cashSettledDelta, // مشتريات: زيادة السداد = خصم من الخزنة
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

    // ⚠ حفظ ختامي لتغييرات `deposits` (تصحيح الخزنة + قيد الديبوزت الإضافي).
    // فرع «مشتريات» وحده كان يستدعي `tx.save()`، فكان دفع `deposits` على فاتورة
    // **مبيعات** يُكتب في الذاكرة ثم يُهمَل — `findByIdAndUpdate` أعلاه لا يشمله.
    // يُحفَظ فقط عند تعديل فعلي على `deposits` تجنباً لأي كتابة زائدة.
    if (depositsTouched && tx && typeof tx.save === 'function') {
      await tx.save();
    }

    return tx!;
  }

  /**
   * Resolves a cancellation reason from either shape into the structured triple the rest of the
   * system stores.
   *
   * Both shapes stay valid on purpose. A caller that sends `cancelReasonCode` gets the countable
   * record; a caller that only sends free text (an older client, or an internal call like the
   * failed-delivery close-out below) still works and simply lands with an empty code, which the
   * reports bucket under «غير محدد». That is what makes this additive rather than a migration.
   *
   * @throws BadRequestException when neither a code nor free text was supplied, or when the code
   *   is `other` and no note explains it — an "other" with no detail is exactly the unusable row
   *   this system exists to stop.
   */
  private resolveCancelReason(
    input: { code?: string; note?: string; text?: string },
    stage: CancelStage,
  ): { code: string; note: string; summary: string } {
    const code = String(input.code || '').trim();
    const note = String(input.note || '').trim();
    const text = String(input.text || '').trim();

    if (!code) {
      if (!text) throw new BadRequestException('يجب اختيار سبب الإلغاء');
      // Free-text-only caller: keep the text, leave the code empty.
      return { code: '', note: '', summary: text };
    }
    const def = cancelReasonDef(code);
    if (!def) throw new BadRequestException('سبب الإلغاء غير معروف');
    if (!def.stages.includes(stage)) {
      throw new BadRequestException(
        `سبب الإلغاء «${def.ar}» غير متاح لهذا النوع من الإلغاء`,
      );
    }
    if (def.requiresNote && !note) {
      throw new BadRequestException('يجب كتابة تفاصيل السبب عند اختيار «سبب آخر»');
    }
    return { code, note, summary: cancelReasonSummary(code, note) };
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
    const resolved = this.resolveCancelReason(
      {
        code: dto.cancelReasonCode,
        note: dto.cancelReasonNote,
        text: dto.cancelReason,
      },
      'transaction',
    );
    return this.performCancellation(tx, resolved.summary, dto.cancelledBy, {
      code: resolved.code,
      note: resolved.note,
      stage: 'transaction',
    });
  }

  private async performCancellation(
    tx: TransactionDocument,
    reason: string,
    cancelledBy: string,
    structured?: { code?: string; note?: string; stage?: CancelStage },
  ): Promise<TransactionDocument> {
    if ((tx as any).carrierSettlement?.payoutId) {
      throw new BadRequestException('الطلب مرتبط بتحويل بوسطة مجمع — يلزم تسوية الدفعة قبل إلغاء الطلب');
    }
    // An automatic Bosta settlement is undone FIRST and the document reloaded. Left in place, the
    // COD reversal below would subtract the full COD (510) where the settlement booked the net
    // (396), and the shipping outflow of a prepaid order would never come back.
    if ((tx as any).carrierSettlement?.status === 'settled') {
      await this.reverseCarrierSettlement(String(tx._id), cancelledBy, 'cancel');
      const fresh = await this.transactionModel.findById(tx._id).exec();
      if (fresh) tx = fresh;
    }
    const previousDeposit = tx.deposit || 0;
    const previousTotal = tx.total || 0;
    const previousRemaining = tx.remaining || 0;
    const previousPayStatus = tx.payStatus;
    const previousCollectMethod = tx.collectMethod;

    tx.cancelled = true;
    tx.cancelReason = reason;
    // Structured fields are additive: an internal caller that passes only free text (the
    // failed-delivery close-out, for instance) leaves them empty and the reports count that row
    // under «غير محدد» rather than losing it.
    tx.cancelReasonCode = structured?.code || '';
    tx.cancelReasonNote = structured?.note || '';
    tx.cancelStage = structured?.stage || 'transaction';
    tx.cancelledBy = cancelledBy;
    tx.cancelledAt = new Date().toISOString();

    // عند الإلغاء: إرجاع حالة الحركة إلى ما كانت عليه أصلاً
    // لا نضع "ملغي" مباشرة، بل نرجع الحالة الأصلية
    // (معلق للحركات المعلقة، مكتملة للحركات المكتملة، إلخ)
    // الحركة الملغاة تُعتبر نهائية
    tx.payStatus = 'ملغي';

    // استرجاع الرصيد المحجوز إلى القيمة الأصلية عند الإلغاء الكامل
    tx.remaining = previousTotal;

    // Receipt deposits can span several vaults. Keep the sale live until every refund succeeds,
    // and persist each completed segment so a retry never refunds that segment twice.
    const deferReceiptCancellation = tx.type === 'مبيعات' &&
      (tx.deposits || []).some((d: any) => d.source === 'deposit-receipt');
    const saved = deferReceiptCancellation ? tx : await tx.save();
    if (deferReceiptCancellation) {
      tx.cancelled = false;
      tx.payStatus = previousPayStatus;
      tx.remaining = previousRemaining;
    }

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
      // مبيعات / مرتجع: refund deposit to client — deduct from vault.
      //
      // ⚠ A Shopify sale's deposit can be several approved transfer receipts landing in DIFFERENT
      //   segments (500 Instapay + 300 cash). Each receipt is refunded from the segment it came
      //   into; refunding the whole deposit from `depMethod` would overdraw one segment and leave
      //   another holding money that is no longer ours. Whatever the receipts do not explain
      //   (an older single deposit) still goes back through `depMethod`, as before.
      //   If the receipts add up to MORE than the deposit (it was edited down after confirmation),
      //   they no longer describe it and the old single refund is used.
      const receiptLines = (saved.deposits || []).filter((d: any) => d?.source === 'deposit-receipt' && !d.reversed);
      const byMethod = new Map<string, number>();
      for (const d of receiptLines) byMethod.set(d.method || vaultMethod, (byMethod.get(d.method || vaultMethod) || 0) + (Number(d.amount) || 0));
      const receiptSum = Array.from(byMethod.values()).reduce((s, v) => s + v, 0);
      if (receiptSum > previousDeposit + 0.005) byMethod.clear();
      const fromReceipts = byMethod.size ? receiptSum : 0;
      const rest = Math.round((previousDeposit - fromReceipts) * 100) / 100;
      const today = new Date().toISOString().split('T')[0];
      const ref = tx.ref || String(tx._id);
      if (rest > 0.005) byMethod.set(vaultMethod, (byMethod.get(vaultMethod) || 0) + rest);
      for (const [method, amount] of byMethod) {
        if (amount <= 0) continue;
        const already = deferReceiptCancellation
          ? (tx.cancellationDepositRefunds || []).filter(r => r.method === method).reduce((s,r)=>s+r.amount,0)
          : 0;
        const due = Math.round((amount - already) * 100) / 100;
        if (due <= 0.005) continue;
        const entry = await this.vaultService.addSystemEntry(
          -due,
          method,
          `إلغاء معاملة #${ref} — رد عربون ${method} — ${tx.client || ''} (بواسطة: ${cancelledBy})`,
          today,
          'إلغاء',
          ref,
        );
        if (deferReceiptCancellation) {
          tx.cancellationDepositRefunds = [...(tx.cancellationDepositRefunds || []),
            {method,amount:due,vaultEntryId:String(entry?._id || ''),at:new Date().toISOString()}];
          tx.cancelled = false;
          tx.payStatus = previousPayStatus;
          tx.remaining = previousRemaining;
          await tx.save();
        }
      }
    }
    if (deferReceiptCancellation) {
      tx.cancelled = true;
      tx.payStatus = 'ملغي';
      tx.remaining = previousTotal;
      await tx.save();
    }
    try {
      const movementInfo = this.classifyInventoryMovement(saved);
      if (movementInfo) {
        const invSnapshot = await this.getInventory();
        const invByCode = new Map(invSnapshot.map((r) => [String(r.code).trim(), r]));
        const movementEntries: RecordMovementEntry[] = [];
        // ⚠ The movement TYPE has to describe the effect on stock, not the type of
        // the transaction being undone. `classifyInventoryMovement` answers "what
        // is this transaction?" — for a sale it returns 'مبيعات', and cancelling
        // only flips the sign. The log then read «مبيعات +1»: a sale that ADDED
        // stock, which is a contradiction on its face and makes the log
        // un-filterable (filtering "مبيعات" returns rows that are really returns).
        // A cancelled sale puts goods back, so it is 'مرتجع مبيعات'; a cancelled
        // purchase takes them out, so it is 'مرتجع مشتريات'.
        const reversalType: InventoryMovementType =
          movementInfo.sign === -1 ? 'مرتجع مبيعات' : 'مرتجع مشتريات';
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
            type: reversalType,
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

  // ══════════════════════════════════════════════════════════════════════════
  //  FAILED DELIVERY — the closing decision
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Blocks operations that contradict an unresolved delivery failure.
   *
   * The courier has returned the shipment and nobody has recorded what happened
   * yet, so the transaction is NOT cancelled — which means every guard written
   * as `if (tx.cancelled)` still lets the operation through. Two of them cause
   * real damage:
   *
   *  • **Collection** would post a vault entry for money the customer never
   *    paid, on goods that are coming back to the shelf.
   *  • **Manual delivery confirmation** writes `deliveredAt`, and
   *    `closeFailedDelivery` refuses any order carrying it (an order that
   *    reached the customer is a customer return, not a failed delivery). One
   *    mis-click therefore strands the order in a state with no exit: it can
   *    neither be closed here nor routed to the returns module, on goods that
   *    were never delivered to anyone.
   *
   * The UI disables both buttons, but both functions are global and reachable
   * from the console — hiding a control is never the guard.
   */
  private assertNoOpenShipIssue(tx: TransactionDocument, action: string): void {
    const state = (tx as any).shipIssueState || '';
    if (state !== 'open' && state !== 'awaiting') return;
    throw new BadRequestException(
      `${action} غير متاح: شركة الشحن رجّعت هذا الطلب ولم تُنهَ معالجته بعد — افتح الفاتورة وأكّد استلام الشحنة أولاً`,
    );
  }

  /** Arabic label per outcome — used in the cancel reason, the ticket and the UI. */
  private static readonly FAILED_DELIVERY_OUTCOMES: Record<string, string> = {
    refused:       'رفض الاستلام',
    unreachable:   'تعذّر الوصول للعميل',
    'bad-address': 'عنوان أو بيانات غلط',
    'courier-error': 'خطأ شركة الشحن',
    lost:          'الشحنة ضاعت عند شركة الشحن',
  };

  /**
   * Closes a failed delivery. This is the end of the line the whole feature exists for.
   *
   * What it does, and the reasoning behind each part:
   *
   * • **The sale is cancelled, not returned.** The customer never received the
   *   goods, so nothing was sold. Recording this as a customer return would
   *   inflate both gross sales (a sale that collected nothing stays counted) and
   *   returns (goods the customer never saw), leaving net correct by coincidence
   *   and the "most returned products" report a lie. `performCancellation` also
   *   brings the stock back on its own — stock is derived from non-cancelled
   *   transactions — and writes the reversing rows into the movement log. Writing
   *   an InventoryMovement by hand would log a return the balance never made.
   *
   * • **`returnShipCost` never touches the vault.** The courier nets return fees
   *   out of other orders' payouts, so the vault already falls by that amount
   *   when the smaller transfer lands. Posting it here too would take the same
   *   pound twice. It is recorded on the order (`shipLoss`) so reports can cost
   *   the failure; the cash side is already handled by arithmetic nobody has to
   *   perform.
   *
   * • **Held money is refunded minus the shipping the company ate.**
   *   `performCancellation` refunds the full deposit, so the retained shipping is
   *   posted back as a separate positive entry. Two lines that each explain
   *   themselves beat one netted line that explains nothing.
   *
   * • **`lost` brings no stock back.** The shipment is not on our shelf. This is
   *   the one outcome that must not cancel — cancelling would credit us stock we
   *   do not have — so it records the loss and closes without touching inventory.
   */
  async closeFailedDelivery(
    id: string,
    dto: {
      outcome: string;
      returnShipCost?: number;
      refundAmount?: number;
      note?: string;
    },
    by: string,
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');

    const outcome = String(dto.outcome || '');
    const outcomeLabel = TransactionsService.FAILED_DELIVERY_OUTCOMES[outcome];
    if (!outcomeLabel) throw new BadRequestException('سبب إنهاء المعالجة غير معروف');

    if ((tx as any).failedDelivery) {
      throw new BadRequestException('تم إنهاء معالجة هذا الطلب بالفعل');
    }
    if (tx.type !== 'مبيعات') {
      throw new BadRequestException('معالجة فشل التوصيل تخص حركات المبيعات فقط');
    }
    // Same guard `cancel()` applies — this path reaches performCancellation
    // directly, so skipping it would let the one case cancellation forbids
    // through a side door.
    this.assertNotExchangePendingCollect(tx);
    // A shipment that reached the customer is a customer return, and refunding it
    // has rules this path does not implement (ceiling, approval, condition).
    if ((tx as any).deliveredAt && outcome !== 'courier-error') {
      throw new BadRequestException(
        'هذا الطلب تم تسليمه للعميل — رجوعه بعد التسليم يمشي على مسار مرتجعات العملاء وليس فشل التوصيل',
      );
    }

    const goodsBack = outcome !== 'lost';
    const returnShipCost = Math.max(0, Number(dto.returnShipCost) || 0);

    // Money the company is holding for this order: a prepaid/deposit amount, or
    // a COD that was collected before the shipment came back.
    const heldByUs = Math.max(0, Number(tx.deposit) || 0);
    const requestedRefund = dto.refundAmount === undefined ? heldByUs : Math.max(0, Number(dto.refundAmount) || 0);
    if (requestedRefund > heldByUs) {
      throw new BadRequestException(
        `المبلغ المطلوب رده (${requestedRefund}) أكبر من المحصّل فعلاً من العميل (${heldByUs})`,
      );
    }
    const refundAmount = heldByUs > 0 ? requestedRefund : 0;
    const shipRetained = Math.max(0, heldByUs - refundAmount);

    const now = new Date().toISOString();
    let retainedVaultEntryId = '';

    if (goodsBack) {
      // Cancels, refunds the full deposit to the vault, reverses a collected COD,
      // returns the stock and writes the movement rows.
      await this.performCancellation(tx, `فشل توصيل — ${outcomeLabel}`, by);

      // performCancellation gave the customer back everything they paid. Whatever
      // the shop keeps against the shipping it ate comes back as its own entry,
      // so the ledger reads "refunded 1000, kept 120" rather than a bare 880.
      if (shipRetained > 0) {
        try {
          const entry = await this.vaultService.addSystemEntry(
            shipRetained,
            (tx as any).depMethod || tx.payment || 'كاش',
            `شحن غير مسترد — فشل توصيل طلب #${tx.ref || String(tx._id)} (${outcomeLabel})`,
            now.split('T')[0],
            // ⚠ Must be one of the values the vault log's type filter offers, or
            // the entry becomes invisible to every filter on that page.
            'تحصيل',
            tx.ref || String(tx._id),
            { customer: tx.client || '' },
            by,
            { linkedTransactionId: String(tx._id) },
          );
          retainedVaultEntryId = String(entry._id);
        } catch (err) {
          // The refund already went out. A failure to re-book the retained
          // shipping leaves the customer correctly paid and the shop short by
          // that amount — wrong, but recoverable by hand, and far better than
          // failing the close and leaving the refund half-applied.
          this.logger.error(
            `[closeFailedDelivery] SHIP_RETENTION_FAILED tx=${tx.ref || tx._id} amount=${shipRetained}: ${(err as Error).message}`,
          );
        }
      }
    }

    const finalTx = await this.transactionModel
      .findByIdAndUpdate(
        id,
        {
          $set: {
            shipIssueState: 'closed',
            // ⚠ Recorded on the order, deliberately NOT posted to the vault.
            shipLoss: (Number(tx.shipLoss) || 0) + returnShipCost,
            failedDelivery: {
              outcome,
              goodsBack,
              returnShipCost,
              refundAmount,
              shipRetained,
              retainedVaultEntryId,
              note: String(dto.note || ''),
              closedAt: now,
              closedBy: by,
            },
          },
        },
        { new: true },
      )
      .exec();

    await this.followUpsService.closeShippingIssueFollowUp(String(id), outcomeLabel, by);

    this.emit('tx:updated', { _id: String(id) });
    this.emit('inventory:changed', { reason: 'failed-delivery:closed', txId: String(id) });
    this.logger.log(
      `Failed delivery closed — tx=${tx.ref || id} outcome=${outcome} goodsBack=${goodsBack} ` +
      `refund=${refundAmount} retained=${shipRetained} returnShip=${returnShipCost} by=${by}`,
    );
    return finalTx as TransactionDocument;
  }

  /**
   * Marks the goods as still on their way back, without closing anything.
   * The courier reports RETURNED days before the shipment physically arrives, so
   * "yes I have it" and "the courier says it's coming" are different answers and
   * only the first may release the order from the card.
   */
  async markFailedDeliveryAwaiting(id: string, by: string): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if ((tx as any).failedDelivery) throw new BadRequestException('تم إنهاء معالجة هذا الطلب بالفعل');

    const updated = await this.transactionModel
      .findByIdAndUpdate(id, { $set: { shipIssueState: 'awaiting' } }, { new: true })
      .exec();
    this.emit('tx:updated', { _id: String(id) });
    this.logger.log(`Failed delivery marked awaiting return — tx=${tx.ref || id} by=${by}`);
    return updated as TransactionDocument;
  }

  /**
   * Sends the order out again on a NEW waybill.
   *
   * ⚠ It does not create a second transaction. The courier needs a new waybill —
   * a returned one cannot be reused — but the sale is the same sale: the same
   * customer owes the same money for the same goods. A duplicate transaction
   * would collide on the reference (sales refs are unique and digits-only) and
   * would count the revenue and the stock deduction twice, which is only
   * survivable by cancelling the original — and cancelling it would push the
   * customer's already-paid money back through the vault and in again, two
   * entries for cash that never moved.
   *
   * The previous waybill is pushed onto `shipmentAttempts` first, because
   * `bostaOrderId` / `bostaTrackingNumber` are single fields and creating the new
   * shipment overwrites them, erasing the attempt that failed.
   */
  async reshipFailedDelivery(
    id: string,
    dto: { addShipCost?: number; chargeCustomer?: boolean; note?: string },
    by: string,
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (tx.cancelled) throw new BadRequestException('المعاملة ملغاة');
    if ((tx as any).failedDelivery) throw new BadRequestException('تم إنهاء معالجة هذا الطلب بالفعل');

    const addShipCost = Math.max(0, Number(dto.addShipCost) || 0);
    const chargeCustomer = dto.chargeCustomer !== false; // default: the customer pays for the retry
    const attempts = ((tx as any).shipmentAttempts || []) as any[];
    const now = new Date().toISOString();

    const set: Record<string, unknown> = {
      shipIssueState: 'reshipped',
      // Cleared so the new journey starts from scratch; the old codes live on in
      // the attempt entry pushed below.
      bostaStatus: '',
      bostaStatusLabel: '',
      bostaShippingStatus: '',
      bostaOrderId: '',
      bostaTrackingNumber: '',
      // ⚠ NOT 'Ready'. `_dashShipStatus` reads pickupStatus === 'Ready' as the
      // CREATED stage, so the order appeared in «قيد الشحن» as a live shipment
      // the moment reship was pressed — before anyone sent anything to the
      // courier and with no waybill to track. 'Preparing' is the truthful state:
      // it is being made ready to go out again, and the card ignores it until a
      // real Bosta order exists.
      pickupStatus: 'Preparing',
      shippedAt: null,
    };

    if (addShipCost > 0) {
      if (chargeCustomer) {
        // The retry is billed to the customer: the order grows and so does what
        // is still owed on it, which is what the courier will collect.
        set.shipCost = (Number(tx.shipCost) || 0) + addShipCost;
        set.total = (Number(tx.total) || 0) + addShipCost;
        set.remaining = (Number(tx.remaining) || 0) + addShipCost;
        set.payStatus = 'معلق';
      } else {
        // The shop eats it — same treatment as the return leg: a cost on the
        // order, no vault entry.
        set.shipLoss = (Number(tx.shipLoss) || 0) + addShipCost;
      }
    }

    const updated = await this.transactionModel
      .findByIdAndUpdate(
        id,
        {
          $set: set,
          $push: {
            shipmentAttempts: {
              attemptNo: attempts.length + 1,
              bostaOrderId: (tx as any).bostaOrderId || '',
              bostaTrackingNumber: (tx as any).bostaTrackingNumber || '',
              finalStatus: (tx as any).bostaStatus || '',
              shipCost: Number(tx.shipCost) || 0,
              chargedToCustomer: chargeCustomer,
              startedAt: (tx as any).shippedAt || '',
              endedAt: now,
              by,
            },
          },
        },
        { new: true },
      )
      .exec();

    await this.followUpsService.closeShippingIssueFollowUp(
      String(id),
      `إعادة شحن — محاولة رقم ${attempts.length + 2}`,
      by,
    );

    this.emit('tx:updated', { _id: String(id) });
    this.logger.log(
      `Reship prepared — tx=${tx.ref || id} attempt=${attempts.length + 2} addShip=${addShipCost} chargeCustomer=${chargeCustomer} by=${by}`,
    );
    return updated as TransactionDocument;
  }

  /**
   * Backfills `shipIssueState` on orders that came back before this feature
   * existed. Without it those orders sit in the card with no way to answer the
   * receipt question — the card only offers it on rows carrying the state.
   *
   * Only ever opens an issue on an order that is not cancelled, was never
   * delivered, and has no closing decision — so running it twice is harmless.
   * `dryRun` defaults to true, matching the Shopify movement backfill.
   */
  async backfillShipIssueState(refs: string[] | undefined, dryRun: boolean): Promise<{
    scanned: number;
    updated: number;
    dryRun: boolean;
    rows: Array<{ ref: string; client: string; bostaStatus: string; action: string }>;
  }> {
    const query: Record<string, unknown> = {
      type: 'مبيعات',
      cancelled: { $ne: true },
      bostaStatus: { $in: ['RETURNED', 'FAILED_ATTEMPT'] },
    };
    if (refs?.length) query.ref = { $in: refs.map((r) => String(r).replace(/^#+/, '').trim()) };

    const candidates = await this.transactionModel.find(query).exec();
    const rows: Array<{ ref: string; client: string; bostaStatus: string; action: string }> = [];
    let updated = 0;

    for (const tx of candidates) {
      const ref = tx.ref || String(tx._id);
      if ((tx as any).failedDelivery) {
        rows.push({ ref, client: tx.client || '', bostaStatus: (tx as any).bostaStatus || '', action: 'تم إنهاؤه سابقاً — تُخُطّي' });
        continue;
      }
      if ((tx as any).deliveredAt) {
        rows.push({ ref, client: tx.client || '', bostaStatus: (tx as any).bostaStatus || '', action: 'تم تسليمه — مرتجع عميل وليس فشل توصيل' });
        continue;
      }
      if ((tx as any).shipIssueState) {
        rows.push({ ref, client: tx.client || '', bostaStatus: (tx as any).bostaStatus || '', action: 'مفتوح بالفعل — تُخُطّي' });
        continue;
      }
      rows.push({ ref, client: tx.client || '', bostaStatus: (tx as any).bostaStatus || '', action: 'سيُفتح للمعالجة' });
      if (!dryRun) {
        await this.transactionModel.updateOne(
          { _id: tx._id },
          {
            $set: {
              shipIssueState: 'open',
              shipIssueTrigger: (tx as any).bostaStatus || 'RETURNED',
              shipIssueOpenedAt: (tx as any).bostaLastSync || tx.date || new Date().toISOString(),
            },
          },
        ).exec();
        updated++;
      }
    }

    if (updated > 0) this.emit('tx:updated', { _id: '' });
    this.logger.log(`backfillShipIssueState — scanned=${candidates.length} updated=${updated} dryRun=${dryRun}`);
    return { scanned: candidates.length, updated, dryRun, rows };
  }

  /**
   * Closes shipping issues the courier already resolved.
   *
   * The mirror of the backfill above, and it exists for the same reason: the
   * webhook only ever *opened* `shipIssueState`, so an order Bosta reported as
   * a problem and then delivered kept its issue open forever — a green
   * `Delivered` badge sitting next to a red "معالجة الطلب" button on one row,
   * with `assertNoOpenShipIssue` still blocking actions on a finished order.
   *
   * `bosta.service.ts` now closes these as the status arrives; this catches the
   * orders that were already stuck when that shipped.
   *
   * Only touches 'open'/'awaiting' — 'reshipped' and 'closed' are human
   * decisions. Idempotent: a second run finds nothing left to close.
   * `dryRun` defaults to true, matching every other backfill in this file.
   */
  async backfillResolvedShipIssues(refs: string[] | undefined, dryRun: boolean): Promise<{
    scanned: number;
    updated: number;
    dryRun: boolean;
    rows: Array<{ ref: string; client: string; bostaStatus: string; action: string }>;
  }> {
    const query: Record<string, unknown> = {
      type: 'مبيعات',
      cancelled: { $ne: true },
      shipIssueState: { $in: ['open', 'awaiting'] },
    };
    if (refs?.length) query.ref = { $in: refs.map((r) => String(r).replace(/^#+/, '').trim()) };

    const candidates = await this.transactionModel.find(query).exec();
    const rows: Array<{ ref: string; client: string; bostaStatus: string; action: string }> = [];
    const RESOLVING = ['DELIVERED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'PICKED_UP'];
    let updated = 0;

    for (const tx of candidates) {
      const ref = tx.ref || String(tx._id);
      const bostaStatus = (tx as any).bostaStatus || '';
      const client = tx.client || '';
      const delivered = !!(tx as any).deliveredAt || bostaStatus === 'DELIVERED';

      // Not resolved: the courier still reports a problem and nobody has acted.
      // These are genuinely open and must stay on the card.
      if (!delivered && !RESOLVING.includes(bostaStatus)) {
        rows.push({ ref, client, bostaStatus, action: 'مشكلة قائمة فعلاً — تُترك مفتوحة' });
        continue;
      }

      rows.push({
        ref, client, bostaStatus,
        action: delivered ? 'تم تسليمه — ستُغلق المعالجة' : `عاد للطريق (${bostaStatus}) — ستُغلق المعالجة`,
      });
      if (!dryRun) {
        const trigger = (tx as any).shipIssueTrigger || 'RETURNED';
        await this.transactionModel.updateOne(
          { _id: tx._id },
          {
            $set: {
              shipIssueState: 'closed',
              // The trail is kept on purpose — see the same block in
              // bosta.service.ts. `shipIssueTrigger`/`shipIssueOpenedAt` are
              // left as written so the failed attempt stays visible.
              failedDelivery: {
                outcome: delivered ? 'delivered-after-issue' : 'back-in-transit',
                goodsBack: false,
                returnShipCost: 0,
                refundAmount: 0,
                shipRetained: 0,
                note: delivered
                  ? `أبلغت شركة الشحن عن مشكلة (${trigger}) ثم سلّمت الطلب — أُغلقت المعالجة بأثر رجعي`
                  : `أبلغت شركة الشحن عن مشكلة (${trigger}) ثم عادت الشحنة للطريق (${bostaStatus}) — أُغلقت المعالجة بأثر رجعي`,
                closedAt: new Date().toISOString(),
                closedBy: 'system:backfill',
              },
            },
          },
        ).exec();
        updated++;
      }
    }

    if (updated > 0) this.emit('tx:updated', { _id: '' });
    this.logger.log(`backfillResolvedShipIssues — scanned=${candidates.length} updated=${updated} dryRun=${dryRun}`);
    return { scanned: candidates.length, updated, dryRun, rows };
  }

  async requestCancel(
    id: string,
    reason: string,
    requestedBy: string,
    requestedById?: string,
    requestedByUsername?: string,
    reasonCode?: string,
    reasonNote?: string,
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
    // Validated here, at submission, rather than at approval: a request that carries an invalid
    // or note-less reason must be rejected while the requester is still on screen to fix it.
    const resolved = this.resolveCancelReason(
      { code: reasonCode, note: reasonNote, text: reason },
      'transaction',
    );
    const updated = await this.transactionModel
      .findByIdAndUpdate(
        id,
        {
          cancelRequest: {
            requestedBy,
            requestedById: requestedById || '',
            requestedByUsername: requestedByUsername || '',
            reason: resolved.summary,
            cancelReasonCode: resolved.code,
            cancelReasonNote: resolved.note,
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
      cancelReasonCode?: string;
      cancelReasonNote?: string;
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
    // The requester's reason is the cancellation's reason — the approver decides whether it
    // happens, not why. Carrying the code through is what keeps request→approve cancellations
    // countable alongside direct ones instead of all landing in «غير محدد».
    const result = await this.performCancellation(tx, reason, requestedBy, {
      code: requester.cancelReasonCode || '',
      note: requester.cancelReasonNote || '',
      stage: 'transaction',
    });
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

  /**
   * إغلاق تنبيه تعارض العنوان بعد الشحن.
   *
   * ⚠ لا يُعدّل shippingAddress إطلاقاً. العنوان المخزَّن هو العنوان الذي شُحنت عليه
   *   الشحنة فعلاً، وهو الحقيقة التي تصف أين ذهبت. الإغلاق يسجّل فقط أن إنساناً تعامل
   *   مع الأمر — النظام لا يستطيع معرفة ذلك بنفسه لأن Bosta لا تعرض تعديلاً للعنوان.
   *
   * تعارض جديد بعد الإغلاق يعيد فتح الحالة (handleOrderUpdate يكتب resolved:false)،
   * لأن تغييراً ثانياً للعنوان واقعة مستقلة تستحق قراراً مستقلاً.
   */
  /**
   * إغلاق أي من تنبيهات تعارض شوبيفاي على الحركة.
   *
   * ⚠ الإغلاق إقرار بشري فقط — لا يُلغي حركة ولا يعدّل عنواناً ولا يحرّك خزنة. النظام لا
   *   يستطيع معرفة أن الموظف اتصل ببوسطا أو ألغى الحركة يدوياً، ولا يجوز أن يستنتج ذلك.
   */
  async resolveShopifyConflict(id: string, kind: string, by: string) {
    const FIELDS: Record<string, string> = {
      address: 'addressChangeConflict',
      cancel: 'shopifyCancelConflict',
      fulfillment: 'externalFulfillment',
    };
    const field = FIELDS[kind];
    if (!field) throw new BadRequestException('نوع التنبيه غير معروف');

    const tx: any = await this.transactionModel.findById(id);
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (!tx[field]) throw new BadRequestException('لا يوجد تنبيه من هذا النوع على المعاملة');

    tx[field] = {
      ...tx[field],
      resolved: true,
      resolvedBy: by,
      resolvedAt: new Date().toISOString(),
    };
    tx.markModified(field);
    await tx.save();
    return { success: true, transaction: tx.toObject() };
  }

  async resolveAddressConflict(id: string, by: string) {
    const tx: any = await this.transactionModel.findById(id);
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    if (!tx.addressChangeConflict) {
      throw new BadRequestException('لا يوجد تعارض عنوان على هذه المعاملة');
    }
    tx.addressChangeConflict = {
      ...tx.addressChangeConflict,
      resolved: true,
      resolvedBy: by,
      resolvedAt: new Date().toISOString(),
    };
    tx.markModified('addressChangeConflict');
    await tx.save();
    return { success: true, transaction: tx.toObject() };
  }

  /** Close an order belonging to a single bank payout. The payout owns the only vault entry. */
  async finalizeCarrierPayoutOrder(id: string, payoutId: string, date: string, by: string): Promise<void> {
    const tx: any = await this.transactionModel.findById(id).lean().exec();
    if (!tx) throw new NotFoundException('طلب دفعة بوسطة غير موجود');
    const cs = tx.carrierSettlement;
    if (cs?.payoutId !== payoutId) throw new BadRequestException('الطلب لا ينتمي لدفعة التحويل');
    if (cs.finalizedPayoutId === payoutId) return;
    if (tx.cancelled || Number(tx.remaining || 0) !== Number(cs.remaining || 0)) {
      throw new BadRequestException('تغيّرت حالة الطلب أثناء تجهيز دفعة بوسطة');
    }
    const round = (n: number) => Math.round(n * 100) / 100;
    const cod = Number(cs.carrierCod) || 0;
    const now = new Date().toISOString();
    const snapshotBefore = Object.fromEntries([
      'deposit', 'remaining', 'payStatus', 'collectMethod', 'collectNote', 'collectedAt',
      'actualShipCost', 'shipLoss', 'shipSaving', 'codCollectionStatus', 'codCollectedBy',
      'codCollectedAt', 'codCollectionMethod',
    ].map(k => [k, tx[k] ?? (['deposit', 'remaining', 'actualShipCost', 'shipLoss', 'shipSaving'].includes(k) ? 0 : '')]));
    const paymentId = `carrier_${payoutId}_${id}`;
    const cashoutAt = bostaCashoutDueAt({ wallet: { cashout: { next_cashout_date: date } } });
    const next = {
      actualShipCost: Number(cs.fees?.priceAfterVat) || 0,
      shipLoss: round((Number(tx.shipLoss) || 0) + (Number(cs.shipLossAdd) || 0)),
      shipSaving: round((Number(tx.shipSaving) || 0) + (Number(cs.shipSavingAdd) || 0)),
      ...(cod > 0 ? {
        deposit: round((Number(tx.deposit) || 0) + cod), remaining: 0, payStatus: 'مكتمل',
        collectMethod: cs.vaultMethod, collectNote: `ضمن دفعة بوسطة ${payoutId}`, collectedAt: date,
        codCollectionStatus: 'Collected', codCollectedBy: by, codCollectedAt: now, codCollectionMethod: cs.vaultMethod,
      } : {}),
      carrierSettlement: { ...cs, status: 'settled', phase: 'bank', finalizedPayoutId: payoutId,
        scheduledCashoutDueAt: cs.cashoutDueAt, cashoutDueAt: cashoutAt,
        settledAt: now, settledBy: by, bookDate: date, snapshotBefore,
        collectPaymentId: cod > 0 ? paymentId : '', collectVaultEntryId: '', shortfallVaultEntryId: '' },
    };
    const result = await this.transactionModel.updateOne(
      { _id: id, 'carrierSettlement.payoutId': payoutId, 'carrierSettlement.finalizedPayoutId': { $ne: payoutId },
        cancelled: { $ne: true }, remaining: tx.remaining },
      { $set: next, $push: {
        ...(cod > 0 ? { payments: { id: paymentId, amount: cod, collectedAmount: cod, method: cs.vaultMethod,
          note: `تحصيل ضمن دفعة بوسطة ${payoutId}`, date: cashoutAt, by,
          remaining: tx.remaining, vaultDelta: 0, carrierPayoutId: payoutId, snapshotBefore } } : {}),
        codCollectionHistory: { action: 'carrier-settled', by, at: now, amount: cod, method: cs.vaultMethod,
          note: `دفعة مجمعة ${payoutId} — مستحقات بوسطة ${next.actualShipCost} ج` },
      }, $inc: { __v: 1 } },
    ).exec();
    if (!result.modifiedCount) throw new BadRequestException('تغيّر الطلب أثناء تسوية دفعة بوسطة');
    this.emit('tx:updated', { _id: id });
  }

  async collect(
    id: string,
    dto: CollectTransactionDto,
    by = 'مستخدم',
    callerRole = '',
    callerPerms: string[] = [],
    /**
     * Internal callers only — deliberately NOT a DTO field, so no HTTP request can switch it on.
     * `carrierActual`: the carrier's real charge (dto.actualShipCost) is deducted EXACTLY, so a
     * carrier that took less than the tariff credits the difference to the vault (shipSaving).
     * Without it the full billed tariff is deducted, which is what manual collection has always
     * done and keeps doing.
     */
    opts: { carrierActual?: boolean } = {},
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) {
      throw new NotFoundException('المعاملة غير موجودة');
    }
    if (tx.cancelled) {
      throw new BadRequestException('لا يمكن تحصيل معاملة ملغية');
    }
    // A Bosta settlement in progress or awaiting review owns this order's collection. Collecting it
    // here as well is how the same cash would be booked twice.
    if ((tx as any).carrierSettlement?.payoutId || (!opts.carrierActual && ['processing', 'review', 'pending'].includes((tx as any).carrierSettlement?.status || ''))) {
      throw new BadRequestException('هذا الطلب قيد تسوية بوسطة — راجع التسوية من الخزنة ← تسويات بوسطة');
    }
    if (tx.payStatus === 'مكتمل') {
      throw new BadRequestException('المعاملة محصلة بالفعل');
    }
    this.assertNoOpenShipIssue(tx, 'التحصيل');
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
      shipSaving: Number((tx as any).shipSaving) || 0,
      codCollectionStatus: tx.codCollectionStatus || '',
    };

    // حساب الشحن للمبيعات
    const billedShip = !isPurchase ? (Number(tx.shipCost) || 0) : 0;
    let shipExtra = 0; // الزيادة في الشحن الفعلي عن المحصل
    let carrierNet: number | null = null; // carrierActual: the exact net, replacing the formula below
    if (!isPurchase && opts.carrierActual) {
      const r2 = (n: number) => Math.round(n * 100) / 100;
      const actual = r2(Number(dto.actualShipCost) || 0);
      shipExtra = r2(Math.max(0, actual - billedShip));
      const saving = billedShip > 0 ? r2(Math.max(0, billedShip - actual)) : 0;
      tx.actualShipCost = actual;
      tx.shipLoss = r2((Number(tx.shipLoss) || 0) + shipExtra);
      (tx as any).shipSaving = r2((Number((tx as any).shipSaving) || 0) + saving);
      carrierNet = r2(Math.max(0, payAmount - actual));
    } else if (!isPurchase && dto.actualShipCost !== undefined && dto.actualShipCost > 0) {
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
    const netVaultAmount = isPurchase
      ? payAmount
      : carrierNet !== null ? carrierNet : Math.max(0, payAmount - remainingShipToDeduct - shipExtra);

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
          : carrierNet !== null
            ? `تسوية بوسطة #${tx.ref || tx._id} — حصّلت ${payAmount} ج، مستحقاتها ${tx.actualShipCost} ج، الصافي ${netVaultAmount} ج`
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
    if (lastPayment?.carrierPayoutId) throw new BadRequestException('هذا التحصيل ضمن دفعة بوسطة — التراجع يكون عن الدفعة كاملة');
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
      shipSaving?: number;
      codCollectionStatus?: string;
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
      // Snapshots taken before these two fields existed lack them — leave the current values.
      if (snap.shipSaving !== undefined) (tx as any).shipSaving = snap.shipSaving;
      if (snap.codCollectionStatus !== undefined) tx.codCollectionStatus = snap.codCollectionStatus;
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

  /**
   * Undoes an automatic Bosta settlement completely: the shipping-outflow entry, the collection,
   * and the shipLoss / shipSaving / actualShipCost it wrote. Lives here, not in the settlement
   * service, because performCancellation must call it — and that direction would be a cycle.
   *
   * ⚠ Order is load-bearing: the outflow entry goes first (by id), then reverseCollect(), which
   *   deletes the newest تحصيل row for this ref. The collection must still be the LAST payment,
   *   or reverseCollect would undo somebody else's.
   */
  async reverseCarrierSettlement(id: string, by: string, why: 'undo' | 'cancel' = 'undo'): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) throw new NotFoundException('المعاملة غير موجودة');
    const cs: any = (tx as any).carrierSettlement;
    if (!cs || cs.status !== 'settled') throw new BadRequestException('لا توجد تسوية بوسطة مسجلة لهذا الطلب');
    if (cs.payoutId) throw new BadRequestException('هذا الطلب ضمن تحويل مجمع — تراجع عن دفعة التحويل كاملة من كشف بوسطة');

    if (cs.collectPaymentId) {
      const pays = tx.payments || [];
      const last: any = pays[pays.length - 1];
      if (!last || last.id !== cs.collectPaymentId) {
        throw new BadRequestException('يوجد تحصيل مسجل بعد التسوية — تراجع عنه أولاً');
      }
    }

    if (cs.shortfallVaultEntryId) await this.vaultService.removeSystemEntryById(cs.shortfallVaultEntryId);
    if (cs.collectPaymentId) {
      await this.reverseCollect(id, by);
    } else if (cs.snapshotBefore) {
      // Prepaid path — nothing went through collect(), so the fields are restored from our own snapshot.
      await this.transactionModel.findByIdAndUpdate(id, {
        $set: {
          actualShipCost: cs.snapshotBefore.actualShipCost || 0,
          shipLoss: cs.snapshotBefore.shipLoss || 0,
          shipSaving: cs.snapshotBefore.shipSaving || 0,
        },
      }).exec();
    }

    const now = new Date().toISOString();
    const saved = await this.transactionModel.findByIdAndUpdate(
      id,
      {
        $set: { carrierSettlement: { ...cs, status: 'reversed', reversedBy: by, reversedAt: now, reversedWhy: why }, carrierSettleLock: '' },
        $push: { codCollectionHistory: { action: 'carrier-settle-reversed', by, at: now, amount: -(Number(cs.net) || 0), method: cs.vaultMethod || '', note: why === 'cancel' ? 'إلغاء الطلب' : 'تراجع عن تسوية بوسطة' } },
      },
      { new: true },
    ).exec();
    this.emit('tx:updated', { _id: id });
    this.emit('settlement:changed', { txId: id, status: 'reversed' });
    return saved as TransactionDocument;
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
    if (paymentIdx !== -1 && payments[paymentIdx]?.carrierPayoutId) {
      throw new BadRequestException('هذا التحصيل ضمن دفعة بوسطة — التراجع يكون عن الدفعة كاملة');
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
    // Manual stock corrections are a fourth term alongside purchases/returns/sales — see
    // getManualAdjustmentQtyByProductCode(). Must stay in step with getAvailableQtyByProductCode:
    // if the two disagree, the oversell guard and this screen report different on-hand figures.
    const adjustmentsByCode =
      await this.inventoryMovementsService.getManualAdjustmentQtyByProductCode();
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
      const adjustments = adjustmentsByCode.get(productCodeNorm) || 0;
      const current = openingBal + purchases + returnsToStock - sales + adjustments;
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
        adjustments,
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
    // The carrier took less than the invoice tariff — written only by the automatic Bosta settlement.
    const totalShipSaving = salesTx.reduce((s, t) => s + (Number((t as any).shipSaving) || 0), 0);
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

    grossProfit = Math.max(0, grossProfit - returnedProfit - totalShipLoss + totalShipSaving);
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
      totalShipSaving,
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
    /**
     * Narrows the SHIPPING panel to one carrier. Scoped to that report alone on purpose —
     * sales, profit and expenses are not per-carrier quantities, and filtering them by a
     * shipping company would silently change every other KPI on the page.
     */
    shippingCarrier?: string,
  ): Promise<Record<string, unknown>> {
    let transactions = await this.transactionModel
      .find({ cancelled: { $ne: true }, archived: { $ne: true } })
      .exec();
    // Unfiltered handle, captured before the two filters below rebind `transactions` to a
    // narrowed array. «آخر بيع» in the stagnant-stock panel is a lifetime fact about the
    // product — scoping it to the selected period would report every product as never-sold
    // whenever the user picks "اليوم".
    const allTx = transactions;
    // ⚠ Compared on the DAY, not the raw string: 63% of transactions store `date` as a full ISO
    //   timestamp, and `'2026-06-30T00:39…' <= '2026-06-30'` is false — which silently dropped
    //   every timestamped row on the last day of the period. See date-window.util.ts.
    if (from || to) {
      transactions = transactions.filter((t) => inDateWindow(t.date, from, to));
    }
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
    // The carrier took less than the invoice tariff — written only by the automatic Bosta settlement.
    const totalShipSaving = salesTx.reduce((s, t) => s + (Number((t as any).shipSaving) || 0), 0);
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

    grossProfit = Math.max(0, grossProfit - returnedProfit - totalShipLoss + totalShipSaving);
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
    const cancellations = await this.buildCancellationsReport(from, to);
    const shipping = await this.buildShippingReport(from, to, shippingCarrier);

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
      totalShipSaving,
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
      cancellations,
      shipping,
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
   * Why orders get cancelled, over the reporting period, across BOTH cancellation paths.
   *
   * The two paths are counted separately and then together, because they answer different
   * questions and cost different amounts:
   *   • `shopify` — cancelled on the Shopify page while still pending. Nothing moved: no stock was
   *     deducted, no vault entry was written, no invoice exists. The cost is the lost sale.
   *   • `transaction` — cancelled after it entered سجل المعاملات. `performCancellation` had to
   *     reverse real effects: refund the deposit out of (or back into) the vault, write reversing
   *     inventory movements, and unwind the supplier payable. This is the expensive kind, and
   *     separating it is the whole point of the split — a rising `transaction` share means orders
   *     are being caught too late.
   *
   * ⚠ `getReports` filters `transactions` to `cancelled: { $ne: true }`, so the cancelled rows this
   *   panel needs are NOT in that array by construction. This method runs its own query. Do not
   *   "optimise" it by reusing the caller's list — it would always return zero.
   *
   * ⚠ Cancelled transactions are dated by `cancelledAt` (when the cancellation happened), not by
   *   `date` (when the order was placed). A cancellation is an event in the period it occurred in;
   *   bucketing an August cancellation of a June order into June would make the current period
   *   look clean and silently rewrite a closed month. `cancelledAt` is a full ISO timestamp, so it
   *   is compared on its date prefix against the same `YYYY-MM-DD` bounds the rest of the report
   *   uses. Rows with no `cancelledAt` (pre-dating the field) fall back to `date` rather than being
   *   dropped.
   *
   * Money is reported as `lostValue` — the invoice total that did not become revenue — and, for
   * the transaction path only, `refunded`: cash that actually left the vault again. A Shopify-stage
   * cancellation can never have a refund, which is exactly the difference the panel exists to show.
   */
  /**
   * Shipping-cost analysis — what the carrier ACTUALLY charged, against what we billed.
   *
   * WHY THIS EXISTS
   * `shipCost` is the tariff we charge the customer; `actualShipCost` is what the carrier
   * deducted. The gap between them was already being recorded per order (as `shipLoss`) and had
   * never been added up anywhere, so it was spread across hundreds of invoices and invisible.
   * Measured on the live data before this was written: of 206 orders carrying an actual cost, 174
   * were charged MORE than billed, one matched exactly, and the total gap was 4,602 EGP.
   *
   * ⚠ THE VAULT IS THE POINT. Shipping is not an expense line here — `collect()` subtracts it from
   *   the collection BEFORE the cash reaches the vault (`netVaultAmount = payAmount − billedShip −
   *   shipExtra`). So an overcharge is not a cost we pay later, it is money that never arrives.
   *   That is why this reports a vault chain rather than a cost table.
   *
   * ⚠ COVERAGE IS STATED, NEVER HIDDEN. Orders with no `actualShipCost` are counted and reported
   *   as such, and the projection over them is returned as a SEPARATE field (`estimatedGap`) from
   *   the measured one (`totalGap`). An estimate presented as a fact in an accounting report is
   *   the one thing this must not do — same rule as the LOAD_FAIL three-state convention.
   *
   * ⚠ Bosta's «Total Fees» is shipping + insurance + VAT, so once a period contains imported rows
   *   `actualShipCost` is a TOTAL DEDUCTION, not a pure shipping rate. `byCity` therefore reports
   *   what the carrier costs us per governorate, which is the question that decides pricing —
   *   the fee split lives on the import record for anyone who needs to go further.
   *
   * Wrapped in try/catch: a reporting panel must never take the whole report down.
   */
  /**
   * Binds historical sales to a carrier code.
   *
   * WHY THIS EXISTS: `carrierCode` was added after the data. Measured on the live database at the
   * time of writing, 0 of 484 non-cancelled sales carried one, while `shipCo` held 'Bosta' (78),
   * 'bosta +' (219), '' (180) and 'Free Shipping🎉' (7). Reports therefore rely on inferring the
   * carrier at READ time on every row, forever. This writes the inference down once, so the code
   * becomes the stored fact it was designed to be and the «غير محدد» bucket shrinks for real.
   *
   * RULES:
   * • **Only rows with no code are touched.** A row that already carries one is never rewritten —
   *   a backfill must not overwrite a decision someone made deliberately.
   * • **Only sales.** A purchase has no outbound shipment; stamping one would put supplier
   *   invoices into the shipping report (the same rule resolveCarrierForWrite follows).
   * • **Cancelled rows are included.** They are excluded from the shipping report but still
   *   appear in the cancellations report and the archive export, and leaving them uncoded would
   *   make the two disagree about the same order.
   * • **`shipCo` is left exactly as it is.** It is what the invoice view, the pickup group and the
   *   archive export render verbatim; rewriting it would alter what historical documents say.
   * • **A row whose name resolves to nothing is REPORTED, never guessed.** `fallback` lets an
   *   admin bind those explicitly (the 180 empty + 7 'Free Shipping' rows) after deciding what
   *   they actually were — the decision belongs to a human, not to a heuristic.
   *
   * ⚠ `dryRun` defaults to TRUE. A bare call previews and writes nothing.
   */
  async backfillCarrierCodes(
    by: string,
    dryRun = true,
    fallback = '',
  ): Promise<Record<string, unknown>> {
    if (fallback && !isValidCarrier(fallback)) {
      throw new BadRequestException(`شركة شحن غير معروفة: ${fallback}`);
    }
    const rows = await this.transactionModel
      .find({
        type: 'مبيعات',
        $or: [{ carrierCode: { $exists: false } }, { carrierCode: '' }, { carrierCode: null }],
      })
      .select('_id ref shipCo carrierCode')
      .lean()
      .exec();

    const resolved: { ref: string; from: string; code: string }[] = [];
    const unresolved: { ref: string; shipCo: string }[] = [];
    const byCode: Record<string, number> = {};
    const ops: { updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }[] = [];

    for (const tx of rows as any[]) {
      const name = String(tx.shipCo || '').trim();
      const code = carrierCodeFromLooseName(name) || fallback;
      if (!code) {
        unresolved.push({ ref: String(tx.ref || ''), shipCo: name });
        continue;
      }
      resolved.push({ ref: String(tx.ref || ''), from: name, code });
      byCode[code] = (byCode[code] || 0) + 1;
      ops.push({ updateOne: { filter: { _id: tx._id }, update: { $set: { carrierCode: code } } } });
    }

    let written = 0;
    if (!dryRun && ops.length) {
      const res: any = await this.transactionModel.bulkWrite(ops as any);
      written = Number(res?.modifiedCount) || 0;
      this.logger.log(
        `backfillCarrierCodes by ${by}: ${written} sales bound to a carrier` +
          (fallback ? ` (fallback=${fallback})` : ''),
      );
    }

    return {
      dryRun,
      fallback,
      candidates: rows.length,
      resolvedCount: resolved.length,
      unresolvedCount: unresolved.length,
      written,
      byCarrier: Object.entries(byCode)
        .map(([code, count]) => ({ code, label: carrierLabel(code, 'ar'), count }))
        .sort((a, b) => b.count - a.count),
      // Capped: this is a preview for a human, not a data export. The counts above are complete.
      sample: resolved.slice(0, 25),
      unresolved: unresolved.slice(0, 50),
    };
  }

  private async buildShippingReport(
    from?: string,
    to?: string,
    carrierFilter?: string,
  ): Promise<Record<string, unknown>> {
    const empty = {
      billed: 0,
      actual: 0,
      totalGap: 0,
      estimatedGap: 0,
      overCount: 0,
      underCount: 0,
      equalCount: 0,
      measuredCount: 0,
      unmeasuredCount: 0,
      coverage: 0,
      avgGap: 0,
      byCity: [] as unknown[],
      byCarrier: [] as unknown[],
      carriers: [] as unknown[],
      carrier: '',
      worst: [] as unknown[],
      worstTruncated: false,
      worstLimit: 0,
      worstTotal: 0,
      feeOnly: { count: 0, amount: 0 },
      imports: [] as unknown[],
      vaultChain: {
        collected: 0,
        billedShip: 0,
        overCharge: 0,
        feeOnly: 0,
        toVault: 0,
      },
    };
    try {
      const sales = await this.transactionModel
        .find({
          type: 'مبيعات',
          cancelled: { $ne: true },
          ...dateWindowQuery(from, to),
        })
        .select('ref client date shipCost actualShipCost shipLoss shippingBostaCity shippingCity shipZone payments total carrierCode shipCo')
        .lean()
        .exec();

      let billed = 0;
      let actual = 0;
      let totalGap = 0;
      let overCount = 0;
      let underCount = 0;
      let equalCount = 0;
      let measuredCount = 0;
      let unmeasuredCount = 0;
      let collected = 0;
      let billedShipOnCollected = 0;

      // Rows that carry no city at all. Named once so the report, the UI and any future
      // consumer agree on the bucket — the same convention as LEGACY_CARRIER_CODE.
      const UNKNOWN_CITY = 'غير محدد';
      const cityMap: Record<string, { orders: number; billed: number; actual: number; zone: string }> = {};
      /**
       * Per-carrier performance. Accumulated over EVERY sale in the window — including the ones
       * excluded by an active carrier filter — because the filter must not be able to hide a
       * carrier from its own comparison table. `carrierFilter` narrows the detail panels; the
       * comparison is always the full picture.
       */
      const carrierMap: Record<
        string,
        { orders: number; billed: number; actual: number; measured: number; gap: number; over: number }
      > = {};
      const worst: {
        ref: string; client: string; city: string;
        carrier: string; carrierLabel: string;
        billed: number; actual: number; gap: number;
      }[] = [];

      for (const tx of sales as any[]) {
        const b = Number(tx.shipCost) || 0;
        const a = Number(tx.actualShipCost) || 0;

        // ⚠ Read-side resolution: `carrierCode` is a new field and NO historical row carries it,
        //   so the legacy free-text `shipCo` is the only carrier evidence on 100% of existing
        //   sales. See resolveCarrierForRead for the measurement.
        const carrier = resolveCarrierForRead(tx) || LEGACY_CARRIER_CODE;

        // The comparison table is built BEFORE the filter is applied — a filter that removed a
        // carrier from the table it is meant to be compared in would make the two panels
        // disagree about how many carriers exist.
        const cm = (carrierMap[carrier] ||= {
          orders: 0, billed: 0, actual: 0, measured: 0, gap: 0, over: 0,
        });
        cm.orders++;
        cm.billed += b;
        if (a > 0) {
          cm.measured++;
          cm.actual += a;
          const g = a - b;
          if (g > 0.01) { cm.gap += g; cm.over++; }
        }

        // Everything below this line describes the SELECTED carrier only.
        if (carrierFilter && carrier !== carrierFilter) continue;

        billed += b;

        // Cash actually collected on this order, for the vault chain.
        const paid = (tx.payments || []).reduce(
          (s: number, p: any) => s + (Number(p.collectedAmount) || Number(p.amount) || 0),
          0,
        );
        if (paid > 0) {
          collected += paid;
          billedShipOnCollected += b;
        }

        if (a <= 0) {
          unmeasuredCount++;
          continue;
        }
        measuredCount++;
        actual += a;
        const gap = a - b;
        if (gap > 0.01) {
          overCount++;
          totalGap += gap;
        } else if (gap < -0.01) underCount++;
        else equalCount++;

        // ⚠ `shipZone` IS NOT A CITY. It is the two-value tariff zone ('cairo' | 'gov')
        //   produced by cityToShipZone(), where 'gov' means "any governorate outside
        //   Cairo/Giza". Falling back to it put a ZONE into a column headed المحافظة, so
        //   the table listed lowercase `cairo` (239 rows, a zone) beside `Cairo` (91 rows,
        //   the real city) as if they were two peer governorates — and printed a bare
        //   `gov`, which names no place at all.
        //
        //   Measured on the live backup: 302 of 484 sales (62%) carry no city and were
        //   being reported as zones. `normalizeCity` recovers 40 of them from the raw
        //   `shippingCity` (verified: 40 resolved, 0 unresolved); the remaining 262 hold
        //   nothing but a zone, so they are bucketed as UNKNOWN and counted, never
        //   disguised as a governorate. Same rule as LEGACY_CARRIER_CODE: the total must
        //   still equal what actually shipped, and a shrinking unknown bucket is the
        //   adoption metric.
        const rawCity = String(tx.shippingBostaCity || '').trim();
        const city =
          normalizeCity(rawCity) ||
          rawCity ||
          normalizeCity(String((tx as any).shippingCity || '').trim()) ||
          UNKNOWN_CITY;
        const c = (cityMap[city] ||= { orders: 0, billed: 0, actual: 0, zone: '' });
        c.orders++;
        c.billed += b;
        c.actual += a;
        // The zone is still worth reporting — it is what the tariff is actually priced on —
        // but as its own attribute of the city, never as a substitute for one.
        if (city === UNKNOWN_CITY) c.zone = String(tx.shipZone || '').trim();

        if (gap > 0.01) {
          worst.push({
            ref: String(tx.ref || ''),
            client: String(tx.client || ''),
            city,
            // Carried per row so the list stays readable with the filter set to "all" — an
            // overcharge is only actionable once you know who to raise it with.
            carrier,
            carrierLabel: carrierLabel(carrier, 'ar'),
            billed: b,
            actual: a,
            gap: Math.round(gap * 100) / 100,
          });
        }
      }

      const round = (n: number) => Math.round(n * 100) / 100;
      const avgGap = overCount ? totalGap / overCount : 0;

      // ⚠ A PROJECTION, returned separately from the measured figure and never folded into it.
      //   It answers "how much are we probably not seeing?" — useful, but not a fact.
      const estimatedGap = unmeasuredCount * avgGap;

      const byCity = Object.entries(cityMap)
        .map(([city, v]) => ({
          city,
          // `unknown` lets the UI label the row honestly ("طلبات بلا محافظة مسجَّلة")
          // instead of printing a zone code the reader cannot interpret.
          unknown: city === UNKNOWN_CITY,
          zone: v.zone,
          orders: v.orders,
          billed: round(v.billed),
          actual: round(v.actual),
          gap: round(v.actual - v.billed),
          avgActual: round(v.actual / Math.max(1, v.orders)),
          avgBilled: round(v.billed / Math.max(1, v.orders)),
        }))
        // The no-city bucket always sorts last: it is not a governorate competing for
        // "worst gap", it is the measurement gap itself. Ranking it among real cities
        // would put a bucket nobody can act on at the top of a table meant for pricing.
        .sort((a, b) => (a.unknown ? 1 : 0) - (b.unknown ? 1 : 0) || b.gap - a.gap);

      worst.sort((a, b) => b.gap - a.gap);
      const MAX_WORST_ROWS = 500;

      // Fee-only deductions: the carrier kept money on shipments that collected nothing (returns).
      // Only import records know about these — they never become a collection, so no transaction
      // carries them.
      // ⚠ The carrier filter MUST reach this query. `feeOnly` — and therefore the «خصم بدون
      //   تحصيل» KPI — is derived entirely from these documents, so leaving them unfiltered
      //   would show one carrier's orders beside every carrier's fee deductions: a KPI strip
      //   that silently mixes two different scopes.
      const importWhere: Record<string, unknown> = {};
      if (from || to) importWhere.date = { $gte: String(from || ''), $lte: String(to || '\uffff') };
      if (carrierFilter) importWhere.carrier = carrierFilter;
      const importDocs = await this.carrierImportModel
        .find(importWhere)
        .select('importNo date by fileName carrier rowsSettled totalCod totalFees totalVault totalVariance feeOnlyCount feeOnlyAmount')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
        .exec()
        .catch(() => [] as any[]);

      const feeOnly = (importDocs as any[]).reduce(
        (acc, d) => {
          acc.count += Number(d.feeOnlyCount) || 0;
          acc.amount += Number(d.feeOnlyAmount) || 0;
          return acc;
        },
        { count: 0, amount: 0 },
      );

      return {
        billed: round(billed),
        actual: round(actual),
        totalGap: round(totalGap),
        estimatedGap: round(estimatedGap),
        overCount,
        underCount,
        equalCount,
        measuredCount,
        unmeasuredCount,
        coverage: measuredCount + unmeasuredCount
          ? round((measuredCount / (measuredCount + unmeasuredCount)) * 100)
          : 0,
        avgGap: round(avgGap),
        // Per-carrier comparison — always the full window, never narrowed by `carrierFilter`.
        byCarrier: Object.entries(carrierMap)
          .map(([code, v]) => ({
            code,
            label: carrierLabel(code, 'ar'),
            labelEn: carrierLabel(code, 'en'),
            orders: v.orders,
            measured: v.measured,
            billed: round(v.billed),
            actual: round(v.actual),
            gap: round(v.gap),
            overCount: v.over,
            // Coverage is per carrier: a company whose statements were never imported has no
            // measured cost, and its zero gap means "not yet measured", not "no overcharge".
            coverage: v.orders ? round((v.measured / v.orders) * 100) : 0,
            avgBilled: v.orders ? round(v.billed / v.orders) : 0,
            avgActual: v.measured ? round(v.actual / v.measured) : 0,
            // The share of the shipping we charged that this carrier takes back above tariff —
            // the one figure that compares carriers of different sizes fairly.
            gapPct: v.billed > 0 ? round((v.gap / v.billed) * 100) : 0,
          }))
          // The unspecified bucket sorts last: it is the measurement gap, not a competitor.
          .sort((a, b) =>
            (a.code === LEGACY_CARRIER_CODE ? 1 : 0) - (b.code === LEGACY_CARRIER_CODE ? 1 : 0) ||
            b.gap - a.gap || b.orders - a.orders),
        // The filter's option list, so the UI never offers a carrier with no rows in the period.
        carriers: Object.keys(carrierMap).map((code) => ({
          code,
          label: carrierLabel(code, 'ar'),
          labelEn: carrierLabel(code, 'en'),
          orders: carrierMap[code].orders,
        })),
        carrier: String(carrierFilter || ''),
        byCity: byCity.slice(0, 25),
        // ⚠ The UI paginates, sorts and filters this list CLIENT-SIDE, so it must receive the
        //   real set — not a top-25 slice. Paging a truncated payload makes page 2 and every
        //   re-sort silently wrong: they would reorder 25 arbitrary rows rather than the
        //   period's actual overcharges. MAX_WORST_ROWS bounds the response instead, and
        //   `worstTruncated` makes the UI SAY SO rather than present a partial list as
        //   complete. Same rule as MAX_CANCEL_ROWS above.
        worst: worst.slice(0, MAX_WORST_ROWS),
        worstTruncated: worst.length > MAX_WORST_ROWS,
        worstLimit: MAX_WORST_ROWS,
        worstTotal: worst.length,
        feeOnly: { count: feeOnly.count, amount: round(feeOnly.amount) },
        imports: importDocs,
        // The vault chain — the shape the panel renders. Each line is money that did or did not
        // arrive, in the order `collect()` applies it.
        vaultChain: {
          collected: round(collected),
          billedShip: round(billedShipOnCollected),
          overCharge: round(totalGap),
          feeOnly: round(feeOnly.amount),
          toVault: round(collected - billedShipOnCollected - totalGap - feeOnly.amount),
        },
      };
    } catch (err) {
      this.logger.warn(`buildShippingReport failed: ${(err as Error).message}`);
      return empty;
    }
  }

  private async buildCancellationsReport(
    from?: string,
    to?: string,
  ): Promise<Record<string, unknown>> {
    const empty = {
      total: 0,
      shopifyCount: 0,
      transactionCount: 0,
      lostValue: 0,
      refunded: 0,
      reasons: [] as unknown[],
      groups: [] as unknown[],
      series: [] as unknown[],
      recent: [] as unknown[],
      recentTruncated: false,
      recentLimit: 0,
      avgHoursToCancel: null as number | null,
      unspecified: 0,
    };
    try {
      const inRange = (iso: string | undefined, fallback?: string): string => {
        // `cancelledAt` is an ISO timestamp, `date` a bare YYYY-MM-DD. Both reduce to a day key
        // by taking the first 10 chars, which is also what the from/to bounds are.
        const s = String(iso || '').trim() || String(fallback || '').trim();
        return s.slice(0, 10);
      };
      const within = (day: string): boolean => {
        if (!day) return false;
        if (from && day < from) return false;
        if (to && day > to) return false;
        return true;
      };

      const [cancelledTx, cancelledShopify] = await Promise.all([
        this.transactionModel.find({ cancelled: true }).exec(),
        this.shopifyOrderModel.find({ cancelled: true }).exec(),
      ]);

      type Row = {
        stage: CancelStage;
        code: string;
        note: string;
        summary: string;
        day: string;
        by: string;
        ref: string;
        client: string;
        /** Invoice value that never became revenue. */
        lostValue: number;
        /** Cash that actually went back out of the vault. Shopify-stage rows are always 0. */
        refunded: number;
        /** Hours between the order being placed and it being cancelled; null when unknowable. */
        hoursToCancel: number | null;
        type: string;
      };

      const hoursBetween = (placed?: string, cancelled?: string): number | null => {
        const a = placed ? Date.parse(placed) : NaN;
        const b = cancelled ? Date.parse(cancelled) : NaN;
        if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
        return Math.round(((b - a) / 3600000) * 10) / 10;
      };

      const rows: Row[] = [];

      for (const tx of cancelledTx) {
        const day = inRange((tx as any).cancelledAt, tx.date);
        if (!within(day)) continue;
        // Only the deposit ever left the vault at cancellation time; the remaining balance was
        // never collected, so calling the whole total "refunded" would double-count the loss
        // that `lostValue` already carries.
        const refunded = Number(tx.deposit) || 0;
        rows.push({
          stage: ((tx as any).cancelStage as CancelStage) || 'transaction',
          code: (tx as any).cancelReasonCode || '',
          note: (tx as any).cancelReasonNote || '',
          summary: tx.cancelReason || '',
          day,
          by: tx.cancelledBy || '',
          ref: tx.ref || String(tx._id),
          client: tx.client || '',
          lostValue: Number(tx.total) || 0,
          refunded,
          hoursToCancel: hoursBetween(
            (tx as any).createdAt
              ? new Date((tx as any).createdAt).toISOString()
              : tx.date,
            (tx as any).cancelledAt,
          ),
          type: tx.type || '',
        });
      }

      for (const o of cancelledShopify) {
        // ShopifyOrder has no business-date field of its own — it relies on Mongoose
        // `timestamps`, so `createdAt` (when we ingested the order) is the fallback.
        const day = inRange(
          (o as any).cancelledAt,
          (o as any).createdAt ? new Date((o as any).createdAt).toISOString() : '',
        );
        if (!within(day)) continue;
        rows.push({
          stage: 'shopify',
          code: (o as any).cancelReasonCode || '',
          note: (o as any).cancelReasonNote || '',
          summary: (o as any).cancelReason || '',
          day,
          by: (o as any).cancelledBy || '',
          ref: (o as any).ref || String(o._id),
          client: (o as any).client || '',
          lostValue: Number((o as any).total) || 0,
          // Before deposit receipts this was a hard 0: nothing was ever taken before confirmation.
          // An APPROVED receipt is cash in the vault before the order is a transaction, and
          // cancelling refunds it — so the figure is what was actually refunded, read from the
          // receipts (status «مُسترد»), and still 0 for every order without one.
          refunded: Math.round(
            ((((o as any).depositReceipts || []) as any[])
              .filter((r) => r?.status === 'مُسترد')
              .reduce((s, r) => s + (Number(r.amount) || 0), 0)) * 100,
          ) / 100,
          hoursToCancel: hoursBetween(
            (o as any).createdAt
              ? new Date((o as any).createdAt).toISOString()
              : '',
            (o as any).cancelledAt,
          ),
          type: 'شوبيفاي',
        });
      }

      if (!rows.length) return empty;

      // ── Per-reason breakdown ────────────────────────────────────────────
      // Rows with no code are bucketed under LEGACY_CANCEL_REASON_CODE rather than dropped, so
      // the reason totals always add up to the number of cancellations that actually happened.
      // A shrinking «غير محدد» bucket is also the adoption metric for this system.
      const byCode = new Map<
        string,
        {
          code: string;
          label: string;
          group: string;
          count: number;
          shopifyCount: number;
          transactionCount: number;
          lostValue: number;
          refunded: number;
        }
      >();
      for (const r of rows) {
        const code = r.code || LEGACY_CANCEL_REASON_CODE;
        const def = cancelReasonDef(code);
        if (!byCode.has(code)) {
          byCode.set(code, {
            code,
            label: def ? def.ar : LEGACY_CANCEL_REASON_AR,
            group: def ? def.group : 'other',
            count: 0,
            shopifyCount: 0,
            transactionCount: 0,
            lostValue: 0,
            refunded: 0,
          });
        }
        const b = byCode.get(code)!;
        b.count += 1;
        if (r.stage === 'shopify') b.shopifyCount += 1;
        else b.transactionCount += 1;
        b.lostValue += r.lostValue;
        b.refunded += r.refunded;
      }
      const reasons = [...byCode.values()]
        .map((b) => ({
          ...b,
          lostValue: Math.round(b.lostValue),
          refunded: Math.round(b.refunded),
          share: Math.round((b.count / rows.length) * 1000) / 10,
        }))
        // By count, not by value: the question this panel answers is "what keeps going wrong",
        // and one large cancelled invoice is not a bigger problem than ten small recurring ones.
        .sort((a, b) => b.count - a.count);

      // ── Per-group rollup ────────────────────────────────────────────────
      const groups = CANCEL_REASON_GROUPS.map((g) => {
        const members = reasons.filter((r) => r.group === g.key);
        return {
          key: g.key,
          label: g.ar,
          count: members.reduce((s, r) => s + r.count, 0),
          lostValue: members.reduce((s, r) => s + r.lostValue, 0),
        };
      })
        .filter((g) => g.count > 0)
        .sort((a, b) => b.count - a.count);

      // ── Daily series ────────────────────────────────────────────────────
      // Split by stage so the trend shows WHEN in the funnel orders are dying, not just how many.
      const dayMap = new Map<
        string,
        { date: string; shopify: number; transaction: number; lostValue: number }
      >();
      for (const r of rows) {
        if (!dayMap.has(r.day)) {
          dayMap.set(r.day, { date: r.day, shopify: 0, transaction: 0, lostValue: 0 });
        }
        const d = dayMap.get(r.day)!;
        if (r.stage === 'shopify') d.shopify += 1;
        else d.transaction += 1;
        d.lostValue += r.lostValue;
      }
      const series = [...dayMap.values()]
        .map((d) => ({ ...d, lostValue: Math.round(d.lostValue) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const timed = rows
        .map((r) => r.hoursToCancel)
        .filter((h): h is number => h !== null);
      const avgHoursToCancel = timed.length
        ? Math.round((timed.reduce((s, h) => s + h, 0) / timed.length) * 10) / 10
        : null;

      // The full list, not a top-25 slice: the table paginates and sorts client-side, and a
      // truncated payload would make page 2 and every sort silently wrong (they would reorder
      // 25 arbitrary rows rather than the period's actual cancellations). Bounded by
      // MAX_CANCEL_ROWS so a very long period cannot return an unbounded payload — the UI states
      // the truncation rather than hiding it.
      const MAX_CANCEL_ROWS = 500;
      const sorted = rows.slice().sort((a, b) => b.day.localeCompare(a.day));
      const recent = sorted
        .slice(0, MAX_CANCEL_ROWS)
        .map((r) => ({
          ref: r.ref,
          client: r.client,
          stage: r.stage,
          type: r.type,
          code: r.code || LEGACY_CANCEL_REASON_CODE,
          label: cancelReasonDef(r.code)?.ar || LEGACY_CANCEL_REASON_AR,
          note: r.note,
          summary: r.summary,
          date: r.day,
          by: r.by,
          lostValue: Math.round(r.lostValue),
          refunded: Math.round(r.refunded),
        }));

      return {
        total: rows.length,
        shopifyCount: rows.filter((r) => r.stage === 'shopify').length,
        transactionCount: rows.filter((r) => r.stage !== 'shopify').length,
        lostValue: Math.round(rows.reduce((s, r) => s + r.lostValue, 0)),
        refunded: Math.round(rows.reduce((s, r) => s + r.refunded, 0)),
        unspecified: rows.filter((r) => !r.code).length,
        avgHoursToCancel,
        reasons,
        groups,
        series,
        recent,
        // Stated, never silent: the table says "showing 500 of 640" rather than presenting a
        // truncated list as if it were the whole period.
        recentTruncated: rows.length > MAX_CANCEL_ROWS,
        recentLimit: MAX_CANCEL_ROWS,
      };
    } catch (e) {
      // Same rule as buildStagnantStock: a reporting panel must never take the whole report down.
      console.error('[getReports] Error building cancellations report:', e);
      return empty;
    }
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

  /**
   * تصحيح خزنة عربون مُقيَّد بالفعل (مثال: سُجِّل على Instapay والصحيح فودافون كاش).
   *
   * يُنفَّذ كقيدين متقابلين — سحب من الخزنة القديمة وإيداع في الجديدة — لا بتعديل أو
   * حذف القيد الأصلي: القيد الأصلي دليل تدقيقي، والتحويل هو ما حدث فعلاً محاسبياً.
   * (وعملياً `VaultService.deleteLastEntryByRef` مقصورة على `تحصيل`/`مشتريات` ولا
   * تصل إلى قيود `ديبوزت مبيعات` أصلاً.)
   *
   * ⚠ ترتيب القيدين مقصود: السحب أولاً. `addSystemEntry` ترفض أي خصم يجعل رصيد
   * القطاع سالباً؛ فلو نُفِّذ الإيداع أولاً ثم فشل السحب لتضاعف المبلغ في الخزنتين.
   * بهذا الترتيب يفشل التحويل كاملاً قبل كتابة أي قيد.
   */
  private async transferDepositVaultSegment(
    tx: TransactionDocument,
    fromMethod: string,
    toMethod: string,
    amount: number,
    txDate: string,
    txRef: string,
    editedBy = '',
  ): Promise<void> {
    if (!(amount > 0) || !fromMethod || !toMethod || fromMethod === toMethod) return;
    // اسمان مختلفان قد يُحلّان لنفس القطاع (والمجهول يقع على 'cash')؛ عندها لا مال يتحرك.
    if (
      resolveVaultSegmentFromPaymentMethod(fromMethod) ===
      resolveVaultSegmentFromPaymentMethod(toMethod)
    ) {
      return;
    }
    const party = tx.client || '';
    const by = editedBy || 'مجهول';
    const isPurchase = tx.type === 'مشتريات';
    const kind = isPurchase ? 'عربون مشتريات' : 'ديبوزت مبيعات';
    const entityCtx = isPurchase ? { supplier: party } : { customer: party };

    await this.vaultService.addSystemEntry(
      -amount,
      fromMethod,
      `تصحيح خزنة ${kind} #${txRef} — ${party} | نقل إلى: ${toMethod} | بواسطة: ${by}`,
      txDate,
      'تصحيح خزنة',
      txRef,
      entityCtx,
      by,
    );
    try {
      await this.vaultService.addSystemEntry(amount,toMethod,
        `تصحيح خزنة ${kind} #${txRef} — ${party} | نقل من: ${fromMethod} | بواسطة: ${by}`,
        txDate,'تصحيح خزنة',txRef,entityCtx,by);
    } catch(error) {
      await this.vaultService.addSystemEntry(amount,fromMethod,
        `تراجع عن تصحيح خزنة ${kind} #${txRef} — تعذّر الإيداع في: ${toMethod}`,
        txDate,'تصحيح خزنة',txRef,entityCtx,by);
      throw error;
    }
  }

  private planDepositVaultCorrections(tx: TransactionDocument, dto: UpdateTransactionDto) {
    const input=dto.depositVaultCorrections || [];
    if (!Array.isArray(input)) throw new BadRequestException('بيانات خزن الدفعات غير صالحة');
    const allowed=['كاش','فودافون كاش','Instapay','تحويل بنكي'];
    const lines=(tx.deposits || []).filter((d: any)=>d.source==='deposit-receipt' && !d.reversed && Number(d.amount)>0);
    const seen=new Set<string>();
    return input.flatMap(c=>{
      if (!c || !c.id || seen.has(c.id) || !allowed.includes(c.method)) throw new BadRequestException('حدّد دفعة صحيحة وخزنة معروفة دون تكرار');
      seen.add(c.id);
      const line=lines.find((d: any)=>d.id===c.id);
      if (!line || tx.cancelled) throw new BadRequestException('لا يمكن تعديل خزنة هذه الدفعة');
      const snapshot=(tx.depositReceipts || []).find(r=>r.id===c.id);
      if (!snapshot || Math.abs(Number(snapshot.amount)-Number(line.amount))>.005 || snapshot.method!==line.method) throw new BadRequestException('بيانات الدفعة غير متطابقة — راجع سجل العربون');
      return line.method===c.method ? [] : [{id:c.id,from:line.method,to:c.method,amount:Number(line.amount)}];
    });
  }

  private async recordVaultForTransaction(
    tx: TransactionDocument,
    manualReceiptId?: string,
  ): Promise<void> {
    const txRef = tx.ref || String(tx._id);
    const txDate = this.formatTxDateForVault(tx);
    const emp = (tx as unknown as { employee?: string }).employee || '';
    const entityCtx = tx.client
      ? (tx.type === 'مشتريات' ? { supplier: tx.client } : { customer: tx.client })
      : undefined;
    if (tx.type === 'مبيعات' && (tx.deposit || 0) > 0) {
      const entry = await this.vaultService.addSystemEntry(
        tx.deposit,
        tx.depMethod || 'كاش',
        `ديبوزت مبيعات #${txRef} — ${tx.client || ''}`,
        txDate,
        'ديبوزت مبيعات',
        txRef,
        entityCtx,
        emp,
      );
      if (manualReceiptId) {
        tx.depositReceipts = tx.depositReceipts.map(r => r.id === manualReceiptId ? { ...r, vaultTxNo: entry?.txNo || '' } : r);
        tx.deposits = tx.deposits.map(d => d.id === manualReceiptId ? { ...d, vaultTxNo: entry?.txNo || '' } : d);
        await tx.save();
      }
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
      .select(TransactionsService.LIST_EXCLUDED_FIELDS)
      .sort({ createdAt: -1 })
      .exec();
  }

  /** Generate a unified group reference: RRR-DDMON (e.g. 104-08MAY) */
  private genPickupRef(forDate?: string): string {
    const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    const now = new Date();
    const parts = /^\d{4}-(\d{2})-(\d{2})$/.exec(forDate || '');
    const day = parts?.[2] || String(now.getDate()).padStart(2, '0');
    const month = MONTHS[parts ? Number(parts[1]) - 1 : now.getMonth()] || MONTHS[now.getMonth()];
    const rnd   = Math.floor(100 + Math.random() * 900);
    return `${rnd}-${day}${month}`;
  }

  /**
   * Move orders into Preparing state (entering a prep group).
   *
   * ⚠ The group's identity (note / shipCo / createdAt / createdBy) is stored on
   * every member row, so it is written ONLY when this call opens the group. An
   * order JOINING an existing group inherits what that group already carries.
   * Writing the caller's meta unconditionally is what the Shopify confirm
   * dialog's "add to this card" path would otherwise do on every order: a group
   * created as «مجموعة الأحمدي — شحن سريع» at 09:00 would lose its note and
   * report itself as created at the moment the newest order joined, because
   * that caller has no note to send and a fresh timestamp. The board reads
   * these fields off the first member row, so the whole card would be renamed.
   */
  async setPickupPreparing(
    ids: string[],
    by: string,
    prepRef: string,
    meta?: { note?: string; shipCo?: string; createdAt?: string; createdBy?: string },
  ): Promise<{ updated: number }> {
    const validIds = [...new Set(ids.filter(id => isValidObjectId(id)))];
    if (!validIds.length) return { updated: 0 };
    const now = new Date().toISOString().slice(0, 10);

    const pendingOrders = await this.transactionModel.find({
      _id: { $in: validIds }, type: 'مبيعات', cancelled: { $ne: true },
      pickupStatus: { $in: ['Pending', null] },
    }).select('_id').exec();
    if (pendingOrders.length !== validIds.length) {
      throw new BadRequestException('يجب أن تكون كل الطلبات في حالة معلّق قبل بدء التحضير');
    }

    // An existing member is the authority on the group's identity.
    const existing = prepRef
      ? await this.transactionModel
          .findOne({ pickupRef: prepRef, pickupStatus: 'Preparing' })
          .select('prepNote prepShipCo prepCreatedAt prepCreatedBy')
          .lean()
      : null;

    const groupMeta = existing
      ? {
          prepNote:      (existing as any).prepNote      || '',
          prepShipCo:    (existing as any).prepShipCo    || '',
          prepCreatedAt: (existing as any).prepCreatedAt || now,
          prepCreatedBy: (existing as any).prepCreatedBy || by,
        }
      : {
          prepNote:      meta?.note      || '',
          prepShipCo:    meta?.shipCo    || '',
          prepCreatedAt: meta?.createdAt || now,
          prepCreatedBy: meta?.createdBy || by,
        };

    const result = await this.transactionModel.updateMany(
      { _id: { $in: validIds }, type: 'مبيعات', cancelled: { $ne: true }, pickupStatus: { $in: ['Pending', null] } },
      {
        $set: {
          pickupStatus: 'Preparing',
          pickupRef: prepRef,
          prepChecked: false,
          ...groupMeta,
        },
        $push: { pickupHistory: { action: 'preparing', date: now, by, pickupRef: prepRef } },
      },
    );
    if (result.modifiedCount !== validIds.length) {
      throw new BadRequestException('تغيّرت حالة بعض الطلبات؛ حدّث الصفحة وحاول مرة أخرى');
    }
    if (result.modifiedCount === validIds.length) {
      this.emit('pickup:updated', { ids: validIds, action: 'preparing', pickupRef: prepRef, by });
    }
    return { updated: result.modifiedCount };
  }

  /** Confirm pick-up for one or more transaction IDs — moves to Ready */
  async confirmPickup(ids: string[], by: string, date?: string, reuseOpenRun = false): Promise<{ updated: number; pickupRef: string }> {
    const validIds = [...new Set(ids.filter(id => isValidObjectId(id)))];
    if (!validIds.length) return { updated: 0, pickupRef: '' };
    const sourceOrders = await this.transactionModel.find({
      _id: { $in: validIds },
      type: 'مبيعات',
      cancelled: { $ne: true },
    }).select('_id pickupStatus prepChecked').exec();
    const allOrdersPrepared = sourceOrders.length === validIds.length && sourceOrders.every(order =>
      order.pickupStatus === 'Preparing' && order.prepChecked === true,
    );
    const allOrdersAlreadyReady = sourceOrders.length === validIds.length && sourceOrders.every(order =>
      order.pickupStatus === 'Ready' || order.pickupStatus === 'Picked-Up',
    );
    // A prep group where some orders were handed to Bosta from the workspace:
    // createOrder already moved those to Ready, the rest are prepared. Every
    // order is still either prepared or ready — move them as one run.
    const isPrepared = (o: any) => o.pickupStatus === 'Preparing' && o.prepChecked === true;
    const isReady = (o: any) => o.pickupStatus === 'Ready' || o.pickupStatus === 'Picked-Up';
    const mixedPreparedAndReady = !allOrdersPrepared && !allOrdersAlreadyReady
      && sourceOrders.length === validIds.length && sourceOrders.every(o => isPrepared(o) || isReady(o));
    if (!allOrdersPrepared && !allOrdersAlreadyReady && !mixedPreparedAndReady) {
      throw new BadRequestException('لا يمكن نقل الطلب إلى الجاهز قبل نقله للتحضير وإكمال تحضيره');
    }
    const now = date || new Date().toISOString().slice(0, 10);
    // A pickup date has one active Ready ticket. Continue that ticket when it
    // already has ready orders; otherwise open a new date-stamped ticket.
    const openRun = reuseOpenRun ? await this.transactionModel.findOne({
      type: 'مبيعات',
      cancelled: { $ne: true },
      pickupStatus: { $in: ['Ready', 'Picked-Up'] },
      pickupDate: now,
      pickupRef: { $nin: ['', null] },
    }).sort({ createdAt: -1, _id: -1 }).select('pickupRef').exec() : null;
    const batchRef = openRun?.pickupRef || this.genPickupRef(now);
    const historyEntry = { action: 'ready', date: now, by, pickupRef: batchRef };
    const result = await this.transactionModel.updateMany(
      {
        _id: { $in: validIds }, type: 'مبيعات', cancelled: { $ne: true },
        ...(mixedPreparedAndReady
          ? { $or: [{ pickupStatus: 'Preparing', prepChecked: true }, { pickupStatus: { $in: ['Ready', 'Picked-Up'] } }] }
          : {
            pickupStatus: allOrdersPrepared ? 'Preparing' : { $in: ['Ready', 'Picked-Up'] },
            ...(allOrdersPrepared ? { prepChecked: true } : {}),
          }),
      },
      {
        $set: { pickupStatus: 'Ready', pickupDate: now, pickupBy: by, pickupRef: batchRef },
        $push: { pickupHistory: historyEntry },
      },
    );
    if (result.modifiedCount === validIds.length) {
      this.emit('pickup:updated', { ids: validIds, action: 'ready', pickupRef: batchRef, pickupDate: now });
    }

    return { updated: result.modifiedCount, pickupRef: batchRef };
  }

  /** Undo pick-up for one or more transaction IDs — reverts Ready or Preparing → Pending */
  async undoPickup(ids: string[], by: string): Promise<{ updated: number }> {
    const validIds = [...new Set(ids.filter(id => isValidObjectId(id)))];
    if (!validIds.length) return { updated: 0 };
    const now = new Date().toISOString().slice(0, 10);
    const historyEntry = { action: 'undo', date: now, by };
    const result = await this.transactionModel.updateMany(
      { _id: { $in: validIds }, type: 'مبيعات', pickupStatus: { $in: ['Ready', 'Picked-Up', 'Preparing'] } },
      {
        $set: { pickupStatus: 'Pending', pickupDate: null, pickupBy: null, pickupRef: null, prepChecked: false },
        $unset: { prepNote: 1, prepShipCo: 1, prepCreatedAt: 1, prepCreatedBy: 1 },
        $push: { pickupHistory: historyEntry },
      },
    );
    if (result.modifiedCount === validIds.length) {
      this.emit('pickup:updated', { ids: validIds, action: 'undo' });
    }
    return { updated: result.modifiedCount };
  }

  /** Move one or more Ready orders into another active pickup run. */
  async addToPickupRun(idsInput: string | string[], pickupRef: string, by: string, date?: string): Promise<{ updated: number }> {
    const ids = [...new Set((Array.isArray(idsInput) ? idsInput : [idsInput]).filter(id => isValidObjectId(id)))];
    if (!ids.length || !pickupRef) return { updated: 0 };
    const targetRun = await this.transactionModel.findOne({
      type: 'مبيعات',
      pickupRef,
      pickupStatus: { $in: ['Ready', 'Picked-Up'] },
      cancelled: { $ne: true },
    }).select('pickupDate').lean();
    if (!targetRun) return { updated: 0 };

    const now = targetRun.pickupDate || date || new Date().toISOString().slice(0, 10);
    const movable = await this.transactionModel.find({
      _id: { $in: ids }, type: 'مبيعات', cancelled: { $ne: true },
      pickupStatus: { $in: ['Ready', 'Picked-Up'] }, pickupRef: { $ne: pickupRef },
    }).select('_id').lean();
    if (movable.length !== ids.length) return { updated: 0 };
    const historyEntry = { action: 'ready_transfer', date: now, by, pickupRef };
    const result = await this.transactionModel.updateMany(
      { _id: { $in: ids }, type: 'مبيعات', cancelled: { $ne: true }, pickupStatus: { $in: ['Ready', 'Picked-Up'] }, pickupRef: { $ne: pickupRef } },
      {
        $set: { pickupStatus: 'Ready', pickupDate: now, pickupBy: by, pickupRef },
        $push: { pickupHistory: historyEntry },
      },
    );
    if (result.modifiedCount) this.emit('pickup:updated', { ids, action: 'ready', pickupRef, pickupDate: now });
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
  async setPrepChecked(id: string, prepChecked: boolean, by: string): Promise<{ ok: boolean; updated: number }> {
    if (!isValidObjectId(id) || typeof prepChecked !== 'boolean') return { ok: false, updated: 0 };
    const now = new Date().toISOString();
    const result = await this.transactionModel.updateOne(
      { _id: id, pickupStatus: 'Preparing', cancelled: { $ne: true } },
      {
        $set: { prepChecked },
        $push: { pickupHistory: { action: 'prep-check', date: now, by, prepChecked } },
      },
    );
    if (!result.modifiedCount) return { ok: false, updated: 0 };
    const tx = await this.transactionModel.findById(id).select('pickupRef pickupHistory prepChecked').lean();
    this.emit('pickup:updated', {
      ids: [id], action: 'prepCheck', prepChecked,
      pickupRef: tx?.pickupRef || null,
      pickupHistory: tx?.pickupHistory || [],
    });
    return { ok: true, updated: result.modifiedCount };
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

  /**
   * إصلاح بأثر رجعي لـ`items[].imageUrl` على المعاملات القديمة.
   *
   * كل سطر اتخزن قبل ما `TransactionItemDto.imageUrl` يتعرّف اتكتب من غير صورة،
   * لأن الـValidationPipe (`whitelist:true`) كان بيشيل الحقل في صمت وهو في طريقه
   * من الـfrontend/Shopify للـschema. الـDTO اتصلّح، بس ده بيغطي الجديد بس —
   * المعاملات المكتوبة قبل كده لسه فاضية والفواتير بتاعتها بتعرض أيقونة بديلة.
   *
   * المطابقة بـ`productId` الأول وبعدين بـ`code`:
   * - `productId` هو الرابط الحقيقي، وهو المكتوب على السطر ساعة البيع.
   * - `code` هو الاحتياطي للسطور القديمة اللي اتخزنت من غير `productId`
   *   (وأي سطر Shopify كوده `SHOPIFY` لأن الـSKU مامتطابقش).
   *
   * ⚠ **بنملا الفاضي بس — مابنستبدلش صورة موجودة.** الصورة المتخزنة على
   * المعاملة هي صورة المنتج **وقت البيع**؛ لو منتج اتغيّرت صورته بعد كده،
   * الكتابة فوقها بتزوّر شكل فاتورة اتطبعت واتسلّمت للعميل خلاص.
   *
   * `dryRun` افتراضياً true زي `backfillMissingSaleMovements` — لازم تبعت
   * `{"dryRun": false}` عشان يكتب فعلياً. آمن للتكرار: تشغيلة تانية بتلاقي
   * الحقول اتملت وبتتخطاها.
   */
  async backfillItemImages(
    dryRun = true,
  ): Promise<{
    dryRun: boolean;
    scanned: number;
    txUpdated: number;
    linesFilled: number;
    linesUnmatched: number;
    unmatched: string[];
    returnRequestsUpdated: number;
    supplierReturnsUpdated: number;
  }> {
    const products = await this.productsService.findAll();

    // فهرسين: بالـid وبالكود. الكود بيتقارن lowercase عشان اختلاف حالة الحروف
    // في سطور Shopify القديمة مايمنعش المطابقة.
    const byId = new Map<string, string>();
    const byCode = new Map<string, string>();
    for (const p of products) {
      const img = String((p as any).imageUrl || '').trim();
      if (!/^https?:\/\//i.test(img)) continue;
      byId.set(String((p as any)._id), img);
      const code = String((p as any).code || '').trim().toLowerCase();
      if (code) byCode.set(code, img);
    }

    const txs = await this.transactionModel.find({}).lean();

    let txUpdated = 0;
    let linesFilled = 0;
    let linesUnmatched = 0;
    const unmatched = new Set<string>();

    // نفس المنطق بيتطبق على 3 مجموعات، فاتعمل مرة واحدة: أي اختلاف بينهم
    // معناه إن فاتورة ومرتجعها يعرضوا صور مختلفة لنفس الصنف.
    const fillDoc = (doc: any): any[] | null => {
      const items = Array.isArray(doc.items) ? doc.items : [];
      if (!items.length) return null;

      let touched = false;
      const nextItems = items.map((it: any) => {
        // موجودة بالفعل → سيبها زي ما هي (شوف التحذير فوق).
        if (String(it?.imageUrl || '').trim()) return it;

        const img =
          byId.get(String(it?.productId || '')) ||
          byCode.get(String(it?.code || '').trim().toLowerCase()) ||
          '';

        if (!img) {
          linesUnmatched++;
          unmatched.add(String(it?.code || it?.name || '؟'));
          return it;
        }

        linesFilled++;
        touched = true;
        return { ...it, imageUrl: img };
      });

      return touched ? nextItems : null;
    };

    for (const tx of txs as any[]) {
      const nextItems = fillDoc(tx);
      if (!nextItems) continue;
      txUpdated++;
      if (!dryRun) {
        await this.transactionModel.updateOne(
          { _id: tx._id },
          { $set: { items: nextItems } },
        );
      }
    }

    // طلبات مرتجع العملاء — بتتنسخ حرفياً على معاملة الـ'مرتجع' وقت الاعتماد
    // (`items: ret.items`)، فطلب معتمد قبل الإصلاح لسه سطوره فاضية.
    let returnRequestsUpdated = 0;
    const rrs = await this.returnRequestModel.find({}).lean();
    for (const rr of rrs as any[]) {
      const nextItems = fillDoc(rr);
      if (!nextItems) continue;
      returnRequestsUpdated++;
      if (!dryRun) {
        await this.returnRequestModel.updateOne(
          { _id: rr._id },
          { $set: { items: nextItems } },
        );
      }
    }

    // مرتجعات الموردين — نفس الحكاية عبر معاملة 'مرتجع مشتريات'.
    let supplierReturnsUpdated = 0;
    const srs = await this.supplierReturnModel.find({}).lean();
    for (const sr of srs as any[]) {
      const nextItems = fillDoc(sr);
      if (!nextItems) continue;
      supplierReturnsUpdated++;
      if (!dryRun) {
        await this.supplierReturnModel.updateOne(
          { _id: sr._id },
          { $set: { items: nextItems } },
        );
      }
    }

    this.logger.log(
      `[backfillItemImages] dryRun=${dryRun} scanned=${txs.length} txUpdated=${txUpdated} ` +
        `returnRequests=${returnRequestsUpdated} supplierReturns=${supplierReturnsUpdated} ` +
        `linesFilled=${linesFilled} linesUnmatched=${linesUnmatched}`,
    );

    return {
      dryRun,
      scanned: txs.length,
      txUpdated,
      returnRequestsUpdated,
      supplierReturnsUpdated,
      linesFilled,
      linesUnmatched,
      // الأصناف اللي مالقيناش لها صورة — بالاسم، عشان تتراجع يدوي بدل ما تختفي في صمت.
      unmatched: [...unmatched].slice(0, 50),
    };
  }
}
