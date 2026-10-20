import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  CreatePurchaseOrderDto,
  UpdatePoStatusDto,
  UpdatePoDto,
  ConvertPoToInvoiceDto,
} from './dto/purchase-order.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';
import { PurchaseReceivingService } from './purchase-receiving.service';

@UseGuards(JwtAuthGuard, PermsGuard)
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly poService: PurchaseOrdersService, private readonly receiving: PurchaseReceivingService) {}

  @Get(':id/receipt')
  @RequirePerms('purchase-view')
  receipt(@Param('id') id: string) { return this.receiving.summary(id); }

  @Get()
  findAll() {
    return this.poService.findAll();
  }

  @Get('supplier/:supplierId')
  findBySupplier(@Param('supplierId') supplierId: string) {
    return this.poService.findBySupplier(supplierId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.poService.findById(id);
  }

  @Post()
  create(@Body() dto: CreatePurchaseOrderDto) {
    return this.poService.create(dto);
  }

  @Put(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePoStatusDto,
  ) {
    return this.poService.updateStatus(id, dto);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePoDto,
  ) {
    return this.poService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.poService.remove(id);
  }

  @Post(':id/convert')
  @RequirePerms('purchase-create')
  convert(
    @Param('id') id: string,
    @Body() dto: ConvertPoToInvoiceDto,
    @Req() req: any,
  ) {
    const callerRole = req.user?.role;
    return this.poService.convertToInvoice(id, dto, callerRole, req.user);
  }
}
