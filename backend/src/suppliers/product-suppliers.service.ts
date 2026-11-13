import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types, isValidObjectId } from 'mongoose';
import { ProductSupplier, ProductSupplierDocument } from './schemas/product-supplier.schema';
import { dateOnly } from '../shared/date-window.util';
import { resolveSupplier, setPrimarySupplier } from './primary-supplier.util';

const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export interface PurchaseForSupplierPrice {
  _id: unknown;
  ref?: string;
  date?: string;
  discount?: number;
  itemsTotal?: number;
  items?: Array<{ productId?: string; code?: string; qty?: number; price?: number; total?: number }>;
}

/**
 * أسعار الموردين لكل منتج (خطوة 4). سعر عرض بيملا فاتورة الشراء — **مش تكلفة ربح**.
 * بيتحدّث تلقائيًا من آخر فاتورة شراء من نفس المورد، أو يدويًا من كارت المنتج.
 */
@Injectable()
export class ProductSuppliersService {
  private readonly logger = new Logger(ProductSuppliersService.name);

  constructor(
    @InjectModel(ProductSupplier.name) private readonly model: Model<ProductSupplierDocument>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  private oid(id: string, label: string) {
    if (!isValidObjectId(id)) throw new BadRequestException(`${label} غير صالح`);
    return new Types.ObjectId(id);
  }

  /** موردين منتج واحد: الأساسي الأول، بعده الأرخص (اللي من غير سعر في الآخر). بيوضّح لو المورد اتمسح. */
  async listForProduct(productId: string): Promise<Array<Record<string, any>>> {
    this.oid(productId, 'المنتج');
    const rows: any[] = (await this.model.find({ productId, active: true }).sort({ price: 1, priceUpdatedAt: -1 }).lean())
      .sort((a: any, b: any) => Number(!!b.primary) - Number(!!a.primary) || Number(a.price === null) - Number(b.price === null));
    const ids = rows.map((r) => r.supplierId).filter(isValidObjectId).map((id) => new Types.ObjectId(id));
    const suppliers = ids.length
      ? await this.connection.collection('suppliers').find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray()
      : [];
    const names = new Map(suppliers.map((s: any) => [String(s._id), String(s.name || '')]));
    return rows.map((r) => ({
      ...r,
      supplierName: names.get(r.supplierId) || r.supplierName,
      supplierMissing: !names.has(r.supplierId),
    }));
  }

  /** أسعار مورد واحد لكل منتجاته — لملء فاتورة الشراء: { [productId]: { price, priceDate, ... } }. */
  async pricesForSupplier(supplierId: string): Promise<Record<string, Record<string, unknown>>> {
    this.oid(supplierId, 'المورد');
    const rows: any[] = await this.model.find({ supplierId, active: true, price: { $ne: null } }, { productId: 1, price: 1, priceDate: 1, priceSource: 1, lastPurchase: 1 }).lean();
    return Object.fromEntries(rows.map((r) => [r.productId, { price: r.price, priceDate: r.priceDate, priceSource: r.priceSource, lastPurchaseRef: (r.lastPurchase as any)?.ref || '' }]));
  }

  /** إضافة أو تعديل سعر مورد يدويًا من كارت المنتج. */
  async setManual(productId: string, supplierId: string, rawPrice: unknown, by: string): Promise<Record<string, any> | null> {
    const price = Number(rawPrice);
    if (!Number.isFinite(price) || price < 0) throw new BadRequestException('السعر لازم يكون رقم صفر أو أكبر');
    const [product, supplier] = await Promise.all([
      this.connection.collection('products').findOne({ _id: this.oid(productId, 'المنتج') }, { projection: { code: 1 } }),
      this.connection.collection('suppliers').findOne({ _id: this.oid(supplierId, 'المورد') }, { projection: { name: 1 } }),
    ]);
    if (!product) throw new NotFoundException('المنتج غير موجود');
    if (!supplier) throw new NotFoundException('المورد غير موجود');
    const now = new Date().toISOString();
    const existing = await this.model.findOne({ productId, supplierId }).lean();
    const entry = { at: now, by, action: existing && existing.active ? 'manual-edit' : 'manual-add', from: existing?.active ? existing.price : null, to: round2(price) };
    return this.model.findOneAndUpdate(
      { productId, supplierId },
      {
        $set: { supplierName: String(supplier.name || ''), price: round2(price), priceSource: 'manual', priceDate: now.slice(0, 10), priceUpdatedAt: now, priceUpdatedBy: by, active: true,
          manualPrice: { price: round2(price), date: now.slice(0, 10), at: now, by } },
        $push: { activityLog: { $each: [entry], $slice: -50 } },
      },
      { upsert: true, new: true },
    ).lean();
  }

  /** إخفاء المورد من جدول المنتج. السجل بيفضل، وأي فاتورة شراء جديدة منه بترجّعه. */
  async remove(productId: string, supplierId: string, by: string) {
    const now = new Date().toISOString();
    const row = await this.model.findOne({ productId, supplierId, active: true }, { primary: 1 }).lean();
    if (!row) throw new NotFoundException('المورد مش موجود في أسعار المنتج ده');
    // لو كان الأساسي: المنتج يرجع «— بدون —» — مايفضلش اسم معلّق مالوش سطر.
    if ((row as any).primary) await setPrimarySupplier(this.connection, productId, null, by);
    await this.model.updateOne(
      { productId, supplierId, active: true },
      { $set: { active: false, primary: false, priceUpdatedBy: by }, $push: { activityLog: { $each: [{ at: now, by, action: 'removed' }], $slice: -50 } } },
    );
    return { ok: true, primaryCleared: !!(row as any).primary };
  }

  /** «اجعله الأساسي» من جدول الأسعار، أو '' لشيل الأساسي. */
  async setPrimary(productId: string, supplierId: string, by: string) {
    this.oid(productId, 'المنتج');
    if (supplierId) {
      this.oid(supplierId, 'المورد');
      if (!(await resolveSupplier(this.connection, { id: supplierId }))) throw new NotFoundException('المورد غير موجود');
    }
    return setPrimarySupplier(this.connection, productId, supplierId ? { id: supplierId } : null, by);
  }

  /**
   * ترحيل: كل منتج عليه اسم مورد (من قبل الربط) يتربط بالمورد اللي اسمه مطابق ويبقى أساسي.
   * اسم مش مطابق لأي مورد بيفضل زي ما هو ويتعرض في التقرير — مافيش تخمين.
   */
  async backfillPrimary(dryRun = true, by = 'backfill') {
    const products: any[] = await this.connection.collection('products')
      .find({ supplier: { $nin: ['', null] }, $or: [{ supplierId: { $in: ['', null] } }, { supplierId: { $exists: false } }] }, { projection: { supplier: 1, code: 1 } }).toArray();
    const out = { candidates: products.length, linked: 0, unmatched: [] as Array<{ code: string; supplier: string }> };
    for (const p of products) {
      const s = await resolveSupplier(this.connection, { name: p.supplier });
      if (!s) { out.unmatched.push({ code: p.code, supplier: p.supplier }); continue; }
      out.linked++;
      if (!dryRun) await setPrimarySupplier(this.connection, String(p._id), { id: s.id }, by);
    }
    return { dryRun, ...out };
  }

  /** المورد اللي فاتورة الشراء دي منه: بالـ id، وإلا بالاسم المطابق تمامًا (نفس قاعدة كشف حساب المورد). */
  private async supplierOfTx(tx: any): Promise<{ id: string; name: string } | null> {
    if (!tx) return null;
    if (tx.supplierId && isValidObjectId(String(tx.supplierId))) {
      const s: any = await this.connection.collection('suppliers').findOne({ _id: new Types.ObjectId(String(tx.supplierId)) }, { projection: { name: 1 } });
      if (s) return { id: String(s._id), name: String(s.name || '') };
    }
    const name = String(tx.client || '').trim();
    if (!name) return null;
    const s: any = await this.connection.collection('suppliers').findOne({ name }, { projection: { name: 1 } });
    return s ? { id: String(s._id), name: String(s.name || '') } : null;
  }

  /**
   * تعديل أو إلغاء فاتورة شراء: سعر كل (منتج، مورد) اتأثر يتحسب من جديد من الفواتير.
   * `before` = الفاتورة قبل التعديل، `after` = بعده (null = اتلغت). بيغطي تغيير المورد نفسه على
   * الفاتورة وإضافة/شيل أصناف. مابيرميش استثناء — الفاتورة اتحفظت خلاص.
   */
  async recomputeForPurchase(before: any, after: any | null, by: string): Promise<number> {
    try {
      const sups = (await Promise.all([this.supplierOfTx(before), this.supplierOfTx(after)])).filter(Boolean) as Array<{ id: string; name: string }>;
      const codes = [...new Set([...(before?.items || []), ...(after?.items || [])].map((i: any) => String(i?.code || '').trim()).filter(Boolean))];
      if (!sups.length || !codes.length) return 0;
      const products = await this.connection.collection('products').find({ code: { $in: codes } }, { projection: { code: 1 } }).toArray();
      let n = 0;
      for (const p of products as any[]) for (const sp of new Map(sups.map((x) => [x.id, x])).values()) {
        if (await this.recomputePrice(String(p._id), String(p.code).trim(), sp, by)) n++;
      }
      return n;
    } catch (e: any) {
      this.logger.error(`recomputeForPurchase ${before?.ref || before?._id}: ${e?.message || e}`);
      return 0;
    }
  }

  /**
   * القاعدة الواحدة لسعر المورد: **آخر فاتورة شراء سارية منه** (بتاريخ الفاتورة، والتعادل بوقت
   * التسجيل) — إلا لو في سعر يدوي تاريخه أحدث (أو نفس اليوم واتكتب بعدها). `lastPurchase` دايمًا آخر
   * فاتورة سارية. مفيش فاتورة ولا سعر يدوي → `price: null` («بدون سعر») والسطر يفضل (العلاقة كانت موجودة).
   */
  async recomputePrice(productId: string, code: string, sup: { id: string; name: string }, by: string): Promise<boolean> {
    const txs: any[] = await this.connection.collection('transactions').find(
      { type: 'مشتريات', cancelled: { $ne: true }, 'items.code': code, $or: [{ supplierId: sup.id }, { supplierId: { $in: ['', null] }, client: sup.name }, { supplierId: { $exists: false }, client: sup.name }] },
      { projection: { ref: 1, date: 1, createdAt: 1, discount: 1, items: 1 } }).toArray();
    let inv: any = null;
    for (const t of txs) {
      const d = dateOnly(t.date) || '';
      const at = new Date(t.createdAt || 0).getTime();
      if (!inv || d > inv.date || (d === inv.date && at > inv.at)) inv = { tx: t, date: d, at };
    }
    let lastPurchase: Record<string, unknown> | null = null;
    if (inv) {
      const items = (inv.tx.items || []).filter((i: any) => Number(i?.qty) > 0 && Number.isFinite(Number(i?.price)));
      const line = [...items].reverse().find((i: any) => String(i.code || '').trim() === code);
      const gross = items.reduce((s: number, i: any) => s + (Number(i.total) || Number(i.qty) * Number(i.price)), 0);
      const discount = Math.min(Math.max(Number(inv.tx.discount) || 0, 0), gross);
      const ratio = gross > 0 ? (gross - discount) / gross : 1;
      if (line) lastPurchase = { txId: String(inv.tx._id), ref: inv.tx.ref || '', date: inv.date, qty: Number(line.qty), price: round2(Number(line.price)), unitCost: round2(Number(line.price) * ratio) };
    }
    const row: any = await this.model.findOne({ productId, supplierId: sup.id }).lean();
    if (!row && !lastPurchase) return false;
    const manual = row?.manualPrice || (row?.priceSource === 'manual' && row?.price !== null && row?.price !== undefined
      ? { price: row.price, date: row.priceDate || String(row.priceUpdatedAt || '').slice(0, 10), at: row.priceUpdatedAt || '' } : null);
    const manualWins = manual && (!lastPurchase || String(manual.date) > String(lastPurchase.date)
      || (String(manual.date) === String(lastPurchase.date) && new Date(manual.at || 0).getTime() >= (inv?.at || 0)));
    const next = manualWins
      ? { price: round2(Number(manual.price)), priceSource: 'manual', priceDate: String(manual.date || '') }
      : lastPurchase
        ? { price: Number(lastPurchase.price), priceSource: 'purchase', priceDate: String(lastPurchase.date) }
        : { price: null, priceSource: 'manual', priceDate: '' };
    const same = row && row.price === next.price && row.priceSource === next.priceSource && row.priceDate === next.priceDate
      && JSON.stringify(row.lastPurchase || null) === JSON.stringify(lastPurchase);
    if (same) return false;
    const now = new Date().toISOString();
    await this.model.updateOne(
      { productId, supplierId: sup.id },
      {
        $set: { supplierName: sup.name, ...next, lastPurchase, priceUpdatedAt: now, priceUpdatedBy: by, ...(row ? {} : { active: true }) },
        $push: { activityLog: { $each: [{ at: now, by, action: 'recomputed', from: row?.price ?? null, to: next.price }], $slice: -50 } },
      },
      { upsert: true },
    );
    if (manual && !row?.manualPrice && row) await this.model.updateOne({ _id: row._id }, { $set: { manualPrice: manual } });
    return true;
  }

  /**
   * فاتورة شراء اتحفظت: كل صنف فيها يحدّث سعر المورد ده.
   * - السعر = سعر السطر (اللي اتكتب في الفاتورة). `lastPurchase.unitCost` = بعد نصيبه من خصم الفاتورة.
   * - فاتورة بتاريخ أقدم من السعر المسجّل مابتكتبش فوقه (فاتورة متأخرة في التسجيل).
   * - مابترميش استثناء أبدًا: الفاتورة اتحفظت بالفعل، وسعر العرض مايوقفهاش.
   * `dryRun` بيرجّع اللي كان هيتكتب من غير كتابة.
   */
  async recordPurchase(tx: PurchaseForSupplierPrice, supplierId: string, supplierName: string, by: string, dryRun = false) {
    const result = { lines: 0, written: 0, skippedOlder: 0, unmatched: [] as string[] };
    try {
      if (!supplierId || !isValidObjectId(supplierId)) return result;
      const items = (tx.items || []).filter((i) => Number(i?.qty) > 0 && Number.isFinite(Number(i?.price)));
      if (!items.length) return result;
      const codes = [...new Set(items.map((i) => String(i.code || '').trim()).filter(Boolean))];
      const products = await this.connection.collection('products').find({ code: { $in: codes } }, { projection: { code: 1 } }).toArray();
      const productByCode = new Map(products.map((p: any) => [String(p.code).trim(), String(p._id)]));
      const gross = items.reduce((s, i) => s + (Number(i.total) || Number(i.qty) * Number(i.price)), 0);
      const discount = Math.min(Math.max(Number(tx.discount) || 0, 0), gross);
      const ratio = gross > 0 ? (gross - discount) / gross : 1;
      const date = dateOnly(tx.date) || new Date().toISOString().slice(0, 10);
      const now = new Date().toISOString();
      // نفس المنتج متكرر في الفاتورة: آخر سطر هو اللي يكسب.
      const byProduct = new Map<string, (typeof items)[number]>();
      for (const item of items) {
        const productId = productByCode.get(String(item.code || '').trim());
        if (!productId) { result.unmatched.push(String(item.code || '')); continue; }
        byProduct.set(productId, item);
      }
      // أول فاتورة شراء لمنتج مالوش مورد خالص: مورّدها يبقى الأساسي. اختيار موجود مابيتغيّرش أبدًا.
      if (!dryRun && byProduct.size) {
        const bare: any[] = await this.connection.collection('products').find(
          { _id: { $in: [...byProduct.keys()].map((id) => new Types.ObjectId(id)) }, supplier: { $in: ['', null] }, supplierId: { $in: ['', null] } },
          { projection: { _id: 1 } }).toArray().catch(() => []);
        for (const p of bare) {
          await setPrimarySupplier(this.connection, String(p._id), { id: supplierId }, by).catch((e) => this.logger.warn(`primary on purchase: ${e?.message || e}`));
        }
      }
      for (const [productId, item] of byProduct) {
        result.lines++;
        const price = round2(Number(item.price));
        const existing = await this.model.findOne({ productId, supplierId }, { priceDate: 1, active: 1 }).lean();
        if (existing?.priceDate && existing.priceDate > date) { result.skippedOlder++; continue; }
        result.written++;
        if (dryRun) continue;
        await this.model.updateOne(
          { productId, supplierId, $or: [{ priceDate: { $lte: date } }, { priceDate: { $in: ['', null] } }] },
          {
            $set: {
              supplierName, price, priceSource: 'purchase', priceDate: date, priceUpdatedAt: now, priceUpdatedBy: by, active: true,
              lastPurchase: { txId: String(tx._id), ref: tx.ref || '', date, qty: Number(item.qty), price, unitCost: round2(price * ratio) },
            },
            $push: { activityLog: { $each: [{ at: now, by, action: 'purchase', ref: tx.ref || '', to: price }], $slice: -50 } },
          },
          { upsert: !existing },
        ).catch((e) => {
          // سباق نادر: فاتورتين لنفس المنتج والمورد في نفس اللحظة. التانية هتلاقي الصف وتكمّل.
          if (e?.code !== 11000) throw e;
        });
      }
    } catch (e: any) {
      this.logger.error(`recordPurchase #${tx.ref || tx._id}: ${e?.message || e}`);
    }
    return result;
  }
}
