import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  UnauthorizedException,
  NotFoundException,
  UploadedFile,
  UseInterceptors,
  Res,
  Optional,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto, DiscountCodeDto, DiscountBundleDto } from './dto/settings.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';
import { PromotionAuditService } from '../promotions/promotion-audit.service';
import { UsersService } from '../users/users.service';
import { SecurityAuditService } from '../security-audit/security-audit.service';
import { PresenceGateway } from '../auth/presence.gateway';

const MAX_VAULT_ATTEMPTS = 4;
// In-memory per-user vault attempt counter (resets on success or server restart)
const vaultAttempts = new Map<string, number>();

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly usersService: UsersService,
    private readonly auditService: SecurityAuditService,
    private readonly presenceGateway: PresenceGateway,
    @Optional() private readonly promoAudit?: PromotionAuditService,
  ) {}

  @Get()
  async getSettings() {
    return this.settingsService.getSettingsSafe();
  }

  @Roles('admin')
  @Put()
  async updateSettings(@Body() dto: UpdateSettingsDto, @Req() req: any) {
    const updated = await this.settingsService.updateSettings(dto, req.body);
    // Language policy is enforced live: when the admin changes the system language
    // or flips the staff-override switch, every connected client must re-evaluate
    // immediately (see handleLangPolicy() in the frontend). Only emitted when one
    // of the two fields was actually part of this request, so unrelated settings
    // saves don't churn every open session.
    if (dto.lang !== undefined || dto.langEnabled !== undefined) {
      this.presenceGateway.emitEvent('settings:lang-policy', {
        lang: updated.lang,
        langEnabled: updated.langEnabled !== false,
      });
    }
    return this.settingsService.stripSensitive(updated);
  }

  @Roles('admin')
  @Post('staff-discount/:enabled')
  async setStaffDiscount(@Param('enabled') enabled: string) {
    const value = enabled === 'true';
    const updated = await this.settingsService.setStaffDiscount(value);
    return this.settingsService.stripSensitive(updated);
  }

  @UseGuards(ThrottlerGuard)
  @Post('verify-vault-password')
  async verifyVaultPassword(@Body('password') password: string, @Req() req: any) {
    const isValid = await this.settingsService.verifyVaultPassword(password);

    if (!isValid) {
      const userId: string = req.user?.userId || req.user?.sub || '';
      const username: string = req.user?.username || '';
      const attempts = (vaultAttempts.get(userId) ?? 0) + 1;
      vaultAttempts.set(userId, attempts);

      this.auditService.log({
        userId,
        username,
        violationType: 'vault_violation',
        action: `كلمة سر الخزنة خاطئة — المحاولة ${attempts} من ${MAX_VAULT_ATTEMPTS}`,
        ipAddress: req.ip || '',
      }).catch(() => null);

      if (attempts >= MAX_VAULT_ATTEMPTS) {
        vaultAttempts.delete(userId);
        const user = await this.usersService.findById(userId).catch(() => null);
        if (user && user.isActive !== false) {
          const lockReason = `تم تعطيل الحساب بعد ${MAX_VAULT_ATTEMPTS} محاولات إدخال كلمة سر الخزنة خاطئة`;
          await this.usersService.lockAccount(userId, lockReason, 'system');
          this.presenceGateway.emitToUser(userId, 'user:force-logout', { reason: lockReason });
          this.auditService.log({
            userId,
            username,
            violationType: 'account_locked',
            action: lockReason,
            ipAddress: req.ip || '',
          }).catch(() => null);
        }
        throw new UnauthorizedException(`🔒 تم تعطيل حسابك بعد ${MAX_VAULT_ATTEMPTS} محاولات خاطئة — تواصل مع المدير`);
      }

      const remaining = MAX_VAULT_ATTEMPTS - attempts;
      throw new UnauthorizedException(`كلمة سر الخزنة غير صحيحة — تبقى ${remaining} محاولة قبل تعطيل الحساب`);
    }

    // Success — reset counter
    const userId: string = req.user?.userId || req.user?.sub || '';
    if (userId) vaultAttempts.delete(userId);
    return { valid: true };
  }

  @Roles('admin')
  @Post('backup')
  async createBackup() {
    return await this.settingsService.createBackup();
  }

  @Roles('admin')
  @Get('backups')
  async getBackups() {
    return await this.settingsService.getBackupList();
  }

  // حالة النسخ الاحتياطي السحابي — قراءة فقط.
  // لا يلمس هذا المسار مفاتيح R2 ولا السحابة؛ يقرأ ملف الحالة الذي يكتبه
  // scripts/cloud-backup.sh بعد كل تشغيل. admin فقط: العدد وتاريخ آخر نسخة
  // معلومة تشغيلية عن البنية التحتية.
  @Roles('admin')
  @Get('cloud-backup-status')
  async getCloudBackupStatus() {
    return await this.settingsService.getCloudBackupStatus();
  }

  // --- Cloudflare R2 cloud backup ------------------------------------------
  // Same shape as the Bosta key routes: the secret goes IN through a POST and
  // never comes back out - getSettings() masks it to a boolean flag.

  @Roles('admin')
  @Post('r2-config')
  async saveR2Config(@Body() body: any) {
    await this.settingsService.saveR2Config({
      accountId: body?.accountId,
      accessKeyId: body?.accessKeyId,
      secretAccessKey: body?.secretAccessKey,
      bucket: body?.bucket,
      enabled: body?.enabled,
      keep: body?.keep,
      receiptsMax: body?.receiptsMax,
    });
    return { success: true, message: 'تم حفظ إعدادات النسخ السحابي' };
  }

  // Accepts optional inline credentials so the user can TEST before saving -
  // otherwise they would have to save a wrong key to find out it is wrong.
  @Roles('admin')
  @Post('r2-config/test')
  async testR2(@Body() body: any) {
    return await this.settingsService.testR2Connection({
      accountId: body?.accountId,
      accessKeyId: body?.accessKeyId,
      secretAccessKey: body?.secretAccessKey,
      bucket: body?.bucket,
    });
  }

  @Roles('admin')
  @Post('r2-upload')
  async uploadToR2(@Body('filename') filename?: string) {
    return await this.settingsService.uploadLatestToR2(filename);
  }

  @Roles('admin')
  @Get('r2-backups')
  async listR2Backups() {
    return await this.settingsService.listR2Backups();
  }

  @Roles('admin')
  @Post('reset-all-data')
  async resetAllData(@Body('password') password: string) {
    const isValid = await this.settingsService.verifyVaultPassword(password);
    if (!isValid) {
      throw new UnauthorizedException('كلمة المرور خاطئة - لا يمكن مسح البيانات');
    }
    return await this.settingsService.resetAllData();
  }

  @Roles('admin')
  @Post('reset-selective-data')
  async resetSelectiveData(
    @Body('password') password: string,
    @Body('collections') collections: string[],
    @Body('resetVault') resetVault: boolean,
  ) {
    const isValid = await this.settingsService.verifyVaultPassword(password);
    if (!isValid) {
      throw new UnauthorizedException('كلمة المرور خاطئة - لا يمكن مسح البيانات');
    }
    if (!Array.isArray(collections) || collections.length === 0) {
      throw new UnauthorizedException('يجب اختيار نوع واحد على الأقل للحذف');
    }
    return await this.settingsService.resetSelectiveData(collections, !!resetVault);
  }

  @Roles('admin')
  @UseGuards(ThrottlerGuard)
  @Post('restore-backup')
  async restoreBackup(@Body('filename') filename: string, @Body('password') password: string) {
    const isValid = await this.settingsService.verifyVaultPassword(password);
    if (!isValid) {
      throw new UnauthorizedException('كلمة المرور خاطئة - لا يمكن استرجاع البيانات');
    }
    return await this.settingsService.restoreBackup(filename);
  }

  // «مزامنة من النسخة الحية» — local copy only (see live-sync.util.ts).
  @Roles('admin')
  @Get('live-sync/status')
  getLiveSyncStatus() {
    return this.settingsService.getLiveSyncStatus();
  }

  @Roles('admin')
  @UseGuards(ThrottlerGuard)
  @Post('live-sync')
  async runLiveSync(@Body('password') password: string, @Req() req: any) {
    const isValid = await this.settingsService.verifyVaultPassword(password);
    if (!isValid) throw new UnauthorizedException('كلمة المرور خاطئة - لا يمكن المزامنة');
    return await this.settingsService.runLiveSync(req.user?.name || req.user?.username || 'admin');
  }

  @Roles('admin')
  @Post('preview-selective-restore')
  async previewSelectiveRestore(@Body('filename') filename: string, @Body('password') password: string) {
    const isValid = await this.settingsService.verifyVaultPassword(password);
    if (!isValid) throw new UnauthorizedException('كلمة المرور خاطئة');
    return await this.settingsService.previewSelectiveRestore(filename);
  }

  @Roles('admin')
  @UseGuards(ThrottlerGuard)
  @Post('selective-restore')
  async selectiveRestore(
    @Body('filename') filename: string,
    @Body('password') password: string,
    @Body('sections') sections: string[],
  ) {
    const isValid = await this.settingsService.verifyVaultPassword(password);
    if (!isValid) throw new UnauthorizedException('كلمة المرور خاطئة - لا يمكن الاسترجاع');
    if (!Array.isArray(sections) || sections.length === 0) {
      throw new UnauthorizedException('يجب اختيار قسم واحد على الأقل');
    }
    return await this.settingsService.selectiveRestoreBackup(filename, sections);
  }

  @Roles('admin')
  @Get('download-backup/:filename')
  async downloadBackup(@Param('filename') filename: string, @Res() res: any) {
    const buffer = await this.settingsService.downloadBackupStream(filename);
    if (!buffer) {
      throw new NotFoundException('ملف النسخة الاحتياطية غير موجود');
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="soulia-${filename}"`);
    res.send(buffer);
  }

  @Roles('admin')
  @Delete('backups')
  async deleteAllBackups(@Body('password') password: string) {
    const isValid = await this.settingsService.verifyVaultPassword(password);
    if (!isValid) {
      throw new UnauthorizedException('كلمة المرور خاطئة');
    }
    return await this.settingsService.deleteAllBackups();
  }

  @UseGuards(ThrottlerGuard)
  @Post('upload-backup')
  @UseInterceptors(FileInterceptor('file'))
  async uploadBackup(
    @UploadedFile() file: any,
    @Body('password') password: string,
  ) {
    const isValid = await this.settingsService.verifyVaultPassword(password);
    if (!isValid) {
      throw new UnauthorizedException('كلمة المرور خاطئة');
    }
    return await this.settingsService.uploadBackup(file);
  }

  // ─── Bosta API Key ───────────────────────────────────────────────────────

  @Roles('admin')
  @Post('shopify-config')
  async saveShopifyConfig(@Body() body: any) {
    await this.settingsService.saveShopifyConfig({
      webhookSecret: body?.webhookSecret,
      storeName: body?.storeName,
      accessToken: body?.accessToken,
      clientId: body?.clientId,
      clientSecret: body?.clientSecret,
    });
    const config = await this.settingsService.getShopifyConfig();
    return {
      success: true,
      settings: {
        shopifyWebhookSecretSet: !!config.webhookSecret,
        shopifyAccessTokenSet: !!config.accessToken,
        shopifyStoreName: config.storeName,
        shopifyClientId: config.clientId,
        shopifyClientSecretSet: !!config.clientSecret,
      },
    };
  }

  @Roles('admin')
  @Post('bosta-api-key')
  async saveBostaApiKey(@Body('key') key: string) {
    if (!key || typeof key !== 'string') {
      return { success: false, message: 'المفتاح مطلوب' };
    }
    await this.settingsService.saveBostaApiKey(key);
    return { success: true, message: 'تم حفظ Bosta API Key بنجاح' };
  }

  @Roles('admin')
  @Post('bosta-webhook-secret')
  async saveBostaWebhookSecret(@Body('secret') secret: string) {
    if (!secret || typeof secret !== 'string') {
      return { success: false, message: 'الرمز السري مطلوب' };
    }
    await this.settingsService.saveBostaWebhookSecret(secret);
    return { success: true, message: 'تم حفظ رمز Webhook السري بنجاح' };
  }

  @Roles('admin')
  @Post('bosta-api-key/test')
  async testBostaApiKey(@Body('key') key: string) {
    const apiKey = (key || '').trim() || await this.settingsService.getBostaApiKey();
    if (!apiKey) return { success: false, state: 'unconfigured', message: 'لم يتم إدخال API Key' };
    try {
      // Carrier API keys authorize pickup locations; the user-profile route can reject a working carrier key.
      const result = await new Promise<{ ok: boolean; state: string; message: string }>((resolve) => {
        const https = require('https');
        const req = https.request(
          { hostname: 'app.bosta.co', path: '/api/v2/pickup-locations', method: 'GET', timeout: 10000,
            headers: { Authorization: apiKey, 'Content-Type': 'application/json' } },
          (res: any) => {
            let data = '';
            res.on('data', (c: any) => { data += c; });
            res.on('end', () => {
              if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, state: 'connected', message: 'الاتصال بـ Bosta ناجح ✅' });
              else if (res.statusCode === 401 || res.statusCode === 403)
                resolve({ ok: false, state: 'disconnected', message: 'المفتاح غير صحيح أو لا يملك الصلاحية المطلوبة ❌' });
              else resolve({ ok: false, state: 'error', message: `تعذر فحص الاتصال: HTTP ${res.statusCode}` });
            });
          },
        );
        req.on('timeout', () => req.destroy(new Error('Connection check timed out')));
        req.on('error', (e: any) => resolve({ ok: false, state: 'error', message: `تعذر فحص الاتصال: ${e.message}` }));
        req.end();
      });
      return { success: result.ok, state: result.state, message: result.message };
    } catch (e: any) {
      return { success: false, state: 'error', message: `خطأ: ${e.message}` };
    }
  }

  // ─── Discount Codes ───────────────────────────────────────────────────────
  // Writes were @Roles('admin'); they now follow the promotions page perms (PermsGuard passes
  // admins unconditionally, so nothing changes for them). Reads stay open — the sale form needs
  // the codes and bundles to suggest and validate a discount.

  @Get('discount-codes')
  async getDiscountCodes() {
    return this.settingsService.getDiscountCodes();
  }

  @UseGuards(PermsGuard)
  @RequirePerms('promotions-codes')
  @Post('discount-codes')
  async addDiscountCode(@Body() dto: DiscountCodeDto, @Req() req: any) {
    const by = req.user?.name || req.user?.username || 'admin';
    const updated = await this.settingsService.addDiscountCode(dto, by);
    void this.promoAudit?.recordManage(req.user, { kind: 'code', action: 'created', ref: dto.code, label: dto.code,
      reason: dto.type === 'percent' ? `${dto.value}%` : `${dto.value} EGP` });
    return updated.discountCodes;
  }

  @UseGuards(PermsGuard)
  @RequirePerms('promotions-codes')
  @Put('discount-codes/:id')
  async updateDiscountCode(
    @Param('id') id: string,
    @Body() dto: Partial<DiscountCodeDto>,
    @Req() req: any,
  ) {
    const by = req.user?.name || req.user?.username || 'admin';
    const updated = await this.settingsService.updateDiscountCode(id, dto, by);
    const code = (updated.discountCodes || []).find((c: any) => c.id === id);
    const onlyToggle = Object.keys(dto || {}).length === 1 && dto.active !== undefined;
    void this.promoAudit?.recordManage(req.user, { kind: 'code', ref: id, label: code?.code || id,
      action: onlyToggle ? (dto.active ? 'enabled' : 'disabled') : 'updated' });
    return updated.discountCodes;
  }

  @UseGuards(PermsGuard)
  @RequirePerms('promotions-codes')
  @Delete('discount-codes/:id')
  async deleteDiscountCode(@Param('id') id: string, @Req() req: any) {
    const by = req.user?.name || req.user?.username || 'admin';
    const before = ((await this.settingsService.getDiscountCodes()) || []) as any[];
    const updated = await this.settingsService.deleteDiscountCode(id, by);
    const code = before.find((c: any) => c.id === id);
    void this.promoAudit?.recordManage(req.user, { kind: 'code', action: 'deleted', ref: id, label: code?.code || id });
    return { success: true, discountCodes: updated.discountCodes };
  }

  @Post('discount-codes/validate')
  async validateDiscountCode(@Body('code') code: string) {
    return this.settingsService.validateDiscountCode(code);
  }

  @Post('discount-codes/:id/record-usage')
  async recordDiscountUsage(
    @Param('id') id: string,
    @Body() body: { txRef: string; txId: string; client: string; amount: number },
    @Req() req: any,
  ) {
    const by = req.user?.name || req.user?.username || '';
    await this.settingsService.recordDiscountUsage(id, { ...body, by });
    return { success: true };
  }

  // ─── Discount Bundles ─────────────────────────────────────────────────────

  @Get('discount-bundles')
  async getDiscountBundles() {
    return this.settingsService.getDiscountBundles();
  }

  @UseGuards(PermsGuard)
  @RequirePerms('promotions-bundles')
  @Post('discount-bundles')
  async addDiscountBundle(@Body() dto: DiscountBundleDto, @Req() req: any) {
    const by = req.user?.name || req.user?.username || 'admin';
    const updated = await this.settingsService.addDiscountBundle(dto, by);
    void this.promoAudit?.recordManage(req.user, { kind: 'bundle', action: 'created', label: dto.name });
    return updated.discountBundles;
  }

  @UseGuards(PermsGuard)
  @RequirePerms('promotions-bundles')
  @Put('discount-bundles/:id')
  async updateDiscountBundle(
    @Param('id') id: string,
    @Body() dto: Partial<DiscountBundleDto>,
    @Req() req: any,
  ) {
    const by = req.user?.name || req.user?.username || 'admin';
    const updated = await this.settingsService.updateDiscountBundle(id, dto, by);
    const bundle = (updated.discountBundles || []).find((b: any) => b.id === id);
    const onlyToggle = Object.keys(dto || {}).length === 1 && dto.active !== undefined;
    void this.promoAudit?.recordManage(req.user, { kind: 'bundle', ref: id, label: bundle?.name || id,
      action: onlyToggle ? (dto.active ? 'enabled' : 'disabled') : 'updated' });
    return updated.discountBundles;
  }

  @UseGuards(PermsGuard)
  @RequirePerms('promotions-bundles')
  @Delete('discount-bundles/:id')
  async deleteDiscountBundle(@Param('id') id: string, @Req() req: any) {
    const before = ((await this.settingsService.getDiscountBundles()) || []) as any[];
    const updated = await this.settingsService.deleteDiscountBundle(id);
    const bundle = before.find((b: any) => b.id === id);
    void this.promoAudit?.recordManage(req.user, { kind: 'bundle', action: 'deleted', ref: id, label: bundle?.name || id });
    return { success: true, discountBundles: updated.discountBundles };
  }
}
