import {
  Injectable,
  Inject,
  forwardRef,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  InventoryMovement,
  InventoryMovementDocument,
  InventoryMovementType,
  InventoryMovementSourceType,
} from './schemas/inventory-movement.schema';
import { ProductsService } from '../products/products.service';
import { TransactionsService } from '../transactions/transactions.service';

export interface RecordMovementEntry {
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

  /** Internal — called from TransactionsService lifecycle hooks. Never throws. */
  async record(entries: RecordMovementEntry[]): Promise<void> {
    if (!entries.length) return;
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
  private async generateMovementId(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = String(Math.floor(100000 + Math.random() * 900000));
      const exists = await this.model.exists({ movementId: candidate });
      if (!exists) return candidate;
    }
    // Extremely unlikely fallback: timestamp-suffixed to guarantee uniqueness.
    return `${Math.floor(100000 + Math.random() * 900000)}${Date.now().toString().slice(-4)}`;
  }

  /** Admin-only manual stock correction. This IS a primary action — throws on invalid input. */
  async adjustStock(params: {
    productId: string;
    qtyDelta: number;
    reason: string;
    by: string;
    byUserId?: string;
  }): Promise<InventoryMovementDocument> {
    const reason = (params.reason || '').trim();
    if (!reason) {
      throw new BadRequestException('سبب التسوية مطلوب');
    }
    const qtyDelta = Number(params.qtyDelta);
    if (!qtyDelta || Number.isNaN(qtyDelta)) {
      throw new BadRequestException('كمية التعديل غير صالحة');
    }

    const product = await this.productsService.findById(params.productId);
    const inventory = await this.transactionsService.getInventory();
    const invRow = inventory.find((i) => i._id === String(product._id));
    const qtyBefore = invRow ? invRow.current : 0;
    const qtyAfter = qtyBefore + qtyDelta;
    const adjustmentRef = await this.generateAdjustmentRef();
    const movementId = await this.generateMovementId();

    return this.model.create({
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
    });
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
  async getManualAdjustmentQtyByProductCode(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    try {
      const rows = await this.model
        .find({ sourceType: 'manual-adjustment' })
        .select('productCode qtyDelta')
        .lean()
        .exec();
      for (const r of rows) {
        const code = String(r.productCode || '').trim();
        if (!code) continue;
        map.set(code, (map.get(code) || 0) + (Number(r.qtyDelta) || 0));
      }
    } catch (err) {
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

    return { items, total, page: safePage, limit: safeLimit };
  }
}
