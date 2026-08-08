import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SupplierReturnOrder,
  SupplierReturnOrderDocument,
  SrStatusEntry,
  SrLinkedInvoice,
  SupplierReturnItem,
} from './schemas/supplier-return.schema';
import {
  CreateSupplierReturnDto,
  UpdateSupplierReturnDto,
  SupplierReturnItemDto,
} from './dto/supplier-return.dto';
import { TransactionsService } from '../transactions/transactions.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import { SupplierLedgerService } from '../supplier-ledger/supplier-ledger.service';
import { SrAllocationService } from './allocation.service';

const VAULT_AR_LABELS = ['كاش', 'فودافون كاش', 'Instapay', 'تحويل بنكي'] as const;

const VAULT_CODE_TO_AR: Record<string, (typeof VAULT_AR_LABELS)[number]> = {
  cash: 'كاش',
  vodafone: 'فودافون كاش',
  instapay: 'Instapay',
  bank: 'تحويل بنكي',
};

function normalizeVaultAccountLabel(
  v: string | undefined,
): (typeof VAULT_AR_LABELS)[number] | undefined {
  if (!v) return undefined;
  const t = String(v).trim();
  if (!t) return undefined;
  if ((VAULT_AR_LABELS as readonly string[]).includes(t)) {
    return t as (typeof VAULT_AR_LABELS)[number];
  }
  return VAULT_CODE_TO_AR[t.toLowerCase()];
}

const NON_TERMINAL_STATUSES = ['مسودة', 'معلق', 'معتمد'];

@Injectable()
export class SupplierReturnsService {
  constructor(
    @InjectModel(SupplierReturnOrder.name)
    private readonly srModel: Model<SupplierReturnOrderDocument>,
    private readonly transactionsService: TransactionsService,
    private readonly suppliersService: SuppliersService,
    private readonly supplierLedgerService: SupplierLedgerService,
    private readonly allocationService: SrAllocationService,
  ) {}

