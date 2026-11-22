import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId, Types } from 'mongoose';
import {
  Transaction,
  TransactionDocument,
} from '../transactions/schemas/transaction.schema';
import { TransactionsService } from '../transactions/transactions.service';
import { computeDepositFieldsFromReceipts } from '../shopify/deposit-receipts.util';
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
import { allocateOrders, AllocationResult, QueueOrder, AllocationState } from './order-allocation.util';
import {
  loadInventoryBreakdown,
  saleAwaitingDispatch,
  ProductBreakdown,
} from '../transactions/inventory-breakdown';

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
  warehouseBalances?: Record<string, number>;
}

/** The stock terms of one SKU — see analyze() */
interface StockFigures {
  onHand: number;
  reservedConfirmed: number;
  notSellable: number;
  sellable: number;
  /** balance before these orders (may be negative) */
  balance: number;
}

/** ShopifyOrder.shopifyDivergence, as written by prepareOrderEdit */
export interface DivergenceInfo {
  shopifyTotal: number;
  erpTotal: number;
  /** erpTotal − shopifyTotal */
  diff: number;
  by: string;
  at: string;
  changes: string[];
}

/** Reasons a pending Shopify order cannot be confirmed yet — most urgent first */
export type ConfirmBlock =
  | 'cancel-request' | 'edit-pending' | 'item-conflict' | 'deposit-review'
  | 'deposit-booking' | 'deposit-over' | 'divergence' | 'dup-ref';

/**
 * Mirrors ShopifyService.approveOrder's refusals (and the Shopify page's
 * duplicate-ref check), read-only. ⚠ Keep in step with approveOrder: a reason
 * missing here lets an order look «ready» and fail at confirmation.
 * `divergence` is confirmable one by one with an acknowledgement, never in bulk.
 */
export function confirmBlocks(order: any, dupRef = false): ConfirmBlock[] {
  const out: ConfirmBlock[] = [];
  const receipts: any[] = Array.isArray(order?.depositReceipts) ? order.depositReceipts : [];
  if (order?.cancelRequest?.status === 'معلق') out.push('cancel-request');
  if (order?.editRequest?.status === 'معلق') out.push('edit-pending');
  if (order?.itemSyncConflict) out.push('item-conflict');
  if (receipts.some((r) => r?.status === 'معلق')) out.push('deposit-review');
  if (receipts.some((r) => (r?.status === 'معتمد' && !r.vaultEntryId) || (r?.status === 'مُسترد' && !r.refundVaultEntryId))) {
    out.push('deposit-booking');
  }
  if (computeDepositFieldsFromReceipts(order).depositAmount > (Number(order?.total) || 0) + 0.5) out.push('deposit-over');
  if (order?.shopifyDivergence) out.push('divergence');
  if (dupRef) out.push('dup-ref');
  return out;
}

/** What the order plan needs to describe a queued order */
interface PlanMeta {
  ref: string;
  client: string;
  date: string;
  orderTotal: number;
  deposit: number;
  payment: string;
  names: Map<string, { sku: string; name: string }>;
  blocks?: ConfirmBlock[];
  divergence?: DivergenceInfo | null;
}

/** One selected order in the oldest-first plan */
export interface OrderPlanEntry {
  transactionId: string;
  ref: string;
  client: string;
  /** creation date — the priority key */
  date: string;
  orderTotal: number;
  deposit: number;
  payment: string;
  state: AllocationState;
  /**
   * Why the order cannot be confirmed right now although its stock is decided
   * (same refusals as approveOrder + the page's duplicate-ref check). Empty =
   * nothing to do. The order keeps its place in the queue and its stock.
   */
  blocks: ConfirmBlock[];
  /** The edit that moved the total away from what Shopify charged (null = none) */
  divergence: DivergenceInfo | null;
  /** 1-based place among every order competing for the stock */
  position: number;
  items: Array<{ sku: string; name: string; qty: number; missing: number; freeAtTurn: number }>;
}

