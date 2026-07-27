import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import {
  Transaction,
  TransactionDocument,
} from '../transactions/schemas/transaction.schema';
import { TransactionsService } from '../transactions/transactions.service';
import { ProductsService } from '../products/products.service';
import { PurchaseOrdersService } from '../purchase-orders/purchase-orders.service';
import { SuppliersService } from '../suppliers/suppliers.service';
import {
  DemandAnalysisLog,
  DemandAnalysisLogDocument,
} from './schemas/demand-analysis-log.schema';
import {
  ShopifyOrder,
  ShopifyOrderDocument,
} from '../shopify/schemas/shopify-order.schema';
import {
  AnalyzeDemandDto,
  AnalyzeShopifyDemandDto,
  AddToPurchaseOrderDto,
  CreatePoFromDemandDto,
  DemandLineDto,
} from './dto/demand-planning.dto';

/** One SKU's accumulated demand while grouping */
interface DemandBucket {
  sku: string;
  displaySku: string;
  name: string;
  required: number;
  affectedOrders: AffectedOrder[];
}

/** Subset of the inventory ledger row this service reads */
interface InventoryRow {
  code: string;
  name: string;
  imageUrl?: string;
  sellPrice?: number;
  buyPrice?: number;
  minStock?: number;
  current: number;
}

/** Subset of the product master this service reads */
interface ProductRow {
  code: string;
  name: string;
  imageUrl?: string;
  sellPrice?: number;
  buyPrice?: number;
  minStock?: number;
  supplier?: string;
}

/** Which order is responsible for part of a SKU's demand */
export interface AffectedOrder {
  transactionId: string;
  ref: string;
  client: string;
  phone: string;
  date: string;
  qty: number;
  variant: string;
  cancelled: boolean;
  pickupStatus: string;
  bostaStatus: string;
  /** Full order value — used to rank the affected orders by importance */
  orderTotal: number;
  /**
   * Deposit already paid, and the payment method.
   *
   * For transactions these are stored fields. For pending Shopify orders the
   * deposit is inferred from the order notes/tags by the frontend's existing
   * parser, so `notes`/`tags` are passed through and `deposit` stays 0 here —
   * duplicating that parser server-side would risk the two drifting apart.
   */
  deposit: number;
  payment: string;
  notes: string;
  tags: string;
}

export interface DemandLine {
  sku: string;
  name: string;
  imageUrl: string;
  supplier: string;
  /** Total quantity the selected orders need */
  required: number;
  /**
   * Stock physically on hand right now, before the selected orders are served.
   * Derived from the canonical inventory ledger, with the selected orders'
   * own deductions added back so their demand is not counted twice.
   */
  available: number;
  /** Committed to other open sales orders that have not shipped yet */
  reserved: number;
  /** available - reserved — what the selected orders can actually draw on */
  freeToUse: number;
  /** max(0, required - freeToUse) */
  shortage: number;
  /** Configured minStock, used as the safety-stock level */
  safetyStock: number;
  /** shortage > 0 ? shortage + safetyStock : 0 */
  suggestedPurchase: number;
  status: 'available' | 'low' | 'shortage';
  statusAr: string;
  buyPrice: number;
  sellPrice: number;
  /** Last price actually paid to a supplier for this SKU */
  lastPurchasePrice: number;
  ordersCount: number;
  affectedOrders: AffectedOrder[];
}

export interface DemandAnalysis {
  ordersCount: number;
  skippedOrders: Array<{ id: string; reason: string }>;
  totalSkus: number;
  totalRequiredQty: number;
  totalShortageQty: number;
  totalSuggestedPurchaseQty: number;
  shortageSkus: number;
  lowSkus: number;
  availableSkus: number;
  estimatedPurchaseCost: number;
  unknownSkus: string[];
  /**
   * Shopify line items carrying a placeholder SKU with no product link. They
   * are excluded from planning and must be mapped to a product first.
   */
  unmappedItems: string[];
  lines: DemandLine[];
  generatedAt: string;
}

/**
 * Placeholder codes the Shopify sync assigns to line items it could not match
 * to a product. They are not real SKUs — many different products share them —
 * so they must never be grouped or turned into purchase quantities.
 */
const PLACEHOLDER_SKUS = new Set(['shopify', 'n/a', 'none', '-', '--']);

/** Sales orders in these states have shipped/settled — stock already left the building */
const SETTLED_BOSTA_STATUSES = new Set([
  'DELIVERED',
  'RETURNED',
  'CANCELLED',
]);

