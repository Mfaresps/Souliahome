import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
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
}
