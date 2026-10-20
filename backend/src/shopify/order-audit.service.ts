import { Injectable, Logger, NotFoundException, BadRequestException, Optional, Inject, forwardRef } from '@nestjs/common';
import { carrierLabel, LEGACY_CARRIER_AR, LEGACY_CARRIER_CODE } from '../shared/carriers.constants';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  Transaction,
  TransactionDocument,
} from '../transactions/schemas/transaction.schema';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import { ShopifyOrder, ShopifyOrderDocument } from './schemas/shopify-order.schema';
import { OrderAudit, OrderAuditDocument } from './schemas/order-audit.schema';
import { ShopifyAdminService } from './shopify-admin.service';
import { PresenceGateway } from '../auth/presence.gateway';
import { approvedDepositTotal, computeDepositFieldsFromReceipts, receiptsIn, round2 } from './deposit-receipts.util';
import { CarrierAutoSettleService } from '../transactions/carrier-auto-settle.service';
import { auditShippingCharge, isAuditBosta } from './order-audit-shipping.util';

/** A single line item as rendered into an audit row. */
export interface AuditItem {
  code: string;
  name: string;
  qty: number;
  price: number;
}

/** One row of the full audit table — one per order number in the range. */
export interface AuditRow {
  orderNumber: string;
  shopifyId: string;
  shopifyCreatedAt: string;
  client: string;
  phone: string;
  orderStatus: string;
  bostaStatus: string;
  bostaOrderId: string;
  bostaTrackingNumber: string;
  paymentStatus: string;
  products: AuditItem[];
  productsLabel: string;
  orderTotal: number;
  productCost: number;
  shippingCost: number;
  actualShipCost: number;
  actualShippingKnown?: boolean;
  actualShippingSource?: string;
  actualShippingReadAt?: string;
  netProfit: number;
  registered: boolean;
  syncStatus: SyncStatus;
  syncLabel: string;
  cancelled: boolean;
  shipCo: string;
  carrierCode: string;
  txId: string;
  hasProfit: boolean;
  hasShipping: boolean;
  notes: string;
  tags: string;
  /**
   * Pending orders only: the deposit as APPROVED deposit receipts state it (money already in the
   * vault), and what is still awaiting a manager. Replaces reading a figure out of `notes`.
   */
  depositApproved: number;
  depositMethod: string;
  depositPending: number;
  shipWithoutDeposit: boolean;
  shipWithoutDepositAt?: string;
}

export type SyncStatus = 'synced' | 'missing' | 'failed' | 'cancelled' | 'pending';

export interface AuditResult {
  period?: { fromDate: string; toDate: string; months?: number[]; year?: number };
  from: number;
  to: number;
  sequence: {
    expectedCount: number;
    registeredCount: number;
    missingCount: number;
    syncRate: number;
    cancelledCount: number;
    pendingCount: number;
  };
  missingOrders: Array<{
    orderNumber: string;
    existsInShopifyMirror: boolean;
    shopifyId: string;
    shopifyCreatedAt: string;
    client: string;
    total: number;
    reason: string;
    reviewed: boolean;
    note: string;
    adminUrl: string;
  }>;
  rows: AuditRow[];
  financials: {
    totalSales: number;
    totalProductCost: number;
    totalShippingCost: number;
    totalActualShippingCost: number;
    billedShippingCost?:number;
    totalProfit: number;
    avgOrderValue: number;
    profitMargin: number;
  };
  shipping: {
    totalShippingCost: number;
    avgShippingCost: number;
    highestOrder: { orderNumber: string; cost: number; client: string } | null;
    companies: Array<{ name: string; orders: number; totalCost: number; avgCost: number }>;
    source?:string;
    measuredCount?:number;
    unconfirmedCount?:number;
    bostaMeasuredCount?:number;
    liveFailedCount?:number;
    liveSkippedCount?:number;
    lastReadAt?:string;
  };
  dateRange: {
    firstOrder: { orderNumber: string; date: string; time: string } | null;
    lastOrder: { orderNumber: string; date: string; time: string } | null;
    durationDays: number;
    ordersPerDay: number;
    salesPerDay: number;
  };
  storeName: string;
  generatedAt: string;
}

@Injectable()
export class OrderAuditService {
  private readonly logger = new Logger(OrderAuditService.name);
  private shippingReads=new Map<string,{deliveryId:string;at:number;data:any}>();

