import { Controller, Get, Post, Body, Query, Param, Req, UseGuards, Optional, ForbiddenException } from '@nestjs/common';
import { BrowseAccessService, MIN_SEARCH_CHARS, MOVEMENTS_FREE_PAGES, MOVEMENTS_FREE_PAGE_SIZE } from '../browse-access/browse-access.service';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';
import { InventoryMovementsService } from './inventory-movements.service';
import { AdjustInventoryDto } from './dto/inventory-movement.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('inventory-movements')
export class InventoryMovementsController {
  constructor(private readonly service: InventoryMovementsService, @Optional() private readonly browseAccess?: BrowseAccessService) {}

  @Get(':id/pieces')
  @UseGuards(PermsGuard)
  @RequirePerms('inventory-units-view')
  pieces(@Param('id') id: string, @Query('page') page?: string) {
    return this.service.movementPieces(id, Number(page) || 1);
  }

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
    @Req() req?: any,
  ) {
    const pageNo = Math.max(1, Number(page) || 1);
    let size = limit ? Number(limit) || 30 : 30;
    // Bulk-browsing protection (Nov 25, 2026), same rule as the transactions log: without
    // «تصفح سجل حركة المخزون كاملًا» or a manager grant, the first 100 rows only — 5 pages of 20,
    // or page 1 alone up to 100 (the product page reads its history that way). Searches shorter
    // than 3 characters are ignored; paging past page 1 is watched.
    if (this.browseAccess && !(await this.browseAccess.canBrowse(req?.user, 'inventory-log'))) {
      if (pageNo > MOVEMENTS_FREE_PAGES) {
        throw new ForbiddenException({ code: 'BROWSE_PRIVATE', scope: 'inventory-log',
          message: 'حفاظًا على خصوصية البيانات، يمكنك تصفّح أول ' + MOVEMENTS_FREE_PAGES + ' صفحات فقط من سجل حركة المخزون. ابحث بكود الصنف، أو اطلب صلاحية التصفح من المدير.' });
      }
      size = Math.min(size, pageNo === 1 ? MOVEMENTS_FREE_PAGES * MOVEMENTS_FREE_PAGE_SIZE : MOVEMENTS_FREE_PAGE_SIZE);
      if (productCode && productCode.trim().length < MIN_SEARCH_CHARS) productCode = undefined;
      if (productName && productName.trim().length < MIN_SEARCH_CHARS) productName = undefined;
      if (ref && ref.trim().length < MIN_SEARCH_CHARS) ref = undefined;
      if (pageNo > 1) await this.browseAccess.trackPaging(req?.user, 'inventory-log');
    }
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
      pageNo,
      size,
    );
  }

  /** قطع المنتج التالفة/المفقودة وحالتها لنافذة التسوية — بنفس قواعد السيرفر. */
  @Roles('admin')
  @Get('writeoff-candidates')
  async writeoffCandidates(@Query('productId') productId: string) {
    return this.service.writeoffCandidates(productId);
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
      warehouseCode: dto.warehouseCode,
      qtyDelta: dto.qtyDelta,
      reason: dto.reason,
      by,
      byUserId: req.user?.userId || '',
      unitIds: dto.unitIds,
      requestKey: dto.requestKey,
      unidentifiedConfirmed: dto.unidentifiedConfirmed,
      unidentifiedNote: dto.unidentifiedNote,
    });
  }
}
