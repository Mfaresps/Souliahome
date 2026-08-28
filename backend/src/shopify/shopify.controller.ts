import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Query,
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
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';

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

    if (topic === 'orders/updated') {
      return this.shopifyService.handleOrderUpdate(req.body);
    }

    // ⚠ «orders/edited» يصل عند التعديل عبر خاصية Edit order الرسمية (إضافة/حذف صنف،
    //   تغيير كمية) — وهو topic مختلف عن «orders/updated». كان يُرمى بصمت، فتعديل
    //   الأصناف لا يصل النظام إطلاقاً. الحمولة تحمل نفس شكل الأوردر فيتولاها نفس المعالج،
    //   الذي يجمّد الأصناف بعد التأكيد ويرفع تعارضاً بدل التعديل الصامت.
    if (topic === 'orders/edited') {
      return this.shopifyService.handleOrderUpdate(req.body);
    }

    if (topic === 'orders/cancelled') {
      return this.shopifyService.handleOrderCancelled(req.body);
    }

    if (topic === 'fulfillments/create' || topic === 'fulfillments/update') {
      return this.shopifyService.handleFulfillment(req.body);
    }

    // ⚠ الستة المسجَّلة في Shopify كلها متعالَجة أعلاه. هذا السطر يمسك أي topic يُضاف في
    //   لوحة شوبيفاي دون معالجة هنا — كان الوضع السابق يرميه بصمت مع 200 OK، فلا يعيد
    //   Shopify المحاولة ولا يظهر في أي مكان.
    //   الرد يبقى 200 عمداً: إرجاع خطأ يدفع Shopify لإعادة المحاولة ثم تعطيل الـ webhook.
    this.logger.warn(`⚠️ Shopify webhook غير مُعالَج: ${topic}`);
    return { received: true, topic, handled: false };
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

  // جلب أوردرات قديمة مباشرة من Shopify (للاستيراد اليدوي)
  @Get('remote-orders')
  @UseGuards(JwtAuthGuard)
  async fetchRemoteOrders(
    @Query('limit') limit?: string,
    @Query('status') status?: 'open' | 'closed' | 'cancelled' | 'any',
    @Query('createdAtMin') createdAtMin?: string,
    @Query('createdAtMax') createdAtMax?: string,
    @Query('name') name?: string,
  ) {
    return this.shopifyService.fetchRemoteOrders({
      limit: limit ? Number(limit) : undefined,
      status,
      createdAtMin,
      createdAtMax,
      name,
    });
  }

  // استيراد أوردر قديم محدد من Shopify (يدخل بحالة pending لانتظار موافقة الأدمن)
  @Post('remote-orders/:shopifyId/import')
  @UseGuards(JwtAuthGuard)
  async importRemoteOrder(@Param('shopifyId') shopifyId: string) {
    return this.shopifyService.importOrderById(shopifyId);
  }

  // قبول أوردر
  @Patch('orders/:id/approve')
  @UseGuards(JwtAuthGuard)
  async approve(
    @Param('id') id: string,
    @Body('deposit') deposit: number,
    @Body('payment') payment: string,
    @Body('carrierCode') carrierCode: string,
    @Request() req: any,
  ) {
    const user = req.user?.username || req.user?.name || 'admin';
    return this.shopifyService.approveOrder(id, user, deposit || 0, payment, carrierCode);
  }

  // إعادة إسناد أوردر لموظف آخر (أدمن فقط) — لا يؤثر على reviewedBy أو الإيداع أو سجل الأداء
  @Patch('orders/:id/reassign')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async reassign(
    @Param('id') id: string,
    @Body('newEmployeeId') newEmployeeId: string,
    @Body('reason') reason: string,
    @Request() req: any,
  ) {
    const changedBy = req.user?.username || req.user?.name || 'admin';
    return this.shopifyService.reassignOrder(id, newEmployeeId, reason || '', changedBy);
  }

  /**
   * إصلاح بأثر رجعي: كتابة حركات المخزون الناقصة لمبيعات Shopify التي تمت
   * قبل أن يسجّل approveOrder حركة المخزون.
   *
   * dryRun افتراضياً true — لازم تبعت {"dryRun": false} عشان يكتب فعلياً.
   * آمن للتكرار: أي مرجع له حركات مسجّلة بالفعل يُتخطى ولا يُضاعف.
   */
  @Post('backfill/inventory-movements')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async backfillInventoryMovements(
    @Body('refs') refs: string[],
    @Body('dryRun') dryRun: boolean,
    @Request() req: any,
  ) {
    if (!Array.isArray(refs) || !refs.length) {
      throw new BadRequestException('refs مطلوبة — مصفوفة بأرقام مراجع المعاملات');
    }
    const by = req.user?.name || req.user?.username || 'admin';
    return this.shopifyService.backfillMissingSaleMovements(refs, by, dryRun !== false);
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

  /**
   * إلغاء مباشر — أدمن، أو موظف يحمل `shopify-cancel`.
   *
   * ⚠ The route stays `@Roles('admin')`-free but gains `PermsGuard`, which bypasses
   *   unconditionally for admins — so admin behaviour is unchanged while the perm becomes
   *   delegable. A staff member WITHOUT `shopify-cancel` must use the request route below;
   *   this one 403s for them, which is the whole point of the split.
   */
  @Patch('orders/:id/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
  @RequirePerms('shopify-cancel')
  async cancelOrder(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @Body('cancelReasonCode') cancelReasonCode: string,
    @Body('cancelReasonNote') cancelReasonNote: string,
    @Request() req: any,
  ) {
    const user = req.user?.username || req.user?.name || 'admin';
    return this.shopifyService.cancelOrder(
      id,
      user,
      reason || '',
      cancelReasonCode || '',
      cancelReasonNote || '',
    );
  }

  /**
   * طلب إلغاء — لموظف يحمل `shopify-cancel-request` ولا يملك صلاحية الإلغاء المباشر.
   * لا يُلغى الأوردر هنا؛ ينتظر قرار المدير في صفحة الموافقات.
   */
  @Patch('orders/:id/request-cancel')
  @UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
  @RequirePerms('shopify-cancel-request')
  async requestCancelOrder(
    @Param('id') id: string,
    @Body('cancelReasonCode') cancelReasonCode: string,
    @Body('cancelReasonNote') cancelReasonNote: string,
    @Request() req: any,
  ) {
    const name = req.user?.name || req.user?.username || '';
    return this.shopifyService.requestCancelOrder(
      id,
      name,
      cancelReasonCode || '',
      cancelReasonNote || '',
      req.user?.userId || req.user?.sub || '',
      req.user?.username || '',
    );
  }

  /**
   * اعتماد/رفض طلب الإلغاء — أدمن فقط، ولا يُشتق من `shopify-cancel`.
   *
   * ⚠ Deliberately NOT folded into the cancel perm: the request→approve step exists to put a
   *   second person between a staff member and the cancellation. If the approval used the same
   *   perm, a holder could approve their own request and the gate would be decorative — the same
   *   rule supplier-returns' approve/reject already follows.
   */
  @Patch('orders/:id/approve-cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async approveCancelRequest(@Param('id') id: string, @Request() req: any) {
    const by = req.user?.name || req.user?.username || 'admin';
    return this.shopifyService.approveCancelRequest(id, by);
  }

  @Patch('orders/:id/reject-cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async rejectCancelRequest(
    @Param('id') id: string,
    @Body('rejectedReason') rejectedReason: string,
    @Request() req: any,
  ) {
    const by = req.user?.name || req.user?.username || 'admin';
    return this.shopifyService.rejectCancelRequest(id, by, rejectedReason || '');
  }

  // استرجاع أوردر ملغي (أدمن فقط)
  @Patch('orders/:id/restore')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async restoreOrder(@Param('id') id: string) {
    return this.shopifyService.restoreOrder(id);
  }

  // ترقية: حفظ shopifyCreatedAt في transactions القديمة (تشغيل مرة واحدة)
  @Post('backfill-shopify-created-at')
  @UseGuards(JwtAuthGuard)
  async backfillShopifyCreatedAt() {
    return this.shopifyService.backfillShopifyCreatedAt();
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
