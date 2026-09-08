import { Injectable, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';
import { ObjectId } from 'mongodb';
import { Settings, SettingsDocument } from './schemas/settings.schema';
import { UpdateSettingsDto, DiscountCodeDto, DiscountBundleDto } from './dto/settings.dto';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { CARRIERS, carrierCodeFromName, carrierCodeFromLooseName } from '../shared/carriers.constants';
import {
  R2Config,
  r2PutObject,
  r2ListObjects,
  r2DeleteObject,
  r2TestConnection,
  normalizeR2AccountId,
} from '../shared/r2-uploader.util';

/**
 * Seeded into a brand-new settings document. Derived from the carrier registry so the two can
 * never drift — adding a carrier there is enough.
 */
const DEFAULT_SHIP_COS = CARRIERS.map((c) => ({
  code: c.code,
  name: c.en,
  cairo: c.tariff.find((t) => t.zone === 'cairo')?.price ?? 110,
  gov: c.tariff.find((t) => t.zone === 'gov')?.price ?? 150,
}));

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
    def(doc, 'editRequest', null);
    // Fields added with the products/categories redesign (Aug 2026) — older backups lack them.
    def(doc, 'images', []);
    def(doc, 'categoryId', null);
    def(doc, 'collectionId', null);
    def(doc, 'isActive', true);
    def(doc, 'description', '');
    def(doc, 'colors', []);
    def(doc, 'features', []);
    def(doc, 'isPattern', false);
    def(doc, 'pattern', '');
    def(doc, 'material', '');
    def(doc, 'sizeType', '');
    def(doc, 'size', '');
    def(doc, 'dimensions', null);
    def(doc, 'tags', []);
    def(doc, 'createdBy', '');
    def(doc, 'activityLog', []);
    return;
  }

  if (collection === 'suppliers') {
    // `phones` was added Aug 2026; `phone` mirrors phones[0]. Backfill both directions so
    // restored suppliers work with the multi-phone UI and the single-number read sites.
    if (!Array.isArray(doc.phones)) doc.phones = doc.phone ? [doc.phone] : [];
    if (!doc.phone && doc.phones.length) doc.phone = doc.phones[0];
    def(doc, 'phone', '');
    def(doc, 'address', '');
    def(doc, 'email', '');
    def(doc, 'products', '');
    def(doc, 'notes', '');
    def(doc, 'activityLog', []);
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
    // ⚠ The field is `isActive` (user.schema.ts). This defaulted `active` — a field the
    // schema does not have — so a backup predating isActive restored an account that
    // every `isActive` check then read as undefined/inactive.
    def(doc, 'isActive', true);
    def(doc, 'perms', []);
    def(doc, 'jobTitle', '');
    return;
  }

  if (collection === 'supplierreturnorders') {
    def(doc, 'itemsTotal', 0);
    def(doc, 'vaultRefundAccount', '');
    def(doc, 'linkedTransactionId', '');
    def(doc, 'settlement', null);
    def(doc, 'reversal', null);
    def(doc, 'statusHistory', []);
    // originalTransactionId/originalRef/originalDate are deprecated in favour of linkedInvoices[].
    // Older records only have the singular fields — synthesise the array so the new read paths work.
    def(doc, 'originalTransactionId', '');
    def(doc, 'originalRef', '');
    def(doc, 'originalDate', '');
    if (!Array.isArray(doc.linkedInvoices)) {
      doc.linkedInvoices = doc.originalTransactionId
        ? [{
            transactionId: doc.originalTransactionId,
            ref: doc.originalRef || '',
            date: doc.originalDate || '',
            allocatedTotal: Number(doc.total) || 0,
          }]
        : [];
    }
    def(doc, 'allocationMethod', doc.linkedInvoices.length > 1 ? 'manual' : 'single-invoice');
    if (Array.isArray(doc.items)) {
      doc.items.forEach((it: any) => { if (!Array.isArray(it.allocations)) it.allocations = []; });
    }
    return;
  }

  if (collection === 'supplierledgerentries') {
    def(doc, 'runningBalance', 0);
    def(doc, 'sourceType', '');
    def(doc, 'sourceId', '');
    def(doc, 'sourceRef', '');
    def(doc, 'vaultEntryId', '');
    def(doc, 'vaultSeg', '');
    def(doc, 'refNo', '');
    def(doc, 'employee', '');
    def(doc, 'reversed', false);
    def(doc, 'reversalOfEntryId', '');
    def(doc, 'meta', null);
    return;
  }

  if (collection === 'inventorymovements') {
    def(doc, 'qtyBefore', 0);
    def(doc, 'qtyAfter', 0);
    def(doc, 'sourceTransactionId', '');
    def(doc, 'sourceTransactionRef', '');
    def(doc, 'byUserId', '');
    def(doc, 'reason', '');
    def(doc, 'notes', '');
    return;
  }

  if (collection === 'categories') {
    def(doc, 'parentId', null);
    def(doc, 'isActive', true);
    def(doc, 'description', '');
    return;
  }

  if (collection === 'collections') {
    def(doc, 'categoryId', null);
    def(doc, 'coverImage', '');
    def(doc, 'description', '');
    def(doc, 'status', 'draft');
    def(doc, 'supplierIds', []);
    def(doc, 'tagIds', []);
    def(doc, 'activityLog', []);
    return;
  }

  if (collection === 'collectionproducts') {
    def(doc, 'addedBy', '');
    def(doc, 'addedAt', '');
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
    // Persist defaults for fields added after the document was first created
    const migrations: Record<string, any> = {};
    if ((settings as any).defaultPayMethod === undefined || (settings as any).defaultPayMethod === null || (settings as any).defaultPayMethod === 'تحويل بنكي')
      migrations['defaultPayMethod'] = 'Instapay';
    if ((settings as any).defaultShipCo === undefined || (settings as any).defaultShipCo === null)
      migrations['defaultShipCo'] = '';
    if ((settings as any).defaultDepMethod === undefined || (settings as any).defaultDepMethod === null)
      migrations['defaultDepMethod'] = '';
    if ((settings as any).codCollectionThreshold === undefined || (settings as any).codCollectionThreshold === null)
      migrations['codCollectionThreshold'] = 5000;
    {
      // performanceConfig sub-fields added after deliveryPoints existed alone — merge in any missing keys
      const perfDefaults = {
        deliveryPoints: 2,
        depositFullPoints: 5,
        depositPartial50Points: 3,
        depositPartialLowPoints: 2,
        depositNonePoints: 1,
      };
      const currentPerf = (settings as any).performanceConfig || {};
      const missingPerfKeys = Object.keys(perfDefaults).filter((k) => currentPerf[k] === undefined || currentPerf[k] === null);
      if (missingPerfKeys.length > 0) {
        migrations['performanceConfig'] = { ...perfDefaults, ...currentPerf };
      }
    }
    {
      // ── Carrier registry backfill ─────────────────────────────────────────
      // shipCos historically stored a display NAME only. Every transaction, report and export now
      // groups by a stable `code`, so each row gets one resolved from its name. A name that
      // matches no known carrier keeps code '' rather than being guessed at — filing real
      // shipments under the wrong company is worse than leaving them unspecified.
      const cos: any[] = Array.isArray((settings as any).shipCos) ? (settings as any).shipCos : [];
      if (cos.some((c) => !c?.code)) {
        migrations['shipCos'] = cos.map((c) => ({
          ...(typeof c?.toObject === 'function' ? c.toObject() : c),
          // ⚠ The LOOSE matcher, not the strict one. Operators decorate the name they type into
          //   Settings ('bosta +', 'Bosta Express'), and the strict matcher leaves every such row
          //   with code '' — which is how 219 of 297 real Bosta orders ended up unbound. Guessing
          //   is acceptable here and not on the write path because the alternative is an unusable
          //   registry row, and the result is visible and editable in Settings.
          code: c?.code || carrierCodeFromLooseName(c?.name || ''),
        }));
      }
      // defaultCarrierCode is derived once from the legacy defaultShipCo name, so an install that
      // already had a default keeps it instead of silently reverting to "no default".
      if ((settings as any).defaultCarrierCode === undefined || (settings as any).defaultCarrierCode === null) {
        migrations['defaultCarrierCode'] = carrierCodeFromLooseName((settings as any).defaultShipCo || '');
      }
    }
    if (Object.keys(migrations).length > 0) {
      await this.settingsModel.findByIdAndUpdate(settings._id, { $set: migrations }).exec();
      Object.assign(settings, migrations);
    }
    return settings;
  }

  stripSensitive(doc: SettingsDocument): Record<string, unknown> {
    const obj = doc.toObject() as unknown as Record<string, unknown>;
    delete obj['vaultPass'];
    // Replace bostaApiKey with a masked flag — never expose raw key to frontend
    obj['bostaApiKeySet'] = !!(obj['bostaApiKey'] as string);
    delete obj['bostaApiKey'];
    // Same treatment for the webhook secret
    obj['bostaWebhookSecretSet'] = !!(obj['bostaWebhookSecret'] as string);
    delete obj['bostaWebhookSecret'];
    // WARN: R2 secret never leaves the server - the frontend sees only a flag.
    // index.html is shipped whole to every user's browser, so any key passing
    // through here would be effectively published.
    obj['r2SecretAccessKeySet'] = !!(obj['r2SecretAccessKey'] as string);
    delete obj['r2SecretAccessKey'];
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

  async saveBostaWebhookSecret(secret: string): Promise<void> {
    const settings = await this.getSettings();
    await this.settingsModel.findByIdAndUpdate(
      settings._id,
      { $set: { bostaWebhookSecret: secret.trim() } },
      { new: true },
    ).exec();
  }

  async getBostaWebhookSecret(): Promise<string> {
    const settings = await this.getSettings();
    return (settings as any).bostaWebhookSecret || process.env.BOSTA_WEBHOOK_SECRET || '';
  }

  // --- Cloud backup (Cloudflare R2) ----------------------------------------

  /**
   * Saves R2 settings. The secret is written ONLY when actually supplied - the
   * UI shows a masked field, so saving an unrelated setting (e.g. the retention
   * count) must not wipe a stored secret.
   */
  async saveR2Config(cfg: {
    accountId?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    bucket?: string;
    enabled?: boolean;
    keep?: number;
  }): Promise<void> {
    const settings = await this.getSettings();
    const $set: Record<string, unknown> = {};

    // يُخزَّن مُطبَّعاً: لصق الرابط الكامل من لوحة Cloudflare هو السلوك الطبيعي،
    // وتخزينه كما هو يجعل الحقل يعرض قيمة تفشل عند أول اتصال.
    if (typeof cfg.accountId === 'string') $set.r2AccountId = normalizeR2AccountId(cfg.accountId);
    if (typeof cfg.accessKeyId === 'string') $set.r2AccessKeyId = cfg.accessKeyId.trim();
    if (typeof cfg.bucket === 'string' && cfg.bucket.trim()) $set.r2Bucket = cfg.bucket.trim();
    if (typeof cfg.enabled === 'boolean') $set.r2Enabled = cfg.enabled;
    if (typeof cfg.keep === 'number' && cfg.keep >= 1 && cfg.keep <= 365) {
      $set.r2Keep = Math.floor(cfg.keep);
    }
    if (typeof cfg.secretAccessKey === 'string' && cfg.secretAccessKey.trim()) {
      $set.r2SecretAccessKey = cfg.secretAccessKey.trim();
    }

    if (Object.keys($set).length === 0) return;
    await this.settingsModel.findByIdAndUpdate(settings._id, { $set }, { new: true }).exec();
  }

  /**
   * Assembles credentials. `overrides` lets the UI test keys BEFORE saving them -
   * otherwise the user would have to save a wrong key to discover it is wrong.
   */
  async getR2Config(overrides?: Partial<R2Config>): Promise<R2Config | null> {
    const s: any = await this.getSettings();
    const cfg: R2Config = {
      accountId: (overrides?.accountId || s.r2AccountId || process.env.R2_ACCOUNT_ID || '').trim(),
      accessKeyId: (overrides?.accessKeyId || s.r2AccessKeyId || process.env.R2_ACCESS_KEY_ID || '').trim(),
      secretAccessKey: (overrides?.secretAccessKey || s.r2SecretAccessKey || process.env.R2_SECRET_ACCESS_KEY || '').trim(),
      bucket: (overrides?.bucket || s.r2Bucket || 'soulia-backups').trim(),
    };
    if (!cfg.accountId || !cfg.accessKeyId || !cfg.secretAccessKey) return null;
    return cfg;
  }

  async testR2Connection(overrides?: Partial<R2Config>): Promise<{ success: boolean; message: string }> {
    const cfg = await this.getR2Config(overrides);
    if (!cfg) {
      return { success: false, message: 'أكمل البيانات الثلاثة أولاً (Account ID و Access Key و Secret)' };
    }
    const res = await r2TestConnection(cfg);
    return { success: res.ok, message: res.message };
  }

  /** Records the last upload result. Written on success AND failure - silent failure is what this prevents. */
  private async writeR2State(
    status: string,
    message: string,
    file = '',
    sizeBytes = 0,
    remoteCount = 0,
  ): Promise<void> {
    try {
      const settings = await this.getSettings();
      await this.settingsModel.findByIdAndUpdate(settings._id, {
        $set: {
          r2LastRun: {
            status,
            message,
            file,
            sizeBytes,
            remoteCount,
            finishedAt: new Date().toISOString(),
          },
        },
      }).exec();
    } catch (e: any) {
      this.logger.warn(`writeR2State failed: ${e?.message}`);
    }
  }

  /** Folder inside the bucket. Fixed, so listing and pruning know where to look. */
  private static readonly R2_PREFIX = 'backups/';

  /**
   * Uploads a backup file to the cloud, then prunes old ones.
   *
   * The rules it follows - each prevents a specific failure:
   * 1. DELETE ONLY AFTER UPLOAD. A failed upload deletes nothing; otherwise one
   *    bad night evicts a healthy backup without putting a replacement in place.
   * 2. VERIFY AFTER UPLOAD. A successful request is not sufficient proof - we ask
   *    the cloud whether the object is actually there.
   * 3. BY COUNT, NOT BY AGE. Age-based deletion wipes everything if uploads stop
   *    for a while - exactly when the backups are needed.
   * 4. NEVER THROWS. Called from a scheduled job; an uncaught exception kills the
   *    whole scheduler and every later run with it.
   */
  async uploadBackupToR2(filename: string): Promise<{ success: boolean; message: string }> {
    try {
      const s: any = await this.getSettings();
      const cfg = await this.getR2Config();
      if (!cfg) {
        return { success: false, message: 'إعدادات R2 غير مكتملة' };
      }

      const filepath = path.join(this.getBackupDir(), filename);
      if (!fs.existsSync(filepath)) {
        const msg = `الملف غير موجود محلياً: ${filename}`;
        await this.writeR2State('error', msg);
        return { success: false, message: msg };
      }

      const body = fs.readFileSync(filepath);
      // A trivially small file means a failed backup; uploading it consumes a slot
      // and evicts a healthy one.
      if (body.length < 1024) {
        const msg = `النسخة صغيرة بشكل غير طبيعي (${body.length} بايت) — لم تُرفع`;
        await this.writeR2State('error', msg);
        return { success: false, message: msg };
      }

      const key = `${SettingsService.R2_PREFIX}${filename}`;
      const put = await r2PutObject(cfg, key, body);
      if (!put.ok) {
        const msg = `فشل الرفع: ${put.message}`;
        this.logger.error(`R2 upload failed for ${filename}: ${put.message}`);
        await this.writeR2State('error', msg, filename, body.length);
        return { success: false, message: msg };
      }

      // (2) Confirm existence before deleting anything.
      const listed = await r2ListObjects(cfg, SettingsService.R2_PREFIX);
      if (!listed.ok) {
        const msg = `تم الرفع لكن تعذّر التحقق: ${listed.message}`;
        await this.writeR2State('warn', msg, filename, body.length);
        return { success: true, message: msg };
      }
      if (!listed.objects.some((o) => o.key === key)) {
        const msg = 'الملف غير موجود على السحابة بعد الرفع — لم يُحذف شيء';
        await this.writeR2State('error', msg, filename, body.length);
        return { success: false, message: msg };
      }

      // (3) Prune by count. Alphabetical order equals chronological order because
      // the ISO timestamp is inside the filename.
      const keep = Number(s.r2Keep) > 0 ? Number(s.r2Keep) : 14;
      const sorted = listed.objects
        .filter((o) => o.key.endsWith('.json'))
        .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));

      let remoteCount = sorted.length;
      if (sorted.length > keep) {
        for (const old of sorted.slice(keep)) {
          const del = await r2DeleteObject(cfg, old.key);
          if (del.ok) {
            remoteCount--;
            this.logger.log(`R2 pruned: ${old.key}`);
          } else {
            this.logger.warn(`R2 prune failed for ${old.key}: ${del.message}`);
          }
        }
      }

      const msg = `تم رفع ${filename} بنجاح`;
      this.logger.log(`R2 upload ok: ${key} (${body.length} bytes, ${remoteCount} on cloud)`);
      await this.writeR2State('ok', msg, filename, body.length, remoteCount);
      return { success: true, message: msg };
    } catch (e: any) {
      // (4) Never throws.
      const msg = `خطأ غير متوقع: ${e?.message || 'غير معروف'}`;
      this.logger.error(`uploadBackupToR2 threw: ${e?.message}`, e?.stack);
      await this.writeR2State('error', msg);
      return { success: false, message: msg };
    }
  }

  /** Lists backups present on the cloud - for the settings panel. */
  async listR2Backups(): Promise<{
    success: boolean;
    message: string;
    files: { name: string; sizeBytes: number; date: string }[];
  }> {
    const cfg = await this.getR2Config();
    if (!cfg) return { success: false, message: 'إعدادات R2 غير مكتملة', files: [] };

    const res = await r2ListObjects(cfg, SettingsService.R2_PREFIX);
    if (!res.ok) return { success: false, message: res.message, files: [] };

    const files = res.objects
      .filter((o) => o.key.endsWith('.json'))
      .map((o) => ({
        name: o.key.slice(SettingsService.R2_PREFIX.length),
        sizeBytes: o.size,
        date: o.lastModified,
      }))
      .sort((a, b) => (a.name < b.name ? 1 : -1));

    return { success: true, message: 'ok', files };
  }

  /**
   * Uploads an existing backup on demand - the panel's "upload now" button.
   * With no name given, takes the most recent local backup.
   */
  async uploadLatestToR2(filename?: string): Promise<{ success: boolean; message: string }> {
    let target = (filename || '').trim();
    if (!target) {
      // getBackupList() returns the ARRAY itself, not {backups:[...]}. Reading
      // `.backups` here yielded undefined, so the button always reported "no
      // local backup" even with eight sitting on disk.
      const rows = await this.getBackupList();
      if (!rows.length) return { success: false, message: 'لا توجد نسخة محلية لرفعها' };
      // The registry is newest-first, but a hand-edited or rebuilt one need not
      // be. Sorting by the ISO timestamp inside the filename makes "latest"
      // true regardless of registry order.
      const newest = rows
        .map(r => r.filename)
        .filter(Boolean)
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0];
      target = newest || rows[0].filename;
    }
    // WARN: path-traversal guard - the name comes from the frontend.
    if (target.indexOf('/') >= 0 || target.indexOf('\\') >= 0 || target.indexOf('..') >= 0) {
      return { success: false, message: 'اسم ملف غير صالح' };
    }
    return await this.uploadBackupToR2(target);
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

  /** Bumps the patch version (x.y.Z -> x.y.Z+1) and stamps the update/upload timestamps. Called by the post-commit git hook on every deploy. */
  async bumpVersion(): Promise<SettingsDocument> {
    const settings = await this.getSettings();
    const parts = (settings.systemVersion || '2.4.0').split('.').map(n => parseInt(n, 10) || 0);
    parts[2] = (parts[2] || 0) + 1;
    settings.systemVersion = parts.join('.');
    const now = new Date();
    settings.lastVersionUpdate = now;
    settings.lastLiveUpload = now;
    return settings.save();
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

  /**
   * Every Mongo collection captured by createBackup(), in write order.
   *
   * This is the single source of truth for "what a backup contains". When a new module adds a
   * collection, add it here AND to SECTION_COLLECTIONS (so selective restore can put it back);
   * ALLOWED_COLLECTIONS decides separately whether clear-data may wipe it. The coverage test in
   * test/integration/settings-backup-coverage.spec.ts fails if these drift apart.
   *
   * `users` IS restored, but by merge rather than wipe-and-insert — see restoreUsersMerge().
   * It was previously captured and then skipped on restore, which meant a restore onto a
   * clean database produced a full transaction history with no employee accounts at all,
   * and performance logs whose employeeId resolved to nobody.
   */
  static readonly BACKUP_COLLECTIONS = [
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
    'tags',
    'purchaseorders',
    'supplierreturnorders',
    'supplierledgerentries',
    // ── Catalogue: categories / collections and the product↔collection join table ──
    'categories',
    'collections',
    'collectionproducts',
    // ── Stock audit trail — without it, restored stock levels have no history ──
    'inventorymovements',
    // ── Per-segment vault balances (settings.vault* is only a mirror of these) ──
    'vaultbalances',
    // ── Operational / audit data ──
    'drafts',
    // Short-lived OTPs, but clear-data wipes them, so the pre-wipe safety backup must restore them.
    'discountotps',
    'securityauditlogs',
    'employeeshifts',
    'employeeleaves',
    'employeeperformancelogs',
    'demandanalysislogs',
    // ── Customer-service playbook ──
    'knowledgefolders',
    'knowledgecards',
    'knowledgeauditlogs',
    'knowledgeimportlogs',
    // Captured last, restored by merge (never wiped) — see restoreUsersMerge().
    'users',
  ];

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

  /**
   * `auto` marks the file as scheduler-generated. It is what makes pruning safe: only
   * auto backups are ever deleted, so a manual backup taken deliberately before a risky
   * operation is never rotated away by a nightly job that knows nothing about it.
   * The prefix is part of the FILENAME, not just the registry, so the distinction
   * survives a lost or hand-edited registry.json.
   */
  async createBackup(auto = false): Promise<{ success: boolean; filename: string; message: string }> {
    try {
      const backupDir = this.getBackupDir();
      const timestamp = this.formatDateTime();
      const filename = `backup_${auto ? 'auto_' : ''}${timestamp}.json`;
      const filepath = path.join(backupDir, filename);

      const settings = await this.settingsModel.findOne().exec();

      const data: Record<string, any[]> = {};
      for (const col of SettingsService.BACKUP_COLLECTIONS) {
        try {
          data[col] = await this.connection.collection(col).find({}).toArray();
        } catch (e: any) {
          // A collection that doesn't exist yet in this database reads as empty rather than
          // aborting the whole backup.
          this.logger.warn(`Backup: could not read collection ${col}: ${e?.message}`);
          data[col] = [];
        }
      }

      const backupData = {
        timestamp: new Date().toISOString(),
        data,
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
      this.updateBackupRegistry(filename, auto);
      this.logger.log(`Backup created: ${filename}`);

      return { success: true, filename, message: `✓ تم إنشاء نسخة احتياطية: ${filename}` };
    } catch (e: any) {
      this.logger.error('createBackup failed', e?.stack || e?.message);
      return { success: false, filename: '', message: `❌ فشل إنشاء النسخة الاحتياطية: ${e?.message || 'خطأ غير معروف'}` };
    }
  }

  /** How many scheduler-generated backups to keep. Manual ones are never counted or pruned. */
  static readonly AUTO_BACKUP_KEEP = 10;

  /**
   * Nightly backup, 03:00 server time.
   *
   * Before this existed there was NO automatic backup at all — a backup happened only
   * when a human opened Settings and pressed the button, so a quiet week meant no
   * recovery point for that week.
   *
   * 03:00 is outside working hours and an hour clear of the 07:00 order-audit cron, so
   * the two never contend for the database at once.
   *
   * Never throws: createBackup() already returns a result object rather than raising,
   * and the catch here covers the prune. A failed nightly backup must log and let the
   * next night try again — a scheduler that dies takes every later run with it.
   */
  @Cron('0 0 3 * * *', { name: 'nightly-backup' })
  async runScheduledBackup(): Promise<void> {
    try {
      const res = await this.createBackup(true);
      if (!res.success) {
        this.logger.error(`Scheduled backup FAILED: ${res.message}`);
        return;
      }
      this.logger.log(`Scheduled backup created: ${res.filename}`);
      this.pruneAutoBackups();

      // Ship it off-box. Until this ran, the nightly backup sat on the SAME disk as
      // the live database, so one disk failure took the data and every recovery
      // point with it. Gated on r2Enabled and awaited but never allowed to throw:
      // uploadBackupToR2 returns a result object, and a cloud outage must not stop
      // tomorrow night from running.
      const s: any = await this.getSettings();
      if (s.r2Enabled) {
        const up = await this.uploadBackupToR2(res.filename);
        if (!up.success) this.logger.error(`R2 upload failed: ${up.message}`);
      }
    } catch (e: any) {
      this.logger.error(`Scheduled backup threw: ${e?.message}`, e?.stack);
    }
  }

  /**
   * Delete the oldest AUTO backups beyond AUTO_BACKUP_KEEP.
   *
   * ⚠ Only files this scheduler created are eligible — identified by the `backup_auto_`
   * prefix, with the registry's `auto` flag as a secondary signal. A manual backup is
   * usually taken deliberately right before something risky, so rotating one away is
   * exactly the file the user would have wanted; and the pre-wipe safety backup that
   * resetSelectiveData() takes is manual for the same reason.
   *
   * Ordering is by the registry date when present and by filename otherwise — the
   * timestamped names sort chronologically as strings, so this holds even if the
   * registry was lost.
   */
  private pruneAutoBackups(): void {
    try {
      const backupDir = this.getBackupDir();
      const registryPath = path.join(backupDir, 'registry.json');

      const autoFiles = fs
        .readdirSync(backupDir)
        .filter(f => f.startsWith('backup_auto_') && f.endsWith('.json'))
        .sort(); // oldest first — timestamps sort lexicographically

      const excess = autoFiles.length - SettingsService.AUTO_BACKUP_KEEP;
      if (excess <= 0) return;

      const doomed = autoFiles.slice(0, excess);
      for (const f of doomed) {
        try {
          fs.unlinkSync(path.join(backupDir, f));
        } catch (e: any) {
          this.logger.warn(`Could not delete old backup ${f}: ${e?.message}`);
        }
      }

      // Drop the pruned rows from the registry so the UI stops listing files that are gone.
      if (fs.existsSync(registryPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
          if (Array.isArray(parsed)) {
            const kept = parsed.filter((r: any) => !doomed.includes(r?.filename));
            fs.writeFileSync(registryPath, JSON.stringify(kept, null, 2));
          }
        } catch (e: any) {
          this.logger.warn(`Could not update registry after prune: ${e?.message}`);
        }
      }

      this.logger.log(`Pruned ${doomed.length} old auto backup(s), keeping ${SettingsService.AUTO_BACKUP_KEEP}`);
    } catch (e: any) {
      // Pruning is housekeeping — its failure must never invalidate the backup just taken.
      this.logger.error(`pruneAutoBackups failed: ${e?.message}`);
    }
  }

  private updateBackupRegistry(filename: string, auto = false): void {
    const backupDir = this.getBackupDir();
    const registryPath = path.join(backupDir, 'registry.json');

    let registry: Array<{ filename: string; date: string; auto?: boolean }> = [];
    if (fs.existsSync(registryPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        if (Array.isArray(parsed)) registry = parsed;
      } catch (e: any) {
        // A corrupt registry must not stop a backup being written — the FILE is the
        // backup; the registry is only an index and is rebuilt from this point on.
        this.logger.warn(`Backup registry unreadable, starting a new one: ${e?.message}`);
      }
    }

    registry.unshift({ filename, date: new Date().toISOString(), auto });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
  }

  /**
   * The backup list, filtered to files that are actually on disk.
   *
   * The registry is an index, not the truth — a row whose file was pruned, deleted by
   * hand or lost with the volume would otherwise be offered as restorable and fail only
   * once the user picked it. `auto` is surfaced so the UI can label scheduler backups
   * and explain why they rotate.
   */
  async getBackupList(): Promise<Array<{ filename: string; date: string; auto?: boolean }>> {
    const backupDir = this.getBackupDir();
    const registryPath = path.join(backupDir, 'registry.json');

    if (!fs.existsSync(registryPath)) return [];

    let registry: Array<{ filename: string; date: string; auto?: boolean }> = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      if (Array.isArray(parsed)) registry = parsed;
    } catch (e: any) {
      this.logger.warn(`Backup registry unreadable: ${e?.message}`);
      return [];
    }

    return registry
      .filter(r => r?.filename && fs.existsSync(path.join(backupDir, r.filename)))
      // Rows predating the auto flag are manual by definition; fall back to the filename
      // so the label stays right even if the registry was rebuilt.
      .map(r => ({ ...r, auto: r.auto ?? r.filename.startsWith('backup_auto_') }));
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
    'purchaseorders',
    'supplierreturnorders',
    'supplierledgerentries',
    'categories',
    'collections',
    'collectionproducts',
    'inventorymovements',
    'vaultbalances',
    'drafts',
    'securityauditlogs',
    'employeeshifts',
    'employeeleaves',
    'employeeperformancelogs',
    'demandanalysislogs',
    'knowledgefolders',
    'knowledgecards',
    'knowledgeauditlogs',
    'knowledgeimportlogs',
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

    // Step 1: Delete current data.
    // ⚠ `users` is excluded from the WIPE but no longer from the restore — see step 2.
    // It must never be deleteMany()'d: a restore that empties the accounts table before
    // rewriting it locks every employee out for the length of the operation, and locks
    // them out permanently if the insert then fails. Users are merged in place instead.
    const collections = Object.keys(backupData.data).filter(c => c !== 'users');
    for (const collectionName of collections) {
      try {
        await this.connection.collection(collectionName).deleteMany({});
      } catch (e: any) {
        this.logger.warn(`Could not clear collection ${collectionName}: ${e?.message}`);
      }
    }

    // Step 2: Restore each collection.
    for (const [collectionName, docs] of Object.entries(backupData.data)) {
      // Users take the merge path, not the wipe-and-insert path every other collection
      // uses. Skipping them entirely (the old behaviour) meant a restore onto a fresh
      // machine produced every transaction with NO employee accounts — and performance
      // logs whose employeeId pointed at users that did not exist, so the leaderboard
      // came back empty even though its rows had been captured correctly.
      if (collectionName === 'users') {
        restoreResults['users'] = await this.restoreUsersMerge(docs as any[]);
        continue;
      }
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
          // ⚠ Restore the Mongoose timestamps as real Dates, not the ISO STRINGS that
          // JSON.parse hands back. Mongo compares BSON types, so a string createdAt does
          // not match a `{$gte: Date}` bound at all — every period-scoped query silently
          // returns ZERO. That is what made «نقاطي» read 0 for an employee holding 279
          // points: the rows were all there, the window just could not see them.
          // Measured on the live database: 633 of 637 rows had a string createdAt.
          // Only these two fields are touched — a business date like `date` or
          // `returnDate` is deliberately a plain YYYY-MM-DD string elsewhere and must
          // stay one (see the date-window helpers).
          for (const f of ['createdAt', 'updatedAt']) {
            const v = fixed[f];
            if (typeof v === 'string' && v) {
              const d = new Date(v);
              if (!isNaN(d.getTime())) fixed[f] = d;
            } else if (v && typeof v === 'object' && typeof v.$date === 'string') {
              const d = new Date(v.$date);
              if (!isNaN(d.getTime())) fixed[f] = d;
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

  /**
   * Restore employee accounts by MERGE, never by wipe-and-replace.
   *
   * Matched on `username` — the field the login form and every `findByUsername` call
   * use, and the one carrying a unique index. Matching on `_id` alone would create a
   * duplicate account for a user whose id differs between databases, and the unique
   * index would then reject the insert, silently losing that employee.
   *
   * The three rules that make this safe to run on a live system:
   *  1. An account present now but absent from the backup is LEFT ALONE, never deleted.
   *     A staff member hired after the backup was taken must not lose their login
   *     because someone restored last week's data — and that could include the admin
   *     running the restore.
   *  2. Credentials are never downgraded to a stale value: `password`/`plainPassword`/
   *     `totpSecret` are only written when the account is being CREATED. A password
   *     changed since the backup stays changed — a restore is not a password reset, and
   *     silently reverting one hands out a credential the user believes is retired.
   *  3. Security state (`loginAttempts`, `lockedAt`, `trustedDevices`, `lastLogin`) is
   *     never restored. It describes the live session history of THIS machine; writing a
   *     month-old lockout back over it would either resurrect a lifted lock or clear a
   *     current one.
   *
   * What IS restored is the identity and authorisation payload — name, role, perms,
   * jobTitle, phone, avatar, isActive — which is exactly what was missing, and what
   * `employeeperformancelogs.employeeId` needs to resolve to a person.
   */
  private async restoreUsersMerge(docs: any[]): Promise<number> {
    if (!Array.isArray(docs) || docs.length === 0) return 0;
    const col = this.connection.collection('users');
    let touched = 0;

    for (const raw of docs) {
      try {
        const doc: any = { ...raw };
        const username = String(doc.username || '').trim();
        if (!username) continue; // an account with no username can never be logged into

        migrateDoc('users', doc);

        const existing = await col.findOne({ username });
        if (existing) {
          // Update the identity/authorisation fields only. Anything absent from the
          // backup doc is left untouched rather than blanked — a backup taken before a
          // field existed must not erase that field's current value.
          const $set: Record<string, unknown> = {};
          for (const f of ['name', 'role', 'jobTitle', 'phone', 'avatar', 'isActive']) {
            if (doc[f] !== undefined) $set[f] = doc[f];
          }
          if (Array.isArray(doc.perms)) $set.perms = doc.perms;
          if (Object.keys($set).length) {
            await col.updateOne({ _id: existing._id }, { $set });
          }
          touched++;
          continue;
        }

        // New account — insert whole, credentials included, so the employee can log in.
        // The backup's own _id is preserved when possible: employeeperformancelogs and
        // shopifyorders.assignedTo store the User._id as a string, so a regenerated id
        // would orphan every point and every assignment belonging to this person.
        if (doc._id) {
          const rawId = typeof doc._id === 'string' ? doc._id : doc._id?.$oid;
          if (rawId) {
            try { doc._id = new ObjectId(rawId); } catch { delete doc._id; }
          }
        }
        await col.insertOne(doc);
        touched++;
      } catch (e: any) {
        // One malformed account must not abort the rest — and must not abort the restore,
        // which by this point has already rewritten every other collection.
        this.logger.warn(`restoreUsersMerge: skipped user ${raw?.username}: ${e?.message}`);
      }
    }

    this.logger.log(`restoreUsersMerge: ${touched}/${docs.length} accounts merged`);
    return touched;
  }

  // Every collection captured by createBackup() must appear in exactly one section here —
  // otherwise a selective restore silently skips it. `users` sits with the staff data it
  // gives meaning to: restoring performance points without the accounts they belong to
  // produces a leaderboard of ids nobody can read.
  // Covered by the settings.service SECTION_COLLECTIONS coverage test.
  private static SECTION_COLLECTIONS: Record<string, string[]> = {
    transactions:   ['transactions', 'returnrequests', 'inventorymovements'],
    products:       ['products', 'categories', 'collections', 'collectionproducts'],
    customers:      ['clients', 'suppliers', 'purchaseorders', 'supplierreturnorders', 'supplierledgerentries'],
    expenses:       ['expenses'],
    vault:          ['vaultentries', 'vaultbalances'],
    other:          ['complaints', 'followups', 'tags', 'shopifyorders', 'mentions',
                     'drafts', 'discountotps', 'securityauditlogs', 'employeeshifts',
                     'employeeleaves', 'employeeperformancelogs', 'demandanalysislogs', 'users',
                     'knowledgefolders', 'knowledgecards', 'knowledgeauditlogs', 'knowledgeimportlogs'],
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
      const bMov = Array.isArray(d.inventorymovements) ? d.inventorymovements : [];
      const cTxCount  = await this.connection.collection('transactions').countDocuments().catch(()=>0);
      const cRetCount = await this.connection.collection('returnrequests').countDocuments().catch(()=>0);
      const cMovCount = await this.connection.collection('inventorymovements').countDocuments().catch(()=>0);
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
        backup:  bTx.length + bRet.length + bMov.length,
        current: cTxCount + cRetCount + cMovCount,
        backupLatest: bLatest, currentLatest: cLatest,
        backupStats:  this.buildTransactionsStats(bTx, bRet),
        currentStats: this.buildTransactionsStats(cTxDocs as any[], cRetDocs as any[]),
      };
    }

    // ── Products ─────────────────────────────────────────────────────────────
    {
      const bDocs = Array.isArray(d.products) ? d.products : [];
      const bCats = Array.isArray(d.categories) ? d.categories : [];
      const bCols = Array.isArray(d.collections) ? d.collections : [];
      const bCP   = Array.isArray(d.collectionproducts) ? d.collectionproducts : [];
      const cCount = await this.connection.collection('products').countDocuments().catch(()=>0);
      const [cCatCount, cColCount, cCPCount] = await Promise.all([
        this.connection.collection('categories').countDocuments().catch(()=>0),
        this.connection.collection('collections').countDocuments().catch(()=>0),
        this.connection.collection('collectionproducts').countDocuments().catch(()=>0),
      ]);
      const cLatest = await this.getLatestDate('products');
      const cDocs = await this.connection.collection('products').find({}).toArray().catch(()=>[]);
      preview['products'] = {
        backup:  bDocs.length + bCats.length + bCols.length + bCP.length,
        current: cCount + cCatCount + cColCount + cCPCount,
        backupLatest:  this.getLatestDateFromDocs(bDocs, 'updatedAt'),
        currentLatest: cLatest,
        backupStats:  this.buildProductsStats(bDocs),
        currentStats: this.buildProductsStats(cDocs as any[]),
      };
    }

    // ── Customers ─────────────────────────────────────────────────────────────
    // (also covers purchaseorders/supplierreturnorders/supplierledgerentries — supplier-scoped
    // data that lives in the same SECTION_COLLECTIONS bucket as 'suppliers')
    {
      const bClients   = Array.isArray(d.clients)   ? d.clients   : [];
      const bSuppliers = Array.isArray(d.suppliers)  ? d.suppliers : [];
      const bPOs       = Array.isArray(d.purchaseorders)        ? d.purchaseorders        : [];
      const bSRs       = Array.isArray(d.supplierreturnorders)  ? d.supplierreturnorders  : [];
      const bSLEs      = Array.isArray(d.supplierledgerentries) ? d.supplierledgerentries : [];
      const [cCliCount, cSupCount, cPOCount, cSRCount, cSLECount] = await Promise.all([
        this.connection.collection('clients').countDocuments().catch(()=>0),
        this.connection.collection('suppliers').countDocuments().catch(()=>0),
        this.connection.collection('purchaseorders').countDocuments().catch(()=>0),
        this.connection.collection('supplierreturnorders').countDocuments().catch(()=>0),
        this.connection.collection('supplierledgerentries').countDocuments().catch(()=>0),
      ]);
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
        backup:  bClients.length + bSuppliers.length + bPOs.length + bSRs.length + bSLEs.length,
        current: cCliCount + cSupCount + cPOCount + cSRCount + cSLECount,
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
      const cols = SettingsService.SECTION_COLLECTIONS['other'];
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
        // A backup taken before this collection existed simply has no key for it. Deleting in that
        // case would wipe live data and restore nothing in its place, so skip the collection
        // entirely — "absent from the backup" must never mean "empty in the backup".
        // An explicitly-empty array IS a real state and still clears the collection.
        if (!Array.isArray(docs)) {
          this.logger.warn(
            `Selective restore: '${col}' is absent from this backup — leaving existing data untouched.`,
          );
          restoreResults[col] = -2; // signals "skipped, not in backup"
          continue;
        }
        try {
          // ⚠ Users take the merge path here too. This branch does deleteMany() then
          // insertMany, which on the accounts table would log every employee out for the
          // duration and lock them out permanently if the insert failed — including the
          // admin performing the restore.
          if (col === 'users') {
            restoreResults[col] = await this.restoreUsersMerge(docs);
            continue;
          }
          await this.connection.collection(col).deleteMany({});
          if (docs.length > 0) {
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

  // ─── النسخ الاحتياطي السحابي (Cloudflare R2) ─────────────────────────────
  //
  // ⚠ لا توجد مفاتيح R2 هنا ولا في أي مكان يصل إليه هذا التطبيق.
  // سكريبت scripts/cloud-backup.sh هو من يتكلم مع السحابة (عبر rclone)، ويكتب
  // نتيجة آخر تشغيل في ملف JSON. هذه الدالة تقرأ ذلك الملف فقط — للعرض.
  //
  // السبب: الواجهة الأمامية ملف واحد يُرسل كاملاً لمتصفح كل مستخدم، فأي مفتاح
  // يمرّ من هنا ينتهي منشوراً. الفصل مقصود: السكريبت يملك المفاتيح، والتطبيق
  // يملك القراءة فقط.

  private getCloudStatePath(): string {
    return process.env.CLOUD_BACKUP_STATE || '/var/backups/soulia/last-run.json';
  }

  async getCloudBackupStatus(): Promise<{
    configured: boolean;
    status: string;
    message: string;
    file: string;
    sizeBytes: number;
    remoteCount: number;
    keep: number;
    finishedAt: string | null;
    ageHours: number | null;
    stale: boolean;
  }> {
    const empty = {
      configured: false,
      status: 'unknown',
      message: 'لم يُشغَّل النسخ السحابي بعد',
      file: '',
      sizeBytes: 0,
      remoteCount: 0,
      keep: 0,
      finishedAt: null as string | null,
      ageHours: null as number | null,
      stale: false,
    };

    try {
      const statePath = this.getCloudStatePath();
      if (!fs.existsSync(statePath)) return empty;

      const raw = fs.readFileSync(statePath, 'utf8');
      const s = JSON.parse(raw);

      const finishedAt: string | null = s.finishedAt || null;
      let ageHours: number | null = null;
      if (finishedAt) {
        const ms = Date.now() - new Date(finishedAt).getTime();
        if (!Number.isNaN(ms)) ageHours = Math.max(0, Math.round(ms / 36e5));
      }

      // "قديم" = مضى أكثر من ٣٦ ساعة على آخر نجاح. النسخ يومي، فتجاوز يوم
      // ونصف يعني أن مهمة cron توقّفت. بدون هذا العَلَم تعرض اللوحة نجاحاً
      // قديماً كأنه نجاح اليوم — وهو بالضبط الفشل الصامت الذي نتجنّبه.
      const stale = ageHours !== null && ageHours > 36;

      return {
        configured: true,
        status: String(s.status || 'unknown'),
        message: String(s.message || ''),
        file: String(s.file || ''),
        sizeBytes: Number(s.sizeBytes) || 0,
        remoteCount: Number(s.remoteCount) || 0,
        keep: Number(s.keep) || 0,
        finishedAt,
        ageHours,
        stale,
      };
    } catch (e: any) {
      // ملف حالة تالف يجب ألا يُقرأ كـ "كل شيء بخير".
      this.logger.warn(`getCloudBackupStatus: ${e?.message}`);
      return { ...empty, status: 'error', message: 'تعذّر قراءة حالة النسخ السحابي' };
    }
  }
}
