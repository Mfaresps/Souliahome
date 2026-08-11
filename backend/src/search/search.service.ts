import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product, ProductDocument } from '../products/schemas/product.schema';
import {
  Transaction,
  TransactionDocument,
} from '../transactions/schemas/transaction.schema';
import {
  Supplier,
  SupplierDocument,
} from '../suppliers/schemas/supplier.schema';
import {
  Complaint,
  ComplaintDocument,
} from '../complaints/schemas/complaint.schema';
import {
  ShopifyOrder,
  ShopifyOrderDocument,
} from '../shopify/schemas/shopify-order.schema';
import { SearchResultItem, SearchResponse } from './dto/search.dto';

const MAX_RESULTS_PER_CATEGORY = 50;
const TX_ACTIVE_FILTER = { cancelled: { $ne: true } };

/* ════════════════════════════════════════════════════════════════════
   محرك الصلة (Relevance engine)

   قبل هذا: كل بحث كان boolean (مطابق / غير مطابق)، والنتائج تُقصّ عند
   أول 50 عنصر *بترتيب قاعدة البيانات* — أي أن أفضل نتيجة قد لا تظهر
   أصلاً. والترتيب بين الأقسام كان قائمة ثابتة في الواجهة.

   الآن: كل عنصر يحصل على درجة صلة مبنية على (أ) جودة المطابقة داخل
   الحقل، (ب) وزن الحقل نفسه، (ج) أولوية النوع حسب نية الاستعلام،
   (د) حداثة/شعبية السجل. الواجهة ترتّب الأقسام بأعلى درجة داخل كل قسم.

   ⚠ منطق التسجيل مُطابَق حرفياً في الواجهة (`_gsTokenFieldScore` /
   `_gsScoreFields` في frontend/public/index.html) لتسجيل عناصر التنقّل
   التي لا تمر بهذا الـ endpoint. أي تعديل هنا يجب أن ينعكس هناك.
   ════════════════════════════════════════════════════════════════════ */

/** أرقام عربية-هندية (٠-٩) وفارسية (۰-۹) — تُحوَّل إلى لاتينية قبل أي مقارنة */
const AR_INDIC_DIGITS = /[٠-٩۰-۹]/g;
/** فاصل الكلمات: أي شيء ليس حرفاً أو رقماً (يشمل - و _ و # و /) */
const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

/** درجات جودة المطابقة داخل حقل واحد (قبل ضربها في وزن الحقل) */
const S_FIELD_EXACT = 100; // الحقل كله يساوي الكلمة
const S_WORD_EXACT = 88; // كلمة كاملة داخل الحقل تساوي الكلمة
const S_FIELD_PREFIX = 78; // الحقل يبدأ بالكلمة
const S_WORD_PREFIX = 60; // كلمة داخل الحقل تبدأ بالكلمة
const S_AL_PREFIX = 54; // كما سبق بعد تجاهل "ال" التعريف
const S_CONTAINS = 34; // ظهور في وسط كلمة
const S_FUZZY_NEAR = 26; // خطأ إملائي بحرف واحد
const S_FUZZY_FAR = 15; // خطأ إملائي بحرفين

/** مكافأة المطابقة التامة لحقل رئيسي (كود صنف، رقم مرجع…) — تثبّتها في القمة */
const EXACT_FIELD_BONUS = 150;
/** مكافأة ظهور الاستعلام متعدد الكلمات كعبارة متصلة */
const PHRASE_BONUS = 15;
/** الحد الأدنى لطول الكلمة قبل السماح بالمطابقة التقريبية */
const FUZZY_MIN_LEN = 4;

/**
 * أولوية النوع — إضافة صغيرة تفكّ التعادل فقط، ولا تقلب مطابقة أقوى.
 * (الفرق بين prefix=78 و contains=34 أكبر بكثير من أي أولوية هنا.)
 */
const TYPE_PRIOR_TEXT: Record<string, number> = {
  order: 5,
  product: 4,
  customer: 3,
  supplier: 2,
  shopify_order: 2,
  complaint: 1,
};
const TYPE_PRIOR_NUMERIC: Record<string, number> = {
  order: 9,
  shopify_order: 6,
  complaint: 3,
  product: 2,
  customer: 1,
  supplier: 0,
};

/** حقل قابل للبحث مع وزنه. `primary` = يستحق مكافأة المطابقة التامة. */
interface WeightedField {
  v: unknown;
  w: number;
  primary?: boolean;
}

