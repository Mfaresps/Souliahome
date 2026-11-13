import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { ProductCostEvent, ProductCostEventDocument } from './schemas/product-cost-event.schema';
import { averageAfterCorrection, averageAfterPurchase, averageAt, currentUnitCost, purchaseLotsByCode, replayAverage, supplierReturnLots } from '../shared/avg-cost.util';

type PurchaseTx = { _id: unknown; ref?: string; discount?: number; items?: any[]; updatedAt?: unknown };
type StockOf = (code: string) => number;

/**
 * متوسط تكلفة كل منتج (خطوة 3). فواتير الشراء بس هي اللي بتغيّره.
 * ⚠ مابيرميش استثناء من مسارات الفواتير: الفاتورة اتحفظت خلاص، والمتوسط ميوقفهاش — الخطأ بيتسجل.
 */
@Injectable()
export class ProductCostService {
  private readonly logger = new Logger(ProductCostService.name);

  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
    @InjectModel(ProductCostEvent.name) private readonly eventModel: Model<ProductCostEventDocument>,
  ) {}

  /** يكتب المتوسط الجديد بشرط إنه ماتغيّرش من وقت القراءة؛ لو اتغيّر يعيد الحساب (3 محاولات). */
  private async writeAverage(productId: string, compute: (avgBefore: number) => number): Promise<{ avgBefore: number; avgAfter: number } | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const p = await this.productModel.findById(productId, { avgCost: 1, buyPrice: 1 }).lean();
      if (!p) return null;
      const avgBefore = currentUnitCost(p as any) ?? 0;
      const avgAfter = compute(avgBefore);
      const stored = (p as any).avgCost ?? null;
      const res = await this.productModel.updateOne(
        { _id: productId, avgCost: stored },
        { $set: { avgCost: avgAfter, avgCostUpdatedAt: new Date().toISOString() } },
      );
      if (res.matchedCount) return { avgBefore, avgAfter };
    }
    this.logger.error(`writeAverage: gave up after 3 concurrent changes on ${productId}`);
    return null;
  }

  private async record(ev: Partial<ProductCostEvent>) {
    try { await this.eventModel.create(ev); } catch (e: any) { if (e?.code !== 11000) throw e; }
  }

  /** فاتورة شراء جديدة. `stockOf` = المخزون **قبل** الفاتورة. */
  async applyPurchase(tx: PurchaseTx, stockOf: StockOf, by: string): Promise<number> {
    let applied = 0;
    try {
      const lots = purchaseLotsByCode(tx.items || [], Number(tx.discount) || 0);
      if (!lots.size) return 0;
      const products = await this.productModel.find({ code: { $in: [...lots.keys()] } }, { code: 1 }).lean();
      for (const p of products as any[]) {
        const productId = String(p._id), lot = lots.get(String(p.code).trim());
        if (!lot) continue;
        const eventKey = `purchase:${String(tx._id)}:${productId}`;
        if (await this.eventModel.exists({ eventKey })) continue;
        const stockBefore = Math.max(0, stockOf(p.code) || 0);
        const w = await this.writeAverage(productId, (avg) => averageAfterPurchase(stockBefore, avg, lot.qty, lot.unitCost));
        if (!w) continue;
        await this.record({ productId, code: p.code, eventKey, kind: 'purchase', txId: String(tx._id), ref: tx.ref || '',
          stockBefore, avgBefore: w.avgBefore, qtyIn: lot.qty, unitCostIn: lot.unitCost, avgAfter: w.avgAfter, by });
        applied++;
      }
    } catch (e: any) {
      this.logger.error(`applyPurchase #${tx.ref || tx._id}: ${e?.message || e}`);
    }
    return applied;
  }

  /** هل الفاتورة دي دخلت المتوسط؟ فواتير ما قبل التفعيل لأ — وتعديلها مايلمسش المتوسط. */
  async purchaseIsInAverage(txId: string): Promise<boolean> {
    return !!(await this.eventModel.exists({ txId: String(txId), kind: { $in: ['purchase', 'purchase-edit'] } }));
  }

  /**
   * تعديل أو إلغاء فاتورة شراء دخلت المتوسط — **إعادة حساب بالترتيب الزمني** (`replayAverage`):
   * الفاتورة بتتحسب في مكانها الأصلي بقيمها الجديدة، وكل الأحداث بعدها بتتعاد. دقيق حتى لو جزء
   * من الفاتورة اتباع، لأن البيع مابيغيّرش المتوسط.
   * ⚠ **البيعات اللي اتعملت في النص مابتتغيّرش.** الفرق بين المتوسط الصح وقت كل بيعة والتكلفة
   *   المحفوظة عليها بيتسجل على حدث التعديل (`soldQtySince` / `costVariance`) — للمراجعة بس.
   * صنف اتضاف للفاتورة في التعديل (مالوش حدث قبل كده) بيدخل المتوسط **دلوقتي** بالمخزون الحالي،
   * ويتسجل كحدث `purchase` (method `added-now`) عشان أي تعديل بعد كده يلاقيه.
   * `stockOf` = المخزون الحالي شامل كمية الفاتورة القديمة. `newTx` = null معناها إلغاء.
   */
  async correctPurchase(txId: string, newTx: PurchaseTx | null, stockOf: StockOf, by: string, revision: string): Promise<number> {
    let applied = 0;
    try {
      const txEvents = await this.eventModel.find({ txId: String(txId) }).sort({ createdAt: 1, _id: 1 }).lean();
      if (!txEvents.some((e: any) => e.kind === 'purchase' || e.kind === 'purchase-edit')) return 0;
      // المساهمة الحالية لكل منتج = آخر حدث ليه في الفاتورة دي.
      const current = new Map<string, { code: string; qty: number; cost: number }>();
      for (const e of txEvents as any[]) {
        current.set(e.productId, e.kind === 'purchase-cancel' ? { code: e.code, qty: 0, cost: 0 } : { code: e.code, qty: e.qtyIn, cost: e.unitCostIn });
      }
      const newLots = newTx ? purchaseLotsByCode(newTx.items || [], Number(newTx.discount) || 0) : new Map<string, { qty: number; unitCost: number }>();
      const kind = newTx ? 'purchase-edit' : 'purchase-cancel';

      for (const [productId, old] of current) {
        const lot = newLots.get(old.code) || { qty: 0, unitCost: 0 };
        if (old.qty === lot.qty && Math.abs(old.cost - lot.unitCost) < 0.0001) continue;
        const eventKey = `${kind}:${String(txId)}:${productId}:${revision}`;
        if (await this.eventModel.exists({ eventKey })) continue;
        if (await this.replayAndRecord(productId, old, lot, String(txId), kind, eventKey, newTx?.ref || '', stockOf(old.code), by)) applied++;
      }

      // أصناف اتضافت للفاتورة في التعديل: تدخل المتوسط دلوقتي.
      const knownCodes = new Set([...current.values()].map((v) => v.code));
      const newCodes = [...newLots.keys()].filter((c) => !knownCodes.has(c));
      const added = newCodes.length ? await this.productModel.find({ code: { $in: newCodes } }, { code: 1 }).lean() : [];
      for (const p of added as any[]) {
        const productId = String(p._id), lot = newLots.get(String(p.code).trim());
        if (!lot) continue;
        const eventKey = `purchase:${String(txId)}:${productId}`;
        if (await this.eventModel.exists({ eventKey })) continue;
        const stockNow = Math.max(0, stockOf(p.code) || 0);
        const w = await this.writeAverage(productId, (avg) => averageAfterPurchase(stockNow, avg, lot.qty, lot.unitCost));
        if (!w) continue;
        await this.record({ productId, code: p.code, eventKey, kind: 'purchase', txId: String(txId), ref: newTx?.ref || '',
          stockBefore: stockNow, avgBefore: w.avgBefore, qtyIn: lot.qty, unitCostIn: lot.unitCost, avgAfter: w.avgAfter, by, method: 'added-now' });
        applied++;
      }
    } catch (e: any) {
      this.logger.error(`correctPurchase ${txId}: ${e?.message || e}`);
    }
    return applied;
  }

  /** إعادة الحساب لمنتج واحد + كتابة النتيجة بشرط إن المتوسط ماتغيّرش من وقت القراءة (3 محاولات). */
  private async replayAndRecord(productId: string, old: { code: string; qty: number; cost: number }, lot: { qty: number; unitCost: number },
    txId: string, kind: string, eventKey: string, ref: string, stockNow: number, by: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const [product, events] = await Promise.all([
        this.productModel.findById(productId, { avgCost: 1, buyPrice: 1 }).lean(),
        this.eventModel.find({ productId }).sort({ createdAt: 1, _id: 1 }).lean(),
      ]);
      if (!product) return false;
      const replay = replayAverage(events as any[], txId, lot);
      if (!replay) return false;
      const stored = (product as any).avgCost ?? null;
      const avgBefore = currentUnitCost(product as any) ?? 0;
      // البيعات اللي اتعملت من وقت الفاتورة: المتوسط الصح وقتها − التكلفة المحفوظة. مابتتغيّرش.
      const sales = await this.productModel.db.collection('transactions').find(
        { type: 'مبيعات', cancelled: { $ne: true }, 'items.code': old.code },
        { projection: { items: 1 } }).toArray();
      let soldQtySince = 0, costVariance = 0;
      for (const tx of sales as any[]) for (const it of tx.items || []) {
        if (String(it.code || '').trim() !== old.code || it.costSource !== 'sale-snapshot' || !it.costAt) continue;
        const at = new Date(it.costAt);
        if (!(at.getTime() >= replay.txPurchaseAt.getTime())) continue;
        const right = averageAt(replay.timeline, at);
        if (right === null) continue;
        const q = Number(it.qty) || 0;
        soldQtySince += q;
        costVariance += (right - (Number(it.unitCost) || 0)) * q;
      }
      const res = await this.productModel.updateOne({ _id: productId, avgCost: stored },
        { $set: { avgCost: replay.finalAvg, avgCostUpdatedAt: new Date().toISOString() } });
      if (!res.matchedCount) continue;
      await this.record({ productId, code: old.code, eventKey, kind, txId, ref,
        stockBefore: Math.max(0, stockNow || 0), avgBefore, qtyIn: lot.qty, unitCostIn: lot.unitCost,
        oldQty: old.qty, oldUnitCost: old.cost, avgAfter: replay.finalAvg, by, method: 'replay',
        soldQtySince, costVariance: Math.round(costVariance * 100) / 100 });
      return true;
    }
    this.logger.error(`replayAndRecord: gave up after 3 concurrent changes on ${productId}`);
    return false;
  }

  /**
   * مرتجع للمورد: القطع بتطلع **بتكلفتها الفعلية** (`allocations.unitCost` من فاتورة الشراء الأصلية)
   * والمتوسط يتعاد حسابه للباقي — كده فرق سعر الشراء عن المتوسط مابيضيعش، بيفضل في قيمة المخزون
   * الباقي ويوصل لتكلفة البيعات الجاية. منتج ماعندوش متوسط لسه (قبل التشغيل) مابيتلمسش.
   * `stockOf` = المخزون **قبل** المرتجع (شامل القطع الراجعة).
   */
  async applySupplierReturn(tx: PurchaseTx, stockOf: StockOf, by: string): Promise<number> {
    let applied = 0;
    try {
      const lots = supplierReturnLots(tx.items || []);
      if (!lots.size) return 0;
      const products = await this.productModel.find({ code: { $in: [...lots.keys()] }, avgCost: { $ne: null } }, { code: 1 }).lean();
      for (const p of products as any[]) {
        const productId = String(p._id), lot = lots.get(String(p.code).trim());
        if (!lot) continue;
        const eventKey = `supplier-return:${String(tx._id)}:${productId}`;
        if (await this.eventModel.exists({ eventKey })) continue;
        const stockBefore = Math.max(0, stockOf(p.code) || 0);
        const w = await this.writeAverage(productId, (avg) => averageAfterCorrection(stockBefore, avg, lot.qty, lot.unitCost, 0, 0));
        if (!w) continue;
        await this.record({ productId, code: p.code, eventKey, kind: 'supplier-return', txId: String(tx._id), ref: tx.ref || '',
          stockBefore, avgBefore: w.avgBefore, oldQty: lot.qty, oldUnitCost: lot.unitCost, avgAfter: w.avgAfter, by });
        applied++;
      }
    } catch (e: any) {
      this.logger.error(`applySupplierReturn #${tx.ref || tx._id}: ${e?.message || e}`);
    }
    return applied;
  }

  /** عكس مرتجع مورد (إلغاء معاملته): القطع بترجع بنفس تكلفتها. `stockOf` = المخزون قبل العكس. */
  async reverseSupplierReturn(txId: string, stockOf: StockOf, by: string): Promise<number> {
    let applied = 0;
    try {
      const events = await this.eventModel.find({ txId: String(txId), kind: 'supplier-return' }).lean();
      for (const e of events as any[]) {
        const eventKey = `supplier-return-reversed:${String(txId)}:${e.productId}`;
        if (await this.eventModel.exists({ eventKey })) continue;
        const stockBefore = Math.max(0, stockOf(e.code) || 0);
        const w = await this.writeAverage(e.productId, (avg) => averageAfterPurchase(stockBefore, avg, e.oldQty, e.oldUnitCost));
        if (!w) continue;
        await this.record({ productId: e.productId, code: e.code, eventKey, kind: 'supplier-return-reversed', txId: String(txId), ref: e.ref,
          stockBefore, avgBefore: w.avgBefore, qtyIn: e.oldQty, unitCostIn: e.oldUnitCost, avgAfter: w.avgAfter, by });
        applied++;
      }
    } catch (e: any) {
      this.logger.error(`reverseSupplierReturn ${txId}: ${e?.message || e}`);
    }
    return applied;
  }

  /** تصحيح يدوي موثّق (أدمن + سبب). بيأثر على اللي جاي بس. */
  async revalue(productId: string, rawAvg: unknown, by: string, reason: string) {
    const avg = Number(rawAvg);
    if (!isValidObjectId(productId)) throw new BadRequestException('المنتج غير صالح');
    if (!Number.isFinite(avg) || avg < 0) throw new BadRequestException('المتوسط لازم يكون رقم صفر أو أكبر');
    if (!String(reason || '').trim()) throw new BadRequestException('سبب التصحيح مطلوب');
    const p: any = await this.productModel.findById(productId, { code: 1 }).lean();
    if (!p) throw new NotFoundException('المنتج غير موجود');
    const w = await this.writeAverage(productId, () => Math.round(avg * 10000) / 10000);
    if (!w) throw new BadRequestException('المتوسط اتغيّر أثناء الحفظ — حاول تاني');
    await this.record({ productId, code: p.code, eventKey: `revalue:${productId}:${Date.now()}`, kind: 'revalue',
      avgBefore: w.avgBefore, avgAfter: w.avgAfter, by, reason: String(reason).trim().slice(0, 300) });
    return { avgCost: w.avgAfter };
  }

  async history(productId: string, limit = 20) {
    if (!isValidObjectId(productId)) throw new BadRequestException('المنتج غير صالح');
    return this.eventModel.find({ productId }).sort({ createdAt: -1, _id: -1 }).limit(Math.min(Math.max(limit, 1), 100)).lean();
  }
}
