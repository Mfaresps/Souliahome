import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Headers,
  Req,
  Res,
  HttpCode,
  Logger,
  BadRequestException,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Request,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Request as ExpressRequest, Response } from 'express';
import { ShopifyService } from './shopify.service';
import { DepositReceiptsService, MAX_RECEIPT_UPLOAD_BYTES, ReceiptActor } from './deposit-receipts.service';
import { DepositAutoApproveService } from './deposit-auto-approve.service';
import { DepositReceiptEntryDto, DepositReceiptReasonDto } from './dto/deposit-receipt.dto';
import { visibleReceipts } from './deposit-receipts.util';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';

function actorOf(req: any): ReceiptActor {
  return {
    id: String(req.user?.userId || req.user?.sub || req.user?._id || ''),
    username: req.user?.username || '',
    name: req.user?.name || req.user?.username || '',
    isAdmin: req.user?.role === 'admin',
  };
}

@Controller('shopify')
export class ShopifyController {
  private readonly logger = new Logger(ShopifyController.name);

  constructor(
    private readonly shopifyService: ShopifyService,
    private readonly depositReceipts: DepositReceiptsService,
    private readonly depositAutoApprove: DepositAutoApproveService,
  ) {}

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
  async getPending(@Request() req: any) {
    return (await this.shopifyService.getPendingOrders()).map(o => visibleReceipts(o, actorOf(req).id));
  }

