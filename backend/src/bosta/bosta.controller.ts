import {
  Controller,
  Post,
  Get,
  Param,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { BostaService } from './bosta.service';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('shipping')
export class BostaController {
  constructor(private readonly bostaService: BostaService) {}

  /** Create a Bosta delivery order for a sales transaction */
  @Post('create-order/:txId')
  async createOrder(@Param('txId') txId: string, @Req() req: any) {
    const operator: string = req.user?.username || req.user?.name || 'system';
    const result = await this.bostaService.createOrder(txId, operator);
    if (!result.success) {
      throw new HttpException(
        { message: result.error || 'فشل إنشاء الشحنة في Bosta' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return result;
  }

  /** Sync Bosta status for a single transaction */
  @Get('sync/:txId')
  async syncStatus(@Param('txId') txId: string) {
    const result = await this.bostaService.syncStatus(txId);
    if (!result.success) {
      throw new HttpException(
        { message: result.error || 'فشل تحديث حالة الشحنة' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return result;
  }

  /** Bulk sync all in-progress Bosta orders — admin only */
  @Post('sync-all')
  @Roles('admin')
  async syncAll() {
    return this.bostaService.syncAll();
  }

  /** Fix corrupted numeric status values — admin only */
  @Post('fix-statuses')
  @Roles('admin')
  async fixStatuses() {
    return this.bostaService.fixCorruptedStatuses();
  }

  /** Cancel a Bosta order — admin only */
  @Post('cancel/:txId')
  @Roles('admin')
  async cancelOrder(@Param('txId') txId: string) {
    const result = await this.bostaService.cancelOrder(txId);
    if (!result.success) {
      throw new HttpException(
        { message: result.error || 'فشل إلغاء الشحنة في Bosta' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return result;
  }
}
