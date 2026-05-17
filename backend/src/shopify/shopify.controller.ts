import {
  Controller,
  Post,
  Headers,
  Req,
  HttpCode,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { ShopifyService } from './shopify.service';

@Controller('shopify')
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(private readonly shopifyService: ShopifyService) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Headers('x-shopify-hmac-sha256') signature: string,
    @Headers('x-shopify-topic') topic: string,
    @Req() req: Request,
  ) {
    const rawBody: Buffer = (req as any).rawBody;

    // التحقق من صحة الطلب
    if (rawBody && signature) {
      const isValid = this.shopifyService.verifyWebhook(rawBody, signature);
      if (!isValid) {
        this.logger.warn('⚠️ Webhook غير موثوق - تم رفضه');
        throw new BadRequestException('Invalid webhook signature');
      }
    }

    this.logger.log(`📦 Shopify Webhook: ${topic}`);

    // نستقبل فقط الأوردرات الجديدة
    if (topic === 'orders/create') {
      const result = await this.shopifyService.handleOrder(req.body);
      return result;
    }

    return { received: true, topic };
  }
}