  // جلب كل الأوردرات
  @Get('orders')
  @UseGuards(JwtAuthGuard)
  async getAll(@Request() req: any) {
    return (await this.shopifyService.getAllOrders()).map(o => visibleReceipts(o, actorOf(req).id));
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

  /**
   * قبول أوردر.
   * ⚠ لا يقبل `deposit`/`payment` من الطلب — العربون هو مجموع إيصالات التحويل المعتمدة،
   *   ويُقرأ على الخادم. قبول رقم مكتوب هنا كان يتيح تجاوز مراجعة المدير من أي واجهة.
   */
  @Patch('orders/:id/approve')
  @UseGuards(JwtAuthGuard)
  async approve(
    @Param('id') id: string,
    @Body('carrierCode') carrierCode: string,
    @Request() req: any,
  ) {
    const user = req.user?.username || req.user?.name || 'admin';
    return this.shopifyService.approveOrder(id, user, carrierCode);
  }

  // ── Deposit receipts ──────────────────────────────────────────────────────────────────
  // Upload / submit / edit / withdraw: the delegable `shopify-deposit-upload` perm.
  // Approve / reject / refund: `@Roles('admin')` ONLY — never a perm a staff member could hold,
  // so an uploader can never approve their own receipt (the approve-cancel rule).

  @Post('orders/:id/deposit-receipts/upload')
  @UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
  @RequirePerms('shopify-deposit-upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_RECEIPT_UPLOAD_BYTES },
      fileFilter: (_req: any, file: any, cb: any) => {
        if (!/^image\/(jpeg|png|webp)$/.test(file.mimetype)) {
          return cb(new BadRequestException('الصورة يجب أن تكون JPG أو PNG أو WebP'), false);
        }
        cb(null, true);
      },
    }),
  )
  async uploadDepositReceipt(@Param('id') id: string, @UploadedFile() file: any, @Request() req: any) {
    return this.depositReceipts.uploadDraft(id, file, actorOf(req));
  }

  @Patch('orders/:id/deposit-receipts/:rid/submit')
  @UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
  @RequirePerms('shopify-deposit-upload')
  async submitDepositReceipt(
    @Param('id') id: string,
    @Param('rid') rid: string,
    @Body() body: DepositReceiptEntryDto,
    @Request() req: any,
  ) {
    return this.depositReceipts.submit(id, rid, body, actorOf(req));
  }

  @Patch('orders/:id/deposit-receipts/:rid')
  @UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
  @RequirePerms('shopify-deposit-upload')
  async editDepositReceipt(
    @Param('id') id: string,
    @Param('rid') rid: string,
    @Body() body: DepositReceiptEntryDto,
    @Request() req: any,
  ) {
    return this.depositReceipts.editPending(id, rid, body, actorOf(req));
  }

  @Delete('orders/:id/deposit-receipts/:rid')
  @UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
  @RequirePerms('shopify-deposit-upload')
  async withdrawDepositReceipt(@Param('id') id: string, @Param('rid') rid: string, @Request() req: any) {
    return this.depositReceipts.withdraw(id, rid, actorOf(req));
  }

  @Patch('orders/:id/deposit-receipts/:rid/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async approveDepositReceipt(@Param('id') id: string, @Param('rid') rid: string, @Request() req: any) {
    return this.depositReceipts.approve(id, rid, actorOf(req));
  }

  @Patch('orders/:id/deposit-receipts/:rid/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async rejectDepositReceipt(
    @Param('id') id: string,
    @Param('rid') rid: string,
    @Body() body: DepositReceiptReasonDto,
    @Request() req: any,
  ) {
    return this.depositReceipts.reject(id, rid, actorOf(req), body?.reason || '');
  }

  @Patch('orders/:id/deposit-receipts/:rid/refund')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async refundDepositReceipt(
    @Param('id') id: string,
    @Param('rid') rid: string,
    @Body() body: DepositReceiptReasonDto,
    @Request() req: any,
  ) {
    return this.depositReceipts.refundApproved(id, rid, actorOf(req), body?.reason || '');
  }

  // ── Auto-approve ────────────────────────────────────────────────────────────────────────
  // The on/off switch itself is `settings.autoApproveDepositsEnabled`, written through the
  // existing admin-only PUT /settings (it also stamps `autoApproveDepositsSince` on first
  // turn-on). These two routes only read/act on top of that switch.

  /** How many pending receipts right now would be approved if the cron ran this second. */
  @Get('deposit-receipts/auto-approve/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async depositAutoApproveStatus() {
    return { cleanCount: await this.depositAutoApprove.pendingCleanCount() };
  }

  /** Runs the same decision immediately, instead of waiting for the next minute's cron. */
  @Post('deposit-receipts/auto-approve/run-now')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  async depositAutoApproveRunNow() {
    return this.depositAutoApprove.runNow();
  }

  /** The receipt image, streamed from R2. Read through the API so the bucket stays private. */
  @Get('deposit-receipts/:rid/image')
  @UseGuards(JwtAuthGuard)
  async depositReceiptImage(@Param('rid') rid: string, @Res() res: Response, @Request() req: any) {
    const body = await this.depositReceipts.getImage(rid, actorOf(req));
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(body);
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
    const changedBy = req.user?.name || req.user?.username || 'admin';
    const changedById = String(req.user?.userId || req.user?._id || '');
    return this.shopifyService.reassignOrder(id, newEmployeeId, reason || '', changedBy, changedById);
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
  async updateItems(
    @Param('id') id: string,
    @Body('items') items: any[],
    @Request() req: any,
  ) {
    const by = req.user?.name || req.user?.username || '';
    return this.shopifyService.updateOrderItems(id, items || [], by);
  }

  /**
   * تعديل الخصم اليدوي وأكواد الخصم على أوردر معلق.
   *
   * ⚠ لا يلمس `discount` (خصم شوبيفاي) إطلاقاً — الخصم اليدوي حقل منفصل، وهو ما
   *   يجعل الويب هوك عاجزاً عن محوه. انظر التعليق على manualDiscount في الـ schema.
   *
   * الدور (`role`) يُمرَّر لأن بوابة OTP معتمدة على الدور لا على صلاحية —
   * الأدمن معفى دائماً، تماماً كما في TransactionsService.create.
   */
  @Patch('orders/:id/discount')
  @UseGuards(JwtAuthGuard)
  async updateDiscount(
    @Param('id') id: string,
    @Body()
    body: {
      manualDiscount?: number;
      manualDiscountType?: string;
      codesDiscount?: number;
      discountCodeId?: string;
      discountCode?: string;
      highValueDiscountOtpId?: string;
    },
    @Request() req: any,
  ) {
    const by = req.user?.name || req.user?.username || '';
    return this.shopifyService.updateOrderDiscount(id, body || {}, by, req.user?.role || '');
  }

  /**
   * تمييز أوردر / إزالة التمييز.
   *
   * ⚠ بلا حارس صلاحيات فوق JWT عمداً: النجمة علامة بصرية لا أثر لها على أي رقم،
   *   وأي مستخدم يراها يجوز له وضعها ورفعها.
   */
  @Patch('orders/:id/star')
  @UseGuards(JwtAuthGuard)
  async toggleStar(
    @Param('id') id: string,
    @Body('starred') starred: boolean,
    @Request() req: any,
  ) {
    const by = req.user?.name || req.user?.username || '';
    return this.shopifyService.toggleOrderStar(id, !!starred, by);
  }

  /**
   * إضافة تعليق على أوردر.
   *
   * ⚠ متاح في كل الحالات — قبل التأكيد وبعده وحتى على أوردر ملغى. التعليق لا يغيّر
   *   قيمة ولا مخزوناً، ومنعه بعد التأكيد يلغي فائدته الأساسية (التواصل على أوردر شغّال).
   * ⚠ لا يسجّل شيئاً في editHistory — نفس قاعدة TransactionsService.addComments.
   */
  @Post('orders/:id/comments')
  @UseGuards(JwtAuthGuard)
  async addComment(
    @Param('id') id: string,
    @Body('comments') comments: any[],
    @Request() req: any,
  ) {
    return this.shopifyService.updateOrderComments(id, comments || []);
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

  /**
   * تراجع مقدّم الطلب عن طلبه قبل بتّ المدير فيه.
   *
   * ⚠ الصلاحية هي `shopify-cancel-request` نفسها — من يملك تقديم الطلب يملك سحبه.
   *   الخدمة تتحقق فوق ذلك من أن الساحب هو صاحب الطلب فعلاً (أو أدمن)، فحيازة
   *   الصلاحية لا تكفي لسحب طلب زميل.
   */
  @Patch('orders/:id/withdraw-cancel')
  @UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
  @RequirePerms('shopify-cancel-request')
  async withdrawCancelRequest(@Param('id') id: string, @Request() req: any) {
    return this.shopifyService.withdrawCancelRequest(
      id,
      req.user?.userId || req.user?.sub || '',
      req.user?.username || '',
      req.user?.role === 'admin',
    );
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