  constructor(
    @InjectModel(Transaction.name)
    private readonly txModel: Model<TransactionDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(ShopifyOrder.name)
    private readonly shopifyOrderModel: Model<ShopifyOrderDocument>,
    @InjectModel(OrderAudit.name)
    private readonly auditModel: Model<OrderAuditDocument>,
    private readonly shopifyAdminService: ShopifyAdminService,
    private readonly presence: PresenceGateway,
    @Optional() @Inject(forwardRef(()=>CarrierAutoSettleService)) private readonly carrierDetails?:CarrierAutoSettleService,
  ) {}

  private async readShipping(txs:any[],live:boolean) {
    this.shippingReads ||= new Map();
    let failed=0,skipped=0,index=0;
    const candidates=txs.filter(tx=>!tx.cancelled&&tx.bostaOrderId&&isAuditBosta(tx));
    if(live&&this.carrierDetails) {
      const deadline=Date.now()+20000;
      await Promise.all(Array.from({length:Math.min(4,candidates.length)},async()=>{
        while(index<candidates.length) {
          const tx=candidates[index++],key=String(tx._id),deliveryId=String(tx.bostaOrderId),cached=this.shippingReads.get(key);
          if(cached?.deliveryId===deliveryId&&Date.now()-cached.at<120000)continue;
          if(Date.now()>deadline){skipped++;continue;}
          try {
            const data=await this.carrierDetails!.bostaDetails(key,cached?.deliveryId!==deliveryId);
            this.shippingReads.delete(key);this.shippingReads.set(key,{deliveryId,at:Date.now(),data});
            if(this.shippingReads.size>5000)this.shippingReads.delete(this.shippingReads.keys().next().value!);
          } catch {failed++;}
        }
      }));
    }
    return{failed,skipped};
  }

  private emit(event: string, payload: unknown): void {
    try {
      this.presence?.emitEvent(event, payload);
    } catch {
      /* swallow — realtime is best-effort */
    }
  }

  /** Strip '#' and any non-digits so '#2231' and '2231' compare equal. */
  private normRef(ref: unknown): string {
    return String(ref ?? '').replace(/[^0-9]/g, '');
  }

  private storeName(): string {
    return process.env.SHOPIFY_STORE_NAME || '';
  }

  private adminUrl(shopifyId: string): string {
    const store = this.storeName();
    if (!store || !shopifyId) return '';
    return `https://admin.shopify.com/store/${store}/orders/${shopifyId}`;
  }

  // ── Core: run the audit over a numeric order range ────────────────────────
  async runAuditPeriod(input: { fromDate?: string; toDate?: string; months?: string; year?: string }, opts: { persist?: boolean; generatedBy?: string; source?: string;shippingLive?:boolean } = {}): Promise<AuditResult> {
    const { fromDate = '', toDate = '' } = input;
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    if (!validDate(fromDate) || !validDate(toDate) || fromDate > toDate) throw new BadRequestException('اختر نطاق تاريخ صحيح');
    const months = input.months ? [...new Set(input.months.split(',').map(Number))] : [];
    const year = Number(input.year);
    if (months.length && (months.some(month => !Number.isInteger(month) || month < 1 || month > 12) || !Number.isInteger(year) || year < 1970 || year > 2100)) throw new BadRequestException('اختر شهوراً وسنة صحيحة');
    const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' });
    const dateKey = (value: any) => {
      const date = new Date(value || '');
      if (!Number.isFinite(date.getTime())) return '';
      const parts = dateFormatter.formatToParts(date);
      const part = (type: string) => parts.find(item => item.type === type)?.value || '';
      return `${part('year')}-${part('month')}-${part('day')}`;
    };
    const [transactions, orders] = await Promise.all([
      this.txModel.find({ type: 'مبيعات', ref: { $exists: true, $ne: '' } }).lean(),
      this.shopifyOrderModel.find({}).lean(),
    ]);
    const dates = new Map<string, string>();
    for (const tx of transactions as any[]) dates.set(this.normRef(tx.ref), dateKey(tx.shopifyCreatedAt || tx.date || tx.createdAt));
    for (const order of orders as any[]) {
      const date = dateKey(order.shopifyCreatedAt || order.createdAt);
      if (date) dates.set(this.normRef(order.ref || order.orderNumber), date);
    }
    const selected = [...dates].filter(([ref, date]) => /^\d+$/.test(ref) && Number(ref) > 0 && date && date >= fromDate && date <= toDate && (!months.length || (Number(date.slice(0, 4)) === year && months.includes(Number(date.slice(5, 7)))))).map(([ref]) => ref);
    if (selected.length > 5000) throw new BadRequestException('الحد الأقصى 5000 طلب — اختر فترة أقصر');
    const numbers = selected.map(Number);
    const result = await this.runAudit(numbers.length ? Math.min(...numbers) : 1, numbers.length ? Math.max(...numbers) : 1, { ...opts, persist: false, orderNumbers: selected });
    result.period = { fromDate, toDate, ...(months.length ? { months, year } : {}) };
    if (!numbers.length) { result.from = 0; result.to = 0; }
    if (opts.persist !== false) await this.saveAuditLog(result, opts.generatedBy || '', opts.source || 'date');
    return result;
  }

