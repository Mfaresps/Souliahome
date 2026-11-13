import { Body, Controller, Delete, ForbiddenException, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { PromotionAuditService } from './promotion-audit.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('promotions')
export class PromotionsController {
  constructor(private readonly audit: PromotionAuditService) {}

  /** فورم البيع بيسجل محاولات خصم الباقات/الأكواد — أي موظف مسجل دخول. */
  @Post('audit')
  async record(@Req() req: any, @Body() body: any) {
    const res = await this.audit.recordUsage(req.user, body);
    void this.audit.trim();
    return res;
  }

  @Get('audit')
  async list(@Req() req: any, @Query() q: any) {
    const u = req.user;
    if (u?.role !== 'admin' && !(u?.perms || []).includes('promotions-audit')) {
      throw new ForbiddenException('ليس لديك صلاحية على سجل المراجعة');
    }
    return this.audit.list(q);
  }

  /** ⚠ مسح سجل مراجعة قرار المدير وحده — صاحب promotions-audit يقرأ ولا يمسح. */
  @Delete('audit')
  @Roles('admin')
  async clear(@Req() req: any) {
    return this.audit.clear(req.user);
  }
}
