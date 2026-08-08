import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SupplierReturnsService } from './supplier-returns.service';
import {
  CreateSupplierReturnDto,
  UpdateSupplierReturnDto,
  RejectSupplierReturnDto,
  CancelSupplierReturnDto,
  CompleteSupplierReturnDto,
  ReverseSupplierReturnDto,
} from './dto/supplier-return.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';

/**
 * Writes are gated on `suppliers-returns`; approve/reject deliberately stay @Roles('admin').
 *
 * The submit → approve step exists to put a second person between a staff member and a stock/
 * ledger movement. Folding approval into the same perm as creation would let one holder request
 * and approve their own return, which is the exact control the two-step flow provides.
 *
 * The GET routes stay JWT-only: `GET /supplier-returns` is a boot-time load that also feeds the
 * approvals page, so gating it would break approvals for a user who legitimately holds
 * `approvals` but not the supplier-returns tab. Tab visibility is enforced client-side.
 */
@UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
@Controller('supplier-returns')
export class SupplierReturnsController {
  constructor(private readonly supplierReturnsService: SupplierReturnsService) {}

  @Get()
  async findAll() {
    return this.supplierReturnsService.findAll();
  }

  @Get('supplier/:supplierId')
  async findBySupplier(@Param('supplierId') supplierId: string) {
    return this.supplierReturnsService.findBySupplier(supplierId);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.supplierReturnsService.findById(id);
  }

  @RequirePerms('suppliers-returns')
  @Post()
  async create(
    @Body() dto: CreateSupplierReturnDto,
    @Req() req: { user: { name: string; username: string; role: string } },
  ) {
    const requestedBy = req.user.name || req.user.username;
    return this.supplierReturnsService.create(
      dto,
      requestedBy,
      req.user.role === 'admin',
    );
  }

  @RequirePerms('suppliers-returns')
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSupplierReturnDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username;
    return this.supplierReturnsService.update(id, dto, by);
  }

  @RequirePerms('suppliers-returns')
  @Post(':id/submit')
  async submit(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username;
    return this.supplierReturnsService.submitForApproval(id, by);
  }

  @Roles('admin')
  @Post(':id/approve')
  async approve(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const approvedBy = req.user.name || req.user.username;
    return this.supplierReturnsService.approve(id, approvedBy);
  }

  @Roles('admin')
  @Post(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectSupplierReturnDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username;
    return this.supplierReturnsService.reject(id, by, dto.rejectedReason);
  }

  @RequirePerms('suppliers-returns')
  @Post(':id/complete')
  async complete(
    @Param('id') id: string,
    @Body() dto: CompleteSupplierReturnDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const completedBy = req.user.name || req.user.username;
    return this.supplierReturnsService.complete(
      id,
      completedBy,
      dto?.settlementMode,
      dto?.remainderMode,
      dto?.vaultRefundAccount,
    );
  }

  @RequirePerms('suppliers-returns')
  @Post(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body() dto: CancelSupplierReturnDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username;
    return this.supplierReturnsService.cancel(id, by, dto.reason);
  }

  @RequirePerms('suppliers-returns')
  @Post(':id/reverse')
  async reverse(
    @Param('id') id: string,
    @Body() dto: ReverseSupplierReturnDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username;
    return this.supplierReturnsService.reverseReturn(id, by, dto.reason);
  }
}
