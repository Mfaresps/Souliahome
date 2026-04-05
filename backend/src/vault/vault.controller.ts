import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { VaultService } from './vault.service';
import { CreateVaultEntryDto } from './dto/vault.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vault')
export class VaultController {
  constructor(private readonly vaultService: VaultService) {}

  @Get()
  async findAll(@Query('from') from?: string, @Query('to') to?: string) {
    return this.vaultService.findAll(from, to);
  }

  @Roles('admin')
  @Post()
  async addEntry(@Body() dto: CreateVaultEntryDto) {
    return this.vaultService.addEntry(dto);
  }
}
