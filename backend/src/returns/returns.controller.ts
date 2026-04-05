import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ReturnsService } from './returns.service';
import { RejectReturnDto } from './dto/return-request.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

const VAULT_HEADER_CODE_TO_METHOD: Record<string, string> = {
  cash: 'كاش',
  vodafone: 'فودافون كاش',
  instapay: 'Instapay',
  bank: 'تحويل بنكي',
};

function readVaultMethodFromHeader(
  headerVal: string | string[] | undefined,
): string | undefined {
  const raw = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (!raw || typeof raw !== 'string') {
    return undefined;
  }
  return VAULT_HEADER_CODE_TO_METHOD[raw.trim().toLowerCase()];
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('returns')
export class ReturnsController {
  constructor(private readonly returnsService: ReturnsService) {}

  @Get()
  async findAll() {
    return this.returnsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.returnsService.findById(id);
  }

  @Post()
  async create(
    @Req() req: Request & { user: { name: string; username: string } },
  ) {
    const requestedBy = req.user.name || req.user.username;
    const raw = req.body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('بيانات الطلب غير صالحة');
    }
    const payload = { ...(raw as Record<string, unknown>) };
    const refundFromHeader = readVaultMethodFromHeader(
      req.headers['x-soulia-vault-refund'],
    );
    const collectFromHeader = readVaultMethodFromHeader(
      req.headers['x-soulia-vault-collect'],
    );
    if (refundFromHeader) {
      payload.vaultRefundAccount = refundFromHeader;
    }
    if (collectFromHeader) {
      payload.vaultCollectAccount = collectFromHeader;
    }
    return this.returnsService.create(payload, requestedBy);
  }

  @Roles('admin')
  @Post(':id/approve')
  async approve(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const approvedBy = req.user.name || req.user.username;
    return this.returnsService.approve(id, approvedBy);
  }

  @Roles('admin')
  @Post(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectReturnDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const approvedBy = req.user.name || req.user.username;
    return this.returnsService.reject(id, approvedBy, dto.rejectedReason);
  }
}
