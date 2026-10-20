import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  ForbiddenException,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductAnalyticsService } from './product-analytics.service';
import {
  CreateProductDto,
  UpdateProductDto,
  ImportProductsDto,
  BulkUpdateProductDto,
  BulkDeleteProductDto,
  RequestProductEditDto,
  ReviewProductEditDto,
} from './dto/product.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';

type ReqUser = { user?: { userId?: string; name?: string; username?: string; role?: string; perms?: string[] } };

function actorOf(req: ReqUser): string {
  return req.user?.name || req.user?.username || 'مستخدم';
}

@UseGuards(JwtAuthGuard, PermsGuard)
@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly analyticsService: ProductAnalyticsService,
  ) {}

  @Get()
  async findAll() {
    return this.productsService.findAll();
  }

  @Get('analytics/card/:productCodeOrName')
  async getProductCard(@Param('productCodeOrName') productCodeOrName: string) {
    return this.analyticsService.getProductAnalytics(productCodeOrName);
  }

  @Get('analytics/search/:partial')
  async searchProductsForAnalytics(@Param('partial') partial: string) {
    return this.analyticsService.searchProducts(partial);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.productsService.findById(id);
  }

  @Post()
  @RequirePerms('products-sku-manage')
  async create(@Body() dto: CreateProductDto, @Request() req: ReqUser) {
    return this.productsService.create(dto, actorOf(req));
  }

  @Post('import')
  @RequirePerms('products-sku-manage')
  async importProducts(@Body() dto: ImportProductsDto, @Request() req: ReqUser) {
    return this.productsService.importProducts(dto.items, actorOf(req));
  }

  @Post('bulk-update')
  async bulkUpdate(@Body() dto: BulkUpdateProductDto) {
    const { ids, ...fields } = dto;
    const count = await this.productsService.bulkUpdate(ids, fields);
    return { message: `تم تعديل ${count} صنف`, modifiedCount: count };
  }

  @Post('bulk-delete')
  @RequirePerms('products-sku-manage')
  async bulkDelete(@Body() dto: BulkDeleteProductDto) {
    const count = await this.productsService.bulkDelete(dto.ids);
    return { message: `تم حذف ${count} صنف`, deletedCount: count };
  }

  @Post('batch-delete')
  @RequirePerms('products-sku-manage')
  async batchDelete(@Body() body: { codes: string[] }) {
    const count = await this.productsService.batchDeleteByCodes(body.codes);
    return { message: `تم حذف ${count} صنف`, deletedCount: count };
  }

  @Post('sync-product-refs')
  @UseGuards(RolesGuard)
  @Roles('admin')
  async syncProductRefs() {
    const result = await this.productsService.syncProductRefs();
    return { message: `تم تحديث ${result.txUpdated} معاملة و ${result.itemsPatched} صنف`, ...result };
  }

  @Post(':id/request-edit')
  async requestEdit(@Param('id') id: string, @Body() dto: RequestProductEditDto, @Request() req: ReqUser) {
    return this.productsService.requestProductEdit(id, {
      requestedBy: actorOf(req),
      requestedById: req.user?.userId,
      requestedByUsername: req.user?.username,
      changes: dto.changes || {},
    });
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post(':id/approve-edit')
  async approveEdit(@Param('id') id: string, @Request() req: { user: { name?: string; username?: string } }) {
    const reviewedBy = req.user?.name || req.user?.username || 'المدير';
    return this.productsService.approveProductEdit(id, reviewedBy);
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post(':id/reject-edit')
  async rejectEdit(@Param('id') id: string, @Body() dto: ReviewProductEditDto, @Request() req: { user: { name?: string; username?: string } }) {
    const reviewedBy = req.user?.name || req.user?.username || 'المدير';
    return this.productsService.rejectProductEdit(id, reviewedBy, dto.rejectedReason);
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
    @Request() req: ReqUser,
  ) {
    if (dto.buyPrice !== undefined && req.user?.role !== 'admin') {
      const perms = req.user?.perms || [];
      if (!perms.includes('purchase-edit-price')) {
        throw new ForbiddenException('ليس لديك صلاحية تعديل سعر الشراء');
      }
    }
    return this.productsService.update(id, dto, actorOf(req));
  }

  @Delete(':id')
  @RequirePerms('products-sku-manage')
  async remove(@Param('id') id: string) {
    await this.productsService.remove(id);
    return { message: 'تم حذف الصنف' };
  }
}
