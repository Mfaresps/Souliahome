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

/** حد أعلى لكل فئة — القائمة قابلة للتمرير في الواجهة */
const MAX_RESULTS_PER_CATEGORY = 50;

const TX_ACTIVE_FILTER = { cancelled: { $ne: true } };

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
    const trimmed = query.trim().replace(/^#+/, '').trim();
    if (!trimmed) {
      return { results: [], total: 0 };
    }
    const [products, orders, customers, supplierResults] = await Promise.all([
      this.searchProducts(trimmed),
      this.searchOrders(trimmed),
      this.searchCustomers(trimmed),
      this.searchSuppliers(trimmed),
    ]);
    const results = [...products, ...customers, ...orders, ...supplierResults];
    return { results, total: results.length };
  }

  private normalizeSearchText(value: string): string {
    return String(value || '')
      .normalize('NFKC')
      .replace(/[\u064B-\u065F\u0670\u0610-\u061A]/g, '')
      .replace(/[\u0622\u0623\u0625]/g, '\u0627')
      .replace(/\u0649/g, '\u064A')
      .replace(/\u0640/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private tokenizeQuery(query: string): string[] {
    const n = this.normalizeSearchText(query);
    if (!n) {
      return [];
    }
    return n.split(/\s+/).filter((t) => t.length > 0);
  }

  private matchesTokens(blob: string, tokens: string[]): boolean {
    if (!tokens.length) {
      return false;
    }
    const norm = this.normalizeSearchText(blob);
    return tokens.every((t) => norm.includes(t));
  }

  private async searchProducts(query: string): Promise<SearchResultItem[]> {
    const tokens = this.tokenizeQuery(query);
    if (!tokens.length) {
      return [];
    }
    const products = await this.productModel
      .find()
      .select('name code supplier sellPrice buyPrice imageUrl')
      .limit(3000)
      .lean()
      .exec();
    const out: SearchResultItem[] = [];
    for (const p of products) {
      const blob = [p.name, p.code, p.supplier].filter(Boolean).join(' ');
      if (!this.matchesTokens(blob, tokens)) {
        continue;
      }
      out.push({
        id: String(p._id),
        type: 'product',
        title: p.name,
        subtitle: `كود: ${p.code}`,
        icon: '🏷️',
        meta: `بيع: ${p.sellPrice} | شراء: ${p.buyPrice}`,
        imageUrl: p.imageUrl || '',
      });
      if (out.length >= MAX_RESULTS_PER_CATEGORY) {
        break;
      }
    }
    return out;
  }

  private async searchOrders(query: string): Promise<SearchResultItem[]> {
    const tokens = this.tokenizeQuery(query);
    if (!tokens.length) {
      return [];
    }
    const transactions = await this.transactionModel
      .find(TX_ACTIVE_FILTER)
      .select('ref client phone type total payStatus notes')
      .sort({ createdAt: -1 })
      .limit(2000)
      .lean()
      .exec();
    const out: SearchResultItem[] = [];
    for (const tx of transactions) {
      const blob = [
        tx.ref,
        tx.client,
        tx.phone,
        tx.notes,
        tx.type,
        String(tx.total ?? ''),
      ]
        .filter(Boolean)
        .join(' ');
      if (!this.matchesTokens(blob, tokens)) {
        continue;
      }
      out.push({
        id: String(tx._id),
        type: 'order',
        title: `#${tx.ref || String(tx._id).slice(-6)}`,
        subtitle: `${tx.type} — ${tx.client || ''}`,
        icon: '📋',
        meta: `${tx.total} ج — ${tx.payStatus}`,
      });
      if (out.length >= MAX_RESULTS_PER_CATEGORY) {
        break;
      }
    }
    return out;
  }

  private async searchCustomers(query: string): Promise<SearchResultItem[]> {
    const tokens = this.tokenizeQuery(query);
    if (!tokens.length) {
      return [];
    }
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
      if (!tx.client) {
        continue;
      }
      const blob = [tx.client, tx.phone].filter(Boolean).join(' ');
      if (!this.matchesTokens(blob, tokens)) {
        continue;
      }
      const existing = clientMap.get(tx.client);
      if (existing) {
        existing.orders++;
        existing.total += tx.total || 0;
        if (!existing.phone && tx.phone) {
          existing.phone = tx.phone;
        }
      } else {
        clientMap.set(tx.client, {
          name: tx.client,
          phone: tx.phone || '',
          orders: 1,
          total: tx.total || 0,
        });
      }
    }
    const clients = Array.from(clientMap.values()).sort(
      (a, b) => b.orders - a.orders,
    );
    return clients.slice(0, MAX_RESULTS_PER_CATEGORY).map((c) => ({
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
    if (!tokens.length) {
      return [];
    }
    const suppliers = await this.supplierModel
      .find()
      .select('name phone address email products notes')
      .limit(2000)
      .lean()
      .exec();
    const out: SearchResultItem[] = [];
    for (const s of suppliers) {
      const blob = [
        s.name,
        s.phone,
        s.address,
        s.email,
        s.products,
        s.notes,
      ]
        .filter(Boolean)
        .join(' ');
      if (!this.matchesTokens(blob, tokens)) {
        continue;
      }
      out.push({
        id: String(s._id),
        type: 'supplier',
        title: s.name,
        subtitle: s.phone || 'بدون رقم',
        icon: '🚚',
        meta: s.address || s.email || '',
      });
      if (out.length >= MAX_RESULTS_PER_CATEGORY) {
        break;
      }
    }
    return out;
  }
}
