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
} from './dto/supplier-return.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
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

  @Post()
  async create(
    @Body() dto: CreateSupplierReturnDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const requestedBy = req.user.name || req.user.username;
    return this.supplierReturnsService.create(dto, requestedBy);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSupplierReturnDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username;
    return this.supplierReturnsService.update(id, dto, by);
  }

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

  @Roles('admin')
  @Post(':id/complete')
  async complete(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const completedBy = req.user.name || req.user.username;
    return this.supplierReturnsService.complete(id, completedBy);
  }

  @Roles('admin')
  @Post(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body() dto: CancelSupplierReturnDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username;
    return this.supplierReturnsService.cancel(id, by, dto.reason);
  }
}
