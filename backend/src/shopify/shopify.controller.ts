import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Headers,
  Req,
  HttpCode,
  Logger,
  BadRequestException,
  UseGuards,
  Request,
} from '@nestjs/common';
import { Request as ExpressRequest } from 'express';
import { ShopifyService } from './shopify.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';

@Controller('shopify')
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(private readonly shopifyService: ShopifyService) {}

  // استقبال webhook من Shopify (بدون auth)
  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Headers('x-shopify-hmac-sha256') signature: string,
    @Headers('x-shopify-topic') topic: string,
    @Req() req: ExpressRequest,
  ) {
    const rawBody: Buffer = (req as any).rawBody;

    if (rawBody && signature) {
      const isValid = this.shopifyService.verifyWebhook(rawBody, signature);
      if (!isValid) {
        this.logger.warn('⚠️ Webhook غير موثوق');
        throw new BadRequestException('Invalid webhook signature');
      }
    }

    this.logger.log(`📦 Shopify Webhook: ${topic}`);

    if (topic === 'orders/create') {
      return this.shopifyService.handleOrder(req.body);
    }

    return { received: true, topic };
  }

  // جلب الأوردرات المعلقة (للأدمن)
  @Get('orders/pending')
  @UseGuards(JwtAuthGuard)
  async getPending() {
    return this.shopifyService.getPendingOrders();
  }

  // جلب كل الأوردرات
  @Get('orders')
  @UseGuards(JwtAuthGuard)
  async getAll() {
    return this.shopifyService.getAllOrders();
  }

  // قبول أوردر
  @Patch('orders/:id/approve')
  @UseGuards(JwtAuthGuard)
  async approve(@Param('id') id: string, @Body('deposit') deposit: number, @Body('payment') payment: string, @Request() req: any) {
    const user = req.user?.username || req.user?.name || 'admin';
    return this.shopifyService.approveOrder(id, user, deposit || 0, payment);
  }

  // تعديل items أوردر
  @Patch('orders/:id/items')
  @UseGuards(JwtAuthGuard)
  async updateItems(@Param('id') id: string, @Body('items') items: any[]) {
    return this.shopifyService.updateOrderItems(id, items || []);
  }

  // رفض أوردر
  @Patch('orders/:id/reject')
  @UseGuards(JwtAuthGuard)
  async reject(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @Request() req: any,
  ) {
    const user = req.user?.username || req.user?.name || 'admin';
    return this.shopifyService.rejectOrder(id, user, reason || '');
  }

  // تحديث الحالة الفرعية لأوردر معلق
  @Patch('orders/:id/pending-status')
  @UseGuards(JwtAuthGuard)
  async updatePendingStatus(@Param('id') id: string, @Body('pendingStatus') pendingStatus: string) {
    return this.shopifyService.updatePendingStatus(id, pendingStatus || '');
  }

  // إعادة حساب totals للأوردرات المعلقة (تشغيل مرة واحدة لإصلاح القديمة)
  @Post('recalc-pending')
  @UseGuards(JwtAuthGuard)
  async recalcPending() {
    return this.shopifyService.recalcPendingOrders();
  }

  // إصلاح الأرقام المرجعية القديمة (تشغيل مرة واحدة)
  @Post('fix-refs')
  @UseGuards(JwtAuthGuard)
  async fixRefs() {
    return this.shopifyService.fixHashRefs();
  }
}
