import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  UnauthorizedException,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { ThrottlerGuard } from '@nestjs/throttler';
import { SettingsService } from './settings.service';
import { UpdateSettingsDto } from './dto/settings.dto';
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
  async updateSettings(@Body() dto: UpdateSettingsDto) {
    const updated = await this.settingsService.updateSettings(dto);
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
  downloadBackup(@Res() res: Response, @Param('filename') filename: string) {
    this.settingsService.downloadBackup(res, filename);
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

  @Roles('admin')
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
}
