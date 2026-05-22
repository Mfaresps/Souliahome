import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { ObjectId } from 'mongodb';
import { Settings, SettingsDocument } from './schemas/settings.schema';
import { UpdateSettingsDto, DiscountCodeDto, DiscountBundleDto } from './dto/settings.dto';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const DEFAULT_SHIP_COS = [
  { name: 'Bosta', cairo: 110, gov: 150 },
  { name: 'J&T Express', cairo: 110, gov: 150 },
  { name: 'Mylerz', cairo: 110, gov: 150 },
];

/** Apply default values for fields added after the backup was created */
function def<T>(obj: any, key: string, value: T): void {
  if (obj[key] === undefined || obj[key] === null) obj[key] = value;
}

function migrateDoc(collection: string, doc: any): void {
  if (collection === 'transactions') {
    def(doc, 'deposit', 0);
    def(doc, 'initialDeposit', 0);
    def(doc, 'remaining', 0);
    def(doc, 'itemsTotal', 0);
    def(doc, 'discount', 0);
    def(doc, 'discountCodeId', '');
    def(doc, 'discountCode', '');
    def(doc, 'discountCodeType', '');
    def(doc, 'shipCost', 0);
    def(doc, 'actualShipCost', 0);
    def(doc, 'shipLoss', 0);
    def(doc, 'payment', '');
    def(doc, 'payStatus', 'معلق');
    def(doc, 'cancelled', false);
    def(doc, 'archived', false);
    def(doc, 'editHistory', []);
    def(doc, 'deposits', []);
    def(doc, 'payments', []);
    def(doc, 'comments', []);
    def(doc, 'tags', []);
    def(doc, 'invoiceImageUrl', '');
    def(doc, 'invoiceImages', []);
    def(doc, 'cancelRequest', null);
    // Normalise items
    if (Array.isArray(doc.items)) {
      doc.items = doc.items.map((it: any) => ({
        productId: it.productId ?? '',
        code: it.code ?? '',
        name: it.name ?? '',
        qty: it.qty ?? 1,
        price: it.price ?? 0,
        total: it.total ?? (it.qty ?? 1) * (it.price ?? 0),
      }));
    }
    return;
  }

  if (collection === 'products') {
    def(doc, 'sellPrice', 0);
    def(doc, 'buyPrice', 0);
    def(doc, 'minStock', 10);
    def(doc, 'openingBalance', 0);
    def(doc, 'supplier', '');
    def(doc, 'imageUrl', '');
    return;
  }

  if (collection === 'expenses') {
    def(doc, 'status', 'معتمد');
    def(doc, 'amount', 0);
    def(doc, 'category', '');
    def(doc, 'note', '');
    return;
  }

  if (collection === 'users') {
    def(doc, 'role', 'staff');
    def(doc, 'active', true);
    return;
  }

  if (collection === 'products') {
    def(doc, 'sellPrice', 0);
    def(doc, 'buyPrice', 0);
    def(doc, 'minStock', 10);
    def(doc, 'openingBalance', 0);
    def(doc, 'supplier', '');
    def(doc, 'imageUrl', '');
    def(doc, 'editRequest', null);
    return;
  }

  if (collection === 'shopifyorders') {
    def(doc, 'status', 'pending');
    def(doc, 'pendingStatus', '');
    def(doc, 'items', []);
    def(doc, 'total', 0);
    def(doc, 'itemsTotal', 0);
    def(doc, 'shipCost', 0);
    def(doc, 'discount', 0);
    def(doc, 'discountCode', '');
    def(doc, 'discountType', '');
    def(doc, 'discountValue', 0);
    def(doc, 'tags', '');
    def(doc, 'shippingAddress', '');
    def(doc, 'orderStatusUrl', '');
    return;
  }
}

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
    // Replace bostaApiKey with a masked flag — never expose raw key to frontend
    obj['bostaApiKeySet'] = !!(obj['bostaApiKey'] as string);
    delete obj['bostaApiKey'];
    return obj;
  }

  async saveBostaApiKey(key: string): Promise<void> {
    const settings = await this.getSettings();
    await this.settingsModel.findByIdAndUpdate(
      settings._id,
      { $set: { bostaApiKey: key.trim() } },
      { new: true },
    ).exec();
  }

  async getBostaApiKey(): Promise<string> {
    const settings = await this.getSettings();
    return (settings as any).bostaApiKey || process.env.BOSTA_API_KEY || '';
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

  async getDiscountBundles(): Promise<SettingsDocument['discountBundles']> {
    const settings = await this.getSettings();
    return settings.discountBundles || [];
  }

  async addDiscountBundle(dto: DiscountBundleDto, by: string): Promise<SettingsDocument> {
    const settings = await this.getSettings();
    const bundles = settings.discountBundles || [];
    const now = new Date().toISOString();
    bundles.push({
      id: crypto.randomUUID(),
      name: dto.name,
      description: dto.description || '',
      productIds: dto.productIds || [],
      discountCodeId: dto.discountCodeId,
      active: dto.active !== false,
      allowPartial: dto.allowPartial || false,
      partialDiscountCodeId: dto.partialDiscountCodeId || null,
      priority: dto.priority ?? 1,
      minQty: dto.minQty ?? 1,
      productMinQtys: dto.productMinQtys ?? {},
      createdBy: by,
      createdAt: now,
    } as any);
    settings.discountBundles = bundles;
    settings.markModified('discountBundles');
    return settings.save();
  }

  async updateDiscountBundle(id: string, dto: Partial<DiscountBundleDto>, by: string): Promise<SettingsDocument> {
    const settings = await this.getSettings();
    const bundles = settings.discountBundles || [];
    const idx = bundles.findIndex((b: any) => b.id === id);
    if (idx === -1) throw new NotFoundException('الباقة غير موجودة');
    const b = bundles[idx] as any;
    if (dto.name !== undefined) b.name = dto.name;
    if (dto.description !== undefined) b.description = dto.description;
    if (dto.productIds !== undefined) b.productIds = dto.productIds;
    if (dto.discountCodeId !== undefined) b.discountCodeId = dto.discountCodeId;
    if (dto.active !== undefined) b.active = dto.active;
    if (dto.allowPartial !== undefined) b.allowPartial = dto.allowPartial;
    if (dto.partialDiscountCodeId !== undefined) b.partialDiscountCodeId = dto.partialDiscountCodeId || null;
    if (dto.priority !== undefined) b.priority = dto.priority;
    if (dto.minQty !== undefined) b.minQty = dto.minQty;
    if (dto.productMinQtys !== undefined) b.productMinQtys = dto.productMinQtys;
    bundles[idx] = b;
    settings.discountBundles = bundles;
    settings.markModified('discountBundles');
    return settings.save();
  }

  async deleteDiscountBundle(id: string): Promise<SettingsDocument> {
    const settings = await this.getSettings();
    const bundles = settings.discountBundles || [];
    const idx = bundles.findIndex((b: any) => b.id === id);
    if (idx === -1) throw new NotFoundException('الباقة غير موجودة');
    bundles.splice(idx, 1);
    settings.discountBundles = bundles;
    settings.markModified('discountBundles');
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
          products: await this.connection.collection('products').find({}).toArray(),
          vaultentries: await this.connection.collection('vaultentries').find({}).toArray(),
          clients: await this.connection.collection('clients').find({}).toArray(),
          suppliers: await this.connection.collection('suppliers').find({}).toArray(),
          returnrequests: await this.connection.collection('returnrequests').find({}).toArray(),
          expenses: await this.connection.collection('expenses').find({}).toArray(),
          complaints: await this.connection.collection('complaints').find({}).toArray(),
          shopifyorders: await this.connection.collection('shopifyorders').find({}).toArray(),
          followups: await this.connection.collection('followups').find({}).toArray(),
          mentions: await this.connection.collection('mentions').find({}).toArray(),
          tags: await this.connection.collection('tags').find({}).toArray(),
          users: await this.connection.collection('users').find({}).toArray(),
        },
        vault_balances: {
          vaultCash: settings?.vaultCash || 0,
          vaultVodafone: settings?.vaultVodafone || 0,
          vaultInstapay: settings?.vaultInstapay || 0,
          vaultBank: settings?.vaultBank || 0,
        },
        offers: {
          discountCodes: (settings?.discountCodes as any[]) || [],
          discountBundles: (settings?.discountBundles as any[]) || [],
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

  static readonly ALLOWED_COLLECTIONS = [
    'transactions',
    'products',
    'vaultentries',
    'clients',
    'suppliers',
    'returnrequests',
    'expenses',
    'complaints',
    'shopifyorders',
    'followups',
    'mentions',
    'discountotps',
    'tags',
  ];

  async resetAllData() {
    return this.resetSelectiveData(SettingsService.ALLOWED_COLLECTIONS, true);
  }

  async resetSelectiveData(selectedCollections: string[], resetVault: boolean) {
    // Whitelist check
    const allowed = SettingsService.ALLOWED_COLLECTIONS;
    const safeCollections = selectedCollections.filter(c => allowed.includes(c));

    // Step 1: Create backup first
    const backup = await this.createBackup();
    if (!backup.success) {
      return {
        success: false,
        message: 'فشل في إنشاء النسخة الاحتياطية - تم إلغاء عملية المسح',
      };
    }

    // Step 2: Delete selected collections
    const results: Record<string, number> = {};
    for (const collectionName of safeCollections) {
      try {
        const result = await this.connection
          .collection(collectionName)
          .deleteMany({});
        results[collectionName] = result.deletedCount;
      } catch (e) {
        results[collectionName] = 0;
      }
    }

    // Step 3: Reset vault balances if requested
    if (resetVault) {
      try {
        const settings = await this.settingsModel.findOne().exec();
        if (settings) {
          settings.vaultCash = 0;
          settings.vaultVodafone = 0;
          settings.vaultInstapay = 0;
          settings.vaultBank = 0;
          settings.vaultBalance = 0;
          settings.discountCodes = [];
          settings.discountBundles = [];
          settings.markModified('discountCodes');
          settings.markModified('discountBundles');
          await settings.save();
          results['vault_balances_reset'] = 1;
          results['offers_cleared'] = 1;
        }
      } catch (e) {
        results['vault_balances_reset'] = 0;
        results['offers_cleared'] = 0;
      }
    }

    const deletedNames = safeCollections.join(', ');
    return {
      success: true,
      message: `✓ تم مسح البيانات المحددة بنجاح\n📦 نسخة احتياطية: ${backup.filename}`,
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

    // Step 1: Delete current data (never touch users collection)
    const collections = Object.keys(backupData.data).filter(c => c !== 'users');
    for (const collectionName of collections) {
      try {
        await this.connection.collection(collectionName).deleteMany({});
      } catch (e: any) {
        this.logger.warn(`Could not clear collection ${collectionName}: ${e?.message}`);
      }
    }

    // Step 2: Restore each collection (skip users to preserve current accounts)
    for (const [collectionName, docs] of Object.entries(backupData.data)) {
      if (collectionName === 'users') continue;
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
          // Apply schema migrations so restored docs match current schema
          migrateDoc(collectionName, fixed);
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

    // Step 3: Restore vault balances and offers
    try {
      const settings = await this.settingsModel.findOne().exec();
      if (settings) {
        if (backupData.vault_balances) {
          settings.vaultCash = Number(backupData.vault_balances.vaultCash) || 0;
          settings.vaultVodafone = Number(backupData.vault_balances.vaultVodafone) || 0;
          settings.vaultInstapay = Number(backupData.vault_balances.vaultInstapay) || 0;
          settings.vaultBank = Number(backupData.vault_balances.vaultBank) || 0;
          settings.vaultBalance = settings.vaultCash + settings.vaultVodafone + settings.vaultInstapay + settings.vaultBank;
          restoreResults['vault_balances'] = 1;
        }
        if (backupData.offers) {
          if (Array.isArray(backupData.offers.discountCodes)) {
            settings.discountCodes = backupData.offers.discountCodes;
            settings.markModified('discountCodes');
            restoreResults['discountCodes'] = backupData.offers.discountCodes.length;
          }
          if (Array.isArray(backupData.offers.discountBundles)) {
            settings.discountBundles = backupData.offers.discountBundles;
            settings.markModified('discountBundles');
            restoreResults['discountBundles'] = backupData.offers.discountBundles.length;
          }
        }
        await settings.save();
      }
    } catch (e: any) {
      this.logger.error('Failed to restore vault balances / offers', e?.message);
      restoreResults['vault_balances'] = 0;
      restoreResults['offers'] = 0;
    }

    this.logger.log(`Restore complete from ${safeFilename}: ${JSON.stringify(restoreResults)}`);
    return {
      success: true,
      message: `✓ تم استرجاع البيانات بنجاح من: ${safeFilename}`,
      restored: restoreResults,
    };
  }

  private static SECTION_COLLECTIONS: Record<string, string[]> = {
    transactions:   ['transactions', 'returnrequests'],
    products:       ['products'],
    customers:      ['clients', 'suppliers'],
    expenses:       ['expenses'],
    vault:          ['vaultentries'],
    other:          ['complaints', 'followups', 'tags', 'shopifyorders', 'mentions'],
  };

  private static DATE_FIELD: Record<string, string> = {
    transactions:   'date',
    returnrequests: 'date',
    products:       'updatedAt',
    clients:        'createdAt',
    suppliers:      'createdAt',
    expenses:       'date',
    vaultentries:   'date',
    complaints:     'createdAt',
    followups:      'createdAt',
  };

  private async getLatestDate(col: string): Promise<string | null> {
    const dateField = SettingsService.DATE_FIELD[col];
    if (!dateField) return null;
    try {
      const sort: Record<string, number> = {};
      sort[dateField] = -1;
      const doc = await this.connection.collection(col).findOne({}, { sort } as any);
      if (!doc) return null;
      const val = doc[dateField];
      if (!val) return null;
      return new Date(val).toLocaleDateString('ar-EG', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch { return null; }
  }

  private getLatestDateFromDocs(docs: any[], dateField: string): string | null {
    if (!Array.isArray(docs) || docs.length === 0 || !dateField) return null;
    let latest: Date | null = null;
    for (const doc of docs) {
      const val = doc[dateField];
      if (!val) continue;
      const d = new Date(val);
      if (!isNaN(d.getTime()) && (!latest || d > latest)) latest = d;
    }
    if (!latest) return null;
    return latest.toLocaleDateString('ar-EG', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  private fmtDate(val: any): string | null {
    if (!val) return null;
    try {
      const d = new Date(val);
      if (isNaN(d.getTime())) return null;
      return d.toLocaleDateString('ar-EG', { day: '2-digit', month: '2-digit', year: 'numeric' });
    } catch { return null; }
  }

  private sumField(docs: any[], field: string): number {
    return docs.reduce((s, d) => s + (Number(d[field]) || 0), 0);
  }

  private buildTransactionsStats(txDocs: any[], retDocs: any[]): Record<string, any> {
    const sales    = txDocs.filter(t => t.type === 'مبيعات');
    const purchases= txDocs.filter(t => t.type === 'مشتريات');
    const returns  = retDocs;
    const cancelled= txDocs.filter(t => t.cancelled);
    const pending  = txDocs.filter(t => t.payStatus === 'معلق');
    return {
      salesCount:     sales.length,
      salesTotal:     this.sumField(sales, 'total'),
      purchaseCount:  purchases.length,
      purchaseTotal:  this.sumField(purchases, 'total'),
      returnCount:    returns.length,
      cancelledCount: cancelled.length,
      pendingPayment: pending.length,
      maxSale:        sales.length ? Math.max(...sales.map(s => Number(s.total) || 0)) : 0,
    };
  }

  private buildProductsStats(docs: any[]): Record<string, any> {
    const totalUnits  = docs.reduce((s, p) => s + (Number(p.stock) || 0), 0);
    const outOfStock  = docs.filter(p => (Number(p.stock) || 0) === 0).length;
    const lowStock    = docs.filter(p => (Number(p.stock) || 0) > 0 && (Number(p.stock) || 0) <= (Number(p.minStock) || 5)).length;
    const categories  = [...new Set(docs.map(p => p.category).filter(Boolean))].length;
    return { totalUnits, outOfStock, lowStock, categories, productCount: docs.length };
  }

  private buildCustomersStats(clientDocs: any[], supplierDocs: any[]): Record<string, any> {
    const withDebt    = clientDocs.filter(c => (Number(c.balance) || 0) > 0).length;
    const totalDebt   = this.sumField(clientDocs, 'balance');
    const supDebt     = this.sumField(supplierDocs, 'balance');
    return {
      clientCount:    clientDocs.length,
      supplierCount:  supplierDocs.length,
      clientsWithDebt: withDebt,
      totalClientDebt: totalDebt,
      totalSupplierDebt: supDebt,
    };
  }

  private buildExpensesStats(docs: any[]): Record<string, any> {
    const approved  = docs.filter(e => e.status === 'معتمد');
    const pending   = docs.filter(e => e.status === 'معلق');
    const total     = this.sumField(approved, 'amount');
    const maxExp    = docs.length ? Math.max(...docs.map(e => Number(e.amount) || 0)) : 0;
    const categories= [...new Set(docs.map(e => e.category).filter(Boolean))].length;
    return { total, approvedCount: approved.length, pendingCount: pending.length, maxExpense: maxExp, categories };
  }

  private buildVaultStats(docs: any[]): Record<string, any> {
    const inflow  = docs.filter(v => (Number(v.amount) || 0) > 0);
    const outflow = docs.filter(v => (Number(v.amount) || 0) < 0);
    const net     = docs.reduce((s, v) => s + (Number(v.amount) || 0), 0);
    return {
      entryCount: docs.length,
      inflowCount: inflow.length,
      inflowTotal: this.sumField(inflow, 'amount'),
      outflowCount: outflow.length,
      outflowTotal: Math.abs(docs.filter(v => (Number(v.amount)||0)<0).reduce((s,v)=>s+(Number(v.amount)||0),0)),
      net,
    };
  }

  async previewSelectiveRestore(filename: string): Promise<any> {
    const backupDir = this.getBackupDir();
    let safeFilename = path.basename(filename);
    if (safeFilename.startsWith('soulia-')) safeFilename = safeFilename.substring(7);
    const filepath = path.join(backupDir, safeFilename);

    if (!fs.existsSync(filepath)) return { success: false, message: 'ملف النسخة الاحتياطية غير موجود' };

    let backupData: any;
    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      backupData = JSON.parse(raw);
    } catch {
      return { success: false, message: 'ملف النسخة الاحتياطية تالف أو غير صالح' };
    }

    const d = backupData?.data || {};
    const preview: Record<string, any> = {};

    // ── Transactions ──────────────────────────────────────────────────────────
    {
      const bTx  = Array.isArray(d.transactions)    ? d.transactions    : [];
      const bRet = Array.isArray(d.returnrequests)  ? d.returnrequests  : [];
      const cTxCount  = await this.connection.collection('transactions').countDocuments().catch(()=>0);
      const cRetCount = await this.connection.collection('returnrequests').countDocuments().catch(()=>0);
      const cLatestTx  = await this.getLatestDate('transactions');
      const cLatestRet = await this.getLatestDate('returnrequests');
      const cLatest = [cLatestTx, cLatestRet].filter(Boolean).sort().pop() || null;
      const bLatestTx  = this.getLatestDateFromDocs(bTx,  'date');
      const bLatestRet = this.getLatestDateFromDocs(bRet, 'date');
      const bLatest = [bLatestTx, bLatestRet].filter(Boolean).sort().pop() || null;

      // current stats from db
      const [cTxDocs, cRetDocs] = await Promise.all([
        this.connection.collection('transactions').find({}).toArray().catch(()=>[]),
        this.connection.collection('returnrequests').find({}).toArray().catch(()=>[]),
      ]);

      preview['transactions'] = {
        backup:  bTx.length + bRet.length,
        current: cTxCount + cRetCount,
        backupLatest: bLatest, currentLatest: cLatest,
        backupStats:  this.buildTransactionsStats(bTx, bRet),
        currentStats: this.buildTransactionsStats(cTxDocs as any[], cRetDocs as any[]),
      };
    }

    // ── Products ─────────────────────────────────────────────────────────────
    {
      const bDocs = Array.isArray(d.products) ? d.products : [];
      const cCount = await this.connection.collection('products').countDocuments().catch(()=>0);
      const cLatest = await this.getLatestDate('products');
      const cDocs = await this.connection.collection('products').find({}).toArray().catch(()=>[]);
      preview['products'] = {
        backup:  bDocs.length,
        current: cCount,
        backupLatest:  this.getLatestDateFromDocs(bDocs, 'updatedAt'),
        currentLatest: cLatest,
        backupStats:  this.buildProductsStats(bDocs),
        currentStats: this.buildProductsStats(cDocs as any[]),
      };
    }

    // ── Customers ─────────────────────────────────────────────────────────────
    {
      const bClients   = Array.isArray(d.clients)   ? d.clients   : [];
      const bSuppliers = Array.isArray(d.suppliers)  ? d.suppliers : [];
      const cCliCount  = await this.connection.collection('clients').countDocuments().catch(()=>0);
      const cSupCount  = await this.connection.collection('suppliers').countDocuments().catch(()=>0);
      const cCliLatest = await this.getLatestDate('clients');
      const cSupLatest = await this.getLatestDate('suppliers');
      const cLatest = [cCliLatest, cSupLatest].filter(Boolean).sort().pop() || null;
      const bLatest = [
        this.getLatestDateFromDocs(bClients,   'createdAt'),
        this.getLatestDateFromDocs(bSuppliers, 'createdAt'),
      ].filter(Boolean).sort().pop() || null;
      const [cCliDocs, cSupDocs] = await Promise.all([
        this.connection.collection('clients').find({}).toArray().catch(()=>[]),
        this.connection.collection('suppliers').find({}).toArray().catch(()=>[]),
      ]);
      preview['customers'] = {
        backup:  bClients.length + bSuppliers.length,
        current: cCliCount + cSupCount,
        backupLatest: bLatest, currentLatest: cLatest,
        backupStats:  this.buildCustomersStats(bClients, bSuppliers),
        currentStats: this.buildCustomersStats(cCliDocs as any[], cSupDocs as any[]),
      };
    }

    // ── Expenses ──────────────────────────────────────────────────────────────
    {
      const bDocs  = Array.isArray(d.expenses) ? d.expenses : [];
      const cCount = await this.connection.collection('expenses').countDocuments().catch(()=>0);
      const cLatest= await this.getLatestDate('expenses');
      const cDocs  = await this.connection.collection('expenses').find({}).toArray().catch(()=>[]);
      preview['expenses'] = {
        backup:  bDocs.length,
        current: cCount,
        backupLatest:  this.getLatestDateFromDocs(bDocs, 'date'),
        currentLatest: cLatest,
        backupStats:  this.buildExpensesStats(bDocs),
        currentStats: this.buildExpensesStats(cDocs as any[]),
      };
    }

    // ── Vault entries ─────────────────────────────────────────────────────────
    {
      const bDocs  = Array.isArray(d.vaultentries) ? d.vaultentries : [];
      const cCount = await this.connection.collection('vaultentries').countDocuments().catch(()=>0);
      const cLatest= await this.getLatestDate('vaultentries');
      const cDocs  = await this.connection.collection('vaultentries').find({}).toArray().catch(()=>[]);
      preview['vault'] = {
        backup:  bDocs.length,
        current: cCount,
        backupLatest:  this.getLatestDateFromDocs(bDocs, 'date'),
        currentLatest: cLatest,
        backupStats:  this.buildVaultStats(bDocs),
        currentStats: this.buildVaultStats(cDocs as any[]),
      };
    }

    // ── Other ─────────────────────────────────────────────────────────────────
    {
      const cols = ['complaints','followups','tags','shopifyorders','mentions'];
      let bCount = 0, cCount = 0;
      const details: Record<string, {backup:number; current:number}> = {};
      for (const col of cols) {
        const bLen = Array.isArray(d[col]) ? d[col].length : 0;
        const cLen = await this.connection.collection(col).countDocuments().catch(()=>0);
        bCount += bLen; cCount += cLen;
        details[col] = { backup: bLen, current: cLen };
      }
      preview['other'] = { backup: bCount, current: cCount, backupLatest: null, currentLatest: null, details };
    }

    // ── Vault balances ────────────────────────────────────────────────────────
    const currentSettings = await this.settingsModel.findOne().exec();
    const bv = backupData?.vault_balances;
    preview['vault_balances'] = {
      backupVaultTotal:  bv ? (Number(bv.vaultCash||0)+Number(bv.vaultVodafone||0)+Number(bv.vaultInstapay||0)+Number(bv.vaultBank||0)) : null,
      currentVaultTotal: currentSettings ? ((currentSettings.vaultCash||0)+(currentSettings.vaultVodafone||0)+(currentSettings.vaultInstapay||0)+(currentSettings.vaultBank||0)) : null,
      backupDetails:  bv || null,
      currentDetails: currentSettings ? {
        vaultCash:      currentSettings.vaultCash,
        vaultVodafone:  currentSettings.vaultVodafone,
        vaultInstapay:  currentSettings.vaultInstapay,
        vaultBank:      currentSettings.vaultBank,
      } : null,
    };

    return { success: true, filename: safeFilename, backupTimestamp: backupData.timestamp, preview };
  }

  async selectiveRestoreBackup(filename: string, sections: string[]): Promise<any> {
    const backupDir = this.getBackupDir();
    let safeFilename = path.basename(filename);
    if (safeFilename.startsWith('soulia-')) safeFilename = safeFilename.substring(7);
    const filepath = path.join(backupDir, safeFilename);

    if (!fs.existsSync(filepath)) return { success: false, message: 'ملف النسخة الاحتياطية غير موجود' };

    let backupData: any;
    try {
      const raw = fs.readFileSync(filepath, 'utf8');
      backupData = JSON.parse(raw);
    } catch {
      return { success: false, message: 'ملف النسخة الاحتياطية تالف أو غير صالح' };
    }

    if (!backupData?.data || typeof backupData.data !== 'object') {
      return { success: false, message: 'صيغة الملف غير صحيحة' };
    }

    const restoreResults: Record<string, number> = {};

    for (const section of sections) {
      if (section === 'vault_balances') {
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
          this.logger.error('selective restore vault_balances failed', e?.message);
        }
        continue;
      }

      const collections = SettingsService.SECTION_COLLECTIONS[section];
      if (!collections) { this.logger.warn(`Unknown section: ${section}`); continue; }

      for (const col of collections) {
        const docs = backupData.data[col];
        try {
          await this.connection.collection(col).deleteMany({});
          if (Array.isArray(docs) && docs.length > 0) {
            const fixedDocs = docs.map((doc: any) => {
              const fixed: any = { ...doc };
              if (fixed._id) {
                const rawId = typeof fixed._id === 'string' ? fixed._id : fixed._id?.$oid;
                if (rawId) { try { fixed._id = new ObjectId(rawId); } catch { delete fixed._id; } }
              }
              migrateDoc(col, fixed);
              return fixed;
            });
            try {
              await this.connection.collection(col).insertMany(fixedDocs, { ordered: false });
              restoreResults[col] = fixedDocs.length;
            } catch (bulkErr: any) {
              restoreResults[col] = bulkErr?.result?.insertedCount ?? 0;
            }
          } else {
            restoreResults[col] = 0;
          }
        } catch (e: any) {
          this.logger.error(`selective restore ${col} failed`, e?.message);
          restoreResults[col] = -1;
        }
      }
    }

    this.logger.log(`Selective restore from ${safeFilename} (${sections.join(',')}): ${JSON.stringify(restoreResults)}`);
    return {
      success: true,
      message: `✓ تم الاسترجاع الانتقائي بنجاح من: ${safeFilename}`,
      restored: restoreResults,
    };
  }
}
