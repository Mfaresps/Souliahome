import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
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
}
