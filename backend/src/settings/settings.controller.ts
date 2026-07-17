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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto, DiscountCodeDto, DiscountBundleDto } from './dto/settings.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
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
  ) {}

  @Get()
  async getSettings() {
    return this.settingsService.getSettingsSafe();
  }

  @Roles('admin')
  @Put()
  async updateSettings(@Body() dto: UpdateSettingsDto, @Req() req: any) {
    const updated = await this.settingsService.updateSettings(dto, req.body);
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
    if (!apiKey) return { success: false, message: 'لم يتم إدخال API Key' };
    try {
      // Test using /api/v2/users/profile — returns 200 on valid key, 401 on invalid
      const result = await new Promise<{ ok: boolean; message: string }>((resolve) => {
        const https = require('https');
        const req = https.request(
          { hostname: 'app.bosta.co', path: '/api/v2/users/profile', method: 'GET',
            headers: { Authorization: apiKey, 'Content-Type': 'application/json' } },
          (res: any) => {
            let data = '';
            res.on('data', (c: any) => { data += c; });
            res.on('end', () => {
              if (res.statusCode === 200) resolve({ ok: true, message: 'الاتصال بـ Bosta ناجح ✅' });
              else if (res.statusCode === 401 || res.statusCode === 403)
                resolve({ ok: false, message: 'المفتاح غير صحيح أو منتهي الصلاحية ❌' });
              else resolve({ ok: false, message: `استجابة غير متوقعة: HTTP ${res.statusCode}` });
            });
          },
        );
        req.on('error', (e: any) => resolve({ ok: false, message: `خطأ في الاتصال: ${e.message}` }));
        req.end();
      });
      return { success: result.ok, message: result.message };
    } catch (e: any) {
      return { success: false, message: `خطأ: ${e.message}` };
    }
  }

  // ─── Discount Codes ───────────────────────────────────────────────────────

  @Get('discount-codes')
  async getDiscountCodes() {
    return this.settingsService.getDiscountCodes();
  }

  @Roles('admin')
  @Post('discount-codes')
  async addDiscountCode(@Body() dto: DiscountCodeDto, @Req() req: any) {
    const by = req.user?.name || req.user?.username || 'admin';
    const updated = await this.settingsService.addDiscountCode(dto, by);
    return updated.discountCodes;
  }

  @Roles('admin')
  @Put('discount-codes/:id')
  async updateDiscountCode(
    @Param('id') id: string,
    @Body() dto: Partial<DiscountCodeDto>,
    @Req() req: any,
  ) {
    const by = req.user?.name || req.user?.username || 'admin';
    const updated = await this.settingsService.updateDiscountCode(id, dto, by);
    return updated.discountCodes;
  }

  @Roles('admin')
  @Delete('discount-codes/:id')
  async deleteDiscountCode(@Param('id') id: string, @Req() req: any) {
    const by = req.user?.name || req.user?.username || 'admin';
    const updated = await this.settingsService.deleteDiscountCode(id, by);
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

  @Roles('admin')
  @Post('discount-bundles')
  async addDiscountBundle(@Body() dto: DiscountBundleDto, @Req() req: any) {
    const by = req.user?.name || req.user?.username || 'admin';
    const updated = await this.settingsService.addDiscountBundle(dto, by);
    return updated.discountBundles;
  }

  @Roles('admin')
  @Put('discount-bundles/:id')
  async updateDiscountBundle(
    @Param('id') id: string,
    @Body() dto: Partial<DiscountBundleDto>,
    @Req() req: any,
  ) {
    const by = req.user?.name || req.user?.username || 'admin';
    const updated = await this.settingsService.updateDiscountBundle(id, dto, by);
    return updated.discountBundles;
  }

  @Roles('admin')
  @Delete('discount-bundles/:id')
  async deleteDiscountBundle(@Param('id') id: string) {
    const updated = await this.settingsService.deleteDiscountBundle(id);
    return { success: true, discountBundles: updated.discountBundles };
  }
}