  async runAudit(
    fromOrder: number,
    toOrder: number,
    opts: { persist?: boolean; generatedBy?: string; source?: string; orderNumbers?: string[];shippingLive?:boolean } = {},
  ): Promise<AuditResult> {
    const from = Math.floor(Number(fromOrder));
    const to = Math.floor(Number(toOrder));

    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      throw new BadRequestException('رقم الأوردر يجب أن يكون رقماً صحيحاً');
    }
    if (from <= 0 || to <= 0) {
      throw new BadRequestException('أرقام الأوردرات يجب أن تكون أكبر من صفر');
    }
    if (to < from) {
      throw new BadRequestException('رقم الأوردر الأخير يجب أن يكون أكبر من أو يساوي الأول');
    }
    if ((opts.orderNumbers ? opts.orderNumbers.length : to - from + 1) > 5000) {
      throw new BadRequestException('النطاق كبير جداً — الحد الأقصى 5000 أوردر في المرة الواحدة');
    }

    const expectedCount = opts.orderNumbers ? new Set(opts.orderNumbers).size : to - from + 1;

    // Build the expected sequence
    const expected: string[] = opts.orderNumbers ? [...new Set(opts.orderNumbers)].sort((a, b) => Number(a) - Number(b)) : [];
    if (!opts.orderNumbers) for (let n = from; n <= to; n++) expected.push(String(n));
    const expectedSet = new Set(expected);

    // ── Load Soulia transactions whose ref falls in range ───────────────────
    // ref is stored clean (no '#') but old rows may still carry it, so we pull
    // a superset by regex and filter numerically in memory.
    const txs = await this.txModel
      .find({
        type: { $in: ['مبيعات'] },
        ref: { $exists: true, $ne: '' },
      })
      .lean();

    const txByRef = new Map<string, any>();
    for (const tx of txs) {
      const key = this.normRef(tx.ref);
      if (!key || !expectedSet.has(key)) continue;
      // Prefer a non-cancelled transaction if duplicates exist for one ref
      const prev = txByRef.get(key);
      if (!prev || (prev.cancelled && !tx.cancelled)) txByRef.set(key, tx);
    }

    // ── Load the Shopify mirror for the same range ─────────────────────────
    const shippingRead=await this.readShipping([...txByRef.values()],opts.shippingLive===true);
    const shopifyOrders = await this.shopifyOrderModel.find({}).lean();
    const shopByRef = new Map<string, any>();
    for (const o of shopifyOrders) {
      const key = this.normRef(o.ref);
      if (!key || !expectedSet.has(key)) continue;
      shopByRef.set(key, o);
    }

    // ── Product cost lookup ────────────────────────────────────────────────
    const products = await this.productModel.find({}).lean();
    const costByCode = new Map<string, number>();
    for (const p of products) costByCode.set(String(p.code), Number(p.buyPrice) || 0);

    // ── Build one row per expected order number ────────────────────────────
    const rows: AuditRow[] = [];