/** Subset of the product master this service reads */
interface ProductRow {
  _id?: unknown;
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
  /** Physically in the warehouse (= onHand; kept for old readers) */
  available: number;
  /** Physically in the warehouse, before the selected orders are served */
  onHand: number;
  /** Confirmed sales not handed to the carrier — already out of the balance (display only) */
  reservedConfirmed: number;
  /** Damaged + lost + awaiting inspection, still inside the balance */
  notSellable: number;
  /** Balance before these orders minus notSellable */
  sellable: number;
  /** Claimed first by older orders outside the selection (oldest-first queue) */
  reservedOlder: number;
  /** = reservedOlder (kept for old readers) */
  reserved: number;
  /** sellable − reservedOlder — what the selected orders can actually draw on */
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
  /**
   * Shopify orders holding at least one line with no product link. They can
   * never be confirmed (approve refuses a line without productId), so the
   * window lists them apart from «ready» / «short» with a way to link them.
   */
  unlinkedOrders?: UnlinkedOrder[];
  /** Selected orders, oldest first, each ready / short / unlinked (all-or-nothing) */
  orderPlan?: OrderPlanEntry[];
  /** How many orders competed for the stock (selected + older/newer pending) */
  queueSize?: number;
  lines: DemandLine[];
  generatedAt: string;
}

export interface UnlinkedOrder {
  transactionId: string;
  ref: string;
  client: string;
  date: string;
  orderTotal: number;
  items: Array<{ name: string; code: string; qty: number }>;
}

/**
 * Placeholder codes the Shopify sync assigns to line items it could not match
 * to a product. They are not real SKUs — many different products share them —
 * so they must never be grouped or turned into purchase quantities.
 */
