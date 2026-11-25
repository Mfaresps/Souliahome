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
  Optional,
  ForbiddenException,
} from '@nestjs/common';
import { DiscountOtpService } from '../discount-otp/discount-otp.service';
import { changedFields } from '../shared/cost-visibility.util';
import { CollectionsService } from './collections.service';
import {
  CreateCollectionDto,
  UpdateCollectionDto,
  AssignProductsDto,
  LinkSupplierDto,
} from './dto/collection.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';

type ReqUser = { user?: { name?: string; username?: string } };

function actorOf(req: ReqUser): string {
  return req.user?.name || req.user?.username || 'مستخدم';
}

// Fine-grained `categories-*` perms replace the old blanket @Roles('admin').
// PermsGuard bypasses unconditionally for role === 'admin', so admin access is unchanged.
@UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
@Controller('collections')
export class CollectionsController {
  constructor(private readonly collectionsService: CollectionsService, @Optional() private readonly otp?: DiscountOtpService) {}

  @Get()
  @RequirePerms('categories-view')
  async findAll(@Query('categoryId') categoryId?: string) {
    if (categoryId) return this.collectionsService.findByCategory(categoryId);
    return this.collectionsService.findAll();
  }

  @Get('search-products/:partial')
  @RequirePerms('categories-assign-products')
  async searchAssignableProducts(@Param('partial') partial: string) {
    return this.collectionsService.searchAssignableProducts(partial);
  }

  // Read by the Products page taxonomy chips too, so it stays on the base view perm.
  @Get('product-links')
  @RequirePerms('categories-view')
  async getProductCollectionMap() {
    return this.collectionsService.getProductCollectionMap();
  }

  @Get(':id')
  @RequirePerms('categories-view')
  async findOne(@Param('id') id: string) {
    return this.collectionsService.findById(id);
  }

  @Get(':id/products')
  @RequirePerms('categories-view')
  async getProducts(@Param('id') id: string) {
    return this.collectionsService.getProducts(id);
  }

  @Post()
  @RequirePerms('categories-create')
  async create(@Body() dto: CreateCollectionDto, @Request() req: ReqUser) {
    return this.collectionsService.create(dto, actorOf(req));
  }

  /** `categories-edit` saves directly; `categories-edit-otp` needs a manager code (Nov 25, 2026). */
  @Put(':id')
  @RequirePerms('categories-view')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCollectionDto,
    @Request() req: ReqUser,
  ) {
    const { otpId, ...body } = dto as UpdateCollectionDto & { otpId?: string };
    const user: any = (req as any)?.user || {}, perms: string[] = user.perms || [];
    if (user.role === 'admin' || perms.includes('categories-edit')) return this.collectionsService.update(id, body as UpdateCollectionDto, actorOf(req));
    if (!perms.includes('categories-edit-otp') || !this.otp) throw new ForbiddenException('ليست لديك صلاحية تعديل المجموعات');
    const changed = changedFields(await this.collectionsService.findById(id), body as Record<string, unknown>);
    if (!changed.length) return this.collectionsService.findById(id);
    const release = await this.otp.consumeRecordEditOtp(String(otpId || ''), 'collection', id, changed);
    try { return await this.collectionsService.update(id, body as UpdateCollectionDto, actorOf(req)); }
    catch (error) { await release(); throw error; }
  }

  @Delete(':id')
  @RequirePerms('categories-delete')
  async remove(@Param('id') id: string) {
    return this.collectionsService.remove(id);
  }

  @Post(':id/products')
  @RequirePerms('categories-assign-products')
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

  @Delete(':id/products/:productId')
  @RequirePerms('categories-assign-products')
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

  @Post(':id/suppliers')
  @RequirePerms('categories-link-suppliers')
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

  @Delete(':id/suppliers/:supplierId')
  @RequirePerms('categories-link-suppliers')
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
