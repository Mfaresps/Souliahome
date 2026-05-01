import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { VaultEntry, VaultEntryDocument } from './schemas/vault-entry.schema';
import { SettingsService } from '../settings/settings.service';
import { resolveVaultSegmentFromPaymentMethod } from './vault-segment.util';
import { generateVaultTexts } from './vault-description.util';
import { CreateVaultEntryDto, UpdateVaultEntryDto } from './dto/vault.dto';
import { PresenceGateway } from '../auth/presence.gateway';
// #region agent log
import { debugLog } from '../debug-log.util';
// #endregion

@Injectable()
export class VaultService {
  constructor(
    @InjectModel(VaultEntry.name)
    private readonly vaultModel: Model<VaultEntryDocument>,
    private readonly settingsService: SettingsService,
    private readonly presence: PresenceGateway,
  ) {}

  private emit(event: string, payload: unknown): void {
    try { this.presence?.emitEvent(event, payload); } catch { /* swallow */ }
  }

  // Helper: sync vault transaction status to original transaction
  private async syncTransactionStatus(vaultEntry: VaultEntryDocument, newStatus: string): Promise<void> {
    if (!vaultEntry.ref) return;

    try {
      // Get transaction model from the same mongoose connection
      const transactionModel = this.vaultModel.db.model('Transaction');
      if (!transactionModel) return;

      // Find transaction by reference number
      const transaction = await transactionModel.findOne({ ref: vaultEntry.ref }).exec();
      if (!transaction) return;

      // Map vault status to transaction payStatus with descriptive messages
      let newPayStatus = transaction.payStatus;
      if (newStatus === 'frozen') {
        newPayStatus = 'تم تجميد الحركة في الخزنة'; // Transaction frozen in vault
      } else if (newStatus === 'completed') {
        newPayStatus = 'مكتملة'; // Completed
      } else if (newStatus === 'cancelled') {
        newPayStatus = 'تم رفض المعاملة من الخزنة'; // Transaction rejected from vault
      }

      if (newPayStatus !== transaction.payStatus) {
        await transactionModel.findByIdAndUpdate(
          transaction._id,
          { payStatus: newPayStatus },
          { new: true }
        ).exec();
      }
    } catch (err) {
      // Log but don't throw - sync failure shouldn't block the operation
      console.error('Failed to sync transaction status:', err);
    }
  }

