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
