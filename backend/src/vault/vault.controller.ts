import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Query,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { VaultService } from './vault.service';
import { CreateVaultEntryDto, UpdateVaultEntryDto } from './dto/vault.dto';
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

  @Get('statistics')
  async getStatistics(@Query('seg') seg?: string) {
    return this.vaultService.getStatistics(seg);
  }

  @Get('search')
  async search(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('seg') seg?: string,
    @Query('employee') employee?: string,
    @Query('status') status?: string,
    @Query('transactionType') transactionType?: string,
  ) {
    return this.vaultService.searchAndFilter({
      from,
      to,
      seg,
      employee,
      status,
      transactionType,
    });
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.vaultService.getById(id);
  }

  @Roles('admin')
  @Post()
  async addEntry(
    @Body() dto: CreateVaultEntryDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const employee = req.user?.name || req.user?.username || '';
    return this.vaultService.addEntry(dto, employee);
  }

  @Roles('admin')
  @Put(':id')
  async updateEntry(
    @Param('id') id: string,
    @Body() dto: UpdateVaultEntryDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const editor = req.user?.name || req.user?.username || '';
    return this.vaultService.updateEntry(id, dto, editor);
  }

  @Roles('admin')
  @Post(':id/freeze')
  async freezeEntry(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @Req() req: { user: { name: string; username: string } },
  ) {
    const freezer = req.user?.name || req.user?.username || '';
    return this.vaultService.freezeEntry(id, body.reason, freezer);
  }

  @Roles('admin')
  @Post(':id/cancel')
  async cancelEntry(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Req() req: { user: { name: string; username: string } },
  ) {
    const canceller = req.user?.name || req.user?.username || '';
    return this.vaultService.cancelEntry(id, canceller, body.reason);
  }

  @Roles('admin')
  @Post(':id/approve')
  async approveEntry(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const approver = req.user?.name || req.user?.username || '';
    return this.vaultService.approveEntry(id, approver);
  }
}