const PLACEHOLDER_SKUS = new Set(['shopify', 'n/a', 'none', '-', '--']);


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
   * Core analysis. Groups the selected orders' items by SKU, reconciles each
   * against the live inventory ledger, and computes shortage + purchase advice.
   *
   * Stock terms (Nov 22, 2026), the same on both entry points:
   *   onHand            physically in the warehouse = balance before these orders + held
   *   reservedConfirmed confirmed sales not handed to the carrier yet (already out of the balance)
   *   notSellable       damaged + lost + awaiting inspection, still inside the balance
   *   sellable          max(0, balance before these orders − notSellable)
   *   reservedOlder     claimed first by older orders outside the selection (FIFO)
   *   freeToUse         sellable − reservedOlder
   * ⚠ `reservedConfirmed` is DISPLAY ONLY: the balance already excludes it. The first
   *   version subtracted other open orders a second time here (double reservation).
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
    const [inventory, products, breakdown] = await Promise.all([
      this.transactionsService.getInventory(),
      this.productsService.findAll(),
      loadInventoryBreakdown(this.txModel.db),
    ]);
    const invBySku = new Map(
      (inventory as InventoryRow[]).map((r) => [this.skuKey(r.code), r]),
    );
    const productBySku = new Map(
      (products as ProductRow[]).map((p) => [this.skuKey(p.code), p]),
    );

    const selectedIdSet = new Set(demandOrders.map((t) => String(t._id)));

    // ── Undo the selection's own deduction; note what others still hold ──
    // getInventory() subtracts EVERY non-cancelled sale. The selected orders'
    // qty is added back (it is counted as `required`). Other confirmed orders
    // still in the warehouse stay subtracted — they are reported, never
    // subtracted again.
    const allSales = await this.txModel
      .find({
        type: 'مبيعات',
        cancelled: { $ne: true },
        archived: { $ne: true },
      })
      .exec();

    const heldBySku = new Map<string, number>();
    const selectedDeductedBySku = new Map<string, number>();
    allSales.forEach((tx) => {
      const isSelected = selectedIdSet.has(String(tx._id));
      if (!isSelected && !saleAwaitingDispatch(tx)) return;
      (tx.items || []).forEach((item) => {
        const key = this.skuKey(item.code);
        const qty = Number(item.qty) || 0;
        if (!key || qty <= 0) return;
        const target = isSelected ? selectedDeductedBySku : heldBySku;
        target.set(key, (target.get(key) || 0) + qty);
      });
    });

    // ── Last purchase price per SKU ───────────────────────────────────────
    const lastPurchasePriceBySku = await this.buildLastPurchasePriceMap();

    // ── Group selected demand by SKU ──────────────────────────────────────
    const buckets = new Map<string, DemandBucket>();
    const unknownSkus = new Set<string>();
    const queue: QueueOrder[] = [];
    const meta = new Map<string, PlanMeta>();

    demandOrders.forEach((tx) => {
      const need = new Map<string, number>();
      const names = new Map<string, { sku: string; name: string }>();
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
        need.set(key, (need.get(key) || 0) + qty);
        if (!names.has(key)) names.set(key, { sku: displaySku, name: this.norm(item.name) });
        this.addToBucket(buckets, key, displaySku, this.norm(item.name), qty, {
          transactionId: String(tx._id),
          ref: this.norm(tx.ref) || String(tx._id).slice(-6),
          client: this.norm(tx.client) || '—',
          phone: this.norm(tx.phone),
          date: this.createdOf(tx),
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
      });
      const id = String(tx._id);
      queue.push({ id, createdAt: this.createdOf(tx), selected: true, unlinked: false, need });
      meta.set(id, {
        ref: this.norm(tx.ref) || id.slice(-6), client: this.norm(tx.client) || '—', date: this.createdOf(tx),
        orderTotal: Number(tx.total) || 0, deposit: Number(tx.deposit) || 0,
        payment: this.norm(tx.depMethod) || this.norm(tx.payment), names,
      });
    });

    // ── Stock figures, then the oldest-first allocation ───────────────────
    const keys = new Set<string>(buckets.keys());
    const figures = this.stockFigures(keys, {
      invBySku, productBySku, breakdown,
      addBackBySku: selectedDeductedBySku, heldBySku,
    });
    const allocation = allocateOrders(queue, this.sellableMap(figures));

    const lines = this.buildLines(buckets, {
      invBySku,
      productBySku,
      lastPurchasePriceBySku,
      figures,
      reservedOlderBySku: allocation.reservedOlder,
    });

    const analysis = this.summarize(
      lines,
      demandOrders.length,
      skippedOrders,
      unknownSkus,
    );
    analysis.orderPlan = this.buildPlan(queue, allocation, meta);
    analysis.queueSize = queue.length;

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

  private divergenceOf(order: any): DivergenceInfo | null {
    const d = order?.shopifyDivergence;
    if (!d) return null;
    const shopifyTotal = Number(d.shopifyTotal) || 0;
    const erpTotal = Number(d.erpTotal ?? order.total) || 0;
    return {
      shopifyTotal,
      erpTotal,
      diff: Number.isFinite(Number(d.diff)) ? Number(d.diff) : Math.round((erpTotal - shopifyTotal) * 100) / 100,
      by: this.norm(d.by),
      at: this.norm(d.at),
      changes: Array.isArray(d.changes) ? d.changes.slice(0, 10).map((c: unknown) => this.norm(c)) : [],
    };
  }

  /** The order's creation date — the FIFO key. Never the last edit. */
  private createdOf(doc: { shopifyCreatedAt?: unknown; createdAt?: unknown }): string {
    const s = this.norm(doc.shopifyCreatedAt);
    if (s) return s;
    const c = doc.createdAt as unknown;
    if (c instanceof Date) return c.toISOString();
    return this.norm(c);
  }

  private addToBucket(
    buckets: Map<string, DemandBucket>,
    key: string,
    displaySku: string,
    name: string,
    qty: number,
    order: AffectedOrder,
  ): void {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { sku: key, displaySku, name, required: 0, affectedOrders: [] };
      buckets.set(key, bucket);
    }
    bucket.required += qty;
    if (!bucket.name) bucket.name = name;
    const existing = bucket.affectedOrders.find((o) => o.transactionId === order.transactionId);
    if (existing) existing.qty += qty;
    else bucket.affectedOrders.push(order);
  }

  /**
   * The stock terms of one SKU (see analyze()). `warehouse` limits balance,
   * held and not-sellable to one warehouse — Shopify orders are confirmed into
   * MAIN, so MAIN is all they can draw on.
   */
  private stockFigures(
    keys: Set<string>,
    ctx: {
      invBySku: Map<string, InventoryRow>;
      productBySku: Map<string, ProductRow>;
      breakdown: Record<string, ProductBreakdown>;
      addBackBySku: Map<string, number>;
      heldBySku?: Map<string, number>;
      warehouse?: string;
    },
  ): Map<string, StockFigures> {
    const out = new Map<string, StockFigures>();
    keys.forEach((key) => {
      const inv = ctx.invBySku.get(key);
      const ledger = inv
        ? ctx.warehouse && inv.warehouseBalances
          ? Number(inv.warehouseBalances[ctx.warehouse] || 0)
          : Number(inv.current) || 0
        : 0;
      const base = ledger + (ctx.addBackBySku.get(key) || 0);
      const productId = ctx.productBySku.get(key)?._id;
      const row = productId ? ctx.breakdown[String(productId)] : undefined;
      let held = 0;
      let issue = 0;
      Object.entries(row?.byWarehouse || {}).forEach(([code, w]) => {
        if (ctx.warehouse && code !== ctx.warehouse) return;
        issue += (w.damaged || 0) + (w.lost || 0) + (w.inspection || 0);
        if (!ctx.heldBySku) held += w.reserved || 0;
      });
      if (ctx.heldBySku) held = ctx.heldBySku.get(key) || 0;
      const notSellable = Math.max(0, Math.min(issue, Math.max(0, base)));
      out.set(key, {
        onHand: Math.max(0, base) + held,
        reservedConfirmed: held,
        notSellable,
        sellable: Math.max(0, base - notSellable),
        balance: base,
      });
    });
    return out;
  }

  private sellableMap(figures: Map<string, StockFigures>): Map<string, number> {
    const m = new Map<string, number>();
    figures.forEach((f, k) => m.set(k, f.sellable));
    return m;
  }

  /** Per selected order, in queue order: ready / short / unlinked, and why. */
  private buildPlan(
    queue: QueueOrder[],
    allocation: AllocationResult,
    meta: Map<string, PlanMeta>,
  ): OrderPlanEntry[] {
    return queue
      .filter((o) => o.selected)
      .map((o) => ({ o, a: allocation.orders.get(o.id)! }))
      .sort((x, y) => x.a.position - y.a.position)
      .map(({ o, a }) => {
        const m = meta.get(o.id)!;
        return {
          transactionId: o.id,
          ref: m.ref,
          client: m.client,
          date: m.date,
          orderTotal: m.orderTotal,
          deposit: m.deposit,
          payment: m.payment,
          state: a.state,
          blocks: m.blocks || [],
          divergence: m.divergence || null,
          position: a.position,
          items: [...o.need.entries()].map(([key, qty]) => ({
            sku: m.names.get(key)?.sku || key,
            name: m.names.get(key)?.name || key,
            qty,
            missing: a.missing.get(key) || 0,
            freeAtTurn: a.freeAtTurn.get(key) || 0,
          })),
        };
      });
  }

  /**
   * Turns SKU demand buckets into report lines. Shared by both entry points.
   */
  private buildLines(
    buckets: Map<string, DemandBucket>,
    ctx: {
      invBySku: Map<string, InventoryRow>;
      productBySku: Map<string, ProductRow>;
      lastPurchasePriceBySku: Map<string, number>;
      figures: Map<string, StockFigures>;
      reservedOlderBySku: Map<string, number>;
    },
  ): DemandLine[] {
    return [...buckets.values()]
      .map((b) => {
        const invRow = ctx.invBySku.get(b.sku);
        const product = ctx.productBySku.get(b.sku);
        const f = ctx.figures.get(b.sku) || { onHand: 0, reservedConfirmed: 0, notSellable: 0, sellable: 0, balance: 0 };
        const reservedOlder = ctx.reservedOlderBySku.get(b.sku) || 0;
        const freeToUse = f.sellable - reservedOlder;
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

        // Oldest first — the order the stock is given out in.
        b.affectedOrders.sort(
          (a, z) => (Date.parse(a.date) || Infinity) - (Date.parse(z.date) || Infinity) || z.qty - a.qty,
        );

        return {
          sku: b.displaySku,
          name: b.name || product?.name || invRow?.name || b.displaySku,
          imageUrl: product?.imageUrl || invRow?.imageUrl || '',
          supplier: this.norm(product?.supplier),
          required: b.required,
          available: f.onHand,
          onHand: f.onHand,
          reservedConfirmed: f.reservedConfirmed,
          notSellable: f.notSellable,
          sellable: f.sellable,
          reservedOlder,
          reserved: reservedOlder,
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
   * been pushed into the transactions log, so nothing is added back.
   *
   * ⚠ The stock is shared out over EVERY pending Shopify order, oldest first —
   *   not only the selection (owner, Nov 22, 2026: oldest first, no double
   *   reservation). An older pending order that was not selected claims its
   *   share first; that share is shown as «محجوز لأوردرات أقدم».
   * ⚠ MAIN only: Shopify orders are confirmed into MAIN, and the Shopify page's
   *   own stock check reads MAIN.
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

    const [inventory, products, breakdown, lastPurchasePriceBySku, competing] = await Promise.all([
      this.transactionsService.getInventory(),
      this.productsService.findAll(),
      loadInventoryBreakdown(this.txModel.db),
      this.buildLastPurchasePriceMap(),
      // Every other pending order competes for the same MAIN stock.
      this.shopifyOrderModel
        .find({ status: 'pending', cancelled: { $ne: true }, _id: { $nin: demandOrders.map((o) => o._id) } })
        .select({ ref: 1, items: 1, shopifyCreatedAt: 1, createdAt: 1 })
        .lean()
        .exec(),
    ]);
    const invBySku = new Map((inventory as InventoryRow[]).map((r) => [this.skuKey(r.code), r]));
    const productBySku = new Map((products as ProductRow[]).map((p) => [this.skuKey(p.code), p]));

    // A transaction already carrying the order's number blocks confirmation
    // (the Shopify page refuses it: the order was most likely entered by hand).
    const cleanRef = (r: unknown) => this.norm(r).replace(/^#+/, '');
    const wantedRefs = [...new Set(demandOrders.map((o) => cleanRef(o.ref)).filter(Boolean))];
    const takenRefs = new Set<string>();
    if (wantedRefs.length) {
      const rows = await this.txModel
        .find({ ref: { $in: [...wantedRefs, ...wantedRefs.map((r) => '#' + r)] } })
        .select({ ref: 1 })
        .lean()
        .exec();
      (rows as Array<{ ref?: string }>).forEach((r) => takenRefs.add(cleanRef(r.ref)));
    }

    // Group the pending Shopify demand by SKU
    const buckets = new Map<string, DemandBucket>();
    const unknownSkus = new Set<string>();
    const unmappedItems = new Set<string>();
    const queue: QueueOrder[] = [];
    const meta = new Map<string, PlanMeta>();
    const unlinkedOrders: UnlinkedOrder[] = [];

    demandOrders.forEach((order) => {
      const id = String(order._id);
      const need = new Map<string, number>();
      const names = new Map<string, { sku: string; name: string }>();
      const unlinkedItems: UnlinkedOrder['items'] = [];
      const deposit = computeDepositFieldsFromReceipts(order);
      (order.items || []).forEach((item) => {
        const displaySku = this.norm(item.code);
        const key = this.skuKey(displaySku);
        const qty = Number(item.qty) || 0;
        if (qty <= 0) return;
        const itemLabel =
          this.norm(item.name) || this.norm(item.shopifyName) || 'غير معروف';
        // Same rule as the Shopify page's bulk confirm (`!i.productId`): a line
        // without a product link blocks the whole order, whatever its code says.
        if (!this.norm(item.productId)) {
          unlinkedItems.push({ name: itemLabel, code: displaySku, qty });
        }
        if (!key) {
          skippedOrders.push({ id, reason: `صنف بدون كود (SKU): ${itemLabel}` });
          return;
        }
        // Unmapped Shopify line items all share the placeholder code
        // "SHOPIFY", so grouping by it would merge unrelated products into one
        // bogus row. They have no product link and cannot be purchased.
        if (PLACEHOLDER_SKUS.has(key) && !this.norm(item.productId)) {
          skippedOrders.push({
            id,
            reason: `صنف غير مرتبط بالمخزن: "${itemLabel}" — اربطه بصنف في قاعدة الأصناف أولاً`,
          });
          unmappedItems.add(itemLabel);
          return;
        }
        if (!productBySku.has(key)) unknownSkus.add(displaySku);
        need.set(key, (need.get(key) || 0) + qty);
        if (!names.has(key)) names.set(key, { sku: displaySku, name: itemLabel });
        this.addToBucket(buckets, key, displaySku, itemLabel, qty, {
          transactionId: id,
          ref: this.norm(order.ref) || id.slice(-6),
          client: this.norm(order.client) || '—',
          phone: this.norm(order.phone),
          date: this.createdOf(order),
          qty,
          variant: this.norm((item as { variant?: string }).variant),
          cancelled: !!order.cancelled,
          pickupStatus: '',
          bostaStatus: '',
          orderTotal: Number(order.total) || 0,
          deposit: deposit.depositAmount,
          payment: deposit.depositMethod,
          notes: this.norm(order.notes),
          tags: this.norm(order.tags),
        });
      });
      const m: PlanMeta = {
        ref: this.norm(order.ref) || id.slice(-6), client: this.norm(order.client) || '—', date: this.createdOf(order),
        orderTotal: Number(order.total) || 0, deposit: deposit.depositAmount, payment: deposit.depositMethod, names,
        blocks: confirmBlocks(order, takenRefs.has(cleanRef(order.ref))),
        divergence: this.divergenceOf(order),
      };
      meta.set(id, m);
      queue.push({ id, createdAt: m.date, selected: true, unlinked: unlinkedItems.length > 0, need });
      if (unlinkedItems.length) {
        unlinkedOrders.push({ transactionId: id, ref: m.ref, client: m.client, date: m.date, orderTotal: m.orderTotal, items: unlinkedItems });
      }
    });

    (competing as Array<{ _id: unknown; items?: Array<{ code?: string; qty?: number; productId?: string }>; shopifyCreatedAt?: string; createdAt?: Date }>)
      .forEach((order) => {
        const need = new Map<string, number>();
        let unlinked = false;
        (order.items || []).forEach((item) => {
          const qty = Number(item.qty) || 0;
          if (qty <= 0) return;
          if (!this.norm(item.productId)) unlinked = true;
          const key = this.skuKey(item.code);
          if (!key || PLACEHOLDER_SKUS.has(key)) return;
          need.set(key, (need.get(key) || 0) + qty);
        });
        queue.push({ id: String(order._id), createdAt: this.createdOf(order), selected: false, unlinked, need });
      });

    const keys = new Set<string>();
    queue.forEach((o) => o.need.forEach((_q, k) => keys.add(k)));
    const figures = this.stockFigures(keys, {
      invBySku, productBySku, breakdown,
      addBackBySku: new Map(),   // pending Shopify orders never touched the ledger
      warehouse: 'MAIN',
    });
    const allocation = allocateOrders(queue, this.sellableMap(figures));

    const lines = this.buildLines(buckets, {
      invBySku,
      productBySku,
      lastPurchasePriceBySku,
      figures,
      reservedOlderBySku: allocation.reservedOlder,
    });

    const analysis = this.summarize(
      lines,
      demandOrders.length,
      skippedOrders,
      unknownSkus,
      unmappedItems,
    );
    analysis.unlinkedOrders = unlinkedOrders;
    analysis.orderPlan = this.buildPlan(queue, allocation, meta);
    analysis.queueSize = queue.length;

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
    // أسعار الموردين (خطوة 4) أحدث معلومة عن سعر الشراء الجاي: بتتحدّث من كل فاتورة، وكمان
    // يدويًا لما المورد يغيّر سعره. الأحدث تاريخًا يكسب. لو الجدول فاضي يفضل آخر سعر فاتورة.
    try {
      const rows = await this.txModel.db.collection('productsuppliers')
        .find({ active: true, price: { $gt: 0 } }, { projection: { productId: 1, price: 1, priceDate: 1, priceUpdatedAt: 1 } })
        .sort({ priceDate: 1, priceUpdatedAt: 1 }).toArray();
      if (rows.length) {
        const ids = [...new Set(rows.map((r: any) => String(r.productId)))].filter((id) => /^[a-f\d]{24}$/i.test(id));
        const products = await this.txModel.db.collection('products')
          .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { projection: { code: 1 } }).toArray();
        const codeById = new Map(products.map((p: any) => [String(p._id), p.code]));
        for (const r of rows as any[]) {
          const key = this.skuKey(codeById.get(String(r.productId)));
          if (key) map.set(key, Number(r.price));
        }
      }
    } catch (e: any) {
      console.warn(`[demand-planning] supplier prices unavailable: ${e?.message || e}`);
    }
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
