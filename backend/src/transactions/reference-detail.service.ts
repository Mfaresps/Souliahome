/**
 * Reference Detail Service
 * Aggregates all data for a specific reference number
 * Including: transactions, returns, customer details, timeline, etc.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Transaction, TransactionDocument } from './schemas/transaction.schema';
import { ReturnRequest, ReturnRequestDocument } from '../returns/schemas/return-request.schema';

export interface CustomerInfo {
  name: string;
  phone: string;
  type: string;
}

export interface TransactionInfo {
  _id: string;
  type: string;
  date: string;
  total: number;
  deposit: number;
  remaining: number;
  items?: Array<{ name: string; code: string; qty: number; price: number }>;
  status: string;
}

export interface ReturnInfo {
  _id: string;
  requestKind: string;
  status: string;
  total: number;
  exchangeTotal?: number;
  priceDifference?: number;
  approvedAt?: string;
}

export interface SummaryInfo {
  totalSales: number;
  totalReturns: number;
  netAmount: number;
  totalPaid: number;
  totalRemaining: number;
  transactionCount: number;
  returnCount: number;
  shipCost: number;
}

export interface TimelineEvent {
  date: string;
  type: string;
  description: string;
  amount: number;
  status: string;
}

export interface ReferenceDetail {
  ref: string;
  customer: CustomerInfo;
  primaryTransaction: TransactionInfo | null;
  allTransactions: TransactionInfo[];
  relatedReturns: ReturnInfo[];
  summary: SummaryInfo;
  timeline: TimelineEvent[];
}

@Injectable()
export class ReferenceDetailService {
  constructor(
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(ReturnRequest.name)
    private readonly returnModel: Model<ReturnRequestDocument>,
  ) {}

  /**
   * Get comprehensive details for a reference number
   */
  async getDetailsByReference(ref: string): Promise<ReferenceDetail> {
    const refStr = String(ref || '').trim();
    if (!refStr) {
      throw new NotFoundException('الرقم المرجعي مفقود');
    }

    // Find all transactions with this reference
    const transactions = await this.transactionModel
      .find({ ref: refStr })
      .sort({ createdAt: -1 })
      .exec();

    if (!transactions.length) {
      throw new NotFoundException(`لا توجد معاملات برقم مرجعي #${refStr}`);
    }

    // Get primary transaction (first sales or largest)
    const primaryTx = transactions.find((t) => t.type === 'مبيعات') || transactions[0];

    // Get customer info from primary transaction
    const customer = {
      name: primaryTx.client || 'غير معروف',
      phone: primaryTx.phone || '',
      type: primaryTx.type === 'مشتريات' ? 'مورد' : 'عميل',
    };

    // Find related returns using original transaction ID
    const relatedReturns = await this.returnModel
      .find({
        originalRef: refStr,
        status: { $in: ['معلق', 'معتمد', 'مرفوض'] },
      })
      .exec();

    // Calculate summary
    const summary = this.calculateSummary(transactions, relatedReturns);

    // Build timeline
    const timeline = this.buildTimeline(transactions, relatedReturns);

    return {
      ref: refStr,
      customer,
      primaryTransaction: this.formatTransaction(primaryTx),
      allTransactions: transactions.map((t) => ({
        _id: t._id.toString(),
        type: t.type,
        date: t.date || new Date().toISOString().split('T')[0],
        total: t.total || 0,
        deposit: t.deposit || 0,
        remaining: t.remaining || 0,
        status: t.payStatus || 'معلق',
      })),
      relatedReturns: relatedReturns.map((r) => ({
        _id: r._id.toString(),
        requestKind: r.requestKind,
        status: r.status,
        total: r.total || 0,
        exchangeTotal: r.exchangeTotal,
        priceDifference: r.priceDifference,
        approvedAt: r.approvedAt,
      })),
      summary,
      timeline,
    };
  }

  /**
   * Search references by partial number
   */
  async searchReferences(partial: string, limit = 20): Promise<string[]> {
    const partialStr = String(partial || '').trim();
    if (!partialStr) return [];

    const matches = await this.transactionModel
      .find({
        ref: { $regex: `^${this.escapeRegex(partialStr)}`, $options: 'i' },
      })
      .distinct('ref')
      .limit(limit)
      .exec();

    return matches.sort();
  }

  /**
   * Get all references for a customer
   */
  async getCustomerReferences(customerName: string): Promise<string[]> {
    const refs = await this.transactionModel
      .find({
        client: { $regex: customerName, $options: 'i' },
      })
      .distinct('ref')
      .exec();

    return refs.filter((r) => r).sort();
  }

  private formatTransaction(tx: TransactionDocument): TransactionInfo {
    return {
      _id: tx._id.toString(),
      type: tx.type,
      date: tx.date || new Date().toISOString().split('T')[0],
      total: tx.total || 0,
      deposit: tx.deposit || 0,
      remaining: tx.remaining || 0,
      items: (tx.items || []).map((i) => ({
        name: i.name,
        code: i.code,
        qty: i.qty,
        price: i.price,
      })),
      status: tx.payStatus || 'معلق',
    };
  }

  private calculateSummary(txs: TransactionDocument[], returns: ReturnRequestDocument[]) {
    const salesTxs = txs.filter((t) => t.type === 'مبيعات');
    const returnTxs = txs.filter((t) => t.type === 'مرتجع');

    const totalSales = salesTxs.reduce((s, t) => s + (t.total || 0), 0);
    const totalReturns = returnTxs.reduce((s, t) => s + (t.total || 0), 0);
    const totalPaid = salesTxs.reduce((s, t) => s + (t.deposit || 0), 0);
    const totalRemaining = salesTxs.reduce((s, t) => s + (t.remaining || 0), 0);
    const shipCost = salesTxs.reduce((s, t) => s + (t.shipCost || 0), 0);

    return {
      totalSales,
      totalReturns,
      netAmount: totalSales - totalReturns,
      totalPaid,
      totalRemaining,
      transactionCount: txs.length,
      returnCount: returns.length,
      shipCost,
    };
  }

  private buildTimeline(
    txs: TransactionDocument[],
    returns: ReturnRequestDocument[],
  ): TimelineEvent[] {
    const events: TimelineEvent[] = [];

    // Transaction events
    txs.forEach((tx) => {
      events.push({
        date: tx.date || new Date().toISOString().split('T')[0],
        type: tx.type,
        description: `${tx.type} بقيمة ${tx.total} ج`,
        amount: tx.total || 0,
        status: tx.payStatus || 'معلق',
      });
    });

    // Return events
    returns.forEach((ret) => {
      const retDoc = ret as any;
      events.push({
        date: retDoc.createdAt?.toISOString?.().split('T')[0] || new Date().toISOString().split('T')[0],
        type: ret.requestKind === 'exchange' ? 'استبدال' : 'مرتجع',
        description: `${ret.requestKind === 'exchange' ? 'استبدال' : 'مرتجع'} — ${ret.status}`,
        amount: ret.total || 0,
        status: ret.status,
      });
    });

    return events.sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
    );
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
