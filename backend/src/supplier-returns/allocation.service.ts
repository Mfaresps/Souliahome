import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SupplierReturnOrder,
  SupplierReturnOrderDocument,
  SrAllocationDetail,
} from './schemas/supplier-return.schema';
import { TransactionsService } from '../transactions/transactions.service';

interface PurchaseLine {
  transactionId: string;
  ref: string;
  date: string;
  qty: number;
  price: number;
}

export interface AllocationResult {
  allocations: SrAllocationDetail[];
  blendedUnitPrice: number;
  totalAllocatedQty: number;
}

@Injectable()
export class SrAllocationService {
  constructor(
    @InjectModel(SupplierReturnOrder.name)
    private readonly srModel: Model<SupplierReturnOrderDocument>,
    private readonly transactionsService: TransactionsService,
  ) {}

  /** Loads purchase history for supplier+code, oldest-first, flattened to one row per matching line. */
  private async loadPurchaseHistoryForCode(
    supplierId: string,
    supplierName: string,
    code: string,
  ): Promise<PurchaseLine[]> {
    const txs = await this.transactionsService.findPurchasesBySupplierForCode(
      supplierId,
      supplierName,
      code,
    );
    const lines: PurchaseLine[] = [];
    for (const tx of txs) {
      for (const it of tx.items || []) {
        if (String(it.code || '').trim() !== code) continue;
        lines.push({
          transactionId: String(tx._id),
          ref: tx.ref || String(tx._id),
          date: tx.date,
          qty: Number(it.qty) || 0,
          price: Number(it.price) || 0,
        });
      }
    }
    lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return lines;
  }

  /** Already-returned qty per (transactionId, code) pair, across all non-rejected/non-cancelled
   *  supplier returns for this supplier — walks every prior return's items[].allocations[]. */
  private async getAlreadyReturnedQtyByInvoiceAndCode(
    supplierId: string,
    excludeId?: string,
  ): Promise<Map<string, number>> {
    const query: Record<string, unknown> = {
      supplierId,
      status: { $nin: ['مرفوض', 'ملغي'] },
    };
    if (excludeId) {
      query._id = { $ne: excludeId };
    }
    const prior = await this.srModel.find(query).exec();
    const map = new Map<string, number>();
    for (const r of prior) {
      for (const it of r.items || []) {
        for (const a of it.allocations || []) {
          if (!a.sourceTransactionId) continue;
          const key = `${a.sourceTransactionId}:${a.code}`;
          map.set(key, (map.get(key) || 0) + (Number(a.qty) || 0));
        }
      }
    }
    return map;
  }

  /** FIFO: walk purchase lines oldest-first, consuming qty against each until qtyToReturn is satisfied. */
  async allocateFifo(
    supplierId: string,
    supplierName: string,
    code: string,
    qtyToReturn: number,
    excludeId?: string,
  ): Promise<AllocationResult> {
    const lines = await this.loadPurchaseHistoryForCode(
      supplierId,
      supplierName,
      code,
    );
    const alreadyReturned = await this.getAlreadyReturnedQtyByInvoiceAndCode(
      supplierId,
      excludeId,
    );
    const allocations: SrAllocationDetail[] = [];
    let remaining = qtyToReturn;
    let totalCost = 0;
    let totalQty = 0;
    for (const line of lines) {
      if (remaining <= 0) break;
      const consumedAlready = alreadyReturned.get(`${line.transactionId}:${code}`) || 0;
      const availableOnLine = line.qty - consumedAlready;
      if (availableOnLine <= 0) continue;
      const take = Math.min(availableOnLine, remaining);
      allocations.push({
        code,
        qty: take,
        unitCost: line.price,
        sourceTransactionId: line.transactionId,
        sourceRef: line.ref,
      });
      totalCost += take * line.price;
      totalQty += take;
      remaining -= take;
    }
    if (remaining > 0) {
      throw new BadRequestException(
        `${code}: لا توجد كمية شراء كافية لتغطية الإرجاع المطلوب — المتاح ${totalQty} من أصل ${qtyToReturn} مطلوبة`,
      );
    }
    return {
      allocations,
      blendedUnitPrice: totalQty > 0 ? totalCost / totalQty : 0,
      totalAllocatedQty: totalQty,
    };
  }