  async findAll(from?: string, to?: string): Promise<VaultEntryDocument[]> {
    const filter: Record<string, unknown> = {};
    if (from || to) {
      filter.date = {};
      if (from) (filter.date as Record<string, string>).$gte = from;
      if (to) (filter.date as Record<string, string>).$lte = to;
    }
    return this.vaultModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  private async generateTxNo(source?: string): Promise<string> {
    // Map source to prefix
    const prefixes: Record<string, string> = {
      'ديبوزت مبيعات': 'SAL',
      'تحصيل': 'SAL',
      'مبيعات': 'SAL',
      'مشتريات': 'PUR',
      'دفع مشتريات': 'PUR',
      'مصروف': 'EXP',
      'رد مرتجع': 'RET',
      'مرتجع': 'RET',
      'إلغاء': 'CAN',
      'خصم بعدي': 'DIS',
      'يدوي': 'MAN',
    };

    const prefix = prefixes[source || ''] || 'TXN';

    // Get count of transactions with same prefix
    const count = await this.vaultModel.countDocuments({
      txNo: { $regex: `^${prefix}-` },
    });

    const nextNumber = (count + 1).toString().padStart(3, '0');
    return `${prefix}-${nextNumber}`;
  }

  async getSegmentBalance(seg: string): Promise<number> {
    const settings = await this.settingsService.getSettings();
    switch (seg) {
      case 'vodafone': return settings.vaultVodafone || 0;
      case 'instapay': return settings.vaultInstapay || 0;
      case 'bank': return settings.vaultBank || 0;
      default: return settings.vaultCash || 0;
    }
  }

  async assertSufficientBalance(method: string, amount: number): Promise<void> {
    const seg = resolveVaultSegmentFromPaymentMethod(method);
    const balance = await this.getSegmentBalance(seg);
    if (balance < amount) {
      const segLabel: Record<string, string> = { cash: 'كاش', vodafone: 'فودافون كاش', instapay: 'Instapay', bank: 'تحويل بنكي' };
      throw new BadRequestException(
        `رصيد ${segLabel[seg] || seg} غير كافٍ — الرصيد الحالي: ${balance} ج والمطلوب: ${amount} ج`
      );
    }
  }

  async addEntry(dto: CreateVaultEntryDto, employee?: string): Promise<VaultEntryDocument> {
    const date = dto.date || new Date().toISOString().split('T')[0];
    const desc = dto.desc || 'تعديل يدوي';
    // Check sufficient balance before withdrawal
    if (dto.amount < 0) {
      const currentBalance = await this.getSegmentBalance(dto.seg);
      if (currentBalance + dto.amount < 0) {
        const segLabel: Record<string, string> = { cash: 'كاش', vodafone: 'فودافون كاش', instapay: 'Instapay', bank: 'تحويل بنكي' };
        throw new BadRequestException(
          `رصيد ${segLabel[dto.seg] || dto.seg} غير كافٍ — الرصيد الحالي: ${currentBalance} ج`
        );
      }
    }
    const settings = await this.settingsService.adjustVaultBalance(
      dto.seg,
      dto.amount,
    );
    const txNo = await this.generateTxNo('يدوي');
    const entry = await this.vaultModel.create({
      date,
      desc,
      amount: dto.amount,
      seg: dto.seg,
      method: dto.method || 'يدوي',
      source: 'يدوي',
      ref: '',
      balCash: settings.vaultCash,
      balVodafone: settings.vaultVodafone,
      balInstapay: settings.vaultInstapay,
      balBank: settings.vaultBank,
      balance: settings.vaultBalance,
      employee: employee || dto.employee || '',
      txNo,
      accountingJustification: dto.accountingJustification || '',
      entityLabel: dto.entityLabel || '',
    });
    this.emit('vault:changed', {
      reason: 'manual',
      amount: dto.amount,
      seg: dto.seg,
      by: employee || dto.employee || '',
      desc,
      ref: '',
      txNo,
      balances: {
        cash: settings.vaultCash || 0,
        vodafone: settings.vaultVodafone || 0,
        instapay: settings.vaultInstapay || 0,
        bank: settings.vaultBank || 0,
        total: settings.vaultBalance || 0,
      },
    });
    return entry;
  }

  async deleteLastEntryByRef(ref: string): Promise<boolean> {
    try {
      const entry = await this.vaultModel.findOne(
        { ref, source: { $in: ['تحصيل', 'مشتريات'] } },
        null,
        { sort: { date: -1, createdAt: -1 } }
      ).exec();
      if (!entry) return false;

      // عكس الرصيد: المبلغ الذي أُضيف وقت التحصيل يُخصم الآن (والعكس)
      const seg = entry.seg || resolveVaultSegmentFromPaymentMethod(entry.method || 'كاش');
      await this.settingsService.adjustVaultBalance(seg, -entry.amount);

      await entry.deleteOne();
      return true;
    } catch (error) {
      return false;
    }
  }

  async addSystemEntry(
    amount: number,
    method: string,
    desc: string,
    date: string,
    source = '',
    ref = '',
    entityContext?: { customer?: string; supplier?: string; category?: string; itemCount?: number },
    employee = '',
  ): Promise<VaultEntryDocument> {
    const seg = resolveVaultSegmentFromPaymentMethod(method);
    // Block any deduction if balance is insufficient
    if (amount < 0) {
      const balance = await this.getSegmentBalance(seg);
      if (balance + amount < 0) {
        const segLabel: Record<string, string> = { cash: 'كاش', vodafone: 'فودافون كاش', instapay: 'Instapay', bank: 'تحويل بنكي' };
        throw new BadRequestException(
          `رصيد ${segLabel[seg] || seg} غير كافٍ — الرصيد الحالي: ${balance} ج والمطلوب خصم: ${Math.abs(amount)} ج`
        );
      }
    }
    const settings = await this.settingsService.adjustVaultBalance(seg, amount);

    // Generate smart description and accounting justification
    const { desc: finalDesc, justification: accountingJustification } = generateVaultTexts(
      amount,
      method,
      desc,
      source,
      ref,
      entityContext,
    );

    const entityLabel = entityContext?.customer || entityContext?.supplier || '';
    const txNo = await this.generateTxNo(source);

    const created = await this.vaultModel.create({
      date,
      desc: finalDesc,
      amount,
      seg,
      method,
      source,
      ref,
      balCash: settings.vaultCash,
      balVodafone: settings.vaultVodafone,
      balInstapay: settings.vaultInstapay,
      balBank: settings.vaultBank,
      balance: settings.vaultBalance,
      status: 'completed',
      transactionType: source,
      accountingJustification,
      entityLabel,
      employee: employee || '',
      txNo,
    });
    // #region agent log
    debugLog('vault.service.ts:addSystemEntry', 'VAULT_ENTRY_CREATED', {
      hypothesisId: 'H1,H3,H5',
      txNo,
      amount,
      seg,
      method,
      source,
      ref,
      desc: finalDesc,
      balanceAfter: {
        cash: settings.vaultCash,
        vodafone: settings.vaultVodafone,
        instapay: settings.vaultInstapay,
        bank: settings.vaultBank,
        total: settings.vaultBalance,
      },
    });
    // #endregion
    this.emit('vault:changed', {
      reason: 'system',
      amount,
      seg,
      source,
      ref,
      txNo,
      desc: finalDesc,
      entityLabel,
      employee: employee || '',
      balances: {
        cash: settings.vaultCash || 0,
        vodafone: settings.vaultVodafone || 0,
        instapay: settings.vaultInstapay || 0,
        bank: settings.vaultBank || 0,
        total: settings.vaultBalance || 0,
      },
    });
    return created;
  }

  async getById(id: string): Promise<VaultEntryDocument> {
    const entry = await this.vaultModel.findById(id).exec();
    if (!entry) throw new NotFoundException('المعاملة غير موجودة');
    return entry;
  }

  async updateEntry(id: string, dto: UpdateVaultEntryDto, editor: string): Promise<VaultEntryDocument> {
    const entry = await this.getById(id);
    const changes: Record<string, { oldValue: unknown; newValue: unknown }> = {};

    // Track changes
    if (dto.desc !== undefined && dto.desc !== entry.desc) {
      changes.desc = { oldValue: entry.desc, newValue: dto.desc };
      entry.desc = dto.desc;
    }
    if (dto.notes !== undefined && dto.notes !== entry.notes) {
      changes.notes = { oldValue: entry.notes, newValue: dto.notes };
      entry.notes = dto.notes;
    }
    if (dto.status !== undefined && dto.status !== entry.status) {
      changes.status = { oldValue: entry.status, newValue: dto.status };
      entry.status = dto.status;
    }
    if (dto.frozenReason !== undefined && dto.frozenReason !== entry.frozenReason) {
      changes.frozenReason = { oldValue: entry.frozenReason, newValue: dto.frozenReason };
      entry.frozenReason = dto.frozenReason;
    }

    // Handle amount changes (adjust vault balance)
    if (dto.amount !== undefined && dto.amount !== entry.amount) {
      const amountDiff = dto.amount - entry.amount;
      changes.amount = { oldValue: entry.amount, newValue: dto.amount };

      // Only adjust if not frozen/cancelled
      if (entry.status !== 'frozen' && entry.status !== 'cancelled') {
        try {
          await this.settingsService.adjustVaultBalance(entry.seg, amountDiff);
          entry.amount = dto.amount;
        } catch (err) {
          throw new BadRequestException(`لا يمكن تعديل المبلغ: رصيد غير كافٍ`);
        }
      }
    }

    // Rebuild edit history if it doesn't exist
    if (!entry.editHistory) {
      entry.editHistory = [];
    }

    // Add edit record
    entry.editHistory.push({
      editor,
      editedAt: new Date().toISOString(),
      changes,
    });

    return entry.save();
  }

  async freezeEntry(id: string, reason: string, freezer: string): Promise<VaultEntryDocument> {
    const entry = await this.getById(id);
    if (entry.status === 'frozen') throw new BadRequestException('المعاملة مجمدة بالفعل');
    if (entry.status === 'cancelled') throw new BadRequestException('لا يمكن تجميد معاملة ملغاة');

    // إذا كانت المعاملة مكتملة (المبلغ دخل الخزنة)، نسترجع المبلغ
    if (entry.status === 'completed' && entry.amount !== 0) {
      try {
        await this.settingsService.adjustVaultBalance(entry.seg, -entry.amount);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(`فشل استرجاع المبلغ من الخزنة: ${errMsg}`);
      }
    }

    entry.status = 'frozen';
    entry.frozenReason = reason;
    if (!entry.editHistory) entry.editHistory = [];
    entry.editHistory.push({
      editor: freezer,
      editedAt: new Date().toISOString(),
      changes: { status: { oldValue: 'completed', newValue: 'frozen' }, reason: { oldValue: '', newValue: reason } },
    });
    const saved = await entry.save();

    // Sync status to original transaction
    await this.syncTransactionStatus(saved, 'frozen');

    return saved;
  }

  async unfreezeEntry(id: string, unfreezer: string): Promise<VaultEntryDocument> {
    const entry = await this.getById(id);
    if (entry.status !== 'frozen') throw new BadRequestException('المعاملة ليست مجمدة');

    // Check if the entry was 'completed' when it was frozen (by looking at editHistory)
    // We only restore balance if it was originally completed (and thus had balance adjusted when frozen)
    let wasCompletedBeforeFreeze = false;
    if (entry.editHistory && entry.editHistory.length > 0) {
      const freezeRecord = entry.editHistory.find(
        (h) => h.changes?.status?.newValue === 'frozen'
      );
      wasCompletedBeforeFreeze = freezeRecord?.changes?.status?.oldValue === 'completed';
    }

    // إعادة المبلغ للخزنة عند التحرير (فقط إذا كانت المعاملة مكتملة قبل التجميد)
    if (wasCompletedBeforeFreeze && entry.amount !== 0) {
      try {
        await this.settingsService.adjustVaultBalance(entry.seg, entry.amount);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new BadRequestException(`فشل إعادة المبلغ للخزنة: ${errMsg}`);
      }
    }

    const oldFrozenReason = entry.frozenReason;
    entry.status = 'completed';
    entry.frozenReason = '';
    if (!entry.editHistory) entry.editHistory = [];
    entry.editHistory.push({
      editor: unfreezer,
      editedAt: new Date().toISOString(),
      changes: { status: { oldValue: 'frozen', newValue: 'completed' }, frozenReason: { oldValue: oldFrozenReason, newValue: '' } },
    });

    const saved = await entry.save();

    // Sync status to original transaction
    await this.syncTransactionStatus(saved, 'completed');

    return saved;
  }

  async cancelEntry(id: string, canceller: string, reason?: string): Promise<VaultEntryDocument> {
    const entry = await this.getById(id);
    if (entry.status === 'cancelled') throw new BadRequestException('المعاملة ملغاة بالفعل');

    const oldStatus = entry.status;
    entry.status = 'cancelled';
    if (reason) entry.notes = `ملغاة: ${reason}`;

    // Reverse amount if it was completed
    if (oldStatus === 'completed') {
      try {
        await this.settingsService.adjustVaultBalance(entry.seg, -entry.amount);
      } catch (err) {
        throw new BadRequestException('خطأ في استرجاع المبلغ');
      }
    }

    if (!entry.editHistory) entry.editHistory = [];
    entry.editHistory.push({
      editor: canceller,
      editedAt: new Date().toISOString(),
      changes: { status: { oldValue: oldStatus, newValue: 'cancelled' }, reason: { oldValue: '', newValue: reason || '' } },
    });
    const saved = await entry.save();

    // Sync status to original transaction
    await this.syncTransactionStatus(saved, 'cancelled');

    return saved;
  }

  async approveEntry(id: string, approver: string): Promise<VaultEntryDocument> {
    const entry = await this.getById(id);
    if (entry.isApproved) throw new BadRequestException('المعاملة موافق عليها بالفعل');

    entry.isApproved = true;
    entry.approvedBy = approver;
    if (!entry.editHistory) entry.editHistory = [];
    entry.editHistory.push({
      editor: approver,
      editedAt: new Date().toISOString(),
      changes: { isApproved: { oldValue: false, newValue: true } },
    });
    return entry.save();
  }

  async searchAndFilter(filters: {
    from?: string;
    to?: string;
    seg?: string;
    employee?: string;
    status?: string;
    transactionType?: string;
  }): Promise<VaultEntryDocument[]> {
    const query: Record<string, unknown> = {};

    if (filters.from || filters.to) {
      query.date = {};
      if (filters.from) (query.date as Record<string, string>).$gte = filters.from;
      if (filters.to) (query.date as Record<string, string>).$lte = filters.to;
    }
    if (filters.seg) query.seg = filters.seg;
    if (filters.employee) query.employee = filters.employee;
    if (filters.status) query.status = filters.status;
    if (filters.transactionType) query.transactionType = filters.transactionType;

    return this.vaultModel.find(query).sort({ createdAt: -1 }).exec();
  }

  async getStatistics(seg?: string): Promise<{
    totalIncome: number;
    totalExpense: number;
    totalTransactions: number;
    frozenTransactions: number;
    cancelledTransactions: number;
    pendingApprovals: number;
  }> {
    // Only count 'completed' entries for income/expense totals (exclude frozen & cancelled)
    const query: Record<string, unknown> = { status: 'completed' };
    if (seg) query.seg = seg;

    const entries = await this.vaultModel.find(query).exec();
    const totalIncome = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    const totalExpense = Math.abs(entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0));
    // Count frozen/cancelled separately since we only queried 'completed' above
    const frozenQuery: Record<string, unknown> = { status: 'frozen' };
    if (seg) frozenQuery.seg = seg;
    const frozenTransactions = await this.vaultModel.countDocuments(frozenQuery);
    const cancelledTransactions = await this.vaultModel.countDocuments({ status: 'cancelled' });
    const pendingApprovals = entries.filter((e) => e.requiresApproval && !e.isApproved).length;

    // #region agent log
    debugLog('vault.service.ts:getStatistics', 'STATISTICS_COMPUTED', {
      hypothesisId: 'H3',
      seg: seg || 'ALL',
      totalIncome,
      totalExpense,
      net: totalIncome - totalExpense,
      totalTransactions: entries.length,
      frozenTransactions,
      cancelledTransactions,
      pendingApprovals,
      filterApplied: 'status === completed (fixed)',
    });
    // #endregion
    return {
      totalIncome,
      totalExpense,
      totalTransactions: entries.length,
      frozenTransactions,
      cancelledTransactions,
      pendingApprovals,
    };
  }