@Injectable()
export class DemandPlanningService {
  constructor(
    @InjectModel(Transaction.name)
    private readonly txModel: Model<TransactionDocument>,
    @InjectModel(ShopifyOrder.name)
    private readonly shopifyOrderModel: Model<ShopifyOrderDocument>,
    @InjectModel(DemandAnalysisLog.name)
    private readonly logModel: Model<DemandAnalysisLogDocument>,
    private readonly transactionsService: TransactionsService,
    private readonly productsService: ProductsService,
    private readonly poService: PurchaseOrdersService,
    private readonly suppliersService: SuppliersService,
  ) {}

  private norm(v: unknown): string {
    return String(v ?? '').trim();
  }

  /** SKU comparison key — case-insensitive so imported sheets still match */
  private skuKey(v: unknown): string {
    return this.norm(v).toLowerCase();
  }

  /**
   * A sales order still holding stock: not cancelled, not archived, and not
   * yet handed over to the courier as a completed delivery.
   */
  private isOpenSalesOrder(tx: TransactionDocument): boolean {
    if (tx.type !== 'مبيعات') return false;
    if (tx.cancelled || tx.archived) return false;
    if (SETTLED_BOSTA_STATUSES.has(this.norm(tx.bostaStatus).toUpperCase())) {
      return false;
    }
    if (this.norm(tx.pickupStatus) === 'Delivered') return false;
    return true;
  }

