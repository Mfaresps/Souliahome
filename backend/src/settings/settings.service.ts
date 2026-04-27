import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { Settings, SettingsDocument } from './schemas/settings.schema';
import { UpdateSettingsDto } from './dto/settings.dto';
import * as fs from 'fs';
import * as path from 'path';

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
    @InjectConnection() private readonly connection: Connection,
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

  private getBackupDir(): string {
    const dir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private formatDateTime(): string {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
  }

  async createBackup(): Promise<{ success: boolean; filename: string; message: string }> {
    const backupDir = this.getBackupDir();
    const timestamp = this.formatDateTime();
    const filename = `backup_${timestamp}.json`;
    const filepath = path.join(backupDir, filename);

    const backupData = {
      timestamp: new Date().toISOString(),
      data: {
        transactions: await this.connection.collection('transactions').find({}).toArray(),
        vaultentries: await this.connection.collection('vaultentries').find({}).toArray(),
        clients: await this.connection.collection('clients').find({}).toArray(),
        suppliers: await this.connection.collection('suppliers').find({}).toArray(),
        returnrequests: await this.connection.collection('returnrequests').find({}).toArray(),
        expenses: await this.connection.collection('expenses').find({}).toArray(),
        complaints: await this.connection.collection('complaints').find({}).toArray(),
      },
      vault_balances: {
        vaultCash: (await this.settingsModel.findOne().exec())?.vaultCash || 0,
        vaultVodafone: (await this.settingsModel.findOne().exec())?.vaultVodafone || 0,
        vaultInstapay: (await this.settingsModel.findOne().exec())?.vaultInstapay || 0,
        vaultBank: (await this.settingsModel.findOne().exec())?.vaultBank || 0,
      },
    };

    fs.writeFileSync(filepath, JSON.stringify(backupData, null, 2));

    // Update backup registry
    this.updateBackupRegistry(filename);

    return {
      success: true,
      filename,
      message: `✓ تم إنشاء نسخة احتياطية: ${filename}`,
    };
  }

  private updateBackupRegistry(filename: string): void {
    const backupDir = this.getBackupDir();
    const registryPath = path.join(backupDir, 'registry.json');

    let registry: Array<{ filename: string; date: string }> = [];
    if (fs.existsSync(registryPath)) {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    }

    registry.unshift({ filename, date: new Date().toISOString() });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  }

  async getBackupList(): Promise<Array<{ filename: string; date: string }>> {
    const backupDir = this.getBackupDir();
    const registryPath = path.join(backupDir, 'registry.json');

    if (!fs.existsSync(registryPath)) {
      return [];
    }

    return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  }

  async resetAllData() {
    // Step 1: Create backup first
    const backup = await this.createBackup();
    if (!backup.success) {
      return {
        success: false,
        message: 'فشل في إنشاء النسخة الاحتياطية - تم إلغاء عملية المسح',
      };
    }

    // Step 2: Delete all data
    const collections = [
      'transactions',
      'vaultentries',
      'clients',
      'suppliers',
      'returnrequests',
      'expenses',
      'complaints',
    ];

    const results: Record<string, number> = {};
    for (const collectionName of collections) {
      try {
        const result = await this.connection
          .collection(collectionName)
          .deleteMany({});
        results[collectionName] = result.deletedCount;
      } catch (e) {
        results[collectionName] = 0;
      }
    }

    // Step 3: Reset vault balances
    try {
      const settings = await this.settingsModel.findOne().exec();
      if (settings) {
        settings.vaultCash = 0;
        settings.vaultVodafone = 0;
        settings.vaultInstapay = 0;
        settings.vaultBank = 0;
        settings.vaultBalance = 0;
        await settings.save();
        results['vault_balances_reset'] = 1;
      }
    } catch (e) {
      results['vault_balances_reset'] = 0;
    }

    return {
      success: true,
      message: `✓ تم مسح جميع البيانات بنجاح\n📦 نسخة احتياطية: ${backup.filename}`,
      deleted: results,
      backup: backup.filename,
    };
  }

  async downloadBackupStream(res: any, filename: string): Promise<void> {
    const backupDir = this.getBackupDir();
    const filepath = path.join(backupDir, filename);

    if (!fs.existsSync(filepath)) {
      res.status(404).json({ success: false, message: 'ملف النسخة الاحتياطية غير موجود' });
      return;
    }

    res.header('Content-Disposition', `attachment; filename="soulia-${filename}"`);
    const fileStream = fs.createReadStream(filepath);
    fileStream.pipe(res);
  }

  downloadBackup(res: any, filename: string) {
    const backupDir = this.getBackupDir();
    const filepath = path.join(backupDir, filename);

    if (!fs.existsSync(filepath)) {
      res.status(404);
      res.json({ success: false, message: 'ملف النسخة الاحتياطية غير موجود' });
      return;
    }

    const fileContent = fs.readFileSync(filepath);
    res.header('Content-Type', 'application/json; charset=utf-8');
    res.header('Content-Length', fileContent.length.toString());
    res.header('Content-Disposition', `attachment; filename="soulia-${filename}"`);
    res.send(fileContent);
  }

  async deleteAllBackups(): Promise<{ success: boolean; message: string }> {
    const backupDir = this.getBackupDir();
    const registryPath = path.join(backupDir, 'registry.json');

    try {
      const files = fs.readdirSync(backupDir);
      for (const file of files) {
        if (file !== 'registry.json' && file.startsWith('backup_')) {
          const filepath = path.join(backupDir, file);
          fs.unlinkSync(filepath);
        }
      }

      // Clear registry
      fs.writeFileSync(registryPath, JSON.stringify([], null, 2));

      return {
        success: true,
        message: '✓ تم حذف جميع النسخ الاحتياطية',
      };
    } catch (e) {
      return {
        success: false,
        message: '❌ فشل في حذف النسخ الاحتياطية',
      };
    }
  }

  async uploadBackup(file: any): Promise<{ success: boolean; message: string; filename?: string }> {
    if (!file) {
      return {
        success: false,
        message: 'لم يتم تحديد ملف',
      };
    }

    try {
      // Validate JSON format
      const backupData = JSON.parse(file.buffer.toString());
      if (!backupData.data || !backupData.timestamp) {
        return {
          success: false,
          message: 'صيغة الملف غير صحيحة - يجب أن يكون ملف نسخة احتياطية صحيح',
        };
      }

      // Save file to backups directory
      const backupDir = this.getBackupDir();
      const timestamp = this.formatDateTime();
      const filename = `backup_imported_${timestamp}.json`;
      const filepath = path.join(backupDir, filename);

      fs.writeFileSync(filepath, JSON.stringify(backupData, null, 2));

      // Update registry
      this.updateBackupRegistry(filename);

      return {
        success: true,
        message: `✓ تم استيراد النسخة الاحتياطية: ${filename}`,
        filename,
      };
    } catch (e) {
      return {
        success: false,
        message: '❌ خطأ في معالجة الملف - تأكد من أنه ملف نسخة احتياطية صحيح',
      };
    }
  }

  async restoreBackup(filename: string) {
    const backupDir = this.getBackupDir();
    const filepath = path.join(backupDir, filename);

    if (!fs.existsSync(filepath)) {
      return {
        success: false,
        message: 'ملف النسخة الاحتياطية غير موجود',
      };
    }

    const backupData = JSON.parse(fs.readFileSync(filepath, 'utf8'));

    // Restore each collection
    const restoreResults: Record<string, number> = {};

    // First, delete current data
    const collections = Object.keys(backupData.data);
    for (const collectionName of collections) {
      try {
        await this.connection.collection(collectionName).deleteMany({});
      } catch (e) {
        // Ignore delete errors
      }
    }

    // Then, restore from backup
    for (const [collectionName, docs] of Object.entries(backupData.data)) {
      try {
        if (Array.isArray(docs) && docs.length > 0) {
          await this.connection.collection(collectionName).insertMany(docs);
          restoreResults[collectionName] = (docs as any[]).length;
        } else {
          restoreResults[collectionName] = 0;
        }
      } catch (e) {
        restoreResults[collectionName] = 0;
      }
    }

    // Restore vault balances
    try {
      const settings = await this.settingsModel.findOne().exec();
      if (settings && backupData.vault_balances) {
        settings.vaultCash = backupData.vault_balances.vaultCash || 0;
        settings.vaultVodafone = backupData.vault_balances.vaultVodafone || 0;
        settings.vaultInstapay = backupData.vault_balances.vaultInstapay || 0;
        settings.vaultBank = backupData.vault_balances.vaultBank || 0;
        settings.vaultBalance = (settings.vaultCash || 0) + (settings.vaultVodafone || 0) +
                               (settings.vaultInstapay || 0) + (settings.vaultBank || 0);
        await settings.save();
        restoreResults['vault_balances'] = 1;
      }
    } catch (e) {
      restoreResults['vault_balances'] = 0;
    }

    return {
      success: true,
      message: `✓ تم استرجاع البيانات بنجاح من: ${filename}`,
      restored: restoreResults,
    };
  }
}