    for (const num of expected) {
      const tx = txByRef.get(num);
      const so = shopByRef.get(num);

      if (tx) {
        const items: AuditItem[] = (tx.items || []).map((i: any) => ({
          code: String(i.code || ''),
          name: String(i.name || ''),
          qty: Number(i.qty) || 0,
          price: Number(i.price) || 0,
        }));

        const productCost = items.reduce(
          (s, i) => s + (costByCode.get(i.code) ?? 0) * i.qty,
          0,
        );
        const itemsTotal = items.reduce((s, i) => s + i.price * i.qty, 0);
        const shippingCost = Number(tx.shipCost) || 0;
        const live=this.shippingReads.get(String(tx._id));
        const actualCharge=auditShippingCharge(tx,live?.deliveryId===String(tx.bostaOrderId||'')?live.data:undefined);
        const actualShipCost = actualCharge.amount ?? (Number(tx.actualShipCost)||0);
        const orderTotal = Number(tx.total) || 0;
        const discount = Number(tx.discount) || 0;

        // Profit = revenue on goods − product cost − real shipping burden − discount
        const shipBurden = actualShipCost > 0 ? actualShipCost : 0;
        const shipRevenue = shippingCost;
        const netProfit = itemsTotal - productCost - discount + shipRevenue - shipBurden;

        const cancelled = !!tx.cancelled;
        const syncStatus: SyncStatus = cancelled ? 'cancelled' : 'synced';

        rows.push({
          orderNumber: num,
          shopifyId: String(tx.shopifyOrderId || so?.shopifyId || ''),
          shopifyCreatedAt: String(tx.shopifyCreatedAt || so?.shopifyCreatedAt || tx.date || ''),
          client: String(tx.client || so?.client || ''),
          phone: String(tx.phone || so?.phone || ''),
          orderStatus: cancelled ? 'ملغي' : String(tx.pickupStatus || 'Pending'),
          bostaStatus: String(tx.bostaStatus || ''),
          bostaOrderId: String(tx.bostaOrderId || ''),
          bostaTrackingNumber: String(tx.bostaTrackingNumber || ''),
          paymentStatus: String(tx.payStatus || ''),
          products: items,
          productsLabel: items.map((i) => `${i.name} ×${i.qty}`).join('، '),
          orderTotal,
          productCost,
          shippingCost,
          actualShipCost,
          actualShippingKnown:actualCharge.amount!==null,
          actualShippingSource:actualCharge.source,
          actualShippingReadAt:actualCharge.readAt,
          netProfit,
          registered: true,
          syncStatus,
          syncLabel: cancelled ? 'ملغي' : 'متزامن',
          cancelled,
          shipCo: String(tx.shipCo || tx.prepShipCo || ''),
          carrierCode: isAuditBosta(tx)?'bosta':String((tx as any).carrierCode || ''),
          txId: String(tx._id || ''),
          hasProfit: productCost > 0,
          hasShipping: shippingCost > 0 || actualShipCost > 0,
          notes: '',
          tags: '',
          depositApproved: 0,
          depositMethod: '',
          depositPending: 0,
          shipWithoutDeposit: false,
        });
        continue;
      }

      // Not registered in Soulia. Distinguish "pending review" from truly missing.
      if (so) {
        const isPending = so.status === 'pending' && !so.cancelled;
        const isRejectedOrCancelled = so.cancelled || so.status === 'rejected';
        const status: SyncStatus = isPending
          ? 'pending'
          : isRejectedOrCancelled
            ? 'cancelled'
            : 'failed';

        const items: AuditItem[] = (so.items || []).map((i: any) => ({
          code: String(i.code || ''),
          name: String(i.name || ''),
          qty: Number(i.qty) || 0,
          price: Number(i.price) || 0,
        }));

        rows.push({
          orderNumber: num,
          shopifyId: String(so.shopifyId || ''),
          shopifyCreatedAt: String(so.shopifyCreatedAt || ''),
          client: String(so.client || ''),
          phone: String(so.phone || ''),
          orderStatus: so.cancelled
            ? 'ملغي'
            : so.status === 'pending'
              ? 'بانتظار المراجعة'
              : so.status === 'rejected'
                ? 'مرفوض'
                : String(so.status || ''),
          bostaStatus: '',
          bostaOrderId: '',
          bostaTrackingNumber: '',
          paymentStatus: String(so.financialStatus || ''),
          products: items,
          productsLabel: items.map((i) => `${i.name} ×${i.qty}`).join('، '),
          orderTotal: Number(so.total) || 0,
          productCost: items.reduce((s, i) => s + (costByCode.get(i.code) ?? 0) * i.qty, 0),
          shippingCost: Number(so.shipCost) || 0,
          actualShipCost: 0,
          netProfit: 0,
          registered: false,
          syncStatus: status,
          syncLabel:
            status === 'pending'
              ? 'بانتظار الموافقة'
              : status === 'cancelled'
                ? 'ملغي / مرفوض'
                : 'فشل المزامنة',
          cancelled: !!so.cancelled,
          shipCo: '',
          carrierCode: '',
          txId: '',
          hasProfit: false,
          hasShipping: (Number(so.shipCost) || 0) > 0,
          notes: String(so.notes || ''),
          tags: String(so.tags || ''),
          depositApproved: approvedDepositTotal(so),
          depositMethod: computeDepositFieldsFromReceipts(so).depositMethod,
          depositPending: round2(receiptsIn(so, 'معلق').reduce((s, r) => s + (Number(r.amount) || 0), 0)),
          shipWithoutDeposit: isPending && !!so.shipWithoutDeposit
            && approvedDepositTotal(so) === 0 && receiptsIn(so, 'معلق', 'معتمد').length === 0,
          shipWithoutDepositAt: so.shipWithoutDepositAt || '',
        });
        continue;
      }

      // Nothing anywhere — a true gap in the sequence.
      rows.push({
        orderNumber: num,
        shopifyId: '',
        shopifyCreatedAt: '',
        client: '',
        phone: '',
        orderStatus: 'غير موجود',
        bostaStatus: '',
        bostaOrderId: '',
        bostaTrackingNumber: '',
        paymentStatus: '',
        products: [],
        productsLabel: '',
        orderTotal: 0,
        productCost: 0,
        shippingCost: 0,
        actualShipCost: 0,
        netProfit: 0,
        registered: false,
        syncStatus: 'missing',
        syncLabel: 'مفقود',
        cancelled: false,
        shipCo: '',
        carrierCode: '',
        txId: '',
        hasProfit: false,
        hasShipping: false,
        notes: '',
        tags: '',
        depositApproved: 0,
        depositMethod: '',
        depositPending: 0,
        shipWithoutDeposit: false,
      });
    }