  private async generateReturnNumber(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `SR-${year}-`;
    const last = await this.srModel
      .findOne({ returnNumber: { $regex: `^${prefix}` } })
      .sort({ returnNumber: -1 })
      .exec();
    let seq = 1;
    if (last) {
      const m = /(\d+)$/.exec(last.returnNumber);
      if (m) seq = parseInt(m[1], 10) + 1;
    }
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  private sumItemsTotal(items: { total?: number }[]): number {
    return Math.round(
      (items || []).reduce((s, it) => s + (Number(it.total) || 0), 0),
    );
  }

  /** Prior returned qty per product code, across all non-rejected/non-cancelled supplier returns of one invoice — used only by the legacy single-invoice path. */
  private async getAlreadyReturnedQtyByCode(
    originalTransactionId: string,
    excludeId?: string,
  ): Promise<Map<string, number>> {
    const query: Record<string, unknown> = {
      originalTransactionId,
      status: { $nin: ['مرفوض', 'ملغي'] },
      'reversal.reversedAt': { $exists: false },
    };
    if (excludeId) {
      query._id = { $ne: excludeId };
    }
    const prior = await this.srModel.find(query).exec();
    const map = new Map<string, number>();
    for (const r of prior) {
      for (const it of r.items || []) {
        const code = String(it.code || '').trim();
        if (!code) continue;
        map.set(code, (map.get(code) || 0) + (Number(it.qty) || 0));
      }
    }
    return map;
  }

  /** Legacy single-invoice validation — requires the requested items' price/qty stay within the
   *  original invoice's line items. Populates allocations[] internally for a uniform data shape. */
  private async validateSingleInvoice(
    originalTransactionId: string,
    requestedItems: SupplierReturnItemDto[],
    excludeId?: string,
  ): Promise<{ items: SupplierReturnItem[]; linkedInvoices: SrLinkedInvoice[] }> {
    if (!requestedItems || !requestedItems.length) {
      throw new BadRequestException('يجب اختيار صنف واحد على الأقل للإرجاع');
    }
    const originalTx = await this.transactionsService.findById(
      originalTransactionId,
    );
    if (originalTx.type !== 'مشتريات') {
      throw new BadRequestException(
        'يمكن إنشاء مرتجع مورد فقط من فاتورة مشتريات',
      );
    }
    if (originalTx.cancelled) {
      throw new BadRequestException('لا يمكن إرجاع أصناف من فاتورة ملغاة');
    }
    const originalByCode = new Map<string, { qty: number; price: number }>();
    for (const it of originalTx.items || []) {
      const code = String(it.code || '').trim();
      if (!code) continue;
      const prev = originalByCode.get(code);
      originalByCode.set(code, {
        qty: (prev?.qty || 0) + (Number(it.qty) || 0),
        price: Number(it.price) || 0,
      });
    }
    const alreadyReturned = await this.getAlreadyReturnedQtyByCode(
      originalTransactionId,
      excludeId,
    );
    const errors: string[] = [];
    const validated: SupplierReturnItem[] = [];
    for (const it of requestedItems) {
      const code = String(it.code || '').trim();
      const original = originalByCode.get(code);
      if (!original) {
        errors.push(`الصنف ${code} غير موجود في الفاتورة الأصلية`);
        continue;
      }
      const qty = Number(it.qty) || 0;
      if (qty <= 0) {
        errors.push(`كمية غير صالحة للصنف ${code}`);
        continue;
      }
      const returnedSoFar = alreadyReturned.get(code) || 0;
      const remaining = original.qty - returnedSoFar;
      if (qty > remaining) {
        errors.push(
          `${code}: المطلوب إرجاعه ${qty} — المتاح للإرجاع ${remaining} (تم إرجاع ${returnedSoFar} مسبقاً من أصل ${original.qty})`,
        );
        continue;
      }
      const price = Number(it.price);
      if (!Number.isFinite(price) || price < 0) {
        errors.push(`سعر غير صالح للصنف ${code}`);
        continue;
      }
      if (price > original.price) {
        errors.push(
          `${code}: سعر الإرجاع (${price}) لا يمكن أن يتجاوز سعر الشراء الأصلي (${original.price})`,
        );
        continue;
      }
      validated.push({
        code,
        name: it.name || code,
        qty,
        price,
        total: qty * price,
        note: it.note || '',
        allocations: [
          {
            code,
            qty,
            unitCost: price,
            sourceTransactionId: originalTransactionId,
            sourceRef: originalTx.ref || originalTransactionId,
          },
        ],
      });
    }
    if (errors.length) {
      throw new BadRequestException(errors.join('؛ '));
    }
    const allocatedTotal = this.sumItemsTotal(validated);
    return {
      items: validated,
      linkedInvoices: [
        {
          transactionId: originalTransactionId,
          ref: originalTx.ref || originalTransactionId,
          date: originalTx.date,
          allocatedTotal,
        },
      ],
    };
  }

  /** Generalized validation for the 'fifo' | 'average' | 'manual' | 'none' allocation methods. */
  private async validateGeneralized(
    supplierId: string,
    supplierName: string,
    allocationMethod: string,
    requestedItems: SupplierReturnItemDto[],
    excludeId?: string,
  ): Promise<{ items: SupplierReturnItem[]; linkedInvoices: SrLinkedInvoice[] }> {
    if (!requestedItems || !requestedItems.length) {
      throw new BadRequestException('يجب اختيار صنف واحد على الأقل للإرجاع');
    }
    const validated: SupplierReturnItem[] = [];
    const invoiceMap = new Map<string, SrLinkedInvoice>();

    for (const it of requestedItems) {
      const code = String(it.code || '').trim();
      if (!code) {
        throw new BadRequestException('كود الصنف مطلوب');
      }
      const qty = Number(it.qty) || 0;
      if (qty <= 0) {
        throw new BadRequestException(`كمية غير صالحة للصنف ${code}`);
      }

      let allocResult: { allocations: SupplierReturnItem['allocations']; blendedUnitPrice: number };
      if (allocationMethod === 'fifo') {
        allocResult = await this.allocationService.allocateFifo(
          supplierId,
          supplierName,
          code,
          qty,
          excludeId,
        );
      } else if (allocationMethod === 'average') {
        allocResult = await this.allocationService.allocateAverage(
          supplierId,
          supplierName,
          code,
          qty,
          excludeId,
        );
      } else if (allocationMethod === 'manual') {
        allocResult = await this.allocationService.validateManualAllocation(
          supplierId,
          supplierName,
          code,
          qty,
          (it.allocations || []).map((a) => ({
            code,
            qty: Number(a.qty),
            unitCost: Number(a.unitCost),
            sourceTransactionId: a.sourceTransactionId || '',
            sourceRef: a.sourceRef || '',
          })),
          excludeId,
        );
      } else {
        // 'none' — no cost basis lookup; the admin's entered price is trusted as-is.
        const price = Number(it.price);
        if (!Number.isFinite(price) || price < 0) {
          throw new BadRequestException(`سعر غير صالح للصنف ${code}`);
        }
        allocResult = { allocations: [], blendedUnitPrice: price };
      }

      const price = allocResult.blendedUnitPrice;
      validated.push({
        code,
        name: it.name || code,
        qty,
        price,
        total: qty * price,
        note: it.note || '',
        allocations: allocResult.allocations,
      });

      for (const a of allocResult.allocations) {
        if (!a.sourceTransactionId) continue;
        const existing = invoiceMap.get(a.sourceTransactionId);
        const lineTotal = a.qty * a.unitCost;
        if (existing) {
          existing.allocatedTotal += lineTotal;
        } else {
          invoiceMap.set(a.sourceTransactionId, {
            transactionId: a.sourceTransactionId,
            ref: a.sourceRef || a.sourceTransactionId,
            date: '',
            allocatedTotal: lineTotal,
          });
        }
      }
    }

    return { items: validated, linkedInvoices: Array.from(invoiceMap.values()) };
  }

  /**
   * A supplier return physically removes stock from the warehouse, so it can never exceed what's
   * actually on hand right now — regardless of what purchase history or allocation would otherwise
   * permit (e.g. some of that purchase may have already been sold). Runs after allocation so it
   * sees the final per-code quantities from either validation path, and runs again on approve()
   * (via the same validateAndAllocate() call) as a defense against stock having dropped between
   * creation and approval.
   */
  private async assertStockAvailable(items: SupplierReturnItem[]): Promise<void> {
    if (!items.length) return;
    const inventory = await this.transactionsService.getInventory();
    const stockByCode = new Map(inventory.map((i) => [i.code, i.current]));
    const errors: string[] = [];
    for (const it of items) {
      const current = stockByCode.get(it.code) ?? 0;
      if (it.qty > current) {
        errors.push(
          `${it.code}: الكمية المطلوب إرجاعها (${it.qty}) تتجاوز المخزون الحالي (${current}) — لا يمكن إرجاع كمية أكبر مما هو متوفر فعلياً في المخزن`,
        );
      }
    }
    if (errors.length) {
      throw new BadRequestException(errors.join('؛ '));
    }
  }

  /** Routes to the legacy single-invoice validator or the generalized allocator, based on input shape. */
  private async validateAndAllocate(
    supplierId: string,
    supplierName: string,
    originalTransactionId: string | undefined,
    linkedTransactionIds: string[] | undefined,
    allocationMethodInput: string | undefined,
    requestedItems: SupplierReturnItemDto[],
    excludeId?: string,
  ): Promise<{
    items: SupplierReturnItem[];
    linkedInvoices: SrLinkedInvoice[];
    allocationMethod: string;
    originalTransactionId: string;
    originalRef: string;
    originalDate: string;
  }> {
    const isLegacy =
      !!originalTransactionId && (!linkedTransactionIds || !linkedTransactionIds.length);

    if (isLegacy) {
      const { items, linkedInvoices } = await this.validateSingleInvoice(
        originalTransactionId as string,
        requestedItems,
        excludeId,
      );
      await this.assertStockAvailable(items);
      return {
        items,
        linkedInvoices,
        allocationMethod: 'single-invoice',
        originalTransactionId: linkedInvoices[0].transactionId,
        originalRef: linkedInvoices[0].ref,
        originalDate: linkedInvoices[0].date,
      };
    }

    const allocationMethod = allocationMethodInput || 'none';
    const { items, linkedInvoices } = await this.validateGeneralized(
      supplierId,
      supplierName,
      allocationMethod,
      requestedItems,
      excludeId,
    );
    await this.assertStockAvailable(items);
    const single = linkedInvoices.length === 1 ? linkedInvoices[0] : undefined;
    return {
      items,
      linkedInvoices,
      allocationMethod,
      originalTransactionId: single?.transactionId || '',
      originalRef: single?.ref || '',
      originalDate: single?.date || '',
    };
  }

  async findAll(): Promise<SupplierReturnOrderDocument[]> {
    return this.srModel.find().sort({ createdAt: -1 }).exec();
  }

  async findBySupplier(
    supplierId: string,
  ): Promise<SupplierReturnOrderDocument[]> {
    return this.srModel.find({ supplierId }).sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<SupplierReturnOrderDocument> {
    const r = await this.srModel.findById(id).exec();
    if (!r) {
      throw new NotFoundException('مرتجع المورد غير موجود');
    }
    return r;
  }

  async create(
    dto: CreateSupplierReturnDto,
    requestedBy: string,
    isAdminRequester = false,
  ): Promise<SupplierReturnOrderDocument> {
    // Not required at create-time — see SupplierReturnOrder.vaultRefundAccount. An invalid label is
    // still rejected; an absent one just defers the choice to complete().
    if (dto.vaultRefundAccount && !normalizeVaultAccountLabel(dto.vaultRefundAccount)) {
      throw new BadRequestException('قسم الخزنة غير صالح');
    }
    const vaultRefundAccount =
      normalizeVaultAccountLabel(dto.vaultRefundAccount) || '';
    const {
      items,
      linkedInvoices,
      allocationMethod,
      originalTransactionId,
      originalRef,
      originalDate,
    } = await this.validateAndAllocate(
      dto.supplierId,
      dto.supplierName,
      dto.originalTransactionId,
      dto.linkedTransactionIds,
      dto.allocationMethod,
      dto.items,
    );
    const itemsTotal = this.sumItemsTotal(items);
    // An admin is both requester and approver, so their non-draft submissions skip the pending-
    // approval step entirely and post straight to معتمد — approving your own request would be a
    // no-op review. Drafts are unaffected (still مسودة until explicitly submitted) since saving as
    // draft is an explicit "not ready yet" signal, independent of who's creating it.
    const autoApprove = isAdminRequester && !dto.saveAsDraft;
    const status = dto.saveAsDraft ? 'مسودة' : autoApprove ? 'معتمد' : 'معلق';
    const returnNumber = await this.generateReturnNumber();
    const now = new Date().toISOString();
    const statusEntry: SrStatusEntry = {
      status,
      changedBy: requestedBy,
      changedAt: now,
      note: dto.saveAsDraft
        ? 'إنشاء كمسودة'
        : autoApprove
          ? 'إنشاء واعتماد تلقائي (بواسطة مدير)'
          : 'إنشاء وإرسال للاعتماد',
    };
    const created = await this.srModel.create({
      supplierId: dto.supplierId,
      supplierName: dto.supplierName,
      returnNumber,
      originalTransactionId,
      originalRef,
      originalDate,
      linkedInvoices,
      allocationMethod,
      returnDate: now.split('T')[0],
      reason: dto.reason,
      reasonDetails: dto.reasonDetails || '',
      items,
      itemsTotal,
      total: itemsTotal,
      status,
      vaultRefundAccount,
      createdBy: requestedBy,
      linkedTransactionId: '',
      statusHistory: [statusEntry],
      ...(autoApprove ? { approvedBy: requestedBy, approvedAt: now } : {}),
    });
    await this.suppliersService.addLog(dto.supplierId, {
      action: 'إنشاء مرتجع مورد',
      detail: `مرتجع ${returnNumber} — ${itemsTotal} ج${created.originalRef ? ' من الفاتورة ' + created.originalRef : ''}${autoApprove ? ' (معتمد تلقائياً)' : ''}`,
      by: requestedBy,
    });
    return created;
  }

  /** يسمح بتعديل الأصناف/السبب/قسم الخزنة طالما الطلب لم يُعتمد بعد. */
  async update(
    id: string,
    dto: UpdateSupplierReturnDto,
    by: string,
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (!['مسودة', 'معلق'].includes(r.status)) {
      throw new BadRequestException(
        'لا يمكن تعديل هذا الطلب بعد اعتماده أو إتمامه أو رفضه',
      );
    }
    let vaultRefundAccount = r.vaultRefundAccount;
    if (dto.vaultRefundAccount) {
      const normalized = normalizeVaultAccountLabel(dto.vaultRefundAccount);
      if (!normalized) {
        throw new BadRequestException('قسم الخزنة غير صالح');
      }
      vaultRefundAccount = normalized;
    }
    if (dto.items) {
      const {
        items,
        linkedInvoices,
        allocationMethod,
        originalTransactionId,
        originalRef,
        originalDate,
      } = await this.validateAndAllocate(
        r.supplierId,
        r.supplierName,
        r.allocationMethod === 'single-invoice' ? r.originalTransactionId : undefined,
        dto.linkedTransactionIds ||
          (r.allocationMethod !== 'single-invoice'
            ? r.linkedInvoices.map((li) => li.transactionId)
            : undefined),
        dto.allocationMethod || (r.allocationMethod !== 'single-invoice' ? r.allocationMethod : undefined),
        dto.items,
        String(r._id),
      );
      r.items = items;
      r.linkedInvoices = linkedInvoices;
      r.allocationMethod = allocationMethod;
      r.originalTransactionId = originalTransactionId;
      r.originalRef = originalRef;
      r.originalDate = originalDate;
      r.itemsTotal = this.sumItemsTotal(items);
      r.total = r.itemsTotal;
    }
    if (dto.reason) {
      r.reason = dto.reason;
    }
    if (dto.reasonDetails !== undefined) {
      r.reasonDetails = dto.reasonDetails;
    }
    r.vaultRefundAccount = vaultRefundAccount;
    r.statusHistory.push({
      status: r.status,
      changedBy: by,
      changedAt: new Date().toISOString(),
      note: 'تعديل بيانات المرتجع',
    });
    const saved = await r.save();
    await this.suppliersService.addLog(r.supplierId, {
      action: 'تعديل مرتجع مورد',
      detail: `مرتجع ${r.returnNumber} — ${r.total} ج`,
      by,
    });
    return saved;
  }

  async submitForApproval(
    id: string,
    by: string,
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (r.status !== 'مسودة') {
      throw new BadRequestException('لا يمكن إرسال هذا الطلب — ليس في حالة مسودة');
    }
    r.status = 'معلق';
    r.statusHistory.push({
      status: 'معلق',
      changedBy: by,
      changedAt: new Date().toISOString(),
    });
    return r.save();
  }

  async approve(
    id: string,
    approvedBy: string,
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (r.status !== 'معلق') {
      throw new BadRequestException('الطلب ليس معلقاً');
    }
    // إعادة التحقق من الأصناف قبل الاعتماد (دفاع ضد تعديل الفاتورة الأصلية بعد الإنشاء)
    if (r.allocationMethod === 'single-invoice' && r.originalTransactionId) {
      await this.validateSingleInvoice(
        r.originalTransactionId,
        r.items,
        String(r._id),
      );
    } else if (['fifo', 'average'].includes(r.allocationMethod)) {
      await this.validateGeneralized(
        r.supplierId,
        r.supplierName,
        r.allocationMethod,
        r.items,
        String(r._id),
      );
    }
    // Re-check stock too — it can have dropped (via a sale) between creation and approval.
    await this.assertStockAvailable(r.items);
    r.status = 'معتمد';
    r.approvedBy = approvedBy;
    r.approvedAt = new Date().toISOString();
    r.statusHistory.push({
      status: 'معتمد',
      changedBy: approvedBy,
      changedAt: r.approvedAt,
    });
    const saved = await r.save();
    await this.suppliersService.addLog(r.supplierId, {
      action: 'اعتماد مرتجع مورد',
      detail: `مرتجع ${r.returnNumber} — بانتظار الإتمام`,
      by: approvedBy,
    });
    return saved;
  }

  /**
   * Splits a return's value into debt-offset / cash-refund / standing-credit portions.
   *
   * 'debt-offset' consumes the supplier's outstanding debt first (capped at it) and routes any
   * excess per remainderMode. 'refund' and 'credit' deliberately bypass the debt entirely — the
   * admin may owe the supplier money and still choose to take the return's value as cash or hold
   * it as credit. Undefined settlementMode preserves the pre-existing behavior (offset first,
   * remainder refunded) so older clients keep working unchanged.
   */
  private computeSettlementSplit(
    returnValue: number,
    debtBefore: number,
    settlementMode: 'debt-offset' | 'refund' | 'credit' | undefined,
    remainderMode: 'refund' | 'credit' | undefined,
  ): { debtOffsetAmount: number; refundAmount: number; creditAmount: number } {
    if (settlementMode === 'refund') {
      return { debtOffsetAmount: 0, refundAmount: returnValue, creditAmount: 0 };
    }
    if (settlementMode === 'credit') {
      return { debtOffsetAmount: 0, refundAmount: 0, creditAmount: returnValue };
    }
    const debtOffsetAmount = Math.max(0, Math.min(returnValue, debtBefore));
    const remainder = returnValue - debtOffsetAmount;
    if (remainder <= 0) {
      return { debtOffsetAmount, refundAmount: 0, creditAmount: 0 };
    }
    return remainderMode === 'credit'
      ? { debtOffsetAmount, refundAmount: 0, creditAmount: remainder }
      : { debtOffsetAmount, refundAmount: remainder, creditAmount: 0 };
  }

  async complete(
    id: string,
    completedBy: string,
    settlementMode?: 'debt-offset' | 'refund' | 'credit',
    remainderMode?: 'refund' | 'credit',
    vaultRefundAccount?: string,
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (r.status !== 'معتمد') {
      throw new BadRequestException('يجب اعتماد الطلب أولاً قبل إتمامه');
    }
    const returnValue = Number(r.total);
    if (returnValue <= 0) {
      throw new BadRequestException('لا يمكن إتمام المرتجع — المبلغ غير صالح');
    }

    // STEP 1: read current ledger balance BEFORE this return is applied.
    const { balance: debtBefore } = await this.supplierLedgerService.getBalanceSummary(
      r.supplierId,
    );

    // STEP 2: compute the split.
    const { debtOffsetAmount, refundAmount, creditAmount } =
      this.computeSettlementSplit(
        returnValue,
        debtBefore,
        settlementMode,
        remainderMode,
      );

    // The vault segment is decided here, where it's finally known whether cash moves at all. A
    // value supplied now wins over any stamped at create-time (older records / legacy clients).
    if (vaultRefundAccount) {
      const normalized = normalizeVaultAccountLabel(vaultRefundAccount);
      if (!normalized) {
        throw new BadRequestException('قسم الخزنة غير صالح');
      }
      r.vaultRefundAccount = normalized;
    }
    if (refundAmount > 0 && !r.vaultRefundAccount) {
      throw new BadRequestException(
        'حدد قسم الخزنة الذي سيُضاف إليه مبلغ الرد النقدي',
      );
    }

    const returnDate = new Date().toISOString();

    // STEP 3: build the مرتجع مشتريات Transaction DTO — total/deposit/depMethod now reflect
    // only the cash-refund portion, not the full return value. Items list is unchanged —
    // inventory impact was never about cash, it's driven by the item quantities.
    const txDto = {
      date: returnDate,
      type: 'مرتجع مشتريات' as const,
      client: r.supplierName,
      supplierId: r.supplierId,
      phone: '',
      ref: (r.linkedInvoices[0]?.ref || r.originalRef || r.returnNumber) + '-SRET',
      notes: `مرتجع مورد معتمد ${r.returnNumber}: ${r.reason}${r.reasonDetails ? ' — ' + r.reasonDetails : ''} | القيمة الإجمالية: ${returnValue} ج — خصم من المديونية: ${debtOffsetAmount} ج — رد نقدي: ${refundAmount} ج — رصيد آجل: ${creditAmount} ج`,
      items: r.items,
      total: refundAmount,
      employee: completedBy,
      deposit: 0,
      remaining: 0,
      depMethod: refundAmount > 0 ? r.vaultRefundAccount : '',
      payment: refundAmount > 0 ? r.vaultRefundAccount : '',
      payStatus: 'مكتمل',
      discount: 0,
      shipCost: 0,
    };
    const tx = await this.transactionsService.create(txDto as never);

    // STEP 4: post ledger entries (debt-offset + credit + refund-audit-row).
    const settlementResult = await this.supplierLedgerService.postReturnSettlement({
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      returnId: String(r._id),
      returnNumber: r.returnNumber,
      date: returnDate,
      debtOffsetAmount,
      creditAmount,
      refundAmount,
      // يربط صف «رد نقدي» في كشف الحساب بعملية الخزنة التي خرجت/دخلت فعلاً.
      refundTxRef: tx?.ref || '',
      employee: completedBy,
    });

    // STEP 5: persist settlement outcome + status on the return order.
    r.status = 'مكتمل';
    r.linkedTransactionId = String(tx._id);
    r.settlement = {
      debtBalanceBeforeApplied: debtBefore,
      returnValue,
      debtOffsetAmount,
      creditAmount,
      refundAmount,
      settlementType:
        debtOffsetAmount > 0 && refundAmount > 0
          ? 'mixed-debt-refund'
          : debtOffsetAmount > 0 && creditAmount > 0
            ? 'mixed-debt-credit'
            : refundAmount > 0
              ? 'refund'
              : creditAmount > 0
                ? 'credit'
                : 'debt-offset',
      debtBalanceAfter: settlementResult.balanceAfter,
      decidedBy: completedBy,
      decidedAt: returnDate,
    };
    r.statusHistory.push({
      status: 'مكتمل',
      changedBy: completedBy,
      changedAt: returnDate,
      note:
        'تسوية: ' +
        [
          debtOffsetAmount ? `خصم مديونية ${debtOffsetAmount} ج` : '',
          refundAmount ? `رد نقدي ${refundAmount} ج (${r.vaultRefundAccount})` : '',
          creditAmount ? `رصيد آجل ${creditAmount} ج` : '',
        ]
          .filter(Boolean)
          .join(' + ') +
        ` — معاملة #${tx.ref}`,
    });
    const saved = await r.save();
    await this.suppliersService.addLog(r.supplierId, {
      action: 'اكتمال مرتجع مورد',
      detail: `مرتجع ${r.returnNumber} — ${r.settlement.settlementType} — الرصيد بعد التسوية: ${settlementResult.balanceAfter} ج`,
      by: completedBy,
    });
    return saved;
  }

  async reject(
    id: string,
    by: string,
    rejectedReason = '',
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (r.status !== 'معلق') {
      throw new BadRequestException('الطلب ليس معلقاً');
    }
    r.status = 'مرفوض';
    r.approvedBy = by;
    r.approvedAt = new Date().toISOString();
    r.rejectedReason = rejectedReason;
    r.statusHistory.push({
      status: 'مرفوض',
      changedBy: by,
      changedAt: r.approvedAt,
      note: rejectedReason,
    });
    return r.save();
  }

  async cancel(
    id: string,
    by: string,
    reason = '',
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (!NON_TERMINAL_STATUSES.includes(r.status)) {
      throw new BadRequestException(
        'لا يمكن إلغاء هذا الطلب في حالته الحالية',
      );
    }
    r.status = 'ملغي';
    r.statusHistory.push({
      status: 'ملغي',
      changedBy: by,
      changedAt: new Date().toISOString(),
      note: reason,
    });
    return r.save();
  }

  /**
   * Undoes a COMPLETED return's inventory, supplier-ledger, and vault-cash effects without
   * deleting the original record. status stays 'مكتمل' — r.reversal's presence is what "reversed"
   * means (see SrReversalInfo). Never mutates history; only posts compensating actions, mirroring
   * the existing TransactionsService.cancel() pattern used everywhere else in this codebase.
   *
   * Ordering is deliberate: ledger reversal runs BEFORE the linked transaction is cancelled. If
   * the ledger step succeeds but the transaction-cancel step then fails, the operation is safely
   * retryable — reverseReturnSettlement() only reverses not-yet-reversed rows, so a retry skips
   * straight to retrying the cancel. The reverse ordering would not be retryable: cancel()'s own
   * `if (tx.cancelled) throw` guard would permanently block a retry after a ledger-step failure,
   * leaving the ledger wrong with no automatic recovery path.
   */
  async reverseReturn(
    id: string,
    reversedBy: string,
    reason: string,
  ): Promise<SupplierReturnOrderDocument> {
    const r = await this.findById(id);
    if (r.status !== 'مكتمل') {
      throw new BadRequestException('لا يمكن عكس طلب لم يكتمل بعد');
    }
    if (r.reversal) {
      throw new BadRequestException('تم عكس هذا المرتجع بالفعل');
    }
    if (!r.linkedTransactionId) {
      throw new BadRequestException('لا توجد معاملة مرتبطة بهذا المرتجع لعكسها');
    }
    const linkedTx = await this.transactionsService.findById(r.linkedTransactionId);
    if (linkedTx.cancelled) {
      throw new BadRequestException(
        'المعاملة المرتبطة بهذا المرتجع ملغاة بالفعل — لا يمكن إتمام العكس بأمان',
      );
    }

    const { balance: debtBefore } = await this.supplierLedgerService.getBalanceSummary(
      r.supplierId,
    );

    const ledgerResult = await this.supplierLedgerService.reverseReturnSettlement({
      returnId: String(r._id),
      by: reversedBy,
      reason,
    });

    const cancelledTx = await this.transactionsService.cancel(r.linkedTransactionId, {
      cancelReason: `عكس مرتجع مورد ${r.returnNumber}: ${reason}`,
      cancelledBy: reversedBy,
    });

    const now = new Date().toISOString();
    r.reversal = {
      reversedBy,
      reversedAt: now,
      reason,
      reversalTransactionId: r.linkedTransactionId,
      reversedLedgerEntryIds: ledgerResult.reversedEntries.map((e) => String(e._id)),
      balanceBeforeReversal: debtBefore,
      balanceAfterReversal: ledgerResult.balanceAfter,
    };
    r.statusHistory.push({
      status: 'مكتمل',
      changedBy: reversedBy,
      changedAt: now,
      note: `عكس المرتجع: ${reason} — الرصيد قبل: ${debtBefore} ج، بعد: ${ledgerResult.balanceAfter} ج — معاملة ملغاة #${cancelledTx.ref}`,
    });
    const saved = await r.save();
    await this.suppliersService.addLog(r.supplierId, {
      action: 'عكس مرتجع مورد',
      detail: `مرتجع ${r.returnNumber} — السبب: ${reason} — الرصيد بعد العكس: ${ledgerResult.balanceAfter} ج`,
      by: reversedBy,
    });
    return saved;
  }
}
