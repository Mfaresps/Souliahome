import { ArgumentsHost, BadRequestException, Body, Catch, Controller, ExceptionFilter, Get, Param, Post, Request, UseFilters, UseGuards } from '@nestjs/common';
import { IsBoolean } from 'class-validator';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/guards/roles.guard';
import { Roles } from '../../core/decorators/roles.decorator';
import { ShopifyDepositMetafieldsService } from './deposit-metafields.service';
import { SyncApiError } from './sync-api.service';

@Catch(SyncApiError)
class SyncApiErrorFilter implements ExceptionFilter {
  catch(error: SyncApiError, host: ArgumentsHost) {
    const status = error.transient ? 503 : 400;
    host.switchToHttp().getResponse().status(status).json({ statusCode: status, message: error.message });
  }
}

class DepositMetafieldsConfigDto {
  @IsBoolean() enabled!: boolean;
}

@Controller('shopify/deposit-metafields')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(new SyncApiErrorFilter())
@Roles('admin')
export class ShopifyDepositMetafieldsController {
  constructor(private readonly service: ShopifyDepositMetafieldsService) {}

  @Get('status') status() { return this.service.status(); }

  @Post('config') configure(@Body() b: DepositMetafieldsConfigDto, @Request() req: any) {
    return this.service.configure(b.enabled, String(req.user?.userId || ''));
  }

  @Post('orders/:orderId/retry') retry(@Param('orderId') orderId: string) {
    if (!/^\d+$/.test(orderId)) throw new BadRequestException('معرّف Shopify غير صالح');
    return this.service.retry(orderId);
  }
}
