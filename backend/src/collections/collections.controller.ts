import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { CollectionsService } from './collections.service';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
  AssignProductsDto,
  LinkSupplierDto,
} from './dto/collection.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

type ReqUser = { user?: { name?: string; username?: string } };

function actorOf(req: ReqUser): string {
  return req.user?.name || req.user?.username || 'مستخدم';
}

@UseGuards(JwtAuthGuard)
@Controller('collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService) {}

  @Get()
  async findAll(@Query('categoryId') categoryId?: string) {
    if (categoryId) return this.collectionsService.findByCategory(categoryId);
    return this.collectionsService.findAll();
  }

  @Get('search-products/:partial')
  async searchAssignableProducts(@Param('partial') partial: string) {
    return this.collectionsService.searchAssignableProducts(partial);
  }

  @Get('product-links')
  async getProductCollectionMap() {
    return this.collectionsService.getProductCollectionMap();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.collectionsService.findById(id);
  }

  @Get(':id/products')
  async getProducts(@Param('id') id: string) {
    return this.collectionsService.getProducts(id);
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post()
  async create(@Body() dto: CreateCollectionDto, @Request() req: ReqUser) {
    return this.collectionsService.create(dto, actorOf(req));
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCollectionDto,
    @Request() req: ReqUser,
  ) {
    return this.collectionsService.update(id, dto, actorOf(req));
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.collectionsService.remove(id);
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post(':id/products')
  async assignProducts(
    @Param('id') id: string,
    @Body() dto: AssignProductsDto,
    @Request() req: ReqUser,
  ) {
    return this.collectionsService.assignProducts(
      id,
      dto.productIds,
      actorOf(req),
    );
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Delete(':id/products/:productId')
  async removeProduct(
    @Param('id') id: string,
    @Param('productId') productId: string,
    @Request() req: ReqUser,
  ) {
    return this.collectionsService.removeProduct(
      id,
      productId,
      actorOf(req),
    );
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post(':id/suppliers')
  async linkSupplier(
    @Param('id') id: string,
    @Body() dto: LinkSupplierDto,
    @Request() req: ReqUser,
  ) {
    return this.collectionsService.linkSupplier(
      id,
      dto.supplierId,
      actorOf(req),
    );
  }

  @UseGuards(RolesGuard)
  @Roles('admin')
  @Delete(':id/suppliers/:supplierId')
  async unlinkSupplier(
    @Param('id') id: string,
    @Param('supplierId') supplierId: string,
    @Request() req: ReqUser,
  ) {
    return this.collectionsService.unlinkSupplier(
      id,
      supplierId,
      actorOf(req),
    );
  }
}
