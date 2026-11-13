import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { ProductSuppliersService } from './product-suppliers.service';

export class SetSupplierPriceDto {
  @IsString() readonly supplierId: string;
  @IsNumber() @Min(0) readonly price: number;
}

export class SetPrimarySupplierDto {
  /** '' = مافيش مورد أساسي. */
  @IsString() readonly supplierId: string;
}

export class BackfillPrimaryDto {
  @IsOptional() @IsBoolean() readonly dryRun?: boolean;
}

type Req = { user?: { role?: string; perms?: string[]; name?: string; username?: string } };

/**
 * أسعار الموردين لكل منتج. أسعار شراء = بيانات حساسة:
 * - القراءة: الأدمن، أو من يرى سعر الشراء (`purchase-edit-price`)، أو من يسجّل فواتير شراء
 *   (`purchase-create`) — فاتورة الشراء بتتملا منها، وده نفس سعر الشراء اللي الفورم بيعرضه أصلًا.
 * - التعديل اليدوي: الأدمن أو `purchase-edit-price` بس — نفس قاعدة تعديل سعر الشراء في الكارت.
 */
@UseGuards(JwtAuthGuard)
@Controller('product-suppliers')
export class ProductSuppliersController {
  constructor(private readonly service: ProductSuppliersService) {}

  private can(req: Req, ...anyOf: string[]) {
    if (req.user?.role === 'admin') return;
    const perms = req.user?.perms || [];
    if (!anyOf.some((p) => perms.includes(p))) throw new ForbiddenException('ليس لديك صلاحية على أسعار الموردين');
  }
  private by(req: Req) { return req.user?.name || req.user?.username || 'النظام'; }

  @Get()
  async list(@Query('productId') productId: string, @Query('supplierId') supplierId: string, @Req() req: Req): Promise<unknown> {
    this.can(req, 'purchase-edit-price', 'purchase-create');
    if (productId) return this.service.listForProduct(productId);
    if (supplierId) return this.service.pricesForSupplier(supplierId);
    return [];
  }

  /** «اجعله الأساسي» — نفس صلاحية تعديل أسعار الموردين. */
  @Put(':productId/primary')
  async primary(@Param('productId') productId: string, @Body() dto: SetPrimarySupplierDto, @Req() req: Req): Promise<unknown> {
    this.can(req, 'purchase-edit-price');
    return this.service.setPrimary(productId, dto.supplierId || '', this.by(req));
  }

  /** ترحيل الأسماء القديمة لمورد أساسي مربوط (أدمن، معاينة افتراضيًا: {dryRun:false} للكتابة). */
  @Post('backfill/primary')
  async backfillPrimary(@Body() dto: BackfillPrimaryDto, @Req() req: Req): Promise<unknown> {
    if (req.user?.role !== 'admin') throw new ForbiddenException('للأدمن فقط');
    return this.service.backfillPrimary(dto?.dryRun !== false, this.by(req));
  }

  @Put(':productId')
  async set(@Param('productId') productId: string, @Body() dto: SetSupplierPriceDto, @Req() req: Req): Promise<unknown> {
    this.can(req, 'purchase-edit-price');
    return this.service.setManual(productId, dto.supplierId, dto.price, this.by(req));
  }

  @Delete(':productId/:supplierId')
  async remove(@Param('productId') productId: string, @Param('supplierId') supplierId: string, @Req() req: Req) {
    this.can(req, 'purchase-edit-price');
    return this.service.remove(productId, supplierId, this.by(req));
  }
}
