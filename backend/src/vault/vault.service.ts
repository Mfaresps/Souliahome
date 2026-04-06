import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { VaultEntry, VaultEntryDocument } from './schemas/vault-entry.schema';
import { SettingsService } from '../settings/settings.service';
import { resolveVaultSegmentFromPaymentMethod } from './vault-segment.util';
import { CreateVaultEntryDto } from './dto/vault.dto';

@Injectable()
export class VaultService {
  constructor(
    @InjectModel(VaultEntry.name)
    private readonly vaultModel: Model<VaultEntryDocument>,
    private readonly settingsService: SettingsService,
  ) {}

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
    });
  }
}
