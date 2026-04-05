import { Injectable } from '@nestjs/common';
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

  async addEntry(dto: CreateVaultEntryDto): Promise<VaultEntryDocument> {
    const date = dto.date || new Date().toISOString().split('T')[0];
    const desc = dto.desc || 'تعديل يدوي';
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
