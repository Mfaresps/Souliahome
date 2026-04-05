import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Transaction,
  TransactionDocument,
} from './schemas/transaction.schema';
import {
  CreateTransactionDto,
  UpdateTransactionDto,
  CancelTransactionDto,
  CollectTransactionDto,
} from './dto/transaction.dto';
import { ProductsService } from '../products/products.service';
import { VaultService } from '../vault/vault.service';

export interface InventoryItem {
  _id: string;
  code: string;
  name: string;
  sellPrice: number;
  buyPrice: number;
  minStock: number;
  openingBalance: number;
  purchases: number;
  returnsToStock: number;
  returnRefs: string;
  sales: number;
  current: number;
  status: 'ok' | 'low' | 'zero';
}

export interface DashboardData {
  totalProducts: number;
  lowStockCount: number;
  totalSales: number;
  totalPurchases: number;
  totalRemaining: number;
  totalExpenses: number;
  grossProfit: number;
  netProfit: number;
  lowStockItems: InventoryItem[];
  recentTransactions: TransactionDocument[];
  topSellers: { name: string; qty: number }[];
  lowSellers: { name: string; qty: number }[];
}

@Injectable()
export class TransactionsService {
  constructor(
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
    private readonly productsService: ProductsService,
    private readonly vaultService: VaultService,
  ) {}

  /**
   * Notes written when a pending return/exchange request is approved (ReturnsService).
   * If a row was wrongly stored as مشتريات, inventory and purchase totals still treat it as إرجاع للمخزن.
   */
  private isApprovedReturnInboundNotes(notes: string | undefined): boolean {
    const n = String(notes || '');
    return (
      n.includes('مرتجع معتمد (طلب كان معلقاً)') ||
      n.startsWith('استبدال — مرتجع:')
    );
  }

  private isCustomerReturnToStockType(type: string): boolean {
    return type === 'مرتجع مبيعات' || type === 'مرتجع';
  }

  /** Inbound qty for المخزن from عميل — not شراء من مورد. */
  private transactionAddsReturnToStock(tx: TransactionDocument): boolean {
    if (this.isCustomerReturnToStockType(tx.type)) {
      return true;
    }
    const ref = String(tx.ref || '').trim();
    if (
      tx.type === 'مشتريات' &&
      (/-RET$/i.test(ref) || this.isApprovedReturnInboundNotes(tx.notes))
    ) {
      return true;
    }
    return false;
  }

  /** True only for supplier purchases (رقم مرجعي أرقام فقط في الواجهة؛ لا يشمل إرجاع العميل). */
  private transactionAddsSupplierPurchases(tx: TransactionDocument): boolean {
    if (tx.type !== 'مشتريات') {
      return false;
    }
    const ref = String(tx.ref || '').trim();
    if (/-RET$/i.test(ref) || this.isApprovedReturnInboundNotes(tx.notes)) {
      return false;
    }
    return true;
  }

  async findAll(page?: number, limit?: number): Promise<TransactionDocument[]> {
    const query = this.transactionModel.find().sort({ createdAt: -1 });
    if (limit && limit > 0) {
      const skip = ((page || 1) - 1) * limit;
      query.skip(skip).limit(limit);
    }
    return query.exec();
  }

