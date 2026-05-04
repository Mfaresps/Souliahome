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
  StreamableFile,
  Res,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto, DiscountCodeDto } from './dto/settings.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

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
  async verifyVaultPassword(@Body('password') password: string) {
    const isValid = await this.settingsService.verifyVaultPassword(password);
    if (!isValid) {
      throw new UnauthorizedException('كلمة المرور غلط');
    }
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
  @UseGuards(ThrottlerGuard)
  @Post('reset-all-data')
  async resetAllData(@Body('password') password: string) {
    const isValid = await this.settingsService.verifyVaultPassword(password);
    if (!isValid) {
      throw new UnauthorizedException('كلمة المرور خاطئة - لا يمكن مسح البيانات');
    }
    return await this.settingsService.resetAllData();
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
}
