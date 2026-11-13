import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { ProductAnalyticsService } from './product-analytics.service';
import { ProductCostService } from './product-cost.service';
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
import { PromotionAuditService } from '../promotions/promotion-audit.service';
import { canViewPromotions } from '../promotions/promotion-perms';

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
    private readonly productCost: ProductCostService,
    @Optional() private readonly promoAudit?: PromotionAuditService,
  ) {}

  @Get()
  async findAll() {
    return this.productsService.findAll();
  }

  /** سجل متوسط التكلفة (خطوة 3) — نفس قاعدة رؤية سعر الشراء: أدمن أو purchase-edit-price. */
  @Get(':id/cost-history')
  async costHistory(@Param('id') id: string, @Request() req: ReqUser) {
    if (req.user?.role !== 'admin' && !(req.user?.perms || []).includes('purchase-edit-price')) {
      throw new ForbiddenException('ليس لديك صلاحية على تكلفة المنتج');
    }
    return this.productCost.history(id);
  }

  /**
   * كل عروض الأسعار على كل الأصناف — لصفحة «العروض والخصومات». أي صلاحية promotions-* تفتحها
   * للقراءة. ⚠ متعرّفة قبل `:id/...` عشان الترتيب، رغم إن الشكل مختلف.
   */
  @Get('offers/all')
  async allOffers(@Request() req: ReqUser) {
    if (!canViewPromotions(req.user)) throw new ForbiddenException('ليس لديك صلاحية على العروض');
    return this.productsService.listAllOffers();
  }

  /** عروض أسعار البيع. القراءة لأي حد بيشوف الأصناف؛ الإضافة والتعديل والإيقاف لصاحب promotions-offers
   *  (كانت للأدمن بس — PermsGuard بيعدّي الأدمن دايمًا). */
  @Get(':id/offers')
  async offers(@Param('id') id: string) {
    return this.productsService.listOffers(id);
  }

  @RequirePerms('promotions-offers')
  @Post(':id/offers')
  async addOffer(@Param('id') id: string, @Body() body: { price?: number; from?: string; to?: string; reason?: string }, @Request() req: ReqUser) {
    const offer = await this.productsService.addOffer(id, body, actorOf(req));
    void this.promoAudit?.recordManage(req.user, { kind: 'offer', action: 'created', ref: id, label: offer.reason || '', amount: offer.price, reason: `${offer.from} → ${offer.to}` });
    return offer;
  }

  @RequirePerms('promotions-offers')
  @Patch(':id/offers/:offerId')
  async updateOffer(@Param('id') id: string, @Param('offerId') offerId: string, @Body() body: { price?: number; from?: string; to?: string; reason?: string }, @Request() req: ReqUser) {
    const before = (await this.productsService.listOffers(id)).find((o) => o.id === offerId);
    const next = await this.productsService.updateOffer(id, offerId, body, actorOf(req));
    // «تفعيل الآن» = an upcoming offer whose start moved to today, so it is running after the edit.
    const after = before?.status === 'upcoming' ? (await this.productsService.listOffers(id)).find((o) => o.id === offerId) : null;
    const startedNow = after?.status === 'active';
    void this.promoAudit?.recordManage(req.user, { kind: 'offer', action: startedNow ? 'started' : 'updated', ref: id, label: next.reason || '', amount: next.price, reason: `${next.from} → ${next.to}` });
    return next;
  }

  @RequirePerms('promotions-offers')
  @Post(':id/offers/:offerId/end')
  async endOffer(@Param('id') id: string, @Param('offerId') offerId: string, @Request() req: ReqUser) {
    const next = await this.productsService.endOffer(id, offerId, actorOf(req));
    void this.promoAudit?.recordManage(req.user, { kind: 'offer', action: next.cancelled ? 'cancelled' : 'stopped', ref: id, label: next.reason || '', amount: next.price, reason: `${next.from} → ${next.to}` });
    return next;
  }

  /** تصحيح يدوي موثّق للمتوسط — أدمن فقط، وبسبب. بيأثر على البيعات الجاية بس. */
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Post(':id/revalue-cost')
  async revalueCost(@Param('id') id: string, @Body('avgCost') avgCost: number, @Body('reason') reason: string, @Request() req: ReqUser) {
    return this.productCost.revalue(id, avgCost, actorOf(req), reason);
  }

  @Get('suggest-sku')
  @RequirePerms('products-sku-manage')
  async suggestSku(@Query('name') name = '', @Query('exclude') exclude = '') {
    return { code: await this.productsService.suggestProductCode(name, exclude) };
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