  async getAnalytics(days = 30, seg?: string): Promise<any> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const fromStr = startDate.toISOString().split('T')[0];
    const toStr = endDate.toISOString().split('T')[0];

    // Previous period for trend
    const prevEnd = new Date(startDate);
    prevEnd.setDate(prevEnd.getDate() - 1);
    const prevStart = new Date(prevEnd);
    prevStart.setDate(prevStart.getDate() - days);
    const prevFromStr = prevStart.toISOString().split('T')[0];
    const prevToStr = prevEnd.toISOString().split('T')[0];

    // Only count 'completed' entries for analytics (exclude frozen & cancelled)
    const query = { status: 'completed', ...(seg ? { seg } : {}) };
    const currentEntries = await this.vaultModel
      .find({ ...query, date: { $gte: fromStr, $lte: toStr } })
      .exec();
    const prevEntries = await this.vaultModel
      .find({ ...query, date: { $gte: prevFromStr, $lte: prevToStr } })
      .exec();

    // Calculate metrics
    const currentNet = currentEntries.reduce((s, e) => s + e.amount, 0);
    const prevNet = prevEntries.reduce((s, e) => s + e.amount, 0);

    const dailyByDate: Record<string, number> = {};
    currentEntries.forEach((e) => {
      dailyByDate[e.date] = (dailyByDate[e.date] || 0) + e.amount;
    });