    // ── Sequence stats ─────────────────────────────────────────────────────
    const registeredCount = rows.filter((r) => r.registered).length;
    const cancelledCount = rows.filter((r) => r.cancelled).length;
    const pendingCount = rows.filter((r) => r.syncStatus === 'pending').length;
    const missingRows = rows.filter(
      (r) => r.syncStatus === 'missing' || r.syncStatus === 'failed',
    );
    const missingCount = missingRows.length;
    const syncRate =
      expectedCount > 0
        ? Math.round((registeredCount / expectedCount) * 1000) / 10
        : 0;

    // ── Prior review notes for these missing numbers ────────────────────────
    const reviewMap = await this.loadReviews(missingRows.map((r) => r.orderNumber));

    const missingOrders = missingRows.map((r) => {
      const rev = reviewMap.get(r.orderNumber);
      return {
        orderNumber: r.orderNumber,
        existsInShopifyMirror: !!r.shopifyId,
        shopifyId: r.shopifyId,
        shopifyCreatedAt: r.shopifyCreatedAt,
        client: r.client,
        total: r.orderTotal,
        reason: r.shopifyId
          ? 'وصل من Shopify لكن لم يُسجَّل كحركة مبيعات'
          : 'رقم غير موجود في Shopify ولا في سوليا (فجوة في التسلسل)',
        reviewed: rev?.reviewed ?? false,
        note: rev?.note ?? '',
        adminUrl: this.adminUrl(r.shopifyId),
      };
    });

    // ── Financials (registered, non-cancelled orders only) ──────────────────
    const financialRows = rows.filter((r) => r.registered && !r.cancelled);
    const totalSales = financialRows.reduce((s, r) => s + r.orderTotal, 0);
    const totalProductCost = financialRows.reduce((s, r) => s + r.productCost, 0);
    const billedShippingCost = financialRows.reduce((s, r) => s + r.shippingCost, 0);
    const totalActualShippingCost = financialRows.reduce((s, r) => s + (r.actualShippingKnown?r.actualShipCost:0), 0);
    const totalShippingCost=totalActualShippingCost;
    const totalProfit = financialRows.reduce((s, r) => s + r.netProfit, 0);
    const avgOrderValue =
      financialRows.length > 0 ? Math.round(totalSales / financialRows.length) : 0;
    const profitMargin =
      totalSales > 0 ? Math.round((totalProfit / totalSales) * 1000) / 10 : 0;

    // ── Shipping analysis ──────────────────────────────────────────────────
    const shipRows = financialRows.filter((r) => r.actualShippingKnown);
    const shipCostOf = (r: AuditRow) => r.actualShipCost;
    const shippingTotal = shipRows.reduce((s, r) => s + shipCostOf(r), 0);

    let highestOrder: { orderNumber: string; cost: number; client: string } | null = null;
    for (const r of shipRows) {
      const c = shipCostOf(r);
      if (!highestOrder || c > highestOrder.cost) {
        highestOrder = { orderNumber: r.orderNumber, cost: c, client: r.client };
      }
    }

