/**
 * Product Analytics Service
 * Comprehensive product performance analysis and invoice tracking
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product, ProductDocument } from './schemas/product.schema';
import { Transaction, TransactionDocument } from '../transactions/schemas/transaction.schema';

export interface ProductInvoice {
  type: 'sales' | 'purchase' | 'return';
  ref: string;
  date: string;
  client: string;
  phone?: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  discountShare: number;
  netTotal: number;
  status: string;
}

export interface ProductPerformance {
  rank: 'Successful' | 'Average' | 'Low-performing';
  reason: string;
  score: number;
}

export interface ProductAnalytics {
  product: {
    code: string;
    name: string;
    sellPrice: number;
    buyPrice: number;
    minStock: number;
    supplier?: string;
  };
  summary: {
    totalSaleInvoices: number;
    totalPurchaseInvoices: number;
    totalReturnInvoices: number;
    totalQuantitySold: number;
    totalQuantityPurchased: number;
    totalQuantityReturned: number;
    totalRevenueFromSales: number;
    totalCostFromPurchases: number;
    totalLossFromReturns: number;
    totalDiscounts: number;
    netRevenue: number;
    netQuantitySold: number;
    avgBuyPrice: number;
    netProfit: number;
    profitMargin: number;
  };
  performance: ProductPerformance;
  invoices: {
    sales: ProductInvoice[];
    purchases: ProductInvoice[];
    returns: ProductInvoice[];
  };
}

@Injectable()
export class ProductAnalyticsService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
  ) {}

  /**
   * Get comprehensive analytics for a specific product
   */
  async getProductAnalytics(
    productCodeOrName: string,
  ): Promise<ProductAnalytics> {
    const searchStr = String(productCodeOrName || '').trim();
    if (!searchStr) {
      throw new NotFoundException('رمز أو اسم المنتج مفقود');
    }

    // Find product by code or name
    const product = await this.productModel
      .findOne({
        $or: [
          { code: { $regex: searchStr, $options: 'i' } },
          { name: { $regex: searchStr, $options: 'i' } },
        ],
      })
      .exec();

    if (!product) {
      throw new NotFoundException(`المنتج "${searchStr}" غير موجود`);
    }

    // Get all transactions containing this product
    const transactions = await this.transactionModel
      .find({
        'items.code': product.code,
        cancelled: { $ne: true },
        archived: { $ne: true },
      })
      .exec();

    // Separate invoices by type
    const saleInvoices: ProductInvoice[] = [];
    const purchaseInvoices: ProductInvoice[] = [];
    const returnInvoices: ProductInvoice[] = [];

    // Process transactions
    transactions.forEach((tx) => {
      const item = (tx.items || []).find(
        (it) => String(it.code || '').trim() === String(product.code).trim(),
      );

      if (!item) return;

      let invoiceType: 'sales' | 'purchase' | 'return' = 'sales';

      if (tx.type === 'مشتريات') {
        invoiceType = 'purchase';
      } else if (tx.type === 'مرتجع' || tx.type === 'مرتجع مبيعات') {
        invoiceType = 'return';
      }

      const itemTotal = item.total || 0;
      const txItemsTotal = (tx.itemsTotal || 0) || (tx.items || []).reduce((s, i) => s + (i.total || 0), 0);
      const txDiscount = tx.discount || 0;
      // Distribute discount proportionally by item share of invoice total
      const discountShare = txItemsTotal > 0 ? (itemTotal / txItemsTotal) * txDiscount : 0;
      const netTotal = itemTotal - discountShare;

      const invoice: ProductInvoice = {
        type: invoiceType,
        ref: tx.ref || tx._id.toString().slice(-8),
        date: tx.date || new Date().toISOString().split('T')[0],
        client: tx.client || 'Unknown',
        phone: tx.phone,
        quantity: item.qty || 0,
        unitPrice: item.price || 0,
        totalPrice: itemTotal,
        discountShare,
        netTotal,
        status: tx.payStatus || 'pending',
      };

      if (invoiceType === 'sales') {
        saleInvoices.push(invoice);
      } else if (invoiceType === 'purchase') {
        purchaseInvoices.push(invoice);
      } else if (invoiceType === 'return') {
        returnInvoices.push(invoice);
      }
    });

    // Calculate summary metrics (use netTotal which already has discount deducted)
    const totalQuantitySold = saleInvoices.reduce((sum, inv) => sum + inv.quantity, 0);
    const totalQuantityPurchased = purchaseInvoices.reduce((sum, inv) => sum + inv.quantity, 0);
    const totalQuantityReturned = returnInvoices.reduce((sum, inv) => sum + inv.quantity, 0);
    const totalRevenueFromSales = saleInvoices.reduce((sum, inv) => sum + inv.netTotal, 0);
    const totalCostFromPurchases = purchaseInvoices.reduce((sum, inv) => sum + inv.netTotal, 0);
    const totalLossFromReturns = returnInvoices.reduce((sum, inv) => sum + inv.netTotal, 0);
    const totalDiscounts = saleInvoices.reduce((sum, inv) => sum + inv.discountShare, 0);

    // Net figures after accounting for returns
    const netQuantitySold = Math.max(0, totalQuantitySold - totalQuantityReturned);
    const netRevenue = Math.max(0, totalRevenueFromSales - totalLossFromReturns);

    // Use avg buy price from actual purchase invoices when available, fallback to product.buyPrice
    const avgBuyPrice =
      totalQuantityPurchased > 0
        ? totalCostFromPurchases / totalQuantityPurchased
        : product.buyPrice || 0;
    const netCost = netQuantitySold * avgBuyPrice;
    const netProfit = netRevenue - netCost;

    const profitMargin =
      netRevenue > 0
        ? Math.round((netProfit / netRevenue) * 100)
        : 0;

    // Calculate performance
    const performance = this.calculatePerformance(
      totalQuantitySold,
      totalQuantityReturned,
      totalRevenueFromSales,
    );

    return {
      product: {
        code: product.code,
        name: product.name,
        sellPrice: product.sellPrice || 0,
        buyPrice: product.buyPrice || 0,
        minStock: product.minStock || 10,
        supplier: product.supplier,
      },
      summary: {
        totalSaleInvoices: saleInvoices.length,
        totalPurchaseInvoices: purchaseInvoices.length,
        totalReturnInvoices: returnInvoices.length,
        totalQuantitySold,
        totalQuantityPurchased,
        totalQuantityReturned,
        totalRevenueFromSales,
        totalCostFromPurchases,
        totalLossFromReturns,
        totalDiscounts,
        netRevenue,
        netQuantitySold,
        avgBuyPrice,
        netProfit,
        profitMargin,
      },
      performance,
      invoices: {
        sales: saleInvoices.sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        ),
        purchases: purchaseInvoices.sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        ),
        returns: returnInvoices.sort(
          (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
        ),
      },
    };
  }

  /**
   * Search products by code or name
   */
  async searchProducts(partial: string, limit = 10): Promise<Array<{ code: string; name: string }>> {
    const partialStr = String(partial || '').trim();
    if (!partialStr) return [];

    const products = await this.productModel
      .find({
        $or: [
          { code: { $regex: partialStr, $options: 'i' } },
          { name: { $regex: partialStr, $options: 'i' } },
        ],
      })
      .limit(limit)
      .exec();

    return products.map((p) => ({
      code: p.code,
      name: p.name,
    }));
  }

  /**
   * Determine product performance ranking
   */
  private calculatePerformance(
    quantitySold: number,
    quantityReturned: number,
    totalRevenue: number,
  ): ProductPerformance {
    if (quantitySold === 0) {
      return {
        rank: 'Low-performing',
        reason: 'لم يتم بيع هذا المنتج مطلقاً',
        score: 0,
      };
    }

    const returnRate = quantityReturned / quantitySold;
    const score = Math.round((1 - returnRate) * 100);

    if (quantitySold >= 10 && returnRate < 0.1) {
      return {
        rank: 'Successful',
        reason: `معدل مرتجعات منخفض (${Math.round(returnRate * 100)}%) مع مبيعات قوية`,
        score,
      };
    } else if (quantitySold >= 5 && returnRate < 0.2) {
      return {
        rank: 'Average',
        reason: `معدل مرتجعات متوسط (${Math.round(returnRate * 100)}%) مع مبيعات معقولة`,
        score,
      };
    } else {
      return {
        rank: 'Low-performing',
        reason: `معدل مرتجعات مرتفع (${Math.round(returnRate * 100)}%) أو مبيعات منخفضة`,
        score,
      };
    }
  }
}