    const daysWithEntries = Object.keys(dailyByDate).length || 1;
    const dailyAverage = currentNet / daysWithEntries;
    const cashVelocity = currentEntries.reduce((s, e) => s + Math.abs(e.amount), 0) / days;

    // Best and worst days
    let bestDay = { date: '', net: 0 };
    let worstDay = { date: '', net: 0 };
    Object.entries(dailyByDate).forEach(([date, net]) => {
      if (net > bestDay.net) bestDay = { date, net };
      if (net < worstDay.net) worstDay = { date, net };
    });

    // Trend
    const trendPct = prevNet !== 0 ? ((currentNet - prevNet) / Math.abs(prevNet)) * 100 : 0;
    const trendDirection = currentNet > prevNet ? 'up' : currentNet < prevNet ? 'down' : 'flat';

    // Module breakdown
    const moduleMap: Record<string, { totalIn: number; totalOut: number; count: number }> = {};
    currentEntries.forEach((e) => {
      const source = e.source || 'يدوي';
      if (!moduleMap[source]) {
        moduleMap[source] = { totalIn: 0, totalOut: 0, count: 0 };
      }
      moduleMap[source].count++;
      if (e.amount > 0) moduleMap[source].totalIn += e.amount;
      else moduleMap[source].totalOut += Math.abs(e.amount);
    });

