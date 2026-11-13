import {
  Injectable,
  Inject,
  forwardRef,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { currentUnitCost } from '../shared/avg-cost.util';
import { InjectModel } from '@nestjs/mongoose';
import { Model, ClientSession, Types } from 'mongoose';
import { DatabaseWriteContext, sessionQuery } from '../shared/database-write-context';
import {
  InventoryMovement,
  InventoryMovementDocument,
  InventoryMovementType,
  InventoryMovementSourceType,
} from './schemas/inventory-movement.schema';
import { ProductsService } from '../products/products.service';
import { TransactionsService } from '../transactions/transactions.service';
import { MAIN_WAREHOUSE, requireWarehouse, warehouseCode } from '../warehouses/warehouse-storage';

export interface RecordMovementEntry {
  afterSalesId?: string;
  afterSalesRef?: string;
  originalInvoiceRef?: string;
  lifecycle?: string;
  physicalQty?: number;
  quarantinedQty?: number;
  unitIds?: string[];
  warehouseCode?: string;
  productId: string;
  productCode: string;
  productName: string;
  type: InventoryMovementType;
  qtyDelta: number;
  qtyBefore: number;
  qtyAfter: number;
  sourceTransactionId?: string;
  sourceTransactionRef?: string;
  sourceType: InventoryMovementSourceType;
  by: string;
  byUserId?: string;
  reason?: string;
  notes?: string;
}

export interface InventoryMovementFilters {
  productCode?: string;
  productName?: string;
  type?: string;
  by?: string;
  dateFrom?: string;
  dateTo?: string;
  sourceTransactionRef?: string;
  sortDir?: 'asc' | 'desc';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class InventoryMovementsService {
  private readonly logger = new Logger(InventoryMovementsService.name);

  constructor(
    @InjectModel(InventoryMovement.name)
    private readonly model: Model<InventoryMovementDocument>,
    private readonly productsService: ProductsService,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
  ) {}

  /** Read only: SKU matches alone never establish an individual piece's provenance. */
  async movementPieces(id: string, requestedPage = 1) {
    const validId = (value: unknown) => /^[a-f\d]{24}$/i.test(String(value || ''));
    if (!validId(id)) throw new BadRequestException('Invalid movement ID');
    const movement = await this.model.findById(id).lean();
    if (!movement) throw new NotFoundException('Inventory movement not found');
    const page = Math.max(1, Math.floor(Number.isFinite(requestedPage) ? requestedPage : 1)), limit = 30;
    const db = this.model.db;
    const exactIds = (movement.unitIds || []).filter(validId);
    const eventLinks: any[] = await db.collection('inventoryunitevents').find({
      $or: [
        { inventoryMovementId: id },
        ...(validId(movement.sourceTransactionId) ? [{ transactionId: movement.sourceTransactionId,
          action: { $in: ['shipped', 'delivered', 'returned', 'supplier-returned'] } }] : []),
      ],
    }, { projection: { unitId: 1 } }).toArray();
    const linkedIds = [...new Set([...exactIds, ...eventLinks.map(event => event.unitId)].filter(validId))];
    const links: any[] = linkedIds.length ? [{ _id: { $in: linkedIds.map(unitId => new Types.ObjectId(unitId)) } }] : [];
    if (!exactIds.length && validId(movement.sourceTransactionId)) {
      links.push({ 'origin.purchaseTransactionId': movement.sourceTransactionId });
      links.push({ 'assignment.transactionId': movement.sourceTransactionId,
        status: { $in: ['picking', 'prepared', 'shipped', 'delivered', 'damaged', 'lost'] } });
    }
    if (!links.length) return { items: [], total: 0, page, limit };
    // Explicit movement membership takes priority over invoice-wide membership.
    const filter: any = { productId: String(movement.productId),
      ...(exactIds.length ? { _id: { $in: exactIds.map(unitId => new Types.ObjectId(unitId)) } } : { $or: links }) };
    const [units, total] = await Promise.all([
      db.collection('inventoryunits').find(filter).sort({ _id: 1 }).skip((page - 1) * limit).limit(limit).toArray(),
      db.collection('inventoryunits').countDocuments(filter),
    ]);
    const unitIds = units.map(unit => String(unit._id));
    const purchaseIds = [...new Set(units.map(unit => unit.origin?.purchaseTransactionId).filter(validId))];
    const [events, purchases, codes] = await Promise.all([
      db.collection('inventoryunitevents').find({ unitId: { $in: unitIds },
        action: { $in: ['registered', 'shipped', 'returned', 'supplier-returned', 'warehouse-changed'] } }).sort({ sequence: 1 }).toArray(),
      db.collection('transactions').find({ _id: { $in: purchaseIds.map(purchaseId => new Types.ObjectId(purchaseId)) }, type: 'مشتريات' },
        { projection: { ref: 1, date: 1 } }).toArray(),
      db.collection('inventoryunitcodes').find({ _id: { $in: units.map(unit => unit._id) } }).toArray(),
    ]);
    return { total, page, limit, items: units.map(unit => {
      const purchase = purchases.find(invoice => String(invoice._id) === unit.origin?.purchaseTransactionId);
      const code = codes.find(row => String(row._id) === String(unit._id))?.code;
      return { unitId: String(unit._id), barcode: unit.barcode,
        manualCode: code ? `U-${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` : null,
        originKind: unit.origin?.kind,
        registeredAtReceipt: String(unit.origin?.reconciliationRef || '').startsWith('receipt:'),
        purchase: purchase ? { id: String(purchase._id), ref: purchase.ref, date: purchase.date } : null,
        history: events.filter(event => event.unitId === String(unit._id)).map(event => ({
          action: event.action, date: event.createdAt,
          fromWarehouseCode: event.details?.fromWarehouseCode || null,
          toWarehouseCode: event.details?.toWarehouseCode || event.details?.warehouseCode || null,
          registrationKind: event.details?.registrationKind || null,
        })),
      };
    }) };
  }

  /** Internal — called from TransactionsService lifecycle hooks. Never throws. */
  async record(entries: RecordMovementEntry[], context?: DatabaseWriteContext): Promise<void> {
    if (!entries.length) return;
    const transactionIds = [...new Set(entries.filter(entry => !entry.warehouseCode && /^[a-f\d]{24}$/i.test(entry.sourceTransactionId || '')).map(entry => entry.sourceTransactionId!))];
    const linked = transactionIds.length ? await this.model.db.collection('transactions').find({ _id: { $in: transactionIds.map(id => new Types.ObjectId(id)) } }, { session: context?.session, projection: { warehouseCode: 1 } }).toArray() : [];
    entries = entries.map(entry => ({ ...entry, warehouseCode: warehouseCode(entry.warehouseCode || linked.find(tx => String(tx._id) === entry.sourceTransactionId)?.warehouseCode) }));
    if (context) {
      for (const entry of entries) await new this.model({ ...entry,
        movementId: await this.generateMovementId(context), sourceTransactionId: entry.sourceTransactionId || '',
        sourceTransactionRef: entry.sourceTransactionRef || '', byUserId: entry.byUserId || '',
        reason: entry.reason || '', notes: entry.notes || '',
      }).save({ session: context.session });
      return; // Strict: an audit failure aborts the whole receipt instead of being swallowed.
    }
    try {
      const withIds = await Promise.all(
        entries.map(async (e) => ({
          ...e,
          movementId: await this.generateMovementId(),
          sourceTransactionId: e.sourceTransactionId || '',
          sourceTransactionRef: e.sourceTransactionRef || '',
          byUserId: e.byUserId || '',
          reason: e.reason || '',
          notes: e.notes || '',
        })),
      );
      await this.model.insertMany(withIds, { ordered: false });
    } catch (err) {
      this.logger.error(
        `record() failed to insert ${entries.length} movement(s): ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }

  /** Random 6-digit movement transaction ID, unique per row and independent of any linked
   * transaction's own ref. Retries on the rare collision. */
  private async generateMovementId(context?: DatabaseWriteContext): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = String(Math.floor(100000 + Math.random() * 900000));
      const exists = await sessionQuery(this.model.exists({ movementId: candidate }), context?.session);
      if (!exists) return candidate;
    }
    // Extremely unlikely fallback: timestamp-suffixed to guarantee uniqueness.
    return `${Math.floor(100000 + Math.random() * 900000)}${Date.now().toString().slice(-4)}`;
  }

  /** Admin-only manual stock correction. This IS a primary action — throws on invalid input. */
  async adjustStock(params: {
    productId: string;
    warehouseCode?: string;
    qtyDelta: number;
    reason: string;
    by: string;
    byUserId?: string;
    /** القطع المحددة اللي التسوية بتشطبها (اختياري، للنقص بس). */
    unitIds?: string[];
    /** مفتاح الطلب — نفس المفتاح = نفس التسوية، مابتتسجلش مرتين. */
    requestKey?: string;
    /** تسوية بالنقص من غير قطع: تأكيد صريح + سبب عدم التحديد. */
    unidentifiedConfirmed?: boolean;
    unidentifiedNote?: string;
  }): Promise<InventoryMovementDocument> {
    const reason = (params.reason || '').trim();
    if (!reason) {
      throw new BadRequestException('سبب التسوية مطلوب');
    }
    const qtyDelta = Number(params.qtyDelta);
    if (!qtyDelta || Number.isNaN(qtyDelta)) {
      throw new BadRequestException('كمية التعديل غير صالحة');
    }
    const requestKey = String(params.requestKey || '').trim();
    if (requestKey && !/^[A-Za-z0-9:_-]{8,120}$/.test(requestKey)) throw new BadRequestException('مفتاح الطلب غير صالح');
    // ⚠ نفس الطلب اتبعت قبل كده (ضغطتين، أو إعادة محاولة بعد انقطاع) → نفس الحركة، من غير تسوية تانية.
    if (requestKey) {
      const prior = await this.model.findOne({ requestKey }).exec();
      if (prior) return prior;
    }

    const product = await this.productsService.findById(params.productId);
    const unitIds = [...new Set((params.unitIds || []).map((id) => String(id).trim()).filter(Boolean))];
    if (unitIds.length) {
      if (qtyDelta > 0) throw new BadRequestException('تحديد القطع للتسوية بالنقص بس');
      if (unitIds.length !== Math.abs(qtyDelta)) throw new BadRequestException(`حددت ${unitIds.length} قطعة والتسوية بـ ${Math.abs(qtyDelta)} — لازم يتساووا`);
      await this.assertUnitsCanBeWrittenOff(unitIds, String(product._id));
    }
    // ⚠ نقص من غير تحديد قطع: مسموح (مخزون قديم من غير أكواد)، بس بتأكيد صريح وسبب مكتوب،
    // وبيتسجل اللي النظام كان شايفه وقتها. الأدمن بيشوف قبل التأكيد لو فيه قطع ممكن يحددها.
    let unidentified: Record<string, unknown> | null = null;
    if (qtyDelta < 0 && !unitIds.length) {
      const facts = await this.unidentifiedFacts(String(product._id));
      const note = String(params.unidentifiedNote || '').trim();
      if (params.unidentifiedConfirmed !== true || note.length < 5) {
        throw new ConflictException({
          code: 'UNIDENTIFIED_CONFIRM_REQUIRED',
          message: 'التسوية بالنقص من غير تحديد قطع محتاجة تأكيد صريح وسبب مكتوب (5 حروف على الأقل)',
          ...facts,
        });
      }
      unidentified = { note: note.slice(0, 300), confirmedBy: params.by, confirmedAt: new Date().toISOString(), ...facts };
    }
    const inventory = await this.transactionsService.getInventory();
    const invRow = inventory.find((i) => i._id === String(product._id));
    const location = await requireWarehouse(this.model.db, params.warehouseCode);
    const qtyBefore = Number(invRow?.warehouseBalances?.[location] || 0);
    const qtyAfter = qtyBefore + qtyDelta;
    if (qtyAfter < 0) throw new BadRequestException('التسوية تتجاوز الرصيد المتاح في المخزن المختار');
    const adjustmentRef = await this.generateAdjustmentRef();
    const movementId = await this.generateMovementId();
    // قيمة التسوية بتكلفة القطعة الحالية (متوسط التكلفة أو سعر الكارت) — للعرض بس، الربح مابيتغيّرش.
    const unitCost = currentUnitCost(product as any) ?? 0;

    // ⚠ حجز القطع قبل كتابة الحركة: فهرس فريد على `unitId`، فالقطعة مايتشطبش خسارتها مرتين أبدًا
    // حتى لو تسويتين اتعملوا في نفس اللحظة. لو كتابة الحركة فشلت، الحجز بيتشال.
    // (حقل منفصل مش `_id`: الاسترجاع من نسخة احتياطية بيحوّل `_id` النصي، فالحماية كانت هتضيع.)
    const claims = this.model.db.collection('inventorywriteoffs');
    if (unitIds.length) {
      await claims.createIndex({ unitId: 1 }, { unique: true, name: 'writeoff_unit_unique' });
      try {
        await claims.insertMany(unitIds.map((id) => ({ unitId: id, movementId, adjustmentRef, productId: String(product._id), by: params.by, at: new Date().toISOString() })), { ordered: true });
      } catch (e: any) {
        if (e?.code === 11000) {
          await claims.deleteMany({ movementId });
          const dupId = String(e?.keyValue?.unitId || '');
          const prior: any = dupId ? await claims.findOne({ unitId: dupId }) : null;
          throw new ConflictException(`القطعة دي خسارتها اتسجلت قبل كده${prior?.adjustmentRef ? ` في التسوية ${prior.adjustmentRef}` : ''} — مش هتتسجل مرتين`);
        }
        throw e;
      }
    }

    try {
      return await this.model.create({
        warehouseCode: location,
        movementId,
        productId: String(product._id),
        productCode: product.code,
        productName: product.name,
        type: 'تسوية مخزون',
        qtyDelta,
        qtyBefore,
        qtyAfter,
        sourceTransactionId: '',
        sourceTransactionRef: adjustmentRef,
        sourceType: 'manual-adjustment',
        by: params.by,
        byUserId: params.byUserId || '',
        reason,
        unitIds,
        requestKey,
        unitCost: Math.round(unitCost * 10000) / 10000,
        costValue: Math.round(qtyDelta * unitCost * 100) / 100,
        unidentified,
      });
    } catch (e: any) {
      if (unitIds.length) await claims.deleteMany({ movementId });
      // نفس المفتاح اتسجل في نفس اللحظة من طلب تاني → رجّع اللي اتسجل.
      if (e?.code === 11000 && requestKey) {
        const prior = await this.model.findOne({ requestKey }).exec();
        if (prior) return prior;
      }
      throw e;
    }
  }

  /**
   * القطع اللي نافذة التسوية بتعرضها لمنتج: كل قطعة تالفة/مفقودة وحالتها **من نفس قواعد
   * `assertUnitsCanBeWrittenOff`** — فالواجهة مابتخمّنش: `selectable` = السيرفر هيقبلها.
   * `blockedReason`: 'written-off' (اتشطبت قبل كده، ومعاها رقم التسوية) أو 'customer-return'.
   */
  async writeoffCandidates(productId: string) {
    if (!/^[a-f\d]{24}$/i.test(String(productId))) throw new BadRequestException('المنتج غير صالح');
    const db = this.model.db;
    const units = await db.collection('inventoryunits')
      .find({ productId: String(productId), status: { $in: ['damaged', 'lost'] } }, { projection: { status: 1, barcode: 1 } })
      .sort({ _id: -1 }).limit(200).toArray();
    const ids = units.map((u: any) => String(u._id));
    const [claimed, returned, codes] = ids.length ? await Promise.all([
      db.collection('inventorywriteoffs').find({ unitId: { $in: ids } }, { projection: { unitId: 1, adjustmentRef: 1 } }).toArray(),
      db.collection('inventoryunitevents').find({ unitId: { $in: ids }, action: 'returned' }, { projection: { unitId: 1 } }).toArray(),
      db.collection('inventoryunitcodes').find({ _id: { $in: units.map((u: any) => u._id) } }, { projection: { code: 1 } }).toArray(),
    ]) : [[], [], []];
    const claimedBy = new Map(claimed.map((c: any) => [String(c.unitId), String(c.adjustmentRef || '')]));
    const returnedSet = new Set(returned.map((e: any) => String(e.unitId)));
    const codeOf = new Map(codes.map((c: any) => { const s = String(c.code || ''); return [String(c._id), s.length >= 9 ? `U-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}` : '']; }));
    const pieces = (units as any[]).map((u) => {
      const id = String(u._id);
      const blockedReason = claimedBy.has(id) ? 'written-off' : (u.status === 'damaged' && returnedSet.has(id) ? 'customer-return' : '');
      return { unitId: id, code: codeOf.get(id) || u.barcode, status: u.status, selectable: !blockedReason, blockedReason, adjustmentRef: claimedBy.get(id) || '' };
    });
    return { pieces, ...(await this.unidentifiedFacts(String(productId))) };
  }

  /**
   * اللي النظام شايفه عن قطع المنتج وقت تسوية بالنقص من غير تحديد:
   * - `unclaimedDamagedLost`: قطع مسجّلة تالفة/مفقودة ولسه خسارتها مااتسجلتش — الأدمن يقدر يحددها.
   * - `customerDamagedReturns`: قطع رجعت تالفة من عملاء — خسارتها متسجلة في المرتجع ومش في الرصيد.
   */
  async unidentifiedFacts(productId: string): Promise<{ unclaimedDamagedLost: number; customerDamagedReturns: number }> {
    const db = this.model.db;
    const units = await db.collection('inventoryunits')
      .find({ productId, status: { $in: ['damaged', 'lost'] } }, { projection: { _id: 1, status: 1 } }).toArray();
    if (!units.length) return { unclaimedDamagedLost: 0, customerDamagedReturns: 0 };
    const ids = units.map((u: any) => String(u._id));
    const [claimed, returned] = await Promise.all([
      db.collection('inventorywriteoffs').find({ unitId: { $in: ids } }, { projection: { unitId: 1 } }).toArray(),
      db.collection('inventoryunitevents').find({ unitId: { $in: ids }, action: 'returned' }, { projection: { unitId: 1 } }).toArray(),
    ]);
    const claimedSet = new Set(claimed.map((c: any) => String(c.unitId)));
    const returnedSet = new Set(returned.map((e: any) => String(e.unitId)));
    let unclaimedDamagedLost = 0, customerDamagedReturns = 0;
    for (const u of units as any[]) {
      const id = String(u._id);
      if (u.status === 'damaged' && returnedSet.has(id)) customerDamagedReturns++;
      else if (!claimedSet.has(id)) unclaimedDamagedLost++;
    }
    return { unclaimedDamagedLost, customerDamagedReturns };
  }

  /**
   * القطع المحددة لازم تكون من نفس المنتج، ومسجّل عليها حالة «تالف» أو «مفقود».
   * ⚠ القطعة اللي رجعت من عميل تالفة **مرفوضة**: المرتجع سجّل خسارتها خلاص ومارجعتش رصيد
   *   المخزن أصلًا (`returnedItemQtyForStock`)، فتسويتها تاني = خصم المخزن والخسارة مرتين.
   */
  private async assertUnitsCanBeWrittenOff(unitIds: string[], productId: string) {
    if (unitIds.some((id) => !/^[a-f\d]{24}$/i.test(id))) throw new BadRequestException('رقم قطعة غير صالح');
    const db = this.model.db;
    const units = await db.collection('inventoryunits')
      .find({ _id: { $in: unitIds.map((id) => new Types.ObjectId(id)) } }, { projection: { productId: 1, status: 1, barcode: 1 } }).toArray();
    if (units.length !== unitIds.length) throw new BadRequestException('قطعة من القطع المحددة مش موجودة');
    for (const u of units as any[]) {
      if (String(u.productId) !== productId) throw new BadRequestException(`القطعة ${u.barcode} مش من المنتج ده`);
      if (!['damaged', 'lost'].includes(u.status)) throw new BadRequestException(`القطعة ${u.barcode} مش مسجّلة تالفة أو مفقودة — سجّل حالتها الأول`);
    }
    const returned = await db.collection('inventoryunitevents')
      .find({ unitId: { $in: unitIds }, action: 'returned' }, { projection: { unitId: 1 } }).toArray();
    const damagedReturns = (units as any[]).filter((u) => u.status === 'damaged' && returned.some((ev: any) => String(ev.unitId) === String(u._id)));
    if (damagedReturns.length) {
      throw new ConflictException(`القطعة ${damagedReturns[0].barcode} رجعت من عميل تالفة — خسارتها اتسجلت في المرتجع ومش داخلة في رصيد المخزن، فمش محتاجة تسوية`);
    }
  }

  /**
   * Net manual-adjustment quantity per product code — the third term in derived stock.
   *
   * ⚠ This is what makes `adjustStock` actually move stock. Stock in this system is DERIVED
   * (`getInventory` = opening + purchases + returns − sales), never stored on the product, so a
   * movement row on its own changes nothing: before this existed, an adjustment wrote a row whose
   * `qtyAfter` was already a lie by the time it was read back, and the next adjustment recomputed
   * `qtyBefore` from the untouched derived figure and silently erased the previous one.
   *
   * Only `sourceType:'manual-adjustment'` is summed. Every other movement type is a RECORD of a
   * transaction that the derived loops already account for — summing those would double-count each
   * sale and purchase.
   *
   * Returned as a Map keyed by trimmed productCode so the callers stay O(products), not O(n²).
   */
  async getManualAdjustmentQtyByProductCode(session?: ClientSession): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const rows = await sessionQuery(this.model
        .find({ sourceType: 'manual-adjustment' })
        .select('productCode qtyDelta')
        .lean(), session)
        .exec();
      for (const r of rows) {
        const code = String(r.productCode || '').trim();
        if (!code) continue;
        map.set(code, (map.get(code) || 0) + (Number(r.qtyDelta) || 0));
      }
    } catch (err) {
      if (session) throw err;
      // A failure here must not take the inventory screen down with it. Returning an empty map
      // degrades to pre-adjustment figures rather than throwing — but it IS wrong stock, so it is
      // logged at error level, not swallowed silently.
      this.logger.error(
        `getManualAdjustmentQtyByProductCode() failed — inventory will omit manual adjustments: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
    return map;
  }

  /**
   * Sum of qtyDelta for a product across every movement logged strictly AFTER `after`.
   *
   * Used only by the retroactive backfill, to rewind current stock back to what the
   * balance was at an earlier moment: a movement that was never logged has no row, so
   * the present balance minus everything logged since lands on that movement's qtyAfter.
   * Returns 0 when `after` is missing, which makes the caller fall back to current stock.
   */
  async sumDeltaAfter(productCode: string, after?: Date): Promise<number> {
    if (!after) return 0;
    const rows = await this.model
      .find({ productCode: String(productCode).trim(), createdAt: { $gt: after } })
      .select('qtyDelta')
      .lean()
      .exec();
    return rows.reduce((sum, r) => sum + (Number(r.qtyDelta) || 0), 0);
  }

  /**
   * How many rows of a given sourceType exist for a transaction ref.
   *
   * Used by the retroactive backfill to ask the precise question "is the create row
   * missing?" — a transaction edited or cancelled after creation carries 'transaction-update'
   * / 'transaction-cancel' rows, so a bare "any row exists" test would report a repaired-looking
   * ref whose original movement is still absent.
   */
  async countBySourceType(
    sourceTransactionRef: string,
    sourceType: InventoryMovementSourceType,
  ): Promise<number> {
    return this.model
      .countDocuments({ sourceTransactionRef: String(sourceTransactionRef).trim(), sourceType })
      .exec();
  }

  /** Sequential human-readable reference for manual adjustments, e.g. ADJ-000001. */
  private async generateAdjustmentRef(): Promise<string> {
    const count = await this.model.countDocuments({ sourceType: 'manual-adjustment' }).exec();
    return `ADJ-${String(count + 1).padStart(6, '0')}`;
  }

  async getManualAdjustmentWarehouseRows(session?: ClientSession) {
    return sessionQuery(this.model.find({ sourceType: 'manual-adjustment' }).select('productCode qtyDelta warehouseCode').lean(), session).exec();
  }

  async findAll(
    filters: InventoryMovementFilters,
    page = 1,
    limit = 30,
  ): Promise<{ items: InventoryMovementDocument[]; total: number; page: number; limit: number }> {
    const q: Record<string, unknown> = {};
    if (filters.productCode) {
      q.$or = [
        { productCode: { $regex: escapeRegex(filters.productCode), $options: 'i' } },
        { productName: { $regex: escapeRegex(filters.productCode), $options: 'i' } },
        { sourceTransactionRef: { $regex: escapeRegex(filters.productCode), $options: 'i' } },
        { originalInvoiceRef: { $regex: escapeRegex(filters.productCode), $options: 'i' } },
        { afterSalesRef: { $regex: escapeRegex(filters.productCode), $options: 'i' } },
        { movementId: { $regex: escapeRegex(filters.productCode), $options: 'i' } },
      ];
    }
    if (filters.productName && !filters.productCode) {
      q.productName = { $regex: escapeRegex(filters.productName), $options: 'i' };
    }
    if (filters.type) q.type = filters.type;
    if (filters.by) q.by = filters.by;
    if (filters.sourceTransactionRef) q.sourceTransactionRef = filters.sourceTransactionRef;
    if (filters.dateFrom || filters.dateTo) {
      const range: Record<string, Date> = {};
      if (filters.dateFrom) range.$gte = new Date(filters.dateFrom);
      if (filters.dateTo) range.$lte = new Date(filters.dateTo + 'T23:59:59.999Z');
      q.createdAt = range;
    }

    const safePage = Math.max(1, page);
    const safeLimit = Math.max(1, Math.min(200, limit));
    const skip = (safePage - 1) * safeLimit;
    const sortDir = filters.sortDir === 'asc' ? 1 : -1;

    const [items, total] = await Promise.all([
      this.model
        .find(q)
        .sort({ createdAt: sortDir })
        .skip(skip)
        .limit(safeLimit)
        .lean()
        .exec() as unknown as Promise<InventoryMovementDocument[]>,
      this.model.countDocuments(q).exec(),
    ]);

    const ids = [...new Set(items.filter(item => !item.warehouseCode && /^[a-f\d]{24}$/i.test(item.sourceTransactionId || '')).map(item => item.sourceTransactionId))];
    const transactions = ids.length ? await this.model.db.collection('transactions').find({ _id: { $in: ids.map(id => new Types.ObjectId(id)) } }, { projection: { warehouseCode: 1 } }).toArray() : [];
    const warehouses = await this.model.db.collection('warehouses').find({}, { projection: { code: 1, name: 1 } }).toArray();
    const enriched = items.map(item => {
      const code = warehouseCode(item.warehouseCode || transactions.find(tx => String(tx._id) === item.sourceTransactionId)?.warehouseCode);
      return { ...item, warehouseCode: code, warehouseName: warehouses.find(location => location.code === code)?.name || (code === MAIN_WAREHOUSE ? 'المخزن الرئيسي' : code) };
    });
    return { items: enriched as unknown as InventoryMovementDocument[], total, page: safePage, limit: safeLimit };
  }
}
