import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Settings, SettingsDocument } from './schemas/settings.schema';
import { UpdateSettingsDto } from './dto/settings.dto';

const DEFAULT_SHIP_COS = [
  { name: 'Bosta', cairo: 110, gov: 150 },
  { name: 'J&T Express', cairo: 110, gov: 150 },
  { name: 'Mylerz', cairo: 110, gov: 150 },
];

@Injectable()
export class SettingsService {
  constructor(
    @InjectModel(Settings.name)
    private readonly settingsModel: Model<SettingsDocument>,
  ) {}

  async getSettings(): Promise<SettingsDocument> {
    let settings = await this.settingsModel.findOne().exec();
    if (!settings) {
      settings = await this.settingsModel.create({
        cairoPrice: 110,
        govPrice: 150,
        shipCos: DEFAULT_SHIP_COS,
        vaultPass: '1234',
      });
    }
    return settings;
  }

  stripSensitive(doc: SettingsDocument): Record<string, unknown> {
    const obj = doc.toObject() as unknown as Record<string, unknown>;
    delete obj['vaultPass'];
    return obj;
  }

  async getSettingsSafe(): Promise<Record<string, unknown>> {
    const settings = await this.getSettings();
    return this.stripSensitive(settings);
  }

  async updateSettings(dto: UpdateSettingsDto): Promise<SettingsDocument> {
    const settings = await this.getSettings();
    Object.assign(settings, dto);
    return settings.save();
  }

  async verifyVaultPassword(password: string): Promise<boolean> {
    const settings = await this.getSettings();
    return password === settings.vaultPass;
  }

  async adjustVaultBalance(
    segment: string,
    amount: number,
  ): Promise<SettingsDocument> {
    const settings = await this.getSettings();
    switch (segment) {
      case 'vodafone':
        settings.vaultVodafone = (settings.vaultVodafone || 0) + amount;
        break;
      case 'instapay':
        settings.vaultInstapay = (settings.vaultInstapay || 0) + amount;
        break;
      case 'bank':
        settings.vaultBank = (settings.vaultBank || 0) + amount;
        break;
      default:
        settings.vaultCash = (settings.vaultCash || 0) + amount;
        break;
    }
    settings.vaultBalance =
      (settings.vaultCash || 0) +
      (settings.vaultVodafone || 0) +
      (settings.vaultInstapay || 0) +
      (settings.vaultBank || 0);
    return settings.save();
  }
}