/** حقل بعد التطبيع والتقطيع — يُحسب مرة واحدة ويُعاد استخدامه لكل كلمة */
interface PreppedField {
  v: string;
  w: number;
  primary: boolean;
  words: string[];
}

/** سياق تسجيل استعلام واحد */
interface ScoreCtx {
  tokens: string[];
  phrase: string;
  numeric: boolean;
  fuzzy: boolean;
}

function toLatinDigits(s: string): string {
  return s.replace(AR_INDIC_DIGITS, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

/** تهريب المدخلات قبل حقنها في $regex — الاستعلام يأتي من المستخدم */
function escapeRegex(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** هل الإدخال أرقام فقط؟ */
function isNumericOnly(q: string): boolean {
  return /^\d+$/.test(q.trim());
}

/** هل يبدأ الإدخال بمقدمة رقم هاتف مصري صالحة (010/011/012/015)؟ */
function isPhoneNumber(q: string): boolean {
  return /^(010|011|012|015)/.test(q.trim());
}

/** أيقونة ديناميكية حسب نوع المعاملة */
function orderIcon(type: string): string {
  if (type === 'مبيعات') return '🛒';
  if (type === 'مشتريات') return '📦';
  if (type?.startsWith('مرتجع')) return '↩️';
  return '📋';
}

/**
 * درجة مطابقة كلمة واحدة داخل حقل واحد (0 = لا مطابقة).
 * تُعيد أفضل درجة ممكنة — لا تتوقف عند أول تطابق.
 */
function tokenFieldScore(f: PreppedField, token: string): number {
  if (!f.v || !token) return 0;
  if (f.v === token) return S_FIELD_EXACT;
  let best = 0;
  if (f.v.startsWith(token)) best = S_FIELD_PREFIX;
  for (const w of f.words) {
    if (w === token) return Math.max(best, S_WORD_EXACT);
    if (w.startsWith(token)) {
      if (S_WORD_PREFIX > best) best = S_WORD_PREFIX;
    } else if (
      // "المخزن" يجب أن يطابق "مخزن" — "ال" التعريف لا تُعد جزءاً من الكلمة
      w.length > token.length + 1 &&
      w.startsWith('ال') &&
      w.slice(2).startsWith(token) &&
      S_AL_PREFIX > best
    ) {
      best = S_AL_PREFIX;
    }
  }
  if (!best && f.v.includes(token)) best = S_CONTAINS;
  return best;
}

/** مسافة تحرير محدودة — تُعيد -1 فور تجاوز `max` (توقّف مبكر) */
function boundedEditDistance(a: string, b: string, max: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return -1;
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = i;
    const lo = Math.max(1, i - max);
    const hi = Math.min(lb, i + max);
    for (let j = 1; j <= lb; j++) {
      if (j < lo || j > hi) {
        cur[j] = max + 1;
        continue;
      }
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, sub);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return -1;
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[lb] <= max ? prev[lb] : -1;
}

/** مطابقة تقريبية (أخطاء إملائية) — تُستخدم فقط عند فشل البحث الدقيق كلياً */
function fuzzyTokenScore(f: PreppedField, token: string): number {
  if (token.length < FUZZY_MIN_LEN) return 0;
  const max = token.length >= 7 ? 2 : 1;
  let best = 0;
  for (const w of f.words) {
    if (Math.abs(w.length - token.length) > max) continue;
    const d = boundedEditDistance(w, token, max);
    if (d < 0) continue;
    const s = d <= 1 ? S_FUZZY_NEAR : S_FUZZY_FAR;
    if (s > best) best = s;
  }
  return best;
}

/** دفعة حداثة: ~6 نقاط لسجل اليوم، تتلاشى لوغاريتمياً حتى 0 بعد سنة */
function recencyBoost(createdAt: unknown): number {
  if (!createdAt) return 0;
  const t = new Date(createdAt as string).getTime();
  if (!t || Number.isNaN(t)) return 0;
  const days = (Date.now() - t) / 86_400_000;
  if (days <= 0) return 6;
  return Math.max(0, 6 - Math.log1p(days) * 1.4);
}

@Injectable()
export class SearchService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(Supplier.name)
    private readonly supplierModel: Model<SupplierDocument>,
    @InjectModel(Complaint.name)
    private readonly complaintModel: Model<ComplaintDocument>,
    @InjectModel(ShopifyOrder.name)
    private readonly shopifyOrderModel: Model<ShopifyOrderDocument>,
  ) {}

  async search(query: string): Promise<SearchResponse> {
    const raw = toLatinDigits(String(query || '')).trim();
    const trimmed = raw.replace(/^#+/, '').trim();
    if (!trimmed) {
      return { results: [], total: 0 };
    }

    const numeric = isNumericOnly(trimmed);
    const isPhone = isPhoneNumber(trimmed);

    let results = await this.runPass(trimmed, numeric, isPhone, false);

    // لا شيء إطلاقاً؟ أعد المحاولة بتسامح إملائي (بحث نصي فقط — الأرقام
    // لا تُصحَّح، فرقم مرجع مقارب لا يعني شيئاً وقد يفتح أوردر خطأ).
    if (
      !results.length &&
      !numeric &&
      !isPhone &&
      trimmed.length >= FUZZY_MIN_LEN
    ) {
      results = await this.runPass(trimmed, numeric, isPhone, true);
    }

    results.sort((a, b) => (b.score || 0) - (a.score || 0));
    return { results, total: results.length };
  }

  /** تمريرة بحث واحدة عبر كل المصادر المناسبة لنية الاستعلام */
  private async runPass(
    trimmed: string,
    numeric: boolean,
    isPhone: boolean,
    fuzzy: boolean,
  ): Promise<SearchResultItem[]> {
    const ctx: ScoreCtx = {
      tokens: this.tokenizeQuery(trimmed),
      phrase: this.normalizeSearchText(trimmed),
      numeric: numeric && !isPhone,
      fuzzy,
    };

    if (isPhone) {
      // يبدأ بـ 01 → رقم هاتف بالتأكيد: عملاء وموردون وحركات
      const [customers, supplierResults, orders, complaintResults] =
        await Promise.all([
          this.searchCustomersByPhone(trimmed, ctx),
          this.searchSuppliersByPhone(trimmed, ctx),
          this.searchOrdersByPhone(trimmed, ctx),
          this.searchComplaintsByText(trimmed, ctx),
        ]);
      return [
        ...customers,
        ...supplierResults,
        ...orders,
        ...complaintResults,
      ];
    }

    if (numeric) {
      // أرقام لا تبدأ بمقدمة هاتف صالحة: رقم مرجع أوردر أو رقم تتبع بوسطة
      const [orders, complaintResults, shopifyResults, trackingResults] =
        await Promise.all([
          this.searchOrdersByRef(trimmed, ctx),
          this.searchComplaintsByText(trimmed, ctx),
          this.searchShopifyOrdersByRef(trimmed, ctx),
          this.searchOrdersByTracking(trimmed, ctx),
        ]);
      // دمج نتائج رقم التتبع مع نتائج المرجع (بدون تكرار نفس الحركة)
      const seenIds = new Set(orders.map((o) => o.id));
      const merged = [
        ...orders,
        ...trackingResults.filter((o) => !seenIds.has(o.id)),
      ];
      return [...merged, ...complaintResults, ...shopifyResults];
    }

    // نص عام
    const [products, orders, customers, supplierResults, complaintResults] =
      await Promise.all([
        this.searchProducts(trimmed, ctx),
        this.searchOrdersByText(trimmed, ctx),
        this.searchCustomersByText(trimmed, ctx),
        this.searchSuppliers(trimmed, ctx),
        this.searchComplaintsByText(trimmed, ctx),
      ]);
    return [
      ...products,
      ...orders,
      ...customers,
      ...supplierResults,
      ...complaintResults,
    ];
  }

  private normalizeSearchText(value: string): string {
    return toLatinDigits(String(value || ''))
      .normalize('NFKC')
      .replace(/[ً-ٰٟؐ-ؚ]/g, '')
      .replace(/[آأإ]/g, 'ا')
      .replace(/ى/g, 'ي')
      .replace(/ـ/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private tokenizeQuery(query: string): string[] {
    const n = this.normalizeSearchText(query);
    if (!n) return [];
    return n.split(/\s+/).filter((t) => t.length > 0);
  }

  /** تطبيع وتقطيع الحقول مرة واحدة قبل الدوران على الكلمات */
  private prepFields(fields: WeightedField[]): PreppedField[] {
    const out: PreppedField[] = [];
    for (const f of fields) {
      const v = this.normalizeSearchText(
        Array.isArray(f.v) ? f.v.join(' ') : String(f.v ?? ''),
      );
      if (!v) continue;
      out.push({
        v,
        w: f.w,
        primary: !!f.primary,
        words: v.split(WORD_SPLIT).filter(Boolean),
      });
    }
    return out;
  }

  /**
   * درجة صلة عنصر واحد. تُعيد 0 إذا لم تطابق **كل** كلمات الاستعلام —
   * وهي نفس دلالة الـ AND التي كانت في `matchesTokens`، فالاسترجاع لم يتغيّر،
   * ما تغيّر هو الترتيب.
   */
  private scoreFields(fields: WeightedField[], ctx: ScoreCtx): number {
    const { tokens, phrase, fuzzy } = ctx;
    if (!tokens.length) return 0;
    const prepped = this.prepFields(fields);
    if (!prepped.length) return 0;

    let sum = 0;
    for (const tok of tokens) {
      let best = 0;
      for (const f of prepped) {
        const s = tokenFieldScore(f, tok) * f.w;
        if (s > best) best = s;
      }
      if (!best && fuzzy) {
        for (const f of prepped) {
          const s = fuzzyTokenScore(f, tok) * f.w;
          if (s > best) best = s;
        }
      }
      if (!best) return 0; // كلمة لم تطابق أي حقل ⇒ العنصر غير مطابق
      sum += best;
    }

    let score = sum / tokens.length;
    if (tokens.length > 1) {
      for (const f of prepped) {
        if (f.v.includes(phrase)) {
          score += PHRASE_BONUS * f.w;
          break;
        }
      }
    }
    for (const f of prepped) {
      if (f.primary && f.v === phrase) {
        score += EXACT_FIELD_BONUS;
        break;
      }
    }
    return score;
  }

  private typePrior(type: string, ctx: ScoreCtx): number {
    return (
      (ctx.numeric ? TYPE_PRIOR_NUMERIC[type] : TYPE_PRIOR_TEXT[type]) || 0
    );
  }

  /** ترتيب تنازلي بالدرجة ثم قصّ إلى الحد الأقصى — يستبدل الـ break المبكر */
  private topN(items: SearchResultItem[]): SearchResultItem[] {
    return items
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, MAX_RESULTS_PER_CATEGORY);
  }

  private orderItem(
    tx: Record<string, any>,
    score: number,
    meta?: string,
  ): SearchResultItem {
    return {
      id: String(tx._id),
      type: 'order',
      title: `#${tx.ref || String(tx._id).slice(-6)}`,
      subtitle: `${tx.type} — ${tx.client || ''}`,
      icon: orderIcon(tx.type),
      meta: meta ?? `${tx.total} ج — ${tx.payStatus}`,
      total: tx.total,
      itemsCount: Array.isArray(tx.items) ? tx.items.length : 0,
      createdAt: tx.createdAt,
      payStatus: tx.payStatus,
      bostaStatusLabel: tx.bostaStatusLabel || '',
      // عدد مرات الشحن السابقة. لازم يوصل للواجهة لأن إعادة الشحن بتفضّي
      // `bostaStatusLabel` (بوليصة جديدة لسه ما اتبعتتش)، فنتيجة البحث كانت
      // بتقرا «لم تُشحن» على طلب اتشحن ورجع — وده عكس الحقيقة مش مجرد نقص.
      shipmentAttempts: Array.isArray(tx.shipmentAttempts) ? tx.shipmentAttempts.length : 0,
      score,
    };
  }

  /** الحقول القابلة للبحث في حركة، مع أوزانها */
  private orderFields(tx: Record<string, any>): WeightedField[] {
    return [
      { v: tx.ref, w: 1, primary: true },
      { v: tx.bostaTrackingNumber, w: 0.9, primary: true },
      { v: tx.client, w: 0.85 },
      { v: tx.phone, w: 0.85, primary: true },
      { v: tx.notes, w: 0.35 },
      { v: tx.type, w: 0.3 },
      { v: tx.total, w: 0.3 },
    ];
  }

  // ── بحث رقمي: ref يبدأ بـ أو يساوي ──────────────────────────────
  private async searchOrdersByRef(
    ref: string,
    ctx: ScoreCtx,
  ): Promise<SearchResultItem[]> {
    const transactions = await this.transactionModel
      .find({ ...TX_ACTIVE_FILTER, ref: { $regex: `^${escapeRegex(ref)}`, $options: 'i' } })
      .select(
        'ref client phone type total payStatus items createdAt bostaStatusLabel bostaTrackingNumber shipmentAttempts notes',
      )
      .sort({ ref: 1 })
      .limit(200)
      .lean()
      .exec();

    return this.topN(
      transactions.map((tx: any) =>
        this.orderItem(
          tx,
          this.scoreFields(this.orderFields(tx), ctx) +
            this.typePrior('order', ctx) +
            recencyBoost(tx.createdAt),
        ),
      ),
    );
  }

  // ── بحث رقمي: رقم تتبع بوسطة (Bosta tracking number) ──────────────
  private async searchOrdersByTracking(
    trackingNo: string,
    ctx: ScoreCtx,
  ): Promise<SearchResultItem[]> {
    const transactions = await this.transactionModel
      .find({
        ...TX_ACTIVE_FILTER,
        bostaTrackingNumber: { $regex: `^${escapeRegex(trackingNo)}`, $options: 'i' },
      })
      .select(
        'ref client phone type total payStatus items createdAt bostaStatusLabel bostaTrackingNumber shipmentAttempts notes',
      )
      .sort({ createdAt: -1 })
      .limit(200)
      .lean()
      .exec();

    return this.topN(
      transactions.map((tx: any) =>
        this.orderItem(
          tx,
          this.scoreFields(this.orderFields(tx), ctx) +
            this.typePrior('order', ctx) +
            recencyBoost(tx.createdAt),
          `تتبع: ${tx.bostaTrackingNumber} — ${tx.total} ج`,
        ),
      ),
    );
  }

  // ── بحث رقمي: أوردرات Shopify غير المسجلة/الملغية (لا تظهر كحركة بعد) ──
  private async searchShopifyOrdersByRef(
    ref: string,
    ctx: ScoreCtx,
  ): Promise<SearchResultItem[]> {
    const orders = await this.shopifyOrderModel
      .find({
        ref: { $regex: `^#?${escapeRegex(ref)}`, $options: 'i' },
        status: { $ne: 'approved' },
      })
      .select('ref client phone total status cancelled items createdAt')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean()
      .exec();

    return this.topN(
      orders.map((o: any) => {
        const statusLabel = o.cancelled
          ? 'ملغي'
          : o.status === 'rejected'
            ? 'مرفوض'
            : 'في انتظار التسجيل';
        const score =
          this.scoreFields(
            [
              { v: String(o.ref || '').replace(/^#+/, ''), w: 1, primary: true },
              { v: o.client, w: 0.85 },
              { v: o.phone, w: 0.85, primary: true },
              { v: o.total, w: 0.3 },
            ],
            ctx,
          ) +
          this.typePrior('shopify_order', ctx) +
          recencyBoost(o.createdAt);
        return {
          id: String(o._id),
          type: 'shopify_order' as const,
          title: `#${String(o.ref || '').replace(/^#+/, '')}`,
          subtitle: `Shopify — ${o.client || ''}`,
          icon: '🛍️',
          meta: `${o.total} ج — ${statusLabel}`,
          total: o.total,
          itemsCount: Array.isArray(o.items) ? o.items.length : 0,
          createdAt: o.createdAt,
          shopifyStatus: statusLabel,
          shopifyCancelled: !!o.cancelled,
          score,
        };
      }),
    );
  }

  // ── بحث رقمي: هاتف يحتوي على الرقم ──────────────────────────────
  private async searchOrdersByPhone(
    phone: string,
    ctx: ScoreCtx,
  ): Promise<SearchResultItem[]> {
    const transactions = await this.transactionModel
      .find({ ...TX_ACTIVE_FILTER, phone: { $regex: escapeRegex(phone), $options: 'i' } })
      .select(
        'ref client phone type total payStatus items createdAt bostaStatusLabel bostaTrackingNumber shipmentAttempts notes',
      )
      .sort({ createdAt: -1 })
      .limit(300)
      .lean()
      .exec();

    return this.topN(
      transactions.map((tx: any) =>
        this.orderItem(
          tx,
          this.scoreFields(this.orderFields(tx), ctx) +
            this.typePrior('order', ctx) +
            recencyBoost(tx.createdAt),
        ),
      ),
    );
  }

  // ── بحث رقمي: عملاء بالهاتف ──────────────────────────────────────
  private async searchCustomersByPhone(
    phone: string,
    ctx: ScoreCtx,
  ): Promise<SearchResultItem[]> {
    const transactions = await this.transactionModel
      .find({ ...TX_ACTIVE_FILTER, phone: { $regex: escapeRegex(phone), $options: 'i' } })
      .select('client phone total')
      .limit(2500)
      .lean()
      .exec();
    return this.aggregateCustomers(transactions, ctx, false);
  }

  private async searchSuppliersByPhone(
    phone: string,
    ctx: ScoreCtx,
  ): Promise<SearchResultItem[]> {
    const suppliers = await this.supplierModel
      .find({ phone: { $regex: escapeRegex(phone), $options: 'i' } })
      .select('name phone address email products notes')
      .limit(300)
      .lean()
      .exec();

    // الفلترة تمت في الاستعلام نفسه، فلا نشترط درجة مطابقة نصية هنا
    return this.topN(
      suppliers.map((s: any) =>
        this.supplierItem(s, this.supplierBaseScore(s, ctx), ctx),
      ),
    );
  }

  // ── بحث نصي ──────────────────────────────────────────────────────
  private async searchProducts(
    query: string,
    ctx: ScoreCtx,
  ): Promise<SearchResultItem[]> {
    if (!ctx.tokens.length) return [];
    const products = await this.productModel
      .find()
      .select(
        'name code supplier sellPrice buyPrice imageUrl isActive colors features material pattern',
      )
      .limit(3000)
      .lean()
      .exec();

    const out: SearchResultItem[] = [];
    for (const p of products as any[]) {
      const base = this.scoreFields(
        [
          { v: p.name, w: 1, primary: true },
          { v: p.code, w: 0.95, primary: true },
          { v: p.supplier, w: 0.45 },
          { v: p.colors, w: 0.3 },
          // مثل الألوان: وزن منخفض حتى لا يزاحم مطابقة الاسم/الكود، لكنه يجعل
          // البحث بـ "waterproof" يصل إلى الأصناف المقاومة للماء.
          { v: p.features, w: 0.28 },
          { v: p.material, w: 0.25 },
          { v: p.pattern, w: 0.25 },
        ],
        ctx,
      );
      if (!base) continue;
      out.push({
        id: String(p._id),
        type: 'product',
        title: p.name,
        subtitle: `كود: ${p.code}`,
        icon: '🏷️',
        meta: `بيع: ${p.sellPrice} | شراء: ${p.buyPrice}`,
        imageUrl: p.imageUrl || '',
        // الأصناف الموقوفة تنزل قليلاً — لا تُخفى، فقد تكون هي المقصودة
        score:
          base + this.typePrior('product', ctx) + (p.isActive === false ? -8 : 0),
      });
    }
    return this.topN(out);
  }

  private async searchOrdersByText(
    query: string,
    ctx: ScoreCtx,
  ): Promise<SearchResultItem[]> {
    if (!ctx.tokens.length) return [];
    const transactions = await this.transactionModel
      .find(TX_ACTIVE_FILTER)
      .select(
        'ref client phone type total payStatus notes items createdAt bostaStatusLabel bostaTrackingNumber shipmentAttempts',
      )
      .sort({ createdAt: -1 })
      .limit(2000)
      .lean()
      .exec();

    const out: SearchResultItem[] = [];
    for (const tx of transactions as any[]) {
      const base = this.scoreFields(this.orderFields(tx), ctx);
      if (!base) continue;
      out.push(
        this.orderItem(
          tx,
          base + this.typePrior('order', ctx) + recencyBoost(tx.createdAt),
        ),
      );
    }
    return this.topN(out);
  }

  private async searchCustomersByText(
    query: string,
    ctx: ScoreCtx,
  ): Promise<SearchResultItem[]> {
    if (!ctx.tokens.length) return [];
    const transactions = await this.transactionModel
      .find(TX_ACTIVE_FILTER)
      .select('client phone total')
      .limit(2500)
      .lean()
      .exec();
    return this.aggregateCustomers(transactions, ctx, true);
  }

  /**
   * العملاء ليسوا مجموعة مستقلة — يُشتقّون من الحركات. نجمّع أولاً ثم نسجّل
   * مرة واحدة لكل عميل، فالتسجيل على مستوى الحركة كان سيكرّر نفس الاسم.
   */
  private aggregateCustomers(
    transactions: any[],
    ctx: ScoreCtx,
    requireTokens: boolean,
  ): SearchResultItem[] {
    const clientMap = new Map<
      string,
      { name: string; phone: string; orders: number; total: number }
    >();
    for (const tx of transactions) {
      if (!tx.client) continue;
      const existing = clientMap.get(tx.client);
      if (existing) {
        existing.orders++;
        existing.total += tx.total || 0;
        if (!existing.phone && tx.phone) existing.phone = tx.phone;
      } else {
        clientMap.set(tx.client, {
          name: tx.client,
          phone: tx.phone || '',
          orders: 1,
          total: tx.total || 0,
        });
      }
    }

    const out: SearchResultItem[] = [];
    for (const c of clientMap.values()) {
      const base = this.scoreFields(
        [
          { v: c.name, w: 1, primary: true },
          { v: c.phone, w: 0.9, primary: true },
        ],
        ctx,
      );
      // في بحث الهاتف الفلترة تمت في الاستعلام نفسه، فلا نشترط مطابقة نصية
      if (requireTokens && !base) continue;
      out.push({
        id: c.name,
        type: 'customer',
        title: c.name,
        subtitle: c.phone || 'بدون رقم',
        icon: '👥',
        meta: `${c.orders} معاملة | ${c.total} ج`,
        // العميل الأكثر تعاملاً هو الأرجح — دفعة صغيرة تفكّ التعادل بين متشابهي الاسم
        score:
          base +
          this.typePrior('customer', ctx) +
          Math.min(6, Math.log1p(c.orders) * 2.2),
      });
    }
    return this.topN(out);
  }

  private async searchComplaintsByText(
    query: string,
    ctx: ScoreCtx,
  ): Promise<SearchResultItem[]> {
    if (!ctx.tokens.length) return [];
    const complaints = await this.complaintModel
      .find()
      .select(
        'complaintNo clientName phone submittedBy transactionRef productName productCode status priority createdAt',
      )
      .sort({ createdAt: -1 })
      .limit(2000)
      .lean()
      .exec();

    const out: SearchResultItem[] = [];
    for (const c of complaints as any[]) {
      const base = this.scoreFields(
        [
          { v: c.complaintNo, w: 1, primary: true },
          { v: String(c.transactionRef || '').replace(/^#+/, ''), w: 0.8, primary: true },
          { v: c.phone, w: 0.8, primary: true },
          { v: c.clientName, w: 0.7 },
          { v: c.productName, w: 0.5 },
          { v: c.productCode, w: 0.5 },
          { v: c.submittedBy, w: 0.4 },
          { v: c.status, w: 0.25 },
        ],
        ctx,
      );
      if (!base) continue;
      out.push({
        id: String(c._id),
        type: 'complaint',
        title: c.complaintNo,
        subtitle: `${c.clientName || c.submittedBy || ''} — ${c.status}`,
        icon: '📮',
        meta: c.transactionRef ? `الطلب: ${c.transactionRef}` : '',
        score:
          base + this.typePrior('complaint', ctx) + recencyBoost(c.createdAt),
      });
    }
    return this.topN(out);
  }

  private supplierBaseScore(s: any, ctx: ScoreCtx): number {
    return this.scoreFields(
      [
        { v: s.name, w: 1, primary: true },
        { v: s.phone, w: 0.85, primary: true },
        { v: s.email, w: 0.5 },
        { v: s.products, w: 0.45 },
        { v: s.address, w: 0.3 },
        { v: s.notes, w: 0.2 },
      ],
      ctx,
    );
  }

  private supplierItem(s: any, base: number, ctx: ScoreCtx): SearchResultItem {
    return {
      id: String(s._id),
      type: 'supplier',
      title: s.name,
      subtitle: s.phone || 'بدون رقم',
      icon: '🚚',
      meta: s.address || s.email || '',
      score: base + this.typePrior('supplier', ctx),
    };
  }

  private async searchSuppliers(
    query: string,
    ctx: ScoreCtx,
  ): Promise<SearchResultItem[]> {
    if (!ctx.tokens.length) return [];
    const suppliers = await this.supplierModel
      .find()
      .select('name phone address email products notes')
      .limit(2000)
      .lean()
      .exec();

    const out: SearchResultItem[] = [];
    for (const s of suppliers as any[]) {
      const base = this.supplierBaseScore(s, ctx);
      if (!base) continue;
      out.push(this.supplierItem(s, base, ctx));
    }
    return this.topN(out);
  }
}
