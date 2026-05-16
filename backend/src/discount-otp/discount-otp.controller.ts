import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DiscountOtpService } from './discount-otp.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('discount-otp')
export class DiscountOtpController {
  constructor(private readonly otpService: DiscountOtpService) {}

  @Post('request')
  async requestOtp(
    @Body()
    body: {
      discountAmount: number;
      itemsTotal?: number;
      client?: string;
      txType?: string;
      txRef?: string;
    },
    @Req() req: any,
  ) {
    const user = req.user || {};
    return this.otpService.requestOtp({
      discountAmount: Number(body.discountAmount) || 0,
      itemsTotal: Number(body.itemsTotal) || 0,
      client: body.client || '',
      txType: body.txType || '',
      txRef: body.txRef || '',
      requestedById: user.userId || '',
      requestedByName: user.name || '',
      requestedByUsername: user.username || '',
    });
  }

  @Post('validate')
  async validateOtp(@Body() body: { otpId: string; otp: string }) {
    return this.otpService.validateOtp(body.otpId, body.otp);
  }

  @Post('purchase-request')
  async requestPurchaseOtp(
    @Body()
    body: {
      supplier: string;
      itemsTotal: number;
      items: Array<{ name: string; qty: number; price: number; total: number }>;
      txRef?: string;
    },
    @Req() req: any,
  ) {
    const user = req.user || {};
    return this.otpService.requestPurchaseOtp({
      supplier: body.supplier || '',
      itemsTotal: Number(body.itemsTotal) || 0,
      items: body.items || [],
      txRef: body.txRef || '',
      requestedById: user.userId || '',
      requestedByName: user.name || '',
      requestedByUsername: user.username || '',
    });
  }

  @Post('import-products-request')
  async requestImportProductsOtp(
    @Body() body: { count?: number; itemNames?: string[] },
    @Req() req: any,
  ) {
    const user = req.user || {};
    return this.otpService.requestImportProductsOtp({
      count: Number(body.count) || 0,
      itemNames: Array.isArray(body.itemNames) ? body.itemNames.slice(0, 20) : [],
      requestedById: user.userId || '',
      requestedByName: user.name || '',
      requestedByUsername: user.username || '',
    });
  }

  @Post('assert-import-products')
  async assertImportProductsOtp(@Body() body: { otpId: string }) {
    await this.otpService.assertImportProductsOtp(body.otpId);
    return { ok: true };
  }

  @Post('delete-product-request')
  async requestDeleteProductOtp(
    @Body()
    body: {
      productName?: string;
      productCode?: string;
      isBulk?: boolean;
      count?: number;
    },
    @Req() req: any,
  ) {
    const user = req.user || {};
    return this.otpService.requestDeleteProductOtp({
      productName: body.productName || '',
      productCode: body.productCode || '',
      isBulk: !!body.isBulk,
      count: Number(body.count) || 1,
      requestedById: user.userId || '',
      requestedByName: user.name || '',
      requestedByUsername: user.username || '',
    });
  }

  @Post('assert-delete-product')
  async assertDeleteProductOtp(@Body() body: { otpId: string }) {
    await this.otpService.assertDeleteProductOtp(body.otpId);
    return { ok: true };
  }

  @Post('delete-supplier-request')
  async requestDeleteSupplierOtp(
    @Body()
    body: {
      supplierName?: string;
      supplierId?: string;
    },
    @Req() req: any,
  ) {
    const user = req.user || {};
    return this.otpService.requestDeleteSupplierOtp({
      supplierName: body.supplierName || '',
      supplierId: body.supplierId || '',
      requestedById: user.userId || '',
      requestedByName: user.name || '',
      requestedByUsername: user.username || '',
    });
  }

  @Post('assert-delete-supplier')
  async assertDeleteSupplierOtp(@Body() body: { otpId: string }) {
    await this.otpService.assertDeleteSupplierOtp(body.otpId);
    return { ok: true };
  }

  @Post('vault-access-request')
  async requestVaultAccessOtp(@Req() req: any) {
    const user = req.user || {};
    return this.otpService.requestVaultAccessOtp({
      requestedById: user.userId || '',
      requestedByName: user.name || '',
      requestedByUsername: user.username || '',
    });
  }

  @Post('assert-vault-access')
  async assertVaultAccessOtp(@Body() body: { otpId: string }) {
    await this.otpService.assertVaultAccessOtp(body.otpId);
    return { ok: true };
  }

  @Post('add-product-request')
  async requestAddProductOtp(
    @Body()
    body: {
      productName?: string;
      productCode?: string;
      sellPrice?: number;
      buyPrice?: number;
    },
    @Req() req: any,
  ) {
    const user = req.user || {};
    return this.otpService.requestAddProductOtp({
      productName: body.productName || '',
      productCode: body.productCode || '',
      sellPrice: Number(body.sellPrice) || 0,
      buyPrice: Number(body.buyPrice) || 0,
      requestedById: user.userId || '',
      requestedByName: user.name || '',
      requestedByUsername: user.username || '',
    });
  }

  @Post('assert-add-product')
  async assertAddProductOtp(@Body() body: { otpId: string }) {
    await this.otpService.assertAddProductOtp(body.otpId);
    return { ok: true };
  }

  @Post('edit-tx-request')
  async requestEditTxOtp(
    @Body() body: any,
    @Req() req: any,
  ) {
    const user = req.user || {};
    return this.otpService.requestEditTxOtp({
      txId: body.txId || '',
      txType: body.txType || '',
      txRef: body.txRef || '',
      changes: Array.isArray(body.changes) ? body.changes : [],
      payload: body.payload || {},
      requestedById: user.userId || '',
      requestedByName: user.name || '',
      requestedByUsername: user.username || '',
    });
  }

  @Roles('admin')
  @Post(':id/approve-edit-tx')
  async approveEditTx(
    @Param('id') id: string,
    @Req() req: any,
  ) {
    const reviewedBy = req.user?.name || req.user?.username || '';
    return this.otpService.approveEditTx(id, reviewedBy);
  }

  @Roles('admin')
  @Post(':id/reject-edit-tx')
  async rejectEditTx(
    @Param('id') id: string,
    @Req() req: any,
  ) {
    const reviewedBy = req.user?.name || req.user?.username || '';
    await this.otpService.rejectEditTx(id, reviewedBy);
    return { ok: true };
  }

  @Get(':id/edit-tx-details')
  async getEditTxDetails(@Param('id') id: string) {
    const doc = await this.otpService.getEditTxOtp(id);
    if (!doc || doc.kind !== 'edit-tx') return { ok: false };
    return {
      ok: true,
      otpId: String(doc._id),
      txId: doc.editTxId,
      txType: doc.editTxType,
      txRef: doc.txRef,
      changes: doc.editChanges || [],
      editStatus: doc.editStatus || '',
      status: doc.status,
      requestedByName: doc.requestedByName,
      requestedByUsername: doc.requestedByUsername,
      createdAt: doc.createdAt,
      expiresAt: doc.expiresAt,
    };
  }

  @Roles('admin')
  @Get()
  async list(@Query('status') status?: string) {
    return this.otpService.list({ status });
  }

  @Get('threshold')
  async getThreshold() {
    const threshold = await this.otpService.getThreshold();
    return { threshold };
  }

  @Get(':id/import-names')
  async getImportItemNames(@Param('id') id: string) {
    return this.otpService.getImportItemNames(id);
  }
}