    // Grouped by the stable carrier CODE, never by the free-text name: «Bosta», «bosta» and
    // «بوسطة» are one carrier and were previously three rows. A row with no code — written before
    // the carrier registry, or by a caller that sent an unrecognised name — falls back to its name
    // so it stays visible, and only a genuinely empty one lands in «غير محدد». That bucket
    // shrinking over time is the adoption metric; it is never dropped, so the company totals
    // always add up to the shipments that actually happened.
    const compMap = new Map<string, { code: string; name: string; orders: number; totalCost: number }>();
    for (const r of shipRows) {
      const code = String(r.carrierCode || '').trim();
      const key = code || r.shipCo?.trim() || LEGACY_CARRIER_CODE;
      const name = code ? carrierLabel(code, 'ar') : r.shipCo?.trim() || LEGACY_CARRIER_AR;
      const cur = compMap.get(key) || { code, name, orders: 0, totalCost: 0 };
      cur.orders += 1;
      cur.totalCost += shipCostOf(r);
      compMap.set(key, cur);
    }
    const companies = Array.from(compMap.values())
      .map((v) => ({
        code: v.code,
        name: v.name,
        orders: v.orders,
        totalCost: round2(v.totalCost),
        avgCost: v.orders > 0 ? round2(v.totalCost / v.orders) : 0,
      }))
      .sort((a, b) => b.totalCost - a.totalCost);

    // ── Date-range analysis ────────────────────────────────────────────────
    const dated = rows
      .filter((r) => r.shopifyCreatedAt)
      .map((r) => ({ r, d: new Date(r.shopifyCreatedAt) }))
      .filter((x) => !isNaN(x.d.getTime()))
      .sort((a, b) => a.d.getTime() - b.d.getTime());

    const fmtPart = (d: Date) => ({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    });

    const firstEntry = dated[0];
    const lastEntry = dated[dated.length - 1];
    let durationDays = 0;
    if (firstEntry && lastEntry) {
      const ms = lastEntry.d.getTime() - firstEntry.d.getTime();
      durationDays = Math.max(1, Math.ceil(ms / 86400000));
    }

    const dateRange = {
      firstOrder: firstEntry
        ? { orderNumber: firstEntry.r.orderNumber, ...fmtPart(firstEntry.d) }
        : null,
      lastOrder: lastEntry
        ? { orderNumber: lastEntry.r.orderNumber, ...fmtPart(lastEntry.d) }
        : null,
      durationDays,
      ordersPerDay:
        durationDays > 0 ? Math.round((registeredCount / durationDays) * 10) / 10 : 0,
      salesPerDay: durationDays > 0 ? Math.round(totalSales / durationDays) : 0,
    };

    const result: AuditResult = {
      from,
      to,
      sequence: {
        expectedCount,
        registeredCount,
        missingCount,
        syncRate,
        cancelledCount,
        pendingCount,
      },
      missingOrders,
      rows,
      financials: {
        totalSales: Math.round(totalSales),
        totalProductCost: Math.round(totalProductCost),
        totalShippingCost: round2(totalShippingCost),
        totalActualShippingCost: round2(totalActualShippingCost),
        billedShippingCost:round2(billedShippingCost),
        totalProfit: Math.round(totalProfit),
        avgOrderValue,
        profitMargin,
      },
      shipping: {
        totalShippingCost: round2(shippingTotal),
        avgShippingCost:
          shipRows.length > 0 ? round2(shippingTotal / shipRows.length) : 0,
        highestOrder: highestOrder
          ? { ...highestOrder, cost: round2(highestOrder.cost) }
          : null,
        companies,
        source:'carrier-actual-v1',measuredCount:shipRows.length,unconfirmedCount:financialRows.length-shipRows.length,
        bostaMeasuredCount:shipRows.filter(row=>row.actualShippingSource?.startsWith('bosta-')).length,
        liveFailedCount:shippingRead.failed,liveSkippedCount:shippingRead.skipped,
        lastReadAt:shipRows.map(row=>row.actualShippingReadAt||'').filter(Boolean).sort().slice(-1)[0]||'',
      },
      dateRange,
      storeName: this.storeName(),
      generatedAt: new Date().toISOString(),
    };

    if (opts.persist !== false) {
      await this.saveAuditLog(result, opts.generatedBy || '', opts.source || 'manual');
    }

