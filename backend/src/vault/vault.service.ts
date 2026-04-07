import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { VaultEntry, VaultEntryDocument } from './schemas/vault-entry.schema';
import { SettingsService } from '../settings/settings.service';
import { resolveVaultSegmentFromPaymentMethod } from './vault-segment.util';
import { CreateVaultEntryDto, UpdateVaultEntryDto } from './dto/vault.dto';

@Injectable()
export class VaultService {
  constructor(
    @InjectModel(VaultEntry.name)
    private readonly vaultModel: Model<VaultEntryDocument>,
    private readonly settingsService: SettingsService,
  ) {}

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

  private generateTxNo(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
    return `V${ts}${rand}`;
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
    return this.vaultModel.create({
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
      txNo: this.generateTxNo(),
    });
  }

  async addSystemEntry(
    amount: number,
    method: string,
    desc: string,
    date: string,
    source = '',
    ref = '',
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
    return this.vaultModel.create({
      date,
      desc,
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
    });
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
    const query: Record<string, unknown> = { status: { $ne: 'cancelled' } };
    if (seg) query.seg = seg;

    const entries = await this.vaultModel.find(query).exec();
    const totalIncome = entries.filter((e) => e.amount > 0).reduce((s, e) => s + e.amount, 0);
    const totalExpense = Math.abs(entries.filter((e) => e.amount < 0).reduce((s, e) => s + e.amount, 0));
    const frozenTransactions = entries.filter((e) => e.status === 'frozen').length;
    const cancelledTransactions = await this.vaultModel.countDocuments({ status: 'cancelled' });
    const pendingApprovals = entries.filter((e) => e.requiresApproval && !e.isApproved).length;

    return {
      totalIncome,
      totalExpense,
      totalTransactions: entries.length,
      frozenTransactions,
      cancelledTransactions,
      pendingApprovals,
    };
  }
}