  async findById(id: string): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) {
      throw new NotFoundException('الحركة غير موجودة');
    }
    return tx;
  }

  async create(dto: CreateTransactionDto): Promise<TransactionDocument> {
    await this.assertRetailRefForPersist(dto.type, dto.ref, undefined);
    await this.assertOutboundWithinAvailableStock(dto.type, dto.items);
    const tx = await this.transactionModel.create(dto);
    await this.recordVaultForTransaction(tx);
    return tx;
  }

  /**
   * For مبيعات / مشتريات: ref must be digits-only when set; unique among non-cancelled txs.
   */
  private async assertRetailRefForPersist(
    type: string,
    refRaw: string | undefined,
    excludeId?: string,
  ): Promise<void> {
    if (type !== 'مبيعات' && type !== 'مشتريات') {
      return;
    }
    const ref = String(refRaw ?? '').trim();
    if (!ref) {
      if (type === 'مبيعات') {
        throw new BadRequestException('الرقم المرجعي مطلوب');
      }
      return;
    }
    if (!/^\d+$/.test(ref)) {
      throw new BadRequestException('الرقم المرجعي يقبل أرقاماً فقط');
    }
    const conflictQuery: Record<string, unknown> = {
      ref,
      cancelled: { $ne: true },
    };
    if (excludeId) {
      conflictQuery._id = { $ne: excludeId };
    }
    const exists = await this.transactionModel.findOne(conflictQuery).exec();
    if (exists) {
      throw new BadRequestException(
        'هذا الرقم المرجعي مسجّل مسبقاً في حركة أخرى',
      );
    }
  }

  private doesTransactionTypeConsumeStock(type: string): boolean {
    return type === 'مبيعات' || type === 'مرتجع مشتريات';
  }

  private aggregateOutboundQtyByCode(
    items: { code: string; qty: number }[],
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const it of items || []) {
      const codeNorm = String(it.code || '').trim();
      const qty = Number(it.qty) || 0;
      if (!codeNorm || qty <= 0) {
        continue;
      }
      map.set(codeNorm, (map.get(codeNorm) || 0) + qty);
    }
    return map;
  }

  private async getAvailableQtyByProductCode(
    excludeTransactionId?: string,
  ): Promise<Map<string, number>> {
    const products = await this.productsService.findAll();
    const transactions = await this.transactionModel
      .find({ cancelled: { $ne: true } })
      .exec();
    const txs = excludeTransactionId
      ? transactions.filter((t) => String(t._id) !== excludeTransactionId)
      : transactions;
    const result = new Map<string, number>();
    for (const product of products) {
      const productCodeNorm = String(product.code || '').trim();
      if (!productCodeNorm) {
        continue;
      }
      let purchases = 0;
      let sales = 0;
      let returnsToStock = 0;
      txs.forEach((tx) => {
        (tx.items || []).forEach((item) => {
          if (String(item.code || '').trim() !== productCodeNorm) {
            return;
          }
          if (this.transactionAddsSupplierPurchases(tx)) {
            purchases += Number(item.qty) || 0;
          } else if (this.transactionAddsReturnToStock(tx)) {
            returnsToStock += Number(item.qty) || 0;
          } else if (tx.type === 'مبيعات' || tx.type === 'مرتجع مشتريات') {
            sales += Number(item.qty) || 0;
          }
        });
      });
      const openingBal = Math.max(
        0,
        Math.floor(Number(product.openingBalance) || 0),
      );
      result.set(
        productCodeNorm,
        openingBal + purchases + returnsToStock - sales,
      );
    }
    return result;
  }

  private async assertOutboundWithinAvailableStock(
    type: string,
    items: { code: string; qty: number }[],
    excludeTransactionId?: string,
  ): Promise<void> {
    if (!this.doesTransactionTypeConsumeStock(type)) {
      return;
    }
    const needed = this.aggregateOutboundQtyByCode(items);
    if (needed.size === 0) {
      throw new BadRequestException(
        'لا توجد كميات صالحة في الأصناف لهذه الحركة',
      );
    }
    const available = await this.getAvailableQtyByProductCode(
      excludeTransactionId,
    );
    const shortages: string[] = [];
    needed.forEach((qty, code) => {
      const have = available.get(code);
      if (have === undefined) {
        shortages.push(`${code} (غير مسجل كصنف)`);
        return;
      }
      if (qty > have) {
        shortages.push(`${code}: المطلوب ${qty} — المتاح في المخزن ${have}`);
      }
    });
    if (shortages.length > 0) {
      throw new BadRequestException(
        'لا يُسمح ببيع أو خصم كمية أكبر من المخزون — ' +
          shortages.join('؛ '),
      );
    }
  }

  /**
   * Blocks edit/cancel/delete for exchange replacement sales that still owe the company.
   */
  private assertNotExchangePendingCollect(tx: TransactionDocument): void {
    const ref = String(tx.ref || '');
    const remaining = tx.remaining || 0;
    const isLocked =
      tx.type === 'مبيعات' &&
      /-EXC$/i.test(ref) &&
      tx.payStatus === 'معلق' &&
      remaining > 0 &&
      !tx.cancelled;
    if (isLocked) {
      throw new BadRequestException(
        'حركة استبدال عليها متبقي لصالح الشركة — لا يُسمح بالتعديل أو الإلغاء أو الحذف قبل تحصيل المبلغ من العميل',
      );
    }
  }

  async update(
    id: string,
    dto: UpdateTransactionDto,
    editedBy = '',
  ): Promise<TransactionDocument> {
    const existing = await this.transactionModel.findById(id).exec();
    if (!existing) {
      throw new NotFoundException('الحركة غير موجودة');
    }
    this.assertNotExchangePendingCollect(existing);
    if (dto.ref !== undefined) {
      await this.assertRetailRefForPersist(
        existing.type,
        dto.ref,
        String(existing._id),
      );
    }
    if (dto.items !== undefined) {
      await this.assertOutboundWithinAvailableStock(
        existing.type,
        dto.items,
        String(existing._id),
      );
    }
    const oldDeposit = existing.deposit || 0;
    const historyEntry = {
      editedAt: new Date().toISOString(),
      editedBy,
      action: 'تعديل',
      before: {
        client: existing.client,
        phone: existing.phone,
        ref: existing.ref,
        deposit: existing.deposit,
        remaining: existing.remaining,
        notes: existing.notes,
        items: existing.items,
        total: existing.total,
        itemsTotal: existing.itemsTotal,
        discount: existing.discount,
        shipCost: existing.shipCost,
        shipCo: existing.shipCo,
        shipZone: existing.shipZone,
        payment: existing.payment,
        payStatus: existing.payStatus,
      },
    };
    const editHistory = [...(existing.editHistory || []), historyEntry];
    const tx = await this.transactionModel
      .findByIdAndUpdate(id, { ...dto, editHistory }, { new: true })
      .exec();

    // Vault adjustment: synchronize vault with monetary changes on save
    if (!existing.cancelled) {
      const txDate = this.formatTxDateForVault(existing);
      const txRef = existing.ref || String(existing._id);
      const depMethod = String(existing.depMethod || '').trim();

      if (existing.type === 'مبيعات' && dto.deposit !== undefined) {
        // مبيعات: deposit change → vault delta
        const newDeposit = Number(dto.deposit) || 0;
        const depositDelta = newDeposit - oldDeposit;
        if (depositDelta !== 0 && depMethod) {
          const direction = depositDelta > 0 ? 'زيادة ديبوزت' : 'خصم ديبوزت';
          await this.vaultService.addSystemEntry(
            depositDelta,
            depMethod,
            `${direction} فاتورة #${txRef} — ${existing.client || ''} | قبل: ${oldDeposit} ج — بعد: ${newDeposit} ج | بواسطة: ${editedBy}`,
            txDate,
            'تعديل ديبوزت',
            txRef,
          );
        }
      } else if (
        existing.type === 'مشتريات' &&
        this.transactionAddsSupplierPurchases(existing) &&
        dto.total !== undefined
      ) {
        // مشتريات: total change → vault delta (purchases are paid in full)
        const oldTotal = existing.total || 0;
        const newTotal = Number(dto.total) || 0;
        const totalDelta = newTotal - oldTotal;
        if (totalDelta !== 0 && depMethod) {
          const direction = totalDelta > 0 ? 'زيادة قيمة مشتريات' : 'تخفيض قيمة مشتريات';
          await this.vaultService.addSystemEntry(
            -totalDelta, // negative: purchases withdraw from vault
            depMethod,
            `${direction} #${txRef} — ${existing.client || ''} | قبل: ${oldTotal} ج — بعد: ${newTotal} ج | بواسطة: ${editedBy}`,
            txDate,
            'تعديل مشتريات',
            txRef,
          );
        }
      }
    }

    return tx!;
  }

  async cancel(
    id: string,
    dto: CancelTransactionDto,
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) {
      throw new NotFoundException('الحركة غير موجودة');
    }
    if (tx.cancelled) {
      throw new BadRequestException('الحركة ملغية بالفعل');
    }
    this.assertNotExchangePendingCollect(tx);
    const previousDeposit = tx.deposit || 0;
    tx.cancelled = true;
    tx.cancelReason = dto.cancelReason;
    tx.cancelledBy = dto.cancelledBy;
    tx.cancelledAt = new Date().toISOString();
    tx.payStatus = 'ملغي';
    const saved = await tx.save();
    if (previousDeposit > 0 && tx.depMethod) {
      await this.vaultService.addSystemEntry(
        -previousDeposit,
        tx.depMethod,
        `إلغاء حركة #${tx.ref || tx._id}`,
        new Date().toISOString().split('T')[0],
        'إلغاء',
        tx.ref || String(tx._id),
      );
    }
    return saved;
  }

  async collect(
    id: string,
    dto: CollectTransactionDto,
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) {
      throw new NotFoundException('الحركة غير موجودة');
    }
    if (tx.cancelled) {
      throw new BadRequestException('لا يمكن تحصيل حركة ملغية');
    }
    if (tx.payStatus === 'مكتمل') {
      throw new BadRequestException('الحركة محصلة بالفعل');
    }
    const collectAmount = tx.remaining || 0;
    tx.remaining = 0;
    tx.payStatus = 'مكتمل';
    if (collectAmount > 0 && /-EXC$/i.test(String(tx.ref || ''))) {
      tx.deposit = collectAmount;
    }
    tx.collectMethod = dto.collectMethod;
    tx.collectNote = dto.collectNote || '';
    tx.collectedAt = new Date().toISOString().split('T')[0];
    const saved = await tx.save();
    if (collectAmount > 0) {
      await this.vaultService.addSystemEntry(
        collectAmount,
        dto.collectMethod,
        `تحصيل #${tx.ref || tx._id}`,
        new Date().toISOString().split('T')[0],
        'تحصيل',
        tx.ref || String(tx._id),
      );
    }
    return saved;
  }

  async remove(id: string): Promise<void> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) {
      throw new NotFoundException('الحركة غير موجودة');
    }
    this.assertNotExchangePendingCollect(tx);
    await this.transactionModel.findByIdAndDelete(id).exec();
  }

  async bulkRemove(ids: string[]): Promise<number> {
    if (!ids.length) {
      return 0;
    }
    const docs = await this.transactionModel.find({ _id: { $in: ids } }).exec();
    for (const tx of docs) {
      this.assertNotExchangePendingCollect(tx);
    }
    const result = await this.transactionModel
      .deleteMany({ _id: { $in: ids } })
      .exec();
    return result.deletedCount;
  }

  async clearAll(): Promise<void> {
    await this.transactionModel.deleteMany({}).exec();
  }

  async getInventory(): Promise<InventoryItem[]> {
    const products = await this.productsService.findAll();
    const transactions = await this.transactionModel
      .find({ cancelled: { $ne: true } })
      .exec();
    return products.map((product) => {
      let purchases = 0;
      let sales = 0;
      let returnsToStock = 0;
      const returnRefSet = new Set<string>();
      const productCodeNorm = String(product.code || '').trim();
      transactions.forEach((tx) => {
        tx.items.forEach((item) => {
          if (String(item.code || '').trim() !== productCodeNorm) {
            return;
          }
          if (this.transactionAddsSupplierPurchases(tx)) {
            purchases += item.qty;
          } else if (this.transactionAddsReturnToStock(tx)) {
            returnsToStock += item.qty;
            const refStr = String(tx.ref || '').trim();
            if (refStr) {
              returnRefSet.add(refStr);
            }
          } else if (tx.type === 'مبيعات' || tx.type === 'مرتجع مشتريات') {
            sales += item.qty;
          }
        });
      });
      const openingBal = Math.max(
        0,
        Math.floor(Number(product.openingBalance) || 0),
      );
      const current = openingBal + purchases + returnsToStock - sales;
      let status: 'ok' | 'low' | 'zero' = 'ok';
      if (current <= 0) {
        status = 'zero';
      } else if (current <= (product.minStock || 10)) {
        status = 'low';
      }
      return {
        _id: product._id.toString(),
        code: product.code,
        name: product.name,
        sellPrice: product.sellPrice,
        buyPrice: product.buyPrice,
        minStock: product.minStock,
        openingBalance: openingBal,
        purchases,
        returnsToStock,
        returnRefs: [...returnRefSet].sort().join('، '),
        sales,
        current,
        status,
      };
    });
  }

  async getDashboard(expenseTotal = 0): Promise<DashboardData> {
    const inventory = await this.getInventory();
    const transactions = await this.transactionModel.find().exec();
    const activeTx = transactions.filter((t) => !t.cancelled);
    const lowStockCount = inventory.filter((p) => p.status !== 'ok').length;
    const salesTx = activeTx.filter((t) => t.type === 'مبيعات');
    const totalSales = salesTx.reduce((sum, t) => sum + t.total, 0);
    const totalPurchases = activeTx
      .filter((t) => this.transactionAddsSupplierPurchases(t))
      .reduce((sum, t) => sum + t.total, 0);
    const totalRemaining = activeTx.reduce(
      (sum, t) => sum + (t.remaining || 0),
      0,
    );
    const products = await this.productsService.findAll();
    let grossProfit = 0;
    salesTx.forEach((tx) => {
      tx.items.forEach((item) => {
        const product = products.find((p) => p.code === item.code);
        grossProfit +=
          (item.price - (product ? product.buyPrice : 0)) * item.qty;
      });
    });
    const netProfit = grossProfit - expenseTotal;
    const salesMap: Record<string, number> = {};
    salesTx.forEach((tx) => {
      tx.items.forEach((item) => {
        salesMap[item.name] = (salesMap[item.name] || 0) + item.qty;
      });
    });
    const sorted = Object.entries(salesMap)
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty);
    const topSellers = sorted.slice(0, 5);
    const lowSellers =
      sorted.length > 5 ? sorted.slice(-5).reverse() : [...sorted].reverse();
    const lowStockItems = inventory
      .filter((p) => p.status !== 'ok')
      .slice(0, 8);
    const recentTransactions = await this.transactionModel
      .find()
      .sort({ createdAt: -1 })
      .limit(8)
      .exec();
    return {
      totalProducts: inventory.length,
      lowStockCount,
      totalSales,
      totalPurchases,
      totalRemaining,
      totalExpenses: expenseTotal,
      grossProfit,
      netProfit,
      lowStockItems,
      recentTransactions,
      topSellers,
      lowSellers,
    };
  }

  async getReports(
    from?: string,
    to?: string,
    expenseTotal = 0,
  ): Promise<Record<string, unknown>> {
    let transactions = await this.transactionModel
      .find({ cancelled: { $ne: true } })
      .exec();
    if (from) transactions = transactions.filter((t) => t.date >= from);
    if (to) transactions = transactions.filter((t) => t.date <= to);
    const salesTx = transactions.filter((t) => t.type === 'مبيعات');
    const pursTx = transactions.filter((t) =>
      this.transactionAddsSupplierPurchases(t),
    );
    const totalSales = salesTx.reduce((s, t) => s + t.total, 0);
    const totalPurchases = pursTx.reduce((s, t) => s + t.total, 0);
    const totalDeposit = salesTx.reduce((s, t) => s + (t.deposit || 0), 0);
    const totalRemaining = salesTx.reduce(
      (s, t) => s + (t.remaining || 0),
      0,
    );
    const products = await this.productsService.findAll();
    let grossProfit = 0;
    const prodProfitMap: Record<
      string,
      { qty: number; rev: number; cost: number; profit: number }
    > = {};
    salesTx.forEach((tx) => {
      tx.items.forEach((item) => {
        const p = products.find((x) => x.code === item.code);
        const cost = p ? p.buyPrice : 0;
        const profit = (item.price - cost) * item.qty;
        grossProfit += profit;
        if (!prodProfitMap[item.name]) {
          prodProfitMap[item.name] = { qty: 0, rev: 0, cost: 0, profit: 0 };
        }
        prodProfitMap[item.name].qty += item.qty;
        prodProfitMap[item.name].rev += item.total;
        prodProfitMap[item.name].cost += cost * item.qty;
        prodProfitMap[item.name].profit += profit;
      });
    });
    const netProfit = grossProfit - expenseTotal;
    return {
      totalSales,
      totalPurchases,
      totalDeposit,
      totalRemaining,
      grossProfit,
      netProfit,
      expenseTotal,
      transactionCount: transactions.length,
      productProfits: Object.entries(prodProfitMap)
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => b.profit - a.profit),
      salesMap: salesTx.reduce(
        (acc: Record<string, number>, tx) => {
          tx.items.forEach((it) => {
            acc[it.name] = (acc[it.name] || 0) + it.qty;
          });
          return acc;
        },
        {},
      ),
    };
  }

  private sumTransactionItemsLineTotal(tx: TransactionDocument): number {
    return Math.round(
      (tx.items || []).reduce(
        (sum, it) => sum + (Number(it.total) || 0),
        0,
      ),
    );
  }

  /**
   * مبلغ خصم الخزنة عند مرتجع: الأفضلية لـ total (استرجاع معتمد).
   * حركة استبدال تُنشأ بـ total=0 عمداً؛ الرد النقدي يمر عبر تحصيل الفرق أو مصروف.
   */
  private resolveReturnRefundVaultAmount(tx: TransactionDocument): number {
    const roundedTotal = Math.round(Number(tx.total) || 0);
    if (roundedTotal > 0) {
      return roundedTotal;
    }
    if (String(tx.notes || '').includes('استبدال')) {
      return 0;
    }
    const itemsTotal = Math.round(Number(tx.itemsTotal) || 0);
    if (itemsTotal > 0) {
      return itemsTotal;
    }
    return this.sumTransactionItemsLineTotal(tx);
  }

  private formatTxDateForVault(tx: TransactionDocument): string {
    const d = tx.date as string | Date | undefined;
    if (d == null || d === '') {
      return new Date().toISOString().split('T')[0];
    }
    if (d instanceof Date) {
      return d.toISOString().split('T')[0];
    }
    const s = String(d);
    return s.includes('T') ? s.split('T')[0] : s.slice(0, 10);
  }

  async applyPostDiscount(
    id: string,
    amount: number,
    vaultAccount: string,
    appliedBy: string,
    notes = '',
  ): Promise<TransactionDocument> {
    const tx = await this.transactionModel.findById(id).exec();
    if (!tx) throw new NotFoundException('الحركة غير موجودة');
    if (tx.cancelled) throw new BadRequestException('لا يمكن تطبيق خصم على حركة ملغية');
    if (tx.type !== 'مبيعات') throw new BadRequestException('الخصم البعدي يُطبَّق على فواتير المبيعات فقط');
    const discountAmount = Math.round(amount);
    if (discountAmount <= 0) throw new BadRequestException('مبلغ الخصم يجب أن يكون أكبر من صفر');
    const historyEntry = {
      editedAt: new Date().toISOString(),
      editedBy: appliedBy,
      action: 'خصم بعدي',
      before: { discount: tx.discount, total: tx.total, remaining: tx.remaining },
      discountApplied: discountAmount,
      vaultAccount,
      notes,
    };
    tx.discount = Math.round((tx.discount || 0) + discountAmount);
    tx.total = Math.max(0, Math.round(tx.total - discountAmount));
    tx.remaining = Math.max(0, Math.round((tx.remaining || 0) - discountAmount));
    if (tx.remaining <= 0) tx.payStatus = 'مكتمل';
    tx.editHistory = [...(tx.editHistory || []), historyEntry];
    const saved = await tx.save();
    const txDate = this.formatTxDateForVault(tx);
    await this.vaultService.addSystemEntry(
      -discountAmount,
      vaultAccount,
      `خصم بعدي على فاتورة #${tx.ref || tx._id} — ${tx.client || ''}${notes ? ' — ' + notes : ''}`,
      txDate,
      'خصم بعدي',
      tx.ref || String(tx._id),
    );
    return saved;
  }

  private async recordVaultForTransaction(
    tx: TransactionDocument,
  ): Promise<void> {
    const txRef = tx.ref || String(tx._id);
    const txDate = this.formatTxDateForVault(tx);
    if (tx.type === 'مبيعات' && (tx.deposit || 0) > 0) {
      await this.vaultService.addSystemEntry(
        tx.deposit,
        tx.depMethod || 'كاش',
        `ديبوزت مبيعات #${txRef} — ${tx.client || ''}`,
        txDate,
        'ديبوزت مبيعات',
        txRef,
      );
    } else if (tx.type === 'مشتريات') {
      if (this.transactionAddsSupplierPurchases(tx)) {
        await this.vaultService.addSystemEntry(
          -(tx.total || 0),
          tx.depMethod || 'كاش',
          `مشتريات #${txRef} — ${tx.client || ''}`,
          txDate,
          'مشتريات',
          txRef,
        );
      } else {
        const refundAmount = this.resolveReturnRefundVaultAmount(tx);
        if (refundAmount <= 0) {
          return;
        }
        await this.vaultService.addSystemEntry(
          -refundAmount,
          tx.depMethod || 'كاش',
          `رد مرتجع للعميل #${txRef} — ${tx.client || ''}`,
          txDate,
          'رد مرتجع',
          txRef,
        );
      }
    } else if (tx.type === 'مرتجع' || tx.type === 'مرتجع مبيعات') {
      const refundAmount = this.resolveReturnRefundVaultAmount(tx);
      if (refundAmount <= 0) {
        return;
      }
      await this.vaultService.addSystemEntry(
        -refundAmount,
        tx.depMethod || 'كاش',
        `رد مرتجع للعميل #${txRef} — ${tx.client || ''}`,
        txDate,
        'رد مرتجع',
        txRef,
      );
    }
  }
}
