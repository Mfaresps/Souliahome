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

@UseGuards(JwtAuthGuard)
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
  async create(@Body() dto: CreateProductDto) {
    return this.productsService.create(dto);
  }

  @Post('import')
  async importProducts(@Body() dto: ImportProductsDto) {
    return this.productsService.importProducts(dto.items);
  }

  @Post('bulk-update')
  async bulkUpdate(@Body() dto: BulkUpdateProductDto) {
    const { ids, ...fields } = dto;
    const count = await this.productsService.bulkUpdate(ids, fields);
    return { message: `تم تعديل ${count} صنف`, modifiedCount: count };
  }

  @Post('bulk-delete')
  async bulkDelete(@Body() dto: BulkDeleteProductDto) {
    const count = await this.productsService.bulkDelete(dto.ids);
    return { message: `تم حذف ${count} صنف`, deletedCount: count };
  }

  @Post('batch-delete')
  async batchDelete(@Body() body: { codes: string[] }) {
    const count = await this.productsService.batchDeleteByCodes(body.codes);
    return { message: `تم حذف ${count} صنف`, deletedCount: count };
  }

  @Post('sync-product-refs')
  async syncProductRefs() {
    const result = await this.productsService.syncProductRefs();
    return { message: `تم تحديث ${result.txUpdated} حركة و ${result.itemsPatched} صنف`, ...result };
  }

  @Post(':id/request-edit')
  async requestEdit(@Param('id') id: string, @Body() dto: RequestProductEditDto) {
    return this.productsService.requestProductEdit(id, {
      requestedBy: dto.requestedBy,
      requestedById: dto.requestedById,
      requestedByUsername: dto.requestedByUsername,
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
  async update(@Param('id') id: string, @Body() dto: UpdateProductDto) {
    return this.productsService.update(id, dto);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.productsService.remove(id);
    return { message: 'تم حذف الصنف' };
  }
}
