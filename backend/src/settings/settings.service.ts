import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { ObjectId } from 'mongodb';
import { Settings, SettingsDocument } from './schemas/settings.schema';
import { UpdateSettingsDto, DiscountCodeDto } from './dto/settings.dto';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const DEFAULT_SHIP_COS = [
  { name: 'Bosta', cairo: 110, gov: 150 },
  { name: 'J&T Express', cairo: 110, gov: 150 },
  { name: 'Mylerz', cairo: 110, gov: 150 },
];

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

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

  async updateSettings(dto: UpdateSettingsDto, rawBody?: Record<string, unknown>): Promise<SettingsDocument> {
    const existing = await this.getSettings();
    const updated = await this.settingsModel.findByIdAndUpdate(
      existing._id,
      { $set: dto as Record<string, unknown> },
      { new: true, upsert: false },
    ).exec();
    return updated ?? existing;
  }

  async setStaffDiscount(value: boolean): Promise<SettingsDocument> {
    const settings = await this.getSettings();
    settings.staffDiscountEnabled = value;
    settings.markModified('staffDiscountEnabled');
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

  async getDiscountCodes(): Promise<SettingsDocument['discountCodes']> {
    const settings = await this.getSettings();
    return settings.discountCodes || [];
  }

  async addDiscountCode(dto: DiscountCodeDto, by: string): Promise<SettingsDocument> {
    const settings = await this.getSettings();
    const codes = settings.discountCodes || [];

    const upper = dto.code.trim().toUpperCase();
    if (codes.some(c => c.code.toUpperCase() === upper)) {
      throw new BadRequestException(`كود الخصم "${upper}" موجود مسبقاً`);
    }

    const now = new Date().toISOString();
    const newCode = {
      id: crypto.randomUUID(),
      code: upper,
      description: dto.description || '',
      type: dto.type,
      value: dto.value,
      startDate: dto.startDate || null,
      endDate: dto.endDate || null,
      active: dto.active !== false,
      usageCount: 0,
      createdBy: by,
      createdAt: now,
      auditLog: [{ action: 'created', by, at: now }],
      usageHistory: [],
    };

    codes.push(newCode as any);
    settings.discountCodes = codes;
    settings.markModified('discountCodes');
    return settings.save();
  }

  async updateDiscountCode(id: string, dto: Partial<DiscountCodeDto>, by: string): Promise<SettingsDocument> {
    const settings = await this.getSettings();
    const codes = settings.discountCodes || [];
    const idx = codes.findIndex(c => c.id === id);
    if (idx === -1) throw new NotFoundException('كود الخصم غير موجود');

    const now = new Date().toISOString();
    const existing = codes[idx] as any;

    if (dto.code !== undefined) {
      const upper = dto.code.trim().toUpperCase();
      if (codes.some((c, i) => i !== idx && c.code.toUpperCase() === upper)) {
        throw new BadRequestException(`كود الخصم "${upper}" موجود مسبقاً`);
      }
      existing.code = upper;
    }
    if (dto.description !== undefined) existing.description = dto.description;
    if (dto.type !== undefined) existing.type = dto.type;
    if (dto.value !== undefined) existing.value = dto.value;
    if (dto.startDate !== undefined) existing.startDate = dto.startDate || null;
    if (dto.endDate !== undefined) existing.endDate = dto.endDate || null;
    if (dto.active !== undefined) {
      const prevActive = existing.active;
      existing.active = dto.active;
      if (prevActive !== dto.active) {
        existing.auditLog = existing.auditLog || [];
        existing.auditLog.push({ action: dto.active ? 'activated' : 'deactivated', by, at: now });
      }
    }

    existing.auditLog = existing.auditLog || [];
    if (Object.keys(dto).some(k => k !== 'active')) {
      existing.auditLog.push({ action: 'updated', by, at: now });
    }

    codes[idx] = existing;
    settings.discountCodes = codes;
    settings.markModified('discountCodes');
    return settings.save();
  }

  async deleteDiscountCode(id: string, by: string): Promise<SettingsDocument> {
    const settings = await this.getSettings();
    const codes = settings.discountCodes || [];
    const idx = codes.findIndex(c => c.id === id);
    if (idx === -1) throw new NotFoundException('كود الخصم غير موجود');

    codes.splice(idx, 1);
    settings.discountCodes = codes;
    settings.markModified('discountCodes');
    return settings.save();
  }

  async recordDiscountUsage(
    codeId: string,
    usage: { txRef: string; txId: string; client: string; amount: number; by: string },
  ): Promise<void> {
    const settings = await this.getSettings();
    const codes = settings.discountCodes || [];
    const idx = codes.findIndex(c => c.id === codeId);
    if (idx === -1) return;

    const entry = codes[idx] as any;
    entry.usageCount = (entry.usageCount || 0) + 1;
    entry.usageHistory = entry.usageHistory || [];
    entry.usageHistory.push({ ...usage, at: new Date().toISOString() });
    codes[idx] = entry;
    settings.discountCodes = codes;
    settings.markModified('discountCodes');
    await settings.save();
  }

  async validateDiscountCode(code: string): Promise<{ valid: boolean; data?: any; message?: string }> {
    const settings = await this.getSettings();
    const codes = settings.discountCodes || [];
    const found = (codes as any[]).find(c => c.code.toUpperCase() === code.toUpperCase());

    if (!found) return { valid: false, message: 'كود الخصم غير موجود' };
    if (!found.active) return { valid: false, message: 'كود الخصم غير مفعل' };

    const now = new Date();
    if (found.startDate && new Date(found.startDate) > now) {
      return { valid: false, message: 'كود الخصم لم يبدأ بعد' };
    }
    if (found.endDate && new Date(found.endDate) < now) {
      return { valid: false, message: 'كود الخصم منتهي الصلاحية' };
    }

    return { valid: true, data: found };
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
    try {
      const backupDir = this.getBackupDir();
      const timestamp = this.formatDateTime();
      const filename = `backup_${timestamp}.json`;
      const filepath = path.join(backupDir, filename);

      const settings = await this.settingsModel.findOne().exec();
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
          vaultCash: settings?.vaultCash || 0,
          vaultVodafone: settings?.vaultVodafone || 0,
          vaultInstapay: settings?.vaultInstapay || 0,
          vaultBank: settings?.vaultBank || 0,
        },
      };

      fs.writeFileSync(filepath, JSON.stringify(backupData, null, 2));
      this.updateBackupRegistry(filename);
      this.logger.log(`Backup created: ${filename}`);

      return { success: true, filename, message: `✓ تم إنشاء نسخة احتياطية: ${filename}` };
    } catch (e: any) {
      this.logger.error('createBackup failed', e?.stack || e?.message);
      return { success: false, filename: '', message: `❌ فشل إنشاء النسخة الاحتياطية: ${e?.message || 'خطأ غير معروف'}` };
    }
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

  async readBackupContent(filename: string): Promise<any | null> {
    const backupDir = this.getBackupDir();
    const safeFilename = path.basename(filename);
    const filepath = path.join(backupDir, safeFilename);

    if (!fs.existsSync(filepath)) {
      return null;
    }

    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      return JSON.parse(raw);
    } catch (e: any) {
      this.logger.error(`readBackupContent failed for ${safeFilename}: ${e?.message}`);
      throw new BadRequestException('ملف النسخة الاحتياطية تالف أو غير صالح');
    }
  }

  async downloadBackupStream(filename: string): Promise<Buffer | null> {
    const backupDir = this.getBackupDir();
    let safeFilename = path.basename(filename);

    // Remove 'soulia-' prefix if present
    if (safeFilename.startsWith('soulia-')) {
      safeFilename = safeFilename.substring(7);
    }

    const filepath = path.join(backupDir, safeFilename);

    if (!fs.existsSync(filepath)) {
      this.logger.warn(`Backup file not found: ${safeFilename}`);
      return null;
    }

    try {
      return fs.readFileSync(filepath);
    } catch (e: any) {
      this.logger.error(`downloadBackupStream failed for ${safeFilename}`, e?.message);
      return null;
    }
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
        if (file !== 'registry.json' && (file.startsWith('backup_') || file.startsWith('soulia-backup_'))) {
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
      // Validate JSON format with UTF-8 encoding
      const fileContent = file.buffer.toString('utf8');
      const backupData = JSON.parse(fileContent);

      if (!backupData.data) {
        return {
          success: false,
          message: '❌ الملف غير صالح - لا يوجد حقل "data"',
        };
      }

      if (!backupData.timestamp) {
        return {
          success: false,
          message: '❌ الملف غير صالح - لا يوجد حقل "timestamp"',
        };
      }

      if (typeof backupData.data !== 'object' || !Array.isArray(backupData.data.transactions)) {
        return {
          success: false,
          message: '❌ صيغة الملف غير صحيحة - البنية الداخلية غير متوافقة',
        };
      }

      // Extract filename, remove 'soulia-' prefix and use a clean standardized format
      let filename = file.originalname || `backup_${this.formatDateTime()}.json`;

      // Remove 'soulia-' prefix if present
      if (filename.startsWith('soulia-')) {
        filename = filename.substring(7); // Remove 'soulia-' (7 chars)
      }

      // Ensure it starts with 'backup_'
      if (!filename.startsWith('backup_')) {
        filename = `backup_${filename}`;
      }

      // Save file to backups directory with UTF-8 encoding
      const backupDir = this.getBackupDir();
      const filepath = path.join(backupDir, filename);

      fs.writeFileSync(filepath, JSON.stringify(backupData, null, 2), 'utf8');

      // Update registry
      this.updateBackupRegistry(filename);

      this.logger.log(`Backup uploaded: ${filename}`);
      return {
        success: true,
        message: `✓ تم استيراد النسخة الاحتياطية: ${filename}`,
        filename,
      };
    } catch (e: any) {
      this.logger.error('uploadBackup failed', e?.message);
      return {
        success: false,
        message: `❌ خطأ في معالجة الملف - ${e?.message || 'تأكد من أنه ملف نسخة احتياطية صحيح'}`,
      };
    }
  }

  async restoreBackup(filename: string) {
    const backupDir = this.getBackupDir();

    // Prevent path traversal and normalize filename
    let safeFilename = path.basename(filename);

    // Remove 'soulia-' prefix if present
    if (safeFilename.startsWith('soulia-')) {
      safeFilename = safeFilename.substring(7);
    }

    const filepath = path.join(backupDir, safeFilename);

    if (!fs.existsSync(filepath)) {
      this.logger.warn(`Backup file not found: ${safeFilename} (searched for: ${filepath})`);
      return { success: false, message: 'ملف النسخة الاحتياطية غير موجود' };
    }

    let backupData: any;
    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      backupData = JSON.parse(raw);
    } catch (e: any) {
      this.logger.error('Failed to parse backup file', e?.message);
      return { success: false, message: 'ملف النسخة الاحتياطية تالف أو غير صالح' };
    }

    if (!backupData?.data || typeof backupData.data !== 'object') {
      return { success: false, message: 'صيغة الملف غير صحيحة - لا يوجد حقل data' };
    }

    const restoreResults: Record<string, number> = {};

    // Step 1: Delete current data
    const collections = Object.keys(backupData.data);
    for (const collectionName of collections) {
      try {
        await this.connection.collection(collectionName).deleteMany({});
      } catch (e: any) {
        this.logger.warn(`Could not clear collection ${collectionName}: ${e?.message}`);
      }
    }

    // Step 2: Restore each collection
    for (const [collectionName, docs] of Object.entries(backupData.data)) {
      try {
        if (!Array.isArray(docs) || docs.length === 0) {
          restoreResults[collectionName] = 0;
          continue;
        }

        const fixedDocs = (docs as any[]).map((doc: any) => {
          const fixed: any = { ...doc };
          // Convert _id string → ObjectId
          if (fixed._id) {
            const rawId = typeof fixed._id === 'string' ? fixed._id : fixed._id?.$oid;
            if (rawId) {
              try { fixed._id = new ObjectId(rawId); } catch { delete fixed._id; }
            }
          }
          return fixed;
        });

        try {
          await this.connection.collection(collectionName).insertMany(fixedDocs, { ordered: false });
          restoreResults[collectionName] = fixedDocs.length;
        } catch (bulkErr: any) {
          // MongoBulkWriteError with partial success
          const inserted = bulkErr?.result?.insertedCount ?? bulkErr?.insertedCount ?? 0;
          this.logger.warn(`Partial restore on ${collectionName}: inserted=${inserted}, err=${bulkErr?.message}`);
          restoreResults[collectionName] = inserted;
        }
      } catch (e: any) {
        this.logger.error(`Failed to restore collection ${collectionName}`, e?.message);
        restoreResults[collectionName] = -1;
      }
    }

    // Step 3: Restore vault balances
    try {
      const settings = await this.settingsModel.findOne().exec();
      if (settings && backupData.vault_balances) {
        settings.vaultCash = Number(backupData.vault_balances.vaultCash) || 0;
        settings.vaultVodafone = Number(backupData.vault_balances.vaultVodafone) || 0;
        settings.vaultInstapay = Number(backupData.vault_balances.vaultInstapay) || 0;
        settings.vaultBank = Number(backupData.vault_balances.vaultBank) || 0;
        settings.vaultBalance = settings.vaultCash + settings.vaultVodafone + settings.vaultInstapay + settings.vaultBank;
        await settings.save();
        restoreResults['vault_balances'] = 1;
      }
    } catch (e: any) {
      this.logger.error('Failed to restore vault balances', e?.message);
      restoreResults['vault_balances'] = 0;
    }

    this.logger.log(`Restore complete from ${safeFilename}: ${JSON.stringify(restoreResults)}`);
    return {
      success: true,
      message: `✓ تم استرجاع البيانات بنجاح من: ${safeFilename}`,
      restored: restoreResults,
    };
  }
}
