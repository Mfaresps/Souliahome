import { Controller, Get, Post, Body, Query, Req, UseGuards } from '@nestjs/common';
import { InventoryMovementsService } from './inventory-movements.service';
import { AdjustInventoryDto } from './dto/inventory-movement.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('inventory-movements')
export class InventoryMovementsController {
  constructor(private readonly service: InventoryMovementsService) {}

  @Get()
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('productCode') productCode?: string,
    @Query('productName') productName?: string,
    @Query('type') type?: string,
    @Query('by') by?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('ref') ref?: string,
    @Query('sortDir') sortDir?: string,
  ) {
    return this.service.findAll(
      {
        productCode,
        productName,
        type,
        by,
        dateFrom,
        dateTo,
        sourceTransactionRef: ref,
        sortDir: sortDir === 'asc' ? 'asc' : 'desc',
      },
      page ? Number(page) : 1,
      limit ? Number(limit) : 30,
    );
  }

  @Roles('admin')
  @Post('adjust')
  async adjust(
    @Body() dto: AdjustInventoryDto,
    @Req() req: { user: { name: string; username: string; userId?: string } },
  ) {
    const by = req.user?.name || req.user?.username || 'مستخدم';
    return this.service.adjustStock({
      productId: dto.productId,
      qtyDelta: dto.qtyDelta,
      reason: dto.reason,
      by,
      byUserId: req.user?.userId || '',
    });
  }
}