    return result;
  }

  /** Latest review state per order number across all past audits. */
  private async loadReviews(
    orderNumbers: string[],
  ): Promise<Map<string, { reviewed: boolean; note: string }>> {
    const map = new Map<string, { reviewed: boolean; note: string }>();
    if (orderNumbers.length === 0) return map;

    const audits = await this.auditModel
      .find({ 'reviews.orderNumber': { $in: orderNumbers } }, { reviews: 1, createdAt: 1 })
      .sort({ createdAt: 1 })
      .lean();

    for (const a of audits) {
      for (const r of (a as any).reviews || []) {
        if (!orderNumbers.includes(r.orderNumber)) continue;
        // later audits overwrite earlier ones
        map.set(r.orderNumber, { reviewed: !!r.reviewed, note: r.note || '' });
      }
    }
    return map;
  }

  private async saveAuditLog(
    result: AuditResult,
    generatedBy: string,
    source: string,
  ): Promise<void> {
    try {
      await this.auditModel.create({
        fromOrder: result.from,
        toOrder: result.to,
        period: result.period,
        expectedCount: result.sequence.expectedCount,
        registeredCount: result.sequence.registeredCount,
        missingCount: result.sequence.missingCount,
        syncRate: result.sequence.syncRate,
        missingOrders: result.missingOrders.map((m) => m.orderNumber),
        financials: {
          totalSales: result.financials.totalSales,
          totalProductCost: result.financials.totalProductCost,
          totalShippingCost: result.financials.totalShippingCost,
          totalProfit: result.financials.totalProfit,
          avgOrderValue: result.financials.avgOrderValue,
        },
        result: result.sequence.missingCount > 0 ? 'gaps_found' : 'clean',
        generatedBy,
        source,
        reviews: [],
      });
    } catch (err) {
      this.logger.error(`فشل حفظ سجل التدقيق: ${(err as Error).message}`);
    }
  }

  // ── Audit history ─────────────────────────────────────────────────────────
  async getHistory(limit = 50): Promise<any[]> {
    return this.auditModel
      .find({})
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 200))
      .lean();
  }

  async deleteHistoryEntry(id: string): Promise<{ deleted: boolean }> {
    const res = await this.auditModel.findByIdAndDelete(id);
    if (!res) throw new NotFoundException('سجل التدقيق غير موجود');
    return { deleted: true };
  }

  // ── Per-missing-order actions ─────────────────────────────────────────────
  /** Mark reviewed and/or attach an investigation note to a missing order. */
  async reviewMissingOrder(
    orderNumber: string,
    body: { reviewed?: boolean; note?: string },
    by: string,
  ): Promise<{ success: boolean; orderNumber: string; reviewed: boolean; note: string }> {
    const num = this.normRef(orderNumber);
    if (!num) throw new BadRequestException('رقم أوردر غير صالح');

    // Attach the review to the most recent audit that contains this number,
    // so the audit log keeps a coherent trail.
    let audit = await this.auditModel
      .findOne({ missingOrders: num })
      .sort({ createdAt: -1 });

    if (!audit) {
      audit = await this.auditModel.findOne({}).sort({ createdAt: -1 });
    }
    if (!audit) {
      throw new NotFoundException('لا يوجد سجل تدقيق لربط المراجعة به — شغّل التدقيق أولاً');
    }

    const reviews = audit.reviews || [];
    const existing = reviews.find((r) => r.orderNumber === num);
    const at = new Date().toISOString();

    if (existing) {
      if (body.reviewed !== undefined) existing.reviewed = !!body.reviewed;
      if (body.note !== undefined) existing.note = String(body.note);
      existing.by = by;
      existing.at = at;
    } else {
      reviews.push({
        orderNumber: num,
        reviewed: body.reviewed ?? false,
        note: String(body.note ?? ''),
        by,
        at,
      });
    }

    audit.reviews = reviews;
    audit.markModified('reviews');
    await audit.save();

    const saved = (audit.reviews || []).find((r) => r.orderNumber === num);
    return {
      success: true,
      orderNumber: num,
      reviewed: saved?.reviewed ?? false,
      note: saved?.note ?? '',
    };
  }

  /**
   * Retry sync: pull the order from Shopify by number and import it into the
   * pending queue so an admin can approve it through the normal flow.
   */
  async retrySync(
    orderNumber: string,
  ): Promise<{ success: boolean; message: string; shopifyId?: string }> {
    const num = this.normRef(orderNumber);
    if (!num) throw new BadRequestException('رقم أوردر غير صالح');

    if (!(await this.shopifyAdminService.isConfigured())) {
      return {
        success: false,
        message: 'Shopify Admin API غير مضبوط — أضف SHOPIFY_STORE_NAME و SHOPIFY_ACCESS_TOKEN',
      };
    }

    // Already mirrored? Then it only needs admin approval, not a re-fetch.
    const existing = await this.shopifyOrderModel.findOne({ ref: num }).lean();
    if (existing) {
      return {
        success: false,
        message: `الأوردر #${num} موجود بالفعل في قائمة أوردرات Shopify بحالة "${(existing as any).status}" — راجعه من صفحة أوردرات Shopify`,
        shopifyId: String((existing as any).shopifyId || ''),
      };
    }

    const res = await this.shopifyAdminService.listOrders({ name: num, status: 'any' });
    if (!res.success) {
      return { success: false, message: res.error || 'تعذر الاتصال بـ Shopify' };
    }

    const match = (res.orders || []).find(
      (o: any) => this.normRef(o.name) === num || String(o.order_number) === num,
    );
    if (!match) {
      return {
        success: false,
        message: `لم يتم العثور على الأوردر #${num} في Shopify — قد يكون محذوفاً أو خارج آخر 250 أوردر`,
      };
    }

    return {
      success: true,
      message: `تم العثور على الأوردر #${num} في Shopify — استورده من صفحة أوردرات Shopify لإتمام المزامنة`,
      shopifyId: String(match.id),
    };
  }

  // ── Daily automatic monitoring ────────────────────────────────────────────
  /**
   * Compares the Shopify mirror against Soulia transactions once a day and
   * emits a notification when registered orders are missing. Audits only the
   * span actually covered by the mirror, so it never invents a range.
   */
  @Cron(CronExpression.EVERY_DAY_AT_7AM)
  async dailyMonitor(): Promise<void> {
    try {
      const orders = await this.shopifyOrderModel.find({}, { ref: 1 }).lean();
      const nums = orders
        .map((o) => Number(this.normRef((o as any).ref)))
        .filter((n) => Number.isFinite(n) && n > 0);

      if (nums.length === 0) {
        this.logger.log('المراقبة اليومية: لا توجد أوردرات Shopify للفحص');
        return;
      }

      const from = Math.min(...nums);
      const to = Math.max(...nums);

      // Guard against an absurd span from a stray order number.
      if (to - from + 1 > 5000) {
        this.logger.warn(
          `المراقبة اليومية: النطاق ${from}-${to} كبير جداً — تم فحص آخر 5000 رقم فقط`,
        );
      }
      const safeFrom = Math.max(from, to - 4999);

      const result = await this.runAudit(safeFrom, to, {
        persist: true,
        generatedBy: 'system',
        source: 'auto',
      });

      if (result.sequence.missingCount > 0) {
        const list = result.missingOrders.slice(0, 20).map((m) => m.orderNumber);
        this.emit('orderAudit:missing', {
          count: result.sequence.missingCount,
          missingOrders: list,
          from: safeFrom,
          to,
          message: `⚠ ${result.sequence.missingCount} أوردر من Shopify غير مسجل في سوليا`,
        });
        this.logger.warn(
          `⚠ المراقبة اليومية: ${result.sequence.missingCount} أوردر مفقود — ${list.join(', ')}`,
        );
      } else {
        this.logger.log(`✅ المراقبة اليومية: كل الأوردرات (${safeFrom}-${to}) مسجلة`);
      }
    } catch (err) {
      this.logger.error(`فشل فحص المراقبة اليومية: ${(err as Error).message}`);
    }
  }

  /** Unread alert payload for the notification bell — latest auto audit with gaps. */
  async getMonitorAlert(): Promise<{
    hasAlert: boolean;
    count: number;
    missingOrders: string[];
    from?: number;
    to?: number;
    at?: string;
  }> {
    const latest = await this.auditModel
      .findOne({ source: 'auto' })
      .sort({ createdAt: -1 })
      .lean();

    if (!latest || (latest as any).missingCount === 0) {
      return { hasAlert: false, count: 0, missingOrders: [] };
    }

    return {
      hasAlert: true,
      count: (latest as any).missingCount,
      missingOrders: ((latest as any).missingOrders || []).slice(0, 20),
      from: (latest as any).fromOrder,
      to: (latest as any).toOrder,
      at: (latest as any).createdAt,
    };
  }
}