  /**
   * Core analysis. Groups the selected orders' items by SKU, reconciles each
   * against the live inventory ledger, and computes shortage + purchase advice.
   */
  async analyze(
    dto: AnalyzeDemandDto,
    actor?: { name?: string; username?: string },
  ): Promise<DemandAnalysis> {
    const rawIds = (dto.transactionIds || []).map((id) => this.norm(id));
    const validIds = rawIds.filter((id) => isValidObjectId(id));
    if (!validIds.length) {
      throw new BadRequestException('لم يتم تحديد أي معاملات صالحة للتحليل');
    }

    const selected = await this.txModel
      .find({ _id: { $in: validIds } })
      .exec();

    const skippedOrders: Array<{ id: string; reason: string }> = [];
    const foundIds = new Set(selected.map((t) => String(t._id)));
    rawIds.forEach((id) => {
      if (!foundIds.has(id)) {
        skippedOrders.push({ id, reason: 'المعاملة غير موجودة' });
      }
    });

    // Only customer demand counts. Purchases and returns are supply, not demand.
    const demandOrders = selected.filter((tx) => {
      if (tx.type !== 'مبيعات') {
        skippedOrders.push({
          id: String(tx._id),
          reason: `النوع "${tx.type}" لا يمثل طلب عميل`,
        });
        return false;
      }
      if (tx.cancelled) {
        skippedOrders.push({ id: String(tx._id), reason: 'معاملة ملغاة' });
        return false;
      }
      // Archived orders are excluded from the inventory ledger, so their
      // deduction can't be added back — counting their demand would inflate
      // the shortage. Keep them out to stay consistent with getInventory().
      if (tx.archived) {
        skippedOrders.push({ id: String(tx._id), reason: 'معاملة مؤرشفة' });
        return false;
      }
      return true;
    });

    if (!demandOrders.length) {
      throw new BadRequestException(
        'لا توجد طلبات مبيعات نشطة ضمن التحديد — التحليل يعمل على طلبات العملاء فقط',
      );
    }

    // ── Inventory + product master ────────────────────────────────────────
    const inventory = await this.transactionsService.getInventory();
    const invBySku = new Map(
      inventory.map((r) => [this.skuKey(r.code), r]),
    );
    const products = await this.productsService.findAll();
    const productBySku = new Map(
      products.map((p) => [this.skuKey(p.code), p]),
    );

    const selectedIdSet = new Set(demandOrders.map((t) => String(t._id)));

    // ── Reserved stock, and undoing the selection's own deduction ─────────
    // getInventory() subtracts EVERY non-cancelled sale, shipped or not. So:
    //
    //  • Every selected order's qty must be added back, regardless of its
    //    shipping state — otherwise its demand is counted twice (once as
    //    `required`, once as a deduction already applied to `current`).
    //  • Only *other* orders that have not yet shipped still hold stock; their
    //    qty is re-expressed as an explicit reservation. Other orders that
    //    already shipped are genuinely gone and stay subtracted.
    const allSales = await this.txModel
      .find({
        type: 'مبيعات',
        cancelled: { $ne: true },
        archived: { $ne: true },
      })
      .exec();

    const reservedBySku = new Map<string, number>();
    const selectedDeductedBySku = new Map<string, number>();
    allSales.forEach((tx) => {
      const isSelected = selectedIdSet.has(String(tx._id));
      // Non-selected orders only matter while they still hold stock
      if (!isSelected && !this.isOpenSalesOrder(tx)) return;
      (tx.items || []).forEach((item) => {
        const key = this.skuKey(item.code);
        if (!key) return;
        const qty = Number(item.qty) || 0;
        if (qty <= 0) return;
        if (isSelected) {
          selectedDeductedBySku.set(
            key,
            (selectedDeductedBySku.get(key) || 0) + qty,
          );
        } else {
          reservedBySku.set(key, (reservedBySku.get(key) || 0) + qty);
        }
      });
    });

    // ── Last purchase price per SKU ───────────────────────────────────────
    const lastPurchasePriceBySku = await this.buildLastPurchasePriceMap();

    // ── Group selected demand by SKU ──────────────────────────────────────
    interface Bucket {
      sku: string;
      displaySku: string;
      name: string;
      required: number;
      affectedOrders: AffectedOrder[];
    }
    const buckets = new Map<string, Bucket>();
    const unknownSkus = new Set<string>();

    demandOrders.forEach((tx) => {
      (tx.items || []).forEach((item) => {
        const displaySku = this.norm(item.code);
        const key = this.skuKey(displaySku);
        const qty = Number(item.qty) || 0;
        if (qty <= 0) return;
        // SKU is the primary identifier — items without one cannot be planned
        if (!key) {
          skippedOrders.push({
            id: String(tx._id),
            reason: `صنف بدون كود (SKU): ${this.norm(item.name) || 'غير معروف'}`,
          });
          return;
        }
        if (!productBySku.has(key)) unknownSkus.add(displaySku);

        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            sku: key,
            displaySku,
            name: this.norm(item.name),
            required: 0,
            affectedOrders: [],
          };
          buckets.set(key, bucket);
        }
        bucket.required += qty;
        if (!bucket.name) bucket.name = this.norm(item.name);

        const existing = bucket.affectedOrders.find(
          (o) => o.transactionId === String(tx._id),
        );
        if (existing) {
          existing.qty += qty;
        } else {
          bucket.affectedOrders.push({
            transactionId: String(tx._id),
            ref: this.norm(tx.ref) || String(tx._id).slice(-6),
            client: this.norm(tx.client) || '—',
            phone: this.norm(tx.phone),
            date: this.norm(tx.transactionDate) || this.norm(tx.date),
            qty,
            variant: this.norm((item as { variant?: string }).variant),
            cancelled: !!tx.cancelled,
            pickupStatus: this.norm(tx.pickupStatus),
            bostaStatus: this.norm(tx.bostaStatus),
            orderTotal: Number(tx.total) || 0,
            deposit: Number(tx.deposit) || 0,
            payment: this.norm(tx.depMethod) || this.norm(tx.payment),
            notes: '',
            tags: '',
          });
        }
      });
    });

    // ── Build the report lines ────────────────────────────────────────────
    const lines = this.buildLines(buckets, {
      invBySku,
      productBySku,
      lastPurchasePriceBySku,
      // Selected transactions were already deducted from the ledger, so their
      // qty is added back to recover on-hand-before-these-orders.
      addBackBySku: selectedDeductedBySku,
      reservedBySku,
    });

    const analysis = this.summarize(
      lines,
      demandOrders.length,
      skippedOrders,
      unknownSkus,
    );

    if (dto.persistLog !== false) {
      await this.writeLog({
        action: 'تحليل احتياج المخزون',
        actor,
        analysis,
        transactionIds: demandOrders.map((t) => String(t._id)),
        orderRefs: demandOrders.map(
          (t) => this.norm(t.ref) || String(t._id).slice(-6),
        ),
        detail:
          `${demandOrders.length} طلب — ${lines.length} صنف — ` +
          `إجمالي مطلوب ${analysis.totalRequiredQty} قطعة — نقص ${analysis.totalShortageQty} قطعة`,
      });
    }

    return analysis;
  }

  /**
   * Turns SKU demand buckets into report lines. Shared by both entry points;
   * the only difference between them is `addBackBySku` — transactions have
   * already been deducted from the ledger, pending Shopify orders have not.
   */
  private buildLines(
    buckets: Map<string, DemandBucket>,
    ctx: {
      invBySku: Map<string, InventoryRow>;
      productBySku: Map<string, ProductRow>;
      lastPurchasePriceBySku: Map<string, number>;
      addBackBySku: Map<string, number>;
      reservedBySku: Map<string, number>;
    },
  ): DemandLine[] {
    return [...buckets.values()]
      .map((b) => {
        const invRow = ctx.invBySku.get(b.sku);
        const product = ctx.productBySku.get(b.sku);
        const ledgerCurrent = invRow ? Number(invRow.current) || 0 : 0;
        const available = ledgerCurrent + (ctx.addBackBySku.get(b.sku) || 0);
        const reserved = ctx.reservedBySku.get(b.sku) || 0;
        const freeToUse = available - reserved;
        const shortage = Math.max(0, b.required - freeToUse);
        const safetyStock = Math.max(
          0,
          Number(product?.minStock ?? invRow?.minStock ?? 0) || 0,
        );
        const suggestedPurchase = shortage > 0 ? shortage + safetyStock : 0;

        let status: DemandLine['status'] = 'available';
        let statusAr = 'الكمية متوفرة بالكامل';
        if (shortage > 0) {
          status = 'shortage';
          statusAr = `نقص ${shortage} قطعة`;
        } else if (freeToUse - b.required <= safetyStock) {
          status = 'low';
          statusAr = 'يكفي الطلبات لكن الرصيد سيصبح منخفضاً';
        }

        const buyPrice = Number(product?.buyPrice ?? invRow?.buyPrice ?? 0) || 0;
        const lastPurchasePrice =
          ctx.lastPurchasePriceBySku.get(b.sku) ?? buyPrice;

        // Highest-value orders first — they are the ones worth protecting when
        // stock is short. Quantity breaks ties.
        b.affectedOrders.sort(
          (a, z) => z.orderTotal - a.orderTotal || z.qty - a.qty,
        );

        return {
          sku: b.displaySku,
          name: b.name || product?.name || invRow?.name || b.displaySku,
          imageUrl: product?.imageUrl || invRow?.imageUrl || '',
          supplier: this.norm(product?.supplier),
          required: b.required,
          available,
          reserved,
          freeToUse,
          shortage,
          safetyStock,
          suggestedPurchase,
          status,
          statusAr,
          buyPrice,
          sellPrice: Number(product?.sellPrice ?? invRow?.sellPrice ?? 0) || 0,
          lastPurchasePrice,
          ordersCount: b.affectedOrders.length,
          affectedOrders: b.affectedOrders,
        } as DemandLine;
      })
      // Worst first: biggest shortage, then biggest demand
      .sort((a, z) => z.shortage - a.shortage || z.required - a.required);
  }

  /** Rolls report lines up into the header totals */
  private summarize(
    lines: DemandLine[],
    ordersCount: number,
    skippedOrders: Array<{ id: string; reason: string }>,
    unknownSkus: Set<string>,
    unmappedItems: Set<string> = new Set(),
  ): DemandAnalysis {
    const estimatedPurchaseCost = lines.reduce(
      (s, l) => s + l.suggestedPurchase * l.lastPurchasePrice,
      0,
    );
    return {
      ordersCount,
      skippedOrders,
      totalSkus: lines.length,
      totalRequiredQty: lines.reduce((s, l) => s + l.required, 0),
      totalShortageQty: lines.reduce((s, l) => s + l.shortage, 0),
      totalSuggestedPurchaseQty: lines.reduce(
        (s, l) => s + l.suggestedPurchase,
        0,
      ),
      shortageSkus: lines.filter((l) => l.status === 'shortage').length,
      lowSkus: lines.filter((l) => l.status === 'low').length,
      availableSkus: lines.filter((l) => l.status === 'available').length,
      estimatedPurchaseCost: Math.round(estimatedPurchaseCost * 100) / 100,
      unknownSkus: [...unknownSkus],
      unmappedItems: [...unmappedItems],
      lines,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Demand analysis for PENDING Shopify orders — the orders that have not yet
   * been pushed into the transactions log.
   *
   * Key difference from analyze(): these orders have NOT touched inventory, so
   * their quantities are pure new demand with nothing to add back. `reserved`
   * is every open sales order already in the ledger, since all of it competes
   * with this incoming demand for the same on-hand stock.
   */
  async analyzeShopify(
    dto: AnalyzeShopifyDemandDto,
    actor?: { name?: string; username?: string },
  ): Promise<DemandAnalysis> {
    const rawIds = (dto.orderIds || []).map((id) => this.norm(id));
    const validIds = rawIds.filter((id) => isValidObjectId(id));
    if (!validIds.length) {
      throw new BadRequestException('لم يتم تحديد أي أوردرات صالحة للتحليل');
    }

    const selected = await this.shopifyOrderModel
      .find({ _id: { $in: validIds } })
      .exec();

    const skippedOrders: Array<{ id: string; reason: string }> = [];
    const foundIds = new Set(selected.map((o) => String(o._id)));
    rawIds.forEach((id) => {
      if (!foundIds.has(id)) {
        skippedOrders.push({ id, reason: 'الأوردر غير موجود' });
      }
    });

    // Only orders still awaiting approval represent un-deducted demand.
    const demandOrders = selected.filter((o) => {
      if (o.cancelled) {
        skippedOrders.push({ id: String(o._id), reason: 'أوردر ملغي' });
        return false;
      }
      if (this.norm(o.status) !== 'pending') {
        skippedOrders.push({
          id: String(o._id),
          reason: `أوردر "${this.norm(o.status) || 'غير معروف'}" — تم إرساله لسجل المعاملات وخُصم من المخزون بالفعل`,
        });
        return false;
      }
      return true;
    });

    if (!demandOrders.length) {
      throw new BadRequestException(
        'لا توجد أوردرات معلقة ضمن التحديد — التحليل يعمل على الأوردرات التي لم تُرسل لسجل المعاملات بعد',
      );
    }

    const inventory = await this.transactionsService.getInventory();
    const invBySku = new Map(inventory.map((r) => [this.skuKey(r.code), r]));
    const products = await this.productsService.findAll();
    const productBySku = new Map(products.map((p) => [this.skuKey(p.code), p]));
    const lastPurchasePriceBySku = await this.buildLastPurchasePriceMap();

    // Every open (unshipped) sales order in the ledger still holds stock and
    // therefore competes with this Shopify demand.
    const allSales = await this.txModel
      .find({
        type: 'مبيعات',
        cancelled: { $ne: true },
        archived: { $ne: true },
      })
      .exec();
    const reservedBySku = new Map<string, number>();
    allSales.forEach((tx) => {
      if (!this.isOpenSalesOrder(tx)) return;
      (tx.items || []).forEach((item) => {
        const key = this.skuKey(item.code);
        const qty = Number(item.qty) || 0;
        if (!key || qty <= 0) return;
        reservedBySku.set(key, (reservedBySku.get(key) || 0) + qty);
      });
    });

    // Group the pending Shopify demand by SKU
    const buckets = new Map<string, DemandBucket>();
    const unknownSkus = new Set<string>();
    const unmappedItems = new Set<string>();
    demandOrders.forEach((order) => {
      (order.items || []).forEach((item) => {
        const displaySku = this.norm(item.code);
        const key = this.skuKey(displaySku);
        const qty = Number(item.qty) || 0;
        if (qty <= 0) return;
        const itemLabel =
          this.norm(item.name) || this.norm(item.shopifyName) || 'غير معروف';
        if (!key) {
          skippedOrders.push({
            id: String(order._id),
            reason: `صنف بدون كود (SKU): ${itemLabel}`,
          });
          return;
        }
        // Unmapped Shopify line items all share the placeholder code
        // "SHOPIFY", so grouping by it would merge unrelated products into one
        // bogus row. They have no product link and cannot be purchased —
        // report them individually so they can be mapped first.
        if (PLACEHOLDER_SKUS.has(key) && !this.norm(item.productId)) {
          skippedOrders.push({
            id: String(order._id),
            reason: `صنف غير مرتبط بالمخزن: "${itemLabel}" — اربطه بصنف في قاعدة الأصناف أولاً`,
          });
          unmappedItems.add(itemLabel);
          return;
        }
        if (!productBySku.has(key)) unknownSkus.add(displaySku);

        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            sku: key,
            displaySku,
            name: this.norm(item.name) || this.norm(item.shopifyName),
            required: 0,
            affectedOrders: [],
          };
          buckets.set(key, bucket);
        }
        bucket.required += qty;
        if (!bucket.name) bucket.name = this.norm(item.name);

        const existing = bucket.affectedOrders.find(
          (o) => o.transactionId === String(order._id),
        );
        if (existing) {
          existing.qty += qty;
        } else {
          bucket.affectedOrders.push({
            transactionId: String(order._id),
            ref: this.norm(order.ref) || String(order._id).slice(-6),
            client: this.norm(order.client) || '—',
            phone: this.norm(order.phone),
            date: this.norm(order.shopifyCreatedAt),
            qty,
            variant: this.norm((item as { variant?: string }).variant),
            cancelled: !!order.cancelled,
            pickupStatus: '',
            bostaStatus: '',
            orderTotal: Number(order.total) || 0,
            // Deposit is derived from notes/tags on the client — see AffectedOrder
            deposit: 0,
            payment: this.norm(order.payment),
            notes: this.norm(order.notes),
            tags: this.norm(order.tags),
          });
        }
      });
    });

    const lines = this.buildLines(buckets, {
      invBySku,
      productBySku,
      lastPurchasePriceBySku,
      // Nothing to add back — pending Shopify orders never touched the ledger
      addBackBySku: new Map(),
      reservedBySku,
    });

    const analysis = this.summarize(
      lines,
      demandOrders.length,
      skippedOrders,
      unknownSkus,
      unmappedItems,
    );

    if (dto.persistLog !== false) {
      await this.writeLog({
        action: 'تحليل احتياج المخزون (أوردرات شوبيفاي)',
        actor,
        analysis,
        transactionIds: demandOrders.map((o) => String(o._id)),
        orderRefs: demandOrders.map(
          (o) => this.norm(o.ref) || String(o._id).slice(-6),
        ),
        detail:
          `${demandOrders.length} أوردر شوبيفاي معلق — ${lines.length} صنف — ` +
          `إجمالي مطلوب ${analysis.totalRequiredQty} قطعة — نقص ${analysis.totalShortageQty} قطعة`,
      });
    }

    return analysis;
  }

  /**
   * Last unit price actually paid per SKU, newest supplier purchase wins.
   * Falls back to the product's buyPrice when the SKU was never purchased.
   */
  private async buildLastPurchasePriceMap(): Promise<Map<string, number>> {
    const purchases = await this.txModel
      .find({
        type: 'مشتريات',
        cancelled: { $ne: true },
        archived: { $ne: true },
      })
      .sort({ createdAt: 1 })
      .exec();
    const map = new Map<string, number>();
    purchases.forEach((tx) => {
      // Return-to-supplier rows carry a -RET ref and must not set the price
      if (/-RET$/i.test(this.norm(tx.ref))) return;
      (tx.items || []).forEach((item) => {
        const key = this.skuKey(item.code);
        const price = Number(item.price) || 0;
        if (key && price > 0) map.set(key, price);
      });
    });
    return map;
  }

  /** Active POs that can still receive quantities (not received, not invoiced) */
  async findOpenPurchaseOrders(): Promise<
    Array<{
      _id: string;
      poNumber: string;
      supplierId: string;
      supplierName: string;
      status: string;
      createdDate: string;
      expectedDeliveryDate: string;
      itemsCount: number;
      totalQty: number;
      items: Array<{ productCode: string; productName: string; qty: number; unitPrice: number }>;
    }>
  > {
    const all = await this.poService.findAll();
    return all
      .filter(
        (po) =>
          !this.norm(po.linkedTransactionId) &&
          po.status !== 'مستلم',
      )
      .map((po) => ({
        _id: String(po._id),
        poNumber: po.poNumber,
        supplierId: po.supplierId,
        supplierName: po.supplierName,
        status: po.status,
        createdDate: po.createdDate,
        expectedDeliveryDate: po.expectedDeliveryDate || '',
        itemsCount: (po.items || []).length,
        totalQty: (po.items || []).reduce(
          (s, i) => s + (Number(i.qty) || 0),
          0,
        ),
        items: (po.items || []).map((i) => ({
          productCode: i.productCode,
          productName: i.productName,
          qty: Number(i.qty) || 0,
          unitPrice: Number(i.unitPrice) || 0,
        })),
      }));
  }

  /** Shared validation for both PO paths */
  private async validateLines(lines: DemandLineDto[]): Promise<
    Array<{
      sku: string;
      name: string;
      qty: number;
      unitPrice: number;
      imageUrl: string;
    }>
  > {
    if (!lines?.length) {
      throw new BadRequestException('لا توجد أصناف لإضافتها');
    }
    const products = await this.productsService.findAll();
    const bySku = new Map(products.map((p) => [this.skuKey(p.code), p]));
    const lastPrices = await this.buildLastPurchasePriceMap();

    const out: Array<{
      sku: string;
      name: string;
      qty: number;
      unitPrice: number;
      imageUrl: string;
    }> = [];
    const seen = new Set<string>();

    for (const line of lines) {
      const displaySku = this.norm(line.sku);
      const key = this.skuKey(displaySku);
      if (!key) {
        throw new BadRequestException('كود الصنف (SKU) مطلوب لكل سطر');
      }
      const product = bySku.get(key);
      if (!product) {
        throw new BadRequestException(
          `الصنف بالكود "${displaySku}" غير موجود في قاعدة الأصناف`,
        );
      }
      const qty = Math.floor(Number(line.qty) || 0);
      if (qty <= 0) {
        throw new BadRequestException(
          `الكمية للصنف "${product.name}" يجب أن تكون أكبر من صفر`,
        );
      }
      if (seen.has(key)) {
        throw new BadRequestException(
          `الصنف "${product.name}" مكرر في القائمة`,
        );
      }
      seen.add(key);
      out.push({
        sku: product.code,
        name: product.name,
        qty,
        unitPrice:
          Number(line.unitPrice) > 0
            ? Number(line.unitPrice)
            : (lastPrices.get(key) ?? (Number(product.buyPrice) || 0)),
        imageUrl: (product as { imageUrl?: string }).imageUrl || '',
      });
    }
    return out;
  }

  /**
   * Merge shortage quantities into an existing purchase order.
   * Matching SKUs are topped up; new SKUs are appended.
   */
  async addToPurchaseOrder(dto: AddToPurchaseOrderDto): Promise<{
    po: unknown;
    changes: Array<{
      sku: string;
      name: string;
      previousQty: number;
      addedQty: number;
      newQty: number;
      isNew: boolean;
    }>;
  }> {
    if (!isValidObjectId(dto.poId)) {
      throw new BadRequestException('معرّف أمر الشراء غير صالح');
    }
    const po = await this.poService.findById(dto.poId);
    if (this.norm(po.linkedTransactionId)) {
      throw new BadRequestException(
        'لا يمكن التعديل — أمر الشراء محوّل إلى فاتورة بالفعل',
      );
    }
    if (po.status === 'مستلم') {
      throw new BadRequestException(
        'لا يمكن الإضافة إلى أمر شراء تم استلامه — أنشئ أمر شراء جديداً',
      );
    }

    const validated = await this.validateLines(dto.lines);

    const merged = (po.items || []).map((i) => ({
      productCode: i.productCode,
      productName: i.productName,
      productImage: i.productImage || '',
      qty: Number(i.qty) || 0,
      unitPrice: Number(i.unitPrice) || 0,
      total: (Number(i.qty) || 0) * (Number(i.unitPrice) || 0),
    }));

    const changes: Array<{
      sku: string;
      name: string;
      previousQty: number;
      addedQty: number;
      newQty: number;
      isNew: boolean;
    }> = [];

    validated.forEach((line) => {
      const idx = merged.findIndex(
        (i) => this.skuKey(i.productCode) === this.skuKey(line.sku),
      );
      if (idx === -1) {
        merged.push({
          productCode: line.sku,
          productName: line.name,
          productImage: line.imageUrl,
          qty: line.qty,
          unitPrice: line.unitPrice,
          total: line.qty * line.unitPrice,
        });
        changes.push({
          sku: line.sku,
          name: line.name,
          previousQty: 0,
          addedQty: line.qty,
          newQty: line.qty,
          isNew: true,
        });
      } else {
        const previousQty = merged[idx].qty;
        const newQty = previousQty + line.qty;
        merged[idx].qty = newQty;
        merged[idx].total = newQty * merged[idx].unitPrice;
        changes.push({
          sku: line.sku,
          name: merged[idx].productName || line.name,
          previousQty,
          addedQty: line.qty,
          newQty,
          isNew: false,
        });
      }
    });

    const updated = await this.poService.update(dto.poId, {
      items: merged.map((i) => ({
        productCode: i.productCode,
        productName: i.productName,
        productImage: i.productImage,
        qty: i.qty,
        unitPrice: i.unitPrice,
      })),
    } as never);

    const summary = changes
      .map(
        (c) =>
          `${c.name}: ${c.previousQty} + ${c.addedQty} = ${c.newQty}` +
          (c.isNew ? ' (صنف جديد)' : ''),
      )
      .join(' | ');

    // PO history — the status trail is the PO's own audit log
    await this.poService.updateStatus(dto.poId, {
      status: po.status,
      changedBy: dto.by,
      note: `إضافة كميات من تحليل احتياج المخزون — ${summary}`,
    } as never);

    await this.writeLog({
      action: 'إضافة إلى أمر شراء',
      actor: { name: dto.by, username: dto.byUsername },
      transactionIds: dto.transactionIds || [],
      poId: String(po._id),
      poNumber: po.poNumber,
      supplierId: po.supplierId,
      supplierName: po.supplierName,
      lines: changes.map((c) => ({
        sku: c.sku,
        name: c.name,
        required: c.addedQty,
        available: 0,
        reserved: 0,
        shortage: c.addedQty,
        suggestedPurchase: c.addedQty,
      })),
      detail: `${po.poNumber} — ${summary}${dto.note ? ' — ' + dto.note : ''}`,
    });

    await this.logSupplierActivity(
      po.supplierId,
      'إضافة كميات لأمر شراء',
      `${po.poNumber} — ${changes.length} صنف من تحليل احتياج المخزون`,
      dto.by,
    );

    return { po: updated, changes };
  }

  /** Create a fresh PO out of the shortage lines */
  async createPurchaseOrderFromDemand(dto: CreatePoFromDemandDto): Promise<{
    po: unknown;
  }> {
    const supplier = await this.resolveSupplier(dto.supplierId);
    const validated = await this.validateLines(dto.lines);

    const po = await this.poService.create({
      supplierId: dto.supplierId,
      supplierName: supplier?.name || dto.supplierName,
      expectedDeliveryDate: dto.expectedDeliveryDate || '',
      notes:
        dto.notes ||
        'أمر شراء مُولَّد من تحليل احتياج المخزون للطلبات المحددة',
      items: validated.map((l) => ({
        productCode: l.sku,
        productName: l.name,
        productImage: l.imageUrl,
        qty: l.qty,
        unitPrice: l.unitPrice,
      })),
      createdBy: dto.by,
    } as never);

    const totalQty = validated.reduce((s, l) => s + l.qty, 0);

    await this.writeLog({
      action: 'إنشاء أمر شراء من التحليل',
      actor: { name: dto.by, username: dto.byUsername },
      transactionIds: dto.transactionIds || [],
      poId: String((po as { _id: unknown })._id),
      poNumber: (po as { poNumber: string }).poNumber,
      supplierId: dto.supplierId,
      supplierName: supplier?.name || dto.supplierName,
      lines: validated.map((l) => ({
        sku: l.sku,
        name: l.name,
        required: l.qty,
        available: 0,
        reserved: 0,
        shortage: l.qty,
        suggestedPurchase: l.qty,
      })),
      detail:
        `${(po as { poNumber: string }).poNumber} — ${validated.length} صنف — ${totalQty} قطعة` +
        (dto.note ? ` — ${dto.note}` : ''),
    });

    await this.logSupplierActivity(
      dto.supplierId,
      'إضافة أمر شراء',
      `${(po as { poNumber: string }).poNumber} — ${validated.length} صنف من تحليل احتياج المخزون`,
      dto.by,
    );

    return { po };
  }

  private async resolveSupplier(
    supplierId: string,
  ): Promise<{ name: string } | null> {
    if (!isValidObjectId(supplierId)) {
      throw new BadRequestException('معرّف المورد غير صالح');
    }
    try {
      const s = await this.suppliersService.findById(supplierId);
      if (!s) throw new NotFoundException('المورد غير موجود');
      return { name: s.name };
    } catch {
      throw new BadRequestException('المورد غير موجود — اختر مورداً صحيحاً');
    }
  }

  private async logSupplierActivity(
    supplierId: string,
    action: string,
    detail: string,
    by: string,
  ): Promise<void> {
    if (!supplierId || !isValidObjectId(supplierId)) return;
    try {
      await this.suppliersService.addLog(supplierId, {
        action,
        detail,
        by,
      } as never);
    } catch {
      // activity logging must never break the operation
    }
  }

  private async writeLog(input: {
    action: string;
    actor?: { name?: string; username?: string };
    analysis?: DemandAnalysis;
    transactionIds?: string[];
    orderRefs?: string[];
    lines?: DemandAnalysisLog['lines'];
    poId?: string;
    poNumber?: string;
    supplierId?: string;
    supplierName?: string;
    detail?: string;
  }): Promise<void> {
    try {
      const a = input.analysis;
      await this.logModel.create({
        action: input.action,
        by: input.actor?.name || input.actor?.username || 'النظام',
        byUsername: input.actor?.username || '',
        at: new Date().toISOString(),
        ordersCount: a?.ordersCount ?? (input.transactionIds || []).length,
        skuCount: a?.totalSkus ?? (input.lines || []).length,
        totalRequiredQty: a?.totalRequiredQty ?? 0,
        totalShortageQty: a?.totalShortageQty ?? 0,
        transactionIds: input.transactionIds || [],
        orderRefs: input.orderRefs || [],
        lines:
          input.lines ??
          (a?.lines || []).map((l) => ({
            sku: l.sku,
            name: l.name,
            required: l.required,
            available: l.available,
            reserved: l.reserved,
            shortage: l.shortage,
            suggestedPurchase: l.suggestedPurchase,
          })),
        poId: input.poId || '',
        poNumber: input.poNumber || '',
        supplierId: input.supplierId || '',
        supplierName: input.supplierName || '',
        detail: input.detail || '',
      });
    } catch (err) {
      console.error('[demand-planning] audit log write failed:', err);
    }
  }

  async findLogs(limit = 200): Promise<DemandAnalysisLogDocument[]> {
    return this.logModel
      .find()
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 500))
      .exec();
  }
}
