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
import { SearchResultItem, SearchResponse } from './dto/search.dto';

const MAX_RESULTS_PER_CATEGORY = 50;
const TX_ACTIVE_FILTER = { cancelled: { $ne: true } };

/** هل الإدخال أرقام فقط؟ */
function isNumericOnly(q: string): boolean {
  return /^\d+$/.test(q.trim());
}

/** هل يبدأ الإدخال بـ 01 (رقم هاتف مصري)؟ */
function isPhoneNumber(q: string): boolean {
  return /^01/.test(q.trim());
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
  ) {}

  async search(query: string): Promise<SearchResponse> {
    const raw = query.trim();
    const trimmed = raw.replace(/^#+/, '').trim();
    if (!trimmed) {
      return { results: [], total: 0 };
    }

    const numeric = isNumericOnly(trimmed);
    const isPhone = isPhoneNumber(trimmed);
    const numLen = trimmed.length;

    let products: SearchResultItem[] = [];
    let orders: SearchResultItem[] = [];
    let customers: SearchResultItem[] = [];
    let supplierResults: SearchResultItem[] = [];

    if (isPhone) {
      // يبدأ بـ 01 → رقم هاتف بالتأكيد: عملاء وموردون أولاً، الحركات تبعاً
      [customers, supplierResults, orders] = await Promise.all([
        this.searchCustomersByPhone(trimmed),
        this.searchSuppliersByPhone(trimmed),
        this.searchOrdersByPhone(trimmed),
      ]);
    } else if (numeric) {
      // أرقام قصيرة (1-6): رقم مرجع أوردر أولاً
      // أرقام طويلة (7+): هاتف أولاً ثم أوردر
      if (numLen <= 6) {
        [orders, customers, supplierResults] = await Promise.all([
          this.searchOrdersByRef(trimmed),
          this.searchCustomersByPhone(trimmed),
          this.searchSuppliersByPhone(trimmed),
        ]);
      } else {
        [customers, orders, supplierResults] = await Promise.all([
          this.searchCustomersByPhone(trimmed),
          this.searchOrdersByPhone(trimmed),
          this.searchSuppliersByPhone(trimmed),
        ]);
      }
    } else {
      // نص: بحث عام في الاسم
      [products, orders, customers, supplierResults] = await Promise.all([
        this.searchProducts(trimmed),
        this.searchOrdersByText(trimmed),
        this.searchCustomersByText(trimmed),
        this.searchSuppliers(trimmed),
      ]);
    }

    const results = [...products, ...customers, ...supplierResults, ...orders];
    return { results, total: results.length };
  }

  private normalizeSearchText(value: string): string {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[ً-ٰٟؐ-ؚ]/g, '')
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

  private matchesTokens(blob: string, tokens: string[]): boolean {
    if (!tokens.length) return false;
    const norm = this.normalizeSearchText(blob);
    return tokens.every((t) => norm.includes(t));
  }

  // ── بحث رقمي: ref يبدأ بـ أو يساوي ──────────────────────────────
  private async searchOrdersByRef(ref: string): Promise<SearchResultItem[]> {
    const transactions = await this.transactionModel
      .find({ ...TX_ACTIVE_FILTER, ref: { $regex: `^${ref}`, $options: 'i' } })
      .select('ref client phone type total payStatus')
      .sort({ ref: 1 })
      .limit(MAX_RESULTS_PER_CATEGORY)
      .lean()
      .exec();

    // الأوردر المطابق تماماً يأتي أولاً
    transactions.sort((a, b) => {
      const aExact = String(a.ref) === ref ? 0 : 1;
      const bExact = String(b.ref) === ref ? 0 : 1;
      return aExact - bExact;
    });

    return transactions.map((tx) => ({
      id: String(tx._id),
      type: 'order' as const,
      title: `#${tx.ref || String(tx._id).slice(-6)}`,
      subtitle: `${tx.type} — ${tx.client || ''}`,
      icon: '📋',
      meta: `${tx.total} ج — ${tx.payStatus}`,
    }));
  }

  // ── بحث رقمي: هاتف يحتوي على الرقم ──────────────────────────────
  private async searchOrdersByPhone(phone: string): Promise<SearchResultItem[]> {
    const transactions = await this.transactionModel
      .find({ ...TX_ACTIVE_FILTER, phone: { $regex: phone, $options: 'i' } })
      .select('ref client phone type total payStatus')
      .sort({ createdAt: -1 })
      .limit(MAX_RESULTS_PER_CATEGORY)
      .lean()
      .exec();

    return transactions.map((tx) => ({
      id: String(tx._id),
      type: 'order' as const,
      title: `#${tx.ref || String(tx._id).slice(-6)}`,
      subtitle: `${tx.type} — ${tx.client || ''}`,
      icon: '📋',
      meta: `${tx.total} ج — ${tx.payStatus}`,
    }));
  }

  // ── بحث رقمي: عملاء بالهاتف ──────────────────────────────────────
  private async searchCustomersByPhone(phone: string): Promise<SearchResultItem[]> {
    const transactions = await this.transactionModel
      .find({ ...TX_ACTIVE_FILTER, phone: { $regex: phone, $options: 'i' } })
      .select('client phone total')
      .limit(2500)
      .lean()
      .exec();

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

    return Array.from(clientMap.values())
      .sort((a, b) => b.orders - a.orders)
      .slice(0, MAX_RESULTS_PER_CATEGORY)
      .map((c) => ({
        id: c.name,
        type: 'customer' as const,
        title: c.name,
        subtitle: c.phone || 'بدون رقم',
        icon: '👥',
        meta: `${c.orders} حركة | ${c.total} ج`,
      }));
  }

  private async searchSuppliersByPhone(phone: string): Promise<SearchResultItem[]> {
    const suppliers = await this.supplierModel
      .find({ phone: { $regex: phone, $options: 'i' } })
      .select('name phone address')
      .limit(MAX_RESULTS_PER_CATEGORY)
      .lean()
      .exec();

    return suppliers.map((s) => ({
      id: String(s._id),
      type: 'supplier' as const,
      title: s.name,
      subtitle: s.phone || 'بدون رقم',
      icon: '🚚',
      meta: s.address || '',
    }));
  }

  // ── بحث نصي ──────────────────────────────────────────────────────
  private async searchProducts(query: string): Promise<SearchResultItem[]> {
    const tokens = this.tokenizeQuery(query);
    if (!tokens.length) return [];
    const products = await this.productModel
      .find()
      .select('name code supplier sellPrice buyPrice imageUrl')
      .limit(3000)
      .lean()
      .exec();
    const out: SearchResultItem[] = [];
    for (const p of products) {
      const blob = [p.name, p.code, p.supplier].filter(Boolean).join(' ');
      if (!this.matchesTokens(blob, tokens)) continue;
      out.push({
        id: String(p._id),
        type: 'product',
        title: p.name,
        subtitle: `كود: ${p.code}`,
        icon: '🏷️',
        meta: `بيع: ${p.sellPrice} | شراء: ${p.buyPrice}`,
        imageUrl: p.imageUrl || '',
      });
      if (out.length >= MAX_RESULTS_PER_CATEGORY) break;
    }
    return out;
  }

  private async searchOrdersByText(query: string): Promise<SearchResultItem[]> {
    const tokens = this.tokenizeQuery(query);
    if (!tokens.length) return [];
    const transactions = await this.transactionModel
      .find(TX_ACTIVE_FILTER)
      .select('ref client phone type total payStatus notes')
      .sort({ createdAt: -1 })
      .limit(2000)
      .lean()
      .exec();
    const out: SearchResultItem[] = [];
    for (const tx of transactions) {
      const blob = [tx.ref, tx.client, tx.phone, tx.notes, tx.type, String(tx.total ?? '')]
        .filter(Boolean)
        .join(' ');
      if (!this.matchesTokens(blob, tokens)) continue;
      out.push({
        id: String(tx._id),
        type: 'order' as const,
        title: `#${tx.ref || String(tx._id).slice(-6)}`,
        subtitle: `${tx.type} — ${tx.client || ''}`,
        icon: '📋',
        meta: `${tx.total} ج — ${tx.payStatus}`,
      });
      if (out.length >= MAX_RESULTS_PER_CATEGORY) break;
    }
    return out;
  }

  private async searchCustomersByText(query: string): Promise<SearchResultItem[]> {
    const tokens = this.tokenizeQuery(query);
    if (!tokens.length) return [];
    const transactions = await this.transactionModel
      .find(TX_ACTIVE_FILTER)
      .select('client phone total')
      .limit(2500)
      .lean()
      .exec();
    const clientMap = new Map<
      string,
      { name: string; phone: string; orders: number; total: number }
    >();
    for (const tx of transactions) {
      if (!tx.client) continue;
      const blob = [tx.client, tx.phone].filter(Boolean).join(' ');
      if (!this.matchesTokens(blob, tokens)) continue;
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
    return Array.from(clientMap.values())
      .sort((a, b) => b.orders - a.orders)
      .slice(0, MAX_RESULTS_PER_CATEGORY)
      .map((c) => ({
        id: c.name,
        type: 'customer' as const,
        title: c.name,
        subtitle: c.phone || 'بدون رقم',
        icon: '👥',
        meta: `${c.orders} حركة | ${c.total} ج`,
      }));
  }

  private async searchSuppliers(query: string): Promise<SearchResultItem[]> {
    const tokens = this.tokenizeQuery(query);
    if (!tokens.length) return [];
    const suppliers = await this.supplierModel
      .find()
      .select('name phone address email products notes')
      .limit(2000)
      .lean()
      .exec();
    const out: SearchResultItem[] = [];
    for (const s of suppliers) {
      const blob = [s.name, s.phone, s.address, s.email, s.products, s.notes]
        .filter(Boolean)
        .join(' ');
      if (!this.matchesTokens(blob, tokens)) continue;
      out.push({
        id: String(s._id),
        type: 'supplier' as const,
        title: s.name,
        subtitle: s.phone || 'بدون رقم',
        icon: '🚚',
        meta: s.address || s.email || '',
      });
      if (out.length >= MAX_RESULTS_PER_CATEGORY) break;
    }
    return out;
  }
}
