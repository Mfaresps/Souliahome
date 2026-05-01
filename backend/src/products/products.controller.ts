import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductAnalyticsService } from './product-analytics.service';
import {
  CreateProductDto,
  UpdateProductDto,
  ImportProductsDto,
  BulkUpdateProductDto,
  BulkDeleteProductDto,
} from './dto/product.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';

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
