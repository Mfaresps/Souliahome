import { notifyApproval } from '../notifications/admin-events';
import { NotificationsService } from '../notifications/notifications.service';
import { Inject as PushInject, Optional as PushOptional } from '@nestjs/common';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ClientSession, Types } from 'mongoose';
import { DatabaseWriteContext } from '../shared/database-write-context';
import { InventoryUnitsService } from '../inventory-units/inventory-units.service';
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
import { ProductsService } from '../products/products.service';
import { allocateReturnOffset } from '../shared/purchase-settlement.util';

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
  @PushOptional() @PushInject(NotificationsService) private readonly notifications?: NotificationsService;
  constructor(
    @InjectModel(SupplierReturnOrder.name)
    private readonly srModel: Model<SupplierReturnOrderDocument>,
    private readonly transactionsService: TransactionsService,
    private readonly suppliersService: SuppliersService,
    private readonly supplierLedgerService: SupplierLedgerService,
    private readonly allocationService: SrAllocationService,
    private readonly productsService: ProductsService,
    private readonly unitTracking: InventoryUnitsService,
  ) {}

  private async atomic<T>(work: (context: DatabaseWriteContext) => Promise<T>, id?: string): Promise<T> {
    const session = await this.srModel.db.startSession(); let result!: T;
    let effects: DatabaseWriteContext['afterCommit'] = [];
    try {
      await session.withTransaction(async () => {
        effects = [];
        if (id) await this.srModel.updateOne({ _id: id }, { $inc: { unitTrackingRevision: 1 } }, { session });
        result = await work({ session, afterCommit: effects });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally { await session.endSession(); }
    for (const effect of effects) { try { await effect(); } catch { /* Committed records remain authoritative. */ } }
    return result;
  }

  private logAfter(context: DatabaseWriteContext, supplierId: string, entry: { action: string; detail: string; by: string }) {
    context.afterCommit.push(async () => { await this.suppliersService.addLog(supplierId, entry); });
  }

  /**
   * صورة الصنف بالكود، للمسار العام اللي مافيهوش فاتورة أصلية واحدة نقرأ منها.
   *
   * بترجّع '' لو الصنف اتمسح أو مالوش صورة — السطر ساعتها بيعرض الأيقونة
   * البديلة بدل ما المرتجع كله يفشل. الصورة تفصيلة عرض، مش شرط لصحة العملية.
   */
  private async resolveItemImage(code: string): Promise<string> {
    try {
      const p = await this.productsService.findByCode(code);
      const img = String((p as { imageUrl?: string } | null)?.imageUrl || '').trim();
      return /^https?:\/\//i.test(img) ? img : '';
    } catch {
      return '';
    }
  }

  async lookupPiece(identifier: string, supplierId?: string) {
    const data = await this.unitTracking.lookup(identifier);
    if (supplierId && Types.ObjectId.isValid(supplierId) && data.unit.origin?.purchaseTransactionId && !['supplier-return-pending', 'returned-to-supplier'].includes(data.unit.status)) {
      const source: any = await this.srModel.db.collection('transactions').findOne({ _id: new Types.ObjectId(data.unit.origin.purchaseTransactionId) });
      const supplier: any = await this.srModel.db.collection('suppliers').findOne({ _id: new Types.ObjectId(supplierId) });
      if (!source || !supplier || source.cancelled || source.archived || (source.supplierId ? String(source.supplierId) !== supplierId : String(source.client || '').trim() !== String(supplier.name).trim())) {
        throw new BadRequestException({ code: 'SR_WRONG_SUPPLIER', message: 'Return piece belongs to another supplier' });
      }
    }
    const product = await this.srModel.db.collection('products').findOne({ _id: new Types.ObjectId(data.unit.productId) },
      { projection: { name: 1, code: 1 } });
    return { unit: data.unit, product, supplierReturn: data.supplierReturn };
  }

  async linkPieces(id: string, dto: UpdateSupplierReturnDto, by: string, actorId: string, context?: DatabaseWriteContext): Promise<SupplierReturnOrderDocument> {
    if (!context) return this.atomic(ctx => this.linkPieces(id, dto, by, actorId, ctx), id);
    const r = await this.findById(id, context.session);
    if (!NON_TERMINAL_STATUSES.includes(r.status)) throw new BadRequestException({ code: 'SR_LINK_CLOSED', message: 'Return is no longer editable' });
    if (!dto.items || dto.items.length !== r.items.length || dto.items.some(input => !r.items.some(item => item.code === input.code && item.qty === input.qty))) {
      throw new BadRequestException({ code: 'SR_PIECE_COUNT', message: 'Return products and quantities must match' });
    }
    await this.unitTracking.finishSupplierReturnUnits(r, actorId, by, context, true);
    r.warehouseCode = dto.warehouseCode || r.warehouseCode || 'MAIN';
    await this.unitTracking.reserveSupplierReturnUnits(r.items, dto.items, r, actorId, by, context);
    r.markModified('items');
    r.statusHistory.push({ status: r.status, changedBy: by, changedAt: new Date().toISOString(), note: 'ربط القطع الفعلية بالمسح أو الإدخال اليدوي' });
    return r.save({ session: context.session });
  }

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
    const originalByCode = new Map<
      string,
      { qty: number; price: number; imageUrl: string }
    >();
    for (const it of originalTx.items || []) {
      const code = String(it.code || '').trim();
      if (!code) continue;
      const prev = originalByCode.get(code);
      originalByCode.set(code, {
        qty: (prev?.qty || 0) + (Number(it.qty) || 0),
        price: Number(it.price) || 0,
        // الصورة بتتحل من الفاتورة الأصلية مش من الـpayload: الأصناف هنا بيبنيها
        // السيرفر أصلاً، فمفيش سبب نثق في العميل في حاجة إحنا شايفينها قدامنا.
        imageUrl: prev?.imageUrl || String((it as { imageUrl?: string }).imageUrl || ''),
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
        imageUrl: original.imageUrl,
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
        imageUrl: await this.resolveItemImage(code),
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

  async findById(id: string, session?: ClientSession): Promise<SupplierReturnOrderDocument> {
    const r = await this.srModel.findById(id).session(session || null).exec();
    if (!r) {
      throw new NotFoundException('مرتجع المورد غير موجود');
    }
    return r;
  }

  async create(
    dto: CreateSupplierReturnDto,
    requestedBy: string,
    isAdminRequester = false,
    actorId = '', context?: DatabaseWriteContext,
  ): Promise<SupplierReturnOrderDocument> {
    if (!context) return this.atomic(ctx => this.create(dto, requestedBy, isAdminRequester, actorId, ctx));
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
    const data: any = {
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
      warehouseCode: dto.warehouseCode || 'MAIN',
    };
    const created = new this.srModel(data);
    await this.unitTracking.reserveSupplierReturnUnits(items, dto.items, created, actorId, requestedBy, context);
    created.items = items; created.markModified('items');
    await created.save({ session: context.session });
    this.logAfter(context, dto.supplierId, {
      action: 'إنشاء مرتجع مورد',
      detail: `مرتجع ${returnNumber} — ${itemsTotal} ج${created.originalRef ? ' من الفاتورة ' + created.originalRef : ''}${autoApprove ? ' (معتمد تلقائياً)' : ''}`,
      by: requestedBy,
    });
    if (!dto.saveAsDraft) context.afterCommit.push(() => notifyApproval(this.notifications, 'approval:supplier-return:' + created._id + ':' + (autoApprove ? 'approved' : 'pending'), returnNumber, 'supplierReturn:' + created._id, { actorName: requestedBy, actionKey: 'supplier-return', status: autoApprove ? 'approved' : 'pending' }));
    return created;
  }

  /** يسمح بتعديل الأصناف/السبب/قسم الخزنة طالما الطلب لم يُعتمد بعد. */
  async update(
    id: string,
    dto: UpdateSupplierReturnDto,
    by: string,
    actorId = '', context?: DatabaseWriteContext,
  ): Promise<SupplierReturnOrderDocument> {
    if (!context) return this.atomic(ctx => this.update(id, dto, by, actorId, ctx), id);
    const r = await this.findById(id, context.session);
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
      await this.unitTracking.finishSupplierReturnUnits(r, actorId, by, context, true);
      r.warehouseCode = dto.warehouseCode || r.warehouseCode || 'MAIN';
      if (dto.reason) r.reason = dto.reason;
      if (dto.reasonDetails !== undefined) r.reasonDetails = dto.reasonDetails;
      await this.unitTracking.reserveSupplierReturnUnits(items, dto.items, r, actorId, by, context);
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
    const saved = await r.save({ session: context.session });
    this.logAfter(context, r.supplierId, {
      action: 'تعديل مرتجع مورد',
      detail: `مرتجع ${r.returnNumber} — ${r.total} ج`,
      by,
    });
    return saved;
  }

  async submitForApproval(
    id: string,
    by: string,
    context?: DatabaseWriteContext,
  ): Promise<SupplierReturnOrderDocument> {
    if (!context) return this.atomic(ctx => this.submitForApproval(id, by, ctx), id);
    const r = await this.findById(id, context.session);
    if (r.status !== 'مسودة') {
      throw new BadRequestException('لا يمكن إرسال هذا الطلب — ليس في حالة مسودة');
    }
    r.status = 'معلق';
    r.statusHistory.push({
      status: 'معلق',
      changedBy: by,
      changedAt: new Date().toISOString(),
    });
    const saved = await r.save({ session: context.session });
    context.afterCommit.push(() => notifyApproval(this.notifications, 'approval:supplier-return:' + id + ':pending', r.returnNumber, 'supplierReturn:' + id, { actorName: r.createdBy || by, actionKey: 'supplier-return', status: 'pending' }));
    return saved;
  }

  async approve(
    id: string,
    approvedBy: string,
    context?: DatabaseWriteContext,
  ): Promise<SupplierReturnOrderDocument> {
    if (!context) return this.atomic(ctx => this.approve(id, approvedBy, ctx), id);
    const r = await this.findById(id, context.session);
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
    const saved = await r.save({ session: context.session });
    this.logAfter(context, r.supplierId, {
      action: 'اعتماد مرتجع مورد',
      detail: `مرتجع ${r.returnNumber} — بانتظار الإتمام`,
      by: approvedBy,
    });
    context.afterCommit.push(() => notifyApproval(this.notifications, 'approval:supplier-return:' + id + ':approved', r.returnNumber, 'supplierReturn:' + id, { actorName: r.createdBy, actionKey: 'supplier-return', status: 'approved' }));
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
    actorId = '', context?: DatabaseWriteContext,
  ): Promise<SupplierReturnOrderDocument> {
    if (!context) return this.atomic(ctx => this.complete(id, completedBy, settlementMode, remainderMode, vaultRefundAccount, actorId, ctx), id);
    const r = await this.findById(id, context.session);
    if (r.status === 'مكتمل' && r.linkedTransactionId && !r.reversal) return r;
    if (r.status !== 'معتمد') {
      throw new BadRequestException('يجب اعتماد الطلب أولاً قبل إتمامه');
    }
    const returnValue = Number(r.total);
    if (returnValue <= 0) {
      throw new BadRequestException('لا يمكن إتمام المرتجع — المبلغ غير صالح');
    }

    // STEP 1: read current ledger balance BEFORE this return is applied.
    const { balance: debtBefore } = await this.supplierLedgerService.getBalanceSummary(
      r.supplierId, context,
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
      warehouseCode: r.warehouseCode || 'MAIN',
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
    await this.unitTracking.finishSupplierReturnUnits(r, actorId, completedBy, context);
    const tx = await this.transactionsService.create(txDto as never, undefined, undefined, undefined, context);

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
    }, context);

    // STEP 4b: the debt-offset reduces the INVOICES too, not only the ledger — otherwise the
    // invoices kept showing the full remaining, and paying or writing off that stale remaining
    // created supplier credit that never existed. Same DB transaction as the ledger rows.
    const offsetResult = debtOffsetAmount > 0
      ? await this.applyReturnOffsetToInvoices(r, debtOffsetAmount, completedBy, returnDate, context)
      : { rows: [], unallocated: 0 };

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
      invoiceOffsets: offsetResult.rows,
      unallocatedOffset: offsetResult.unallocated,
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
    const saved = await r.save({ session: context.session });
    this.logAfter(context, r.supplierId, {
      action: 'اكتمال مرتجع مورد',
      detail: `مرتجع ${r.returnNumber} — ${r.settlement.settlementType} — الرصيد بعد التسوية: ${settlementResult.balanceAfter} ج`,
      by: completedBy,
    });
    return saved;
  }

  /**
   * Spreads `amount` over the supplier's open purchase invoices (the invoices the goods came from
   * first, then oldest first — `allocateReturnOffset`) and writes each share onto the invoice:
   * `remaining` drops, `supplierReturnOffsets` records it. Each write is conditional on the
   * remaining read here, so a payment landing in between aborts the whole completion.
   */
  private async applyReturnOffsetToInvoices(
    r: SupplierReturnOrderDocument,
    amount: number,
    by: string,
    at: string,
    context: DatabaseWriteContext,
  ): Promise<{ rows: Array<{ transactionId: string; ref: string; amount: number }>; unallocated: number }> {
    const col = this.srModel.db.collection('transactions');
    const sid = String(r.supplierId || '');
    const docs = await col.find(
      {
        type: 'مشتريات', cancelled: { $ne: true }, archived: { $ne: true }, remaining: { $gt: 0 },
        ref: { $not: /-RET/ },
        $or: [{ supplierId: sid }, { supplierId: { $in: ['', null] }, client: r.supplierName }],
      },
      { session: context.session, projection: { ref: 1, remaining: 1, date: 1, createdAt: 1 } },
    ).toArray();
    const plan = allocateReturnOffset(
      amount,
      docs.map((d: any) => ({ id: String(d._id), ref: String(d.ref || ''), remaining: Number(d.remaining) || 0, date: String(d.date || ''), createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : '' })),
      (r.linkedInvoices || []).map((li) => ({ id: String(li.transactionId), cap: Number(li.allocatedTotal) || 0 })),
    );
    const r2 = (n: number) => Math.round(n * 100) / 100;
    for (const row of plan.rows) {
      const doc: any = docs.find((d: any) => String(d._id) === row.id);
      const newRemaining = r2((Number(doc.remaining) || 0) - row.amount);
      const done = newRemaining < 0.005;
      const res = await col.updateOne(
        { _id: doc._id, remaining: doc.remaining, cancelled: { $ne: true } },
        {
          $set: { remaining: done ? 0 : newRemaining, ...(done ? { payStatus: 'مكتمل' } : {}) },
          $push: { supplierReturnOffsets: { returnId: String(r._id), returnNumber: r.returnNumber, amount: row.amount, at, by } } as any,
        },
        { session: context.session },
      );
      if (!res.matchedCount) {
        throw new ConflictException(`تغيّرت الفاتورة #${row.ref} أثناء إتمام المرتجع — أعد المحاولة`);
      }
    }
    return { rows: plan.rows.map((x) => ({ transactionId: x.id, ref: x.ref, amount: x.amount })), unallocated: plan.unallocated };
  }

  /**
   * One-time correction for data from before Nov 15, 2026: writes onto the invoices what the
   * supplier ledger already holds but no invoice shows, so the sum of invoice remainings equals
   * the ledger again.
   *  (a) every completed, non-reversed return whose «خصم من المديونية» was never written onto an
   *      invoice (no `settlement.invoiceOffsets`) — spread like a new return (`allocateReturnOffset`);
   *  (b) the manual ledger reductions the admin names (`ledgerEntryIds`: negative, non-reversed
   *      'manual-adjustment' rows) — a supplier discount or an uncoded return booked in the ledger only.
   * Touches no vault entry and no ledger row (both are already right). Dry run unless
   * `dryRun === false`; a second run finds nothing to do (returns are marked, ledger rows are
   * recorded on the invoice by id).
   */
  async backfillInvoiceOffsets(
    opts: { dryRun?: boolean; supplierId?: string; ledgerEntryIds?: string[] },
    by: string,
  ) {
    const dryRun = opts.dryRun !== false;
    const db = this.srModel.db;
    const txCol = db.collection('transactions');
    const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
    const at = new Date().toISOString();

    const returns = await this.srModel.find({
      status: 'مكتمل', reversal: null, 'settlement.debtOffsetAmount': { $gt: 0 },
      'settlement.invoiceOffsets': { $exists: false },
      ...(opts.supplierId ? { supplierId: opts.supplierId } : {}),
    }).sort({ createdAt: 1 }).exec();

    const ids = (opts.ledgerEntryIds || []).filter((x) => Types.ObjectId.isValid(x));
    const ledgerRows: any[] = ids.length
      ? await db.collection('supplierledgerentries').find({ _id: { $in: ids.map((x) => new Types.ObjectId(x)) } }).toArray()
      : [];
    const refused: string[] = [];
    for (const id of opts.ledgerEntryIds || []) {
      const e = ledgerRows.find((x) => String(x._id) === String(id));
      if (!e) { refused.push(`${id}: قيد غير موجود`); continue; }
      if (e.entryType !== 'manual-adjustment' || !(Number(e.amount) < 0) || e.reversed) refused.push(`${id}: ليس قيد تخفيض يدوي سارياً`);
      else if (opts.supplierId && String(e.supplierId) !== String(opts.supplierId)) refused.push(`${id}: لمورد آخر`);
      else if (await txCol.findOne({ 'supplierReturnOffsets.ledgerEntryId': String(e._id) })) refused.push(`${id}: سُجِّل على فاتورة من قبل`);
    }
    if (refused.length) throw new BadRequestException('قيود غير صالحة للتصحيح — ' + refused.join(' | '));

    // Open invoices per supplier, kept in memory so the plan accounts for earlier shares.
    const open = new Map<string, any[]>();
    const openOf = async (supplierId: string, supplierName: string) => {
      if (!open.has(supplierId)) {
        const docs = await txCol.find({
          type: 'مشتريات', cancelled: { $ne: true }, archived: { $ne: true }, remaining: { $gt: 0 }, ref: { $not: /-RET/ },
          $or: [{ supplierId }, { supplierId: { $in: ['', null] }, client: supplierName }],
        }).project({ ref: 1, remaining: 1, date: 1, createdAt: 1 }).toArray();
        open.set(supplierId, docs.map((d: any) => ({
          _id: d._id, id: String(d._id), ref: String(d.ref || ''), remainingRead: Number(d.remaining) || 0,
          remaining: Number(d.remaining) || 0, date: String(d.date || ''), createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : '',
        })));
      }
      return open.get(supplierId)!;
    };
    const writes = new Map<string, { doc: any; push: any[] }>();
    const plan: any[] = [];
    const spread = async (supplierId: string, supplierName: string, amount: number, caps: Array<{ id: string; cap: number }>, entry: Record<string, unknown>, label: string) => {
      const invs = await openOf(supplierId, supplierName);
      const res = allocateReturnOffset(amount, invs.map((i) => ({ id: i.id, ref: i.ref, remaining: i.remaining, date: i.date, createdAt: i.createdAt })), caps);
      for (const row of res.rows) {
        const inv = invs.find((i) => i.id === row.id);
        inv.remaining = r2(inv.remaining - row.amount);
        const w = writes.get(row.id) || { doc: inv, push: [] as any[] };
        w.push.push({ ...entry, amount: row.amount, at, by, backfilled: true });
        writes.set(row.id, w);
      }
      plan.push({ source: label, supplier: supplierName, amount: r2(amount), toInvoices: res.rows.map((x) => ({ ref: x.ref, amount: x.amount })), unallocated: res.unallocated });
      return res;
    };

    const returnResults: Array<{ r: any; rows: Array<{ id: string; ref: string; amount: number }>; unallocated: number }> = [];
    for (const r of returns) {
      const st: any = r.settlement || {};
      const res = await spread(String(r.supplierId), r.supplierName, Number(st.debtOffsetAmount) || 0,
        (r.linkedInvoices || []).map((li) => ({ id: String(li.transactionId), cap: Number(li.allocatedTotal) || 0 })),
        { returnId: String(r._id), returnNumber: r.returnNumber }, `مرتجع ${r.returnNumber}`);
      returnResults.push({ r, rows: res.rows, unallocated: res.unallocated });
    }
    for (const e of ledgerRows) {
      await spread(String(e.supplierId), String(e.supplierName || ''), -Number(e.amount), [],
        { kind: 'ledger-adjustment', ledgerEntryId: String(e._id), reason: String(e.desc || '').slice(0, 200) },
        `قيد يدوي: ${String(e.desc || '').slice(0, 80)}`);
    }

    const invoices = [...writes.values()].map((w) => ({
      ref: w.doc.ref, remainingBefore: r2(w.doc.remainingRead), remainingAfter: r2(w.doc.remaining),
      lines: w.push.map((x) => ({ amount: x.amount, from: x.returnNumber ? `مرتجع ${x.returnNumber}` : 'قيد يدوي' })),
    }));
    // For one supplier: how far the open invoices are above the ledger, and which manual ledger
    // reductions could explain it (negative, non-reversed, not posted by an invoice edit/cancel,
    // not yet written onto an invoice). The admin chooses among them — never guessed.
    let reconcile: any = null;
    if (opts.supplierId) {
      const rows: any[] = await db.collection('supplierledgerentries').find({ supplierId: opts.supplierId }).sort({ createdAt: 1, _id: 1 }).toArray();
      const balance = rows.length ? r2(rows[rows.length - 1].runningBalance) : 0;
      const sup: any = await db.collection('suppliers').findOne({ _id: Types.ObjectId.isValid(opts.supplierId) ? new Types.ObjectId(opts.supplierId) : (opts.supplierId as any) });
      const invs = await openOf(opts.supplierId, String(sup?.name || ''));
      const openNow = r2(invs.reduce((sum, i) => sum + i.remainingRead, 0));
      const applied = new Set((await txCol.find({ 'supplierReturnOffsets.ledgerEntryId': { $exists: true } }).project({ supplierReturnOffsets: 1 }).toArray())
        .flatMap((t: any) => (t.supplierReturnOffsets || []).map((o: any) => String(o.ledgerEntryId || ''))));
      const auto = /تعديل فاتورة مشتريات|إلغاء فاتورة مشتريات|تراجع عن|نقل فاتورة|عكس قيد/;
      reconcile = {
        ledgerBalance: balance, invoicesOpen: openNow, gap: r2(openNow - Math.max(0, balance)), // standing credit (balance < 0) is not an invoice gap
        candidates: rows.filter((e) => e.entryType === 'manual-adjustment' && Number(e.amount) < 0 && !e.reversed && !auto.test(String(e.desc || '')) && !applied.has(String(e._id)))
          .map((e) => ({ id: String(e._id), date: String(e.date || '').slice(0, 10), amount: r2(-Number(e.amount)), desc: String(e.desc || ''), employee: e.employee || '' })),
      };
    }
    const summary = {
      reconcile,
      dryRun, returns: returns.length, ledgerEntries: ledgerRows.length, invoicesTouched: invoices.length,
      totalWritten: r2(invoices.reduce((sum, i) => sum + (i.remainingBefore - i.remainingAfter), 0)), plan, invoices,
    };
    if (dryRun) return summary;

    await this.atomic(async (context) => {
      for (const [, w] of writes) {
        const after = r2(w.doc.remaining);
        const res = await txCol.updateOne(
          { _id: w.doc._id, remaining: w.doc.remainingRead, cancelled: { $ne: true } },
          { $set: { remaining: after < 0.005 ? 0 : after, ...(after < 0.005 ? { payStatus: 'مكتمل' } : {}) }, $push: { supplierReturnOffsets: { $each: w.push } } as any },
          { session: context.session },
        );
        if (!res.matchedCount) throw new ConflictException(`تغيّرت الفاتورة #${w.doc.ref} أثناء التصحيح — أعد التجربة`);
      }
      for (const x of returnResults) {
        await this.srModel.updateOne(
          { _id: x.r._id, 'settlement.invoiceOffsets': { $exists: false } },
          { $set: {
            'settlement.invoiceOffsets': x.rows.map((row) => ({ transactionId: row.id, ref: row.ref, amount: row.amount })),
            'settlement.unallocatedOffset': x.unallocated,
            'settlement.invoiceOffsetsBackfilledAt': at,
          } },
          { session: context.session },
        );
      }
    });
    const touched = new Set([...returnResults.map((x) => String(x.r.supplierId)), ...ledgerRows.map((e) => String(e.supplierId))]);
    for (const sid of touched) {
      await this.suppliersService.addLog(sid, { action: 'تصحيح متبقي الفواتير', detail: `كُتب على الفواتير ${summary.totalWritten} ج من خصومات موجودة في سجل المديونية`, by }).catch(() => undefined);
    }
    return { ...summary, dryRun: false };
  }

  /** Gives each invoice back what this return took off it (idempotent: only open offsets). */
  private async restoreReturnOffsets(r: SupplierReturnOrderDocument, by: string, at: string): Promise<void> {
    const rows: Array<{ transactionId: string; amount: number }> = ((r.settlement as any)?.invoiceOffsets || []);
    if (!rows.length) return;
    const col = this.srModel.db.collection('transactions');
    for (const row of rows) {
      if (!Types.ObjectId.isValid(row.transactionId)) continue;
      await col.updateOne(
        {
          _id: new Types.ObjectId(row.transactionId),
          supplierReturnOffsets: { $elemMatch: { returnId: String(r._id), reversedAt: { $exists: false } } },
        },
        {
          $inc: { remaining: Number(row.amount) || 0 },
          $set: { payStatus: 'معلق', 'supplierReturnOffsets.$.reversedAt': at, 'supplierReturnOffsets.$.reversedBy': by },
        },
      );
    }
  }

  async reject(
    id: string,
    by: string,
    rejectedReason = '',
    actorId = '', context?: DatabaseWriteContext,
  ): Promise<SupplierReturnOrderDocument> {
    if (!context) return this.atomic(ctx => this.reject(id, by, rejectedReason, actorId, ctx), id);
    const r = await this.findById(id, context.session);
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
    await this.unitTracking.finishSupplierReturnUnits(r, actorId, by, context, true);
    const saved = await r.save({ session: context.session });
    context.afterCommit.push(() => notifyApproval(this.notifications, 'approval:supplier-return:' + id + ':rejected', r.returnNumber, 'supplierReturn:' + id, { actorName: r.createdBy, actionKey: 'supplier-return', status: 'rejected' }));
    return saved;
  }

  async cancel(
    id: string,
    by: string,
    reason = '',
    actorId = '', context?: DatabaseWriteContext,
  ): Promise<SupplierReturnOrderDocument> {
    if (!context) return this.atomic(ctx => this.cancel(id, by, reason, actorId, ctx), id);
    const r = await this.findById(id, context.session);
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
    await this.unitTracking.finishSupplierReturnUnits(r, actorId, by, context, true);
    return r.save({ session: context.session });
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

    // The invoices get back what the return took off their remaining — after the ledger reversal
    // (both are idempotent, so a retry after a failure further down is safe).
    await this.restoreReturnOffsets(r, reversedBy, new Date().toISOString());

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