  /** Average cost: weighted-average unit price across remaining purchase history, split across
   *  lines FIFO-order for qty accounting but priced uniformly, keeping per-invoice traceability. */
  async allocateAverage(
    supplierId: string,
    supplierName: string,
    code: string,
    qtyToReturn: number,
    excludeId?: string,
  ): Promise<AllocationResult> {
    const lines = await this.loadPurchaseHistoryForCode(
      supplierId,
      supplierName,
      code,
    );
    const alreadyReturned = await this.getAlreadyReturnedQtyByInvoiceAndCode(
      supplierId,
      excludeId,
    );
    const remainingLines = lines
      .map((line) => ({
        ...line,
        available: line.qty - (alreadyReturned.get(`${line.transactionId}:${code}`) || 0),
      }))
      .filter((line) => line.available > 0);

    const totalAvailable = remainingLines.reduce((s, l) => s + l.available, 0);
    if (totalAvailable < qtyToReturn) {
      throw new BadRequestException(
        `${code}: لا توجد كمية شراء كافية لتغطية الإرجاع المطلوب — المتاح ${totalAvailable} من أصل ${qtyToReturn} مطلوبة`,
      );
    }
    const weightedCost = remainingLines.reduce(
      (s, l) => s + l.available * l.price,
      0,
    );
    const avgPrice = totalAvailable > 0 ? weightedCost / totalAvailable : 0;

    const allocations: SrAllocationDetail[] = [];
    let remaining = qtyToReturn;
    for (const line of remainingLines) {
      if (remaining <= 0) break;
      const take = Math.min(line.available, remaining);
      allocations.push({
        code,
        qty: take,
        unitCost: avgPrice,
        sourceTransactionId: line.transactionId,
        sourceRef: line.ref,
      });
      remaining -= take;
    }
    return {
      allocations,
      blendedUnitPrice: avgPrice,
      totalAllocatedQty: qtyToReturn,
    };
  }

  /** Pure validation for admin-supplied manual allocations — qty sums match, unitCost doesn't
   *  exceed that invoice's original price for the code, per-invoice cumulative qty stays within
   *  that invoice's remaining-returnable qty. */
  async validateManualAllocation(
    supplierId: string,
    supplierName: string,
    code: string,
    qtyToReturn: number,
    proposedAllocations: SrAllocationDetail[],
    excludeId?: string,
  ): Promise<AllocationResult> {
    if (!proposedAllocations || !proposedAllocations.length) {
      throw new BadRequestException(`${code}: يجب تحديد توزيع التكلفة يدوياً`);
    }
    const sumQty = proposedAllocations.reduce((s, a) => s + (Number(a.qty) || 0), 0);
    if (sumQty !== qtyToReturn) {
      throw new BadRequestException(
        `${code}: مجموع الكميات الموزعة (${sumQty}) لا يساوي الكمية المطلوب إرجاعها (${qtyToReturn})`,
      );
    }
    const lines = await this.loadPurchaseHistoryForCode(
      supplierId,
      supplierName,
      code,
    );
    const alreadyReturned = await this.getAlreadyReturnedQtyByInvoiceAndCode(
      supplierId,
      excludeId,
    );
    const linesByTx = new Map(lines.map((l) => [l.transactionId, l]));
    const consumedInThisRequest = new Map<string, number>();
    for (const a of proposedAllocations) {
      const srcId = a.sourceTransactionId || '';
      const line = linesByTx.get(srcId);
      if (!line) {
        throw new BadRequestException(
          `${code}: الفاتورة المصدر ${a.sourceRef || srcId} لا تحتوي هذا الصنف`,
        );
      }
      if (Number(a.unitCost) > line.price) {
        throw new BadRequestException(
          `${code}: التكلفة المدخلة (${a.unitCost}) تتجاوز سعر الشراء الأصلي (${line.price}) في الفاتورة ${line.ref}`,
        );
      }
      const already = alreadyReturned.get(`${srcId}:${code}`) || 0;
      const usedNow = (consumedInThisRequest.get(srcId) || 0) + Number(a.qty);
      consumedInThisRequest.set(srcId, usedNow);
      if (already + usedNow > line.qty) {
        throw new BadRequestException(
          `${code}: الكمية المطلوبة من الفاتورة ${line.ref} تتجاوز المتاح للإرجاع (${line.qty - already})`,
        );
      }
    }
    const totalCost = proposedAllocations.reduce(
      (s, a) => s + Number(a.qty) * Number(a.unitCost),
      0,
    );
    return {
      allocations: proposedAllocations.map((a) => ({
        code,
        qty: Number(a.qty),
        unitCost: Number(a.unitCost),
        sourceTransactionId: a.sourceTransactionId || '',
        sourceRef: a.sourceRef || '',
      })),
      blendedUnitPrice: qtyToReturn > 0 ? totalCost / qtyToReturn : 0,
      totalAllocatedQty: qtyToReturn,
    };
  }
}