    const totalAbsFlow = currentEntries.reduce((s, e) => s + Math.abs(e.amount), 0) || 1;
    const moduleBreakdown = Object.entries(moduleMap).map(([source, { totalIn, totalOut, count }]) => ({
      source,
      totalIn,
      totalOut,
      count,
      pct: (((totalIn + totalOut) / totalAbsFlow) * 100).toFixed(2),
    }));

    // Top entities
    const entityMap: Record<string, { total: number; count: number }> = {};
    currentEntries.forEach((e) => {
      const label = e.entityLabel || 'داخلي';
      if (label && label.length > 0) {
        if (!entityMap[label]) entityMap[label] = { total: 0, count: 0 };
        entityMap[label].total += Math.abs(e.amount);
        entityMap[label].count++;
      }
    });

    const topEntities = Object.entries(entityMap)
      .sort(([, a], [, b]) => b.total - a.total)
      .slice(0, 10)
      .map(([label, { total, count }]) => ({ entityLabel: label, total, count }));

    // Current balances
    const settings = await this.settingsService.getSettings();

    // #region agent log
    debugLog('vault.service.ts:getAnalytics', 'ANALYTICS_COMPUTED', {
      hypothesisId: 'H3',
      windowDays: days,
      seg: seg || 'ALL',
      dateRange: { from: fromStr, to: toStr },
      monthlyNet: currentNet,
      lastMonthNet: prevNet,
      dailyAverage,
      cashVelocity,
      currentEntriesCount: currentEntries.length,
      segmentBalances: {
        cash: settings.vaultCash || 0,
        vodafone: settings.vaultVodafone || 0,
        instapay: settings.vaultInstapay || 0,
        bank: settings.vaultBank || 0,
        total: settings.vaultBalance || 0,
      },
      sumOfAllEntriesAmount: currentEntries.reduce((s, e) => s + e.amount, 0),
      sumPositive: currentEntries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0),
      sumNegative: currentEntries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0),
    });
    // #endregion
    return {
      dailyAverage,
      monthlyNet: currentNet,
      lastMonthNet: prevNet,
      trendDirection,
      trendPct: Math.abs(trendPct).toFixed(1),
      bestDay,
      worstDay,
      cashVelocity,
      moduleBreakdown,
      topEntities,
      segmentBalances: {
        cash: settings.vaultCash || 0,
        vodafone: settings.vaultVodafone || 0,
        instapay: settings.vaultInstapay || 0,
        bank: settings.vaultBank || 0,
        total: settings.vaultBalance || 0,
      },
    };
  }

  async getCashFlow(days = 30, seg?: string): Promise<any> {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const fromStr = startDate.toISOString().split('T')[0];
    const toStr = endDate.toISOString().split('T')[0];

    // Only count 'completed' entries for cash flow (exclude frozen & cancelled)
    const query = { status: 'completed', ...(seg ? { seg } : {}) };
    const entries = await this.vaultModel
      .find({ ...query, date: { $gte: fromStr, $lte: toStr } })
      .exec();

    // Build daily aggregates
    const dailyByDate: Record<string, { inflow: number; outflow: number }> = {};
    entries.forEach((e) => {
      if (!dailyByDate[e.date]) {
        dailyByDate[e.date] = { inflow: 0, outflow: 0 };
      }
      if (e.amount > 0) dailyByDate[e.date].inflow += e.amount;
      else dailyByDate[e.date].outflow += Math.abs(e.amount);
    });

    // Fill missing days
    const allDates = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      allDates.push(dateStr);
      if (!dailyByDate[dateStr]) {
        dailyByDate[dateStr] = { inflow: 0, outflow: 0 };
      }
    }

    // Build output arrays
    const labels = allDates;
    const inflow = allDates.map((d) => dailyByDate[d].inflow);
    const outflow = allDates.map((d) => dailyByDate[d].outflow);
    const net = allDates.map((d) => dailyByDate[d].inflow - dailyByDate[d].outflow);

    // Running balance
    let cumulative = 0;
    const runningBalance = net.map((n) => {
      cumulative += n;
      return cumulative;
    });

    return {
      labels,
      inflow,
      outflow,
      net,
      runningBalance,
    };
  }
}
