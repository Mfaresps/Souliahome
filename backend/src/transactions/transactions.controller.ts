import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  HttpException,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { TransactionsService } from './transactions.service';
import { ReferenceDetailService } from './reference-detail.service';
import { ReportsExportService } from './reports-export.service';
import { CarrierSettlementService } from './carrier-settlement.service';
import {
  CreateTransactionDto,
  UpdateTransactionDto,
  CancelTransactionDto,
  CollectTransactionDto,
  BulkDeleteDto,
  PostDiscountDto,
  RequestCancelDto,
  ReviewCancelDto,
  CloseFailedDeliveryDto,
  ReshipTransactionDto,
  BackfillShipIssueDto,
} from './dto/transaction.dto';
import { JwtAuthGuard } from '../core/guards/jwt-auth.guard';
import { RolesGuard } from '../core/guards/roles.guard';
import { Roles } from '../core/decorators/roles.decorator';
import { PermsGuard } from '../core/guards/perms.guard';
import { RequirePerms } from '../core/decorators/perms.decorator';
import { ExpensesService } from '../expenses/expenses.service';
import { maskTransactionForRole, maskTransactionsForRole, filterPurchasesForPerms } from './purchase-mask.util';
import { inDateWindow } from '../shared/date-window.util';

@UseGuards(JwtAuthGuard, RolesGuard, PermsGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly referenceDetailService: ReferenceDetailService,
    private readonly expensesService: ExpensesService,
    private readonly reportsExportService: ReportsExportService,
    private readonly carrierSettlementService: CarrierSettlementService,
  ) {}

  // ── Carrier settlement-file import ────────────────────────────────────────────────────────
  // Two routes, deliberately split: preview READS ONLY and settle WRITES. A single route that
  // settled as a side effect of uploading would make the review screen impossible — the whole
  // safety model is that a file can be uploaded and inspected with no financial effect.
  //
  // ⚠ `carrier-import` is its own permission, NOT folded into the ordinary collect gate.
  //   Settling 150 orders in one action is a different level of authority from collecting one,
  //   and it must be granted deliberately.
  //
  // The file is held in memory only (`memoryStorage` default) and never written to disk: it
  // carries customer names and phone numbers, and nothing here needs it after parsing.

  @RequirePerms('carrier-import')
  @Post('carrier-statement/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async carrierStatementPreview(
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Body('carrier') carrier?: string,
  ) {
    if (!file?.buffer) throw new BadRequestException('لم يتم رفع أي ملف');
    return this.carrierSettlementService.preview(
      file.buffer,
      file.originalname || 'statement.xlsx',
      String(carrier || 'bosta'),
    );
  }

  @RequirePerms('carrier-import')
  @Post('carrier-statement/settle')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  async carrierStatementSettle(
    @UploadedFile() file: { buffer: Buffer; originalname: string } | undefined,
    @Body() body: any,
    @Req() req?: any,
  ) {
    if (!file?.buffer) throw new BadRequestException('لم يتم رفع أي ملف');
    // multipart carries everything as strings — `rows` arrives as JSON text.
    let rows: number[] = [];
    try {
      rows = typeof body?.rows === 'string' ? JSON.parse(body.rows) : body?.rows || [];
    } catch {
      throw new BadRequestException('قائمة الصفوف المختارة غير صالحة');
    }
    const by = req?.user?.name || req?.user?.username || 'مستخدم';
    return this.carrierSettlementService.settle(
      file.buffer,
      file.originalname || 'statement.xlsx',
      String(body?.carrier || 'bosta'),
      {
        rows,
        collectMethod: String(body?.collectMethod || ''),
        note: String(body?.note || ''),
        acknowledgeDuplicate:
          body?.acknowledgeDuplicate === true || body?.acknowledgeDuplicate === 'true',
      },
      by,
      req?.user?.role || '',
      req?.user?.perms || [],
    );
  }

  @RequirePerms('carrier-import')
  @Get('carrier-statement/imports')
  async carrierImports(@Query('limit') limit?: string) {
    return this.carrierSettlementService.list(Number(limit) || 50);
  }

  @RequirePerms('carrier-import')
  @Get('carrier-statement/imports/:importNo')
  async carrierImportOne(@Param('importNo') importNo: string) {
    const doc = await this.carrierSettlementService.getOne(importNo);
    if (!doc) throw new HttpException('عملية الاستيراد غير موجودة', HttpStatus.NOT_FOUND);
    return doc;
  }

  @Get()
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Req() req?: { user?: { role?: string; perms?: string[] } },
  ) {
    const txs = await this.transactionsService.findAll(
      page ? Number(page) : undefined,
      limit ? Number(limit) : undefined,
    );
    const filtered = filterPurchasesForPerms(txs, req?.user?.role, req?.user?.perms);
    return maskTransactionsForRole(filtered, req?.user?.role);
  }

  /**
   * Writes `carrierCode` onto historical sales that never had one.
   *
   * ⚠ `dryRun` defaults to true (`dryRun !== false`), so a bare `{}` PREVIEWS and writes nothing.
   *   Send `{"dryRun": false}` to commit. `fallback` binds the rows whose `shipCo` resolves to
   *   nothing — an explicit admin decision, never a guess.
   */
  @Roles('admin')
  @Post('backfill/carrier-codes')
  async backfillCarrierCodes(
    @Body('dryRun') dryRun: boolean,
    @Body('fallback') fallback: string,
    @Req() req: any,
  ) {
    const by = req?.user?.name || req?.user?.username || 'admin';
    return this.transactionsService.backfillCarrierCodes(by, dryRun !== false, String(fallback || ''));
  }

  @Roles('admin')
  @Get('dashboard')
  async getDashboard() {
    const expenses = await this.expensesService.findAll();
    const expenseTotal = expenses.filter(e => e.status === 'معتمد').reduce((s, e) => s + e.amount, 0);
    return this.transactionsService.getDashboard(expenseTotal);
  }

  @Get('inventory')
  async getInventory() {
    return this.transactionsService.getInventory();
  }

  @Get('reports')
  async getReports(
    @Query('from') from?: string,
    @Query('to') to?: string,
    // Shipping-panel only — see getReports.
    @Query('carrier') carrier?: string,
  ) {
    const expenses = await this.expensesService.findAll();
    // Day-window compare: expense dates are plain YYYY-MM-DD today, but the sibling
    // transaction filter had to move off raw-string compare (see date-window.util.ts) and
    // these two must scope identically or the expense KPI covers a different period.
    const filteredExpenses = expenses.filter((e) => inDateWindow(e.date, from, to));
    const expenseTotal = filteredExpenses.filter(e => e.status === 'معتمد').reduce((s, e) => s + e.amount, 0);
    return this.transactionsService.getReports(from, to, expenseTotal, carrier);
  }

  @Roles('admin')
  @Get('reports/export')
  async exportReports(
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<void> {
    const expenses = await this.expensesService.findAll();
    // Day-window compare: expense dates are plain YYYY-MM-DD today, but the sibling
    // transaction filter had to move off raw-string compare (see date-window.util.ts) and
    // these two must scope identically or the expense KPI covers a different period.
    const filteredExpenses = expenses.filter((e) => inDateWindow(e.date, from, to));
    const expenseTotal = filteredExpenses
      .filter((e) => e.status === 'معتمد')
      .reduce((s, e) => s + e.amount, 0);
    const report = await this.transactionsService.getReports(from, to, expenseTotal);

    const stamp = new Date().toISOString().slice(0, 10);
    const baseName = `report_${from || 'all'}_${to || stamp}`;
    const fmt = (format || 'excel').toLowerCase();

    if (fmt === 'pdf') {
      const buffer = await this.reportsExportService.buildPdf(report);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
      res.setHeader('Content-Length', String(buffer.length));
      res.end(buffer);
      return;
    }

    const buffer = await this.reportsExportService.buildExcel(report);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }

  @Get('archived')
  async findArchived(@Req() req?: { user?: { role?: string; perms?: string[] } }) {
    const txs = await this.transactionsService.findArchived();
    const filtered = filterPurchasesForPerms(txs, req?.user?.role, req?.user?.perms);
    return maskTransactionsForRole(filtered, req?.user?.role);
  }

  @Get('reference/:ref')
  async getReferenceDetails(
    @Param('ref') ref: string,
    @Req() req?: { user?: { role?: string; perms?: string[] } },
  ) {
    const detail = await this.referenceDetailService.getDetailsByReference(ref);
    if (req?.user?.role === 'admin') return detail;

    const canViewPurchases = (req?.user?.perms || []).includes('purchase-view');
    const isPurchaseTx = (t: any) => t && (t.type === 'مشتريات' || t.type === 'مرتجع مشتريات');
    const maskTxInfo = (t: any) => {
      if (!isPurchaseTx(t)) return t;
      if (!canViewPurchases) return null;
      return { ...t, total: null, deposit: null, remaining: null, items: undefined };
    };
    return {
      ...detail,
      primaryTransaction: maskTxInfo(detail.primaryTransaction),
      allTransactions: (detail.allTransactions || []).filter((t: any) => canViewPurchases || !isPurchaseTx(t)).map(maskTxInfo),
    };
  }

  @Get('reference-search/:partial')
  async searchReferences(@Param('partial') partial: string) {
    return this.referenceDetailService.searchReferences(partial);
  }

  @Post()
  async create(
    @Body() dto: CreateTransactionDto,
    @Req() req: { user?: { role?: string; perms?: string[] } },
  ) {
    if (dto.type === 'مشتريات' && req.user?.role !== 'admin') {
      const perms = req.user?.perms || [];
      if (!perms.includes('purchase-create')) {
        throw new ForbiddenException('ليس لديك صلاحية إنشاء عملية شراء');
      }
    }
    return this.transactionsService.create(dto, req.user?.role);
  }

  @Roles('admin')
  @Post('bulk-delete')
  async bulkDelete(
    @Body() dto: BulkDeleteDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const archivedBy = req.user.name || req.user.username || '';
    const count = await this.transactionsService.bulkRemove(dto.ids, archivedBy);
    return { message: `تم تجميد ${count} معاملة`, deletedCount: count };
  }

  @Roles('admin')
  @Delete(':id/permanent')
  async permanentDelete(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const deletedBy = req.user.name || req.user.username || '';
    await this.transactionsService.hardDelete(id, deletedBy);
    return { message: 'تم الحذف النهائي للمعاملة' };
  }

  // ─── Pick-Up endpoints (must be BEFORE @Get(':id') to avoid routing conflict) ──

  @Get('pickup-orders')
  async getPickupOrders() {
    return this.transactionsService.findPickupOrders();
  }

  @Post('pickup-orders/preparing')
  async setPickupPreparing(
    @Body() body: { ids: string[]; prepRef: string; note?: string; shipCo?: string; createdAt?: string },
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username || 'مستخدم';
    return this.transactionsService.setPickupPreparing(body.ids, by, body.prepRef, {
      note: body.note || '',
      shipCo: body.shipCo || '',
      createdAt: body.createdAt || '',
      createdBy: by,
    });
  }

  @Post('pickup-orders/confirm')
  async confirmPickup(
    @Body() body: { ids: string[]; date?: string; reuseOpenRun?: boolean },
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username || 'مستخدم';
    return this.transactionsService.confirmPickup(body.ids, by, body.date, body.reuseOpenRun === true);
  }

  @Post('pickup-orders/undo')
  async undoPickup(
    @Body() body: { ids: string[] },
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username || 'مستخدم';
    return this.transactionsService.undoPickup(body.ids, by);
  }

  @Post('pickup-orders/add-to-run')
  async addToPickupRun(
    @Body() body: { id?: string; ids?: string[]; pickupRef: string; date?: string },
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username || 'مستخدم';
    const ids = Array.isArray(body.ids) && body.ids.length ? body.ids : (body.id ? [body.id] : []);
    return this.transactionsService.addToPickupRun(ids, body.pickupRef, by, body.date);
  }

  @Patch('pickup-orders/:id/prep-check')
  async setPrepChecked(
    @Param('id') id: string,
    @Body() body: { prepChecked: boolean },
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username || 'مستخدم';
    return this.transactionsService.setPrepChecked(id, body.prepChecked, by);
  }

  @Get('by-ref/:ref')
  async findByRef(
    @Param('ref') ref: string,
    @Query('type') type?: string,
    @Req() req?: { user?: { role?: string; perms?: string[] } },
  ) {
    const tx = await this.transactionsService.findByRef(ref, type);
    this.assertPurchaseViewable(tx, req?.user);
    return maskTransactionForRole(tx, req?.user?.role);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Req() req?: { user?: { role?: string; perms?: string[] } }) {
    if (id === 'pickup-orders') {
      const txs = await this.transactionsService.findPickupOrders();
      return maskTransactionsForRole(filterPurchasesForPerms(txs, req?.user?.role, req?.user?.perms), req?.user?.role);
    }
    if (id === 'archived') {
      const txs = await this.transactionsService.findArchived();
      return maskTransactionsForRole(filterPurchasesForPerms(txs, req?.user?.role, req?.user?.perms), req?.user?.role);
    }
    if (!isValidObjectId(id)) throw new BadRequestException('معرّف المعاملة غير صالح');
    const tx = await this.transactionsService.findById(id);
    this.assertPurchaseViewable(tx, req?.user);
    return maskTransactionForRole(tx, req?.user?.role);
  }

  private assertPurchaseViewable(
    tx: any,
    user?: { role?: string; perms?: string[] },
  ): void {
    if (!tx) return;
    if (user?.role === 'admin') return;
    if (tx.type !== 'مشتريات' && tx.type !== 'مرتجع مشتريات') return;
    if ((user?.perms || []).includes('purchase-view')) return;
    throw new ForbiddenException('ليس لديك صلاحية عرض فواتير الشراء');
  }

  @Get(':id/lock-status')
  async getLockStatus(@Param('id') id: string) {
    return this.transactionsService.getEditLockStatus(id);
  }

  @Post(':id/lock')
  async acquireLock(
    @Param('id') id: string,
    @Req() req: { user: { userId: string; name: string; username: string } },
  ) {
    const requestingUser = req.user?.name || req.user?.username || 'مستخدم';
    const result = this.transactionsService.tryAcquireEditLock(id, requestingUser, req.user?.userId);
    if (!result.ok) {
      throw new HttpException(
        { message: `هذه المعاملة قيد التعديل بواسطة ${result.lockedBy} — حاول لاحقاً`, lockedBy: result.lockedBy },
        HttpStatus.CONFLICT,
      );
    }
    return { ok: true, user: requestingUser };
  }

  @Post(':id/unlock')
  async releaseLock(@Param('id') id: string) {
    this.transactionsService.releaseEditLock(id);
    return { ok: true };
  }

  @Post(':id/restore')
  async restore(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const restoredBy = req.user?.name || req.user?.username || 'مستخدم';
    return this.transactionsService.restore(id, restoredBy);
  }

  @Post(':id/request-cancel')
  async requestCancel(
    @Param('id') id: string,
    @Body() dto: RequestCancelDto,
  ) {
    return this.transactionsService.requestCancel(
      id,
      dto.reason || '',
      dto.requestedBy,
      dto.requestedById,
      dto.requestedByUsername,
      dto.cancelReasonCode,
      dto.cancelReasonNote,
    );
  }

  @Roles('admin')
  @Post(':id/approve-cancel')
  async approveCancel(
    @Param('id') id: string,
    @Body() dto: ReviewCancelDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const reviewedBy = req.user.name || req.user.username || '';
    return this.transactionsService.approveCancel(id, reviewedBy, dto?.vaultAccount);
  }

  @Roles('admin')
  @Post(':id/reject-cancel')
  async rejectCancel(
    @Param('id') id: string,
    @Body() dto: ReviewCancelDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const reviewedBy = req.user.name || req.user.username || '';
    return this.transactionsService.rejectCancel(id, reviewedBy, dto.rejectedReason);
  }

  @Post(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body() dto: CancelTransactionDto,
  ) {
    return this.transactionsService.cancel(id, dto);
  }

  // ── Failed delivery ───────────────────────────────────────────────────────
  // Declared BEFORE the generic ':id/...' handlers that follow are irrelevant —
  // Nest matches on the full path — but kept together so the whole path is
  // readable in one place.

  /**
   * "Yes, the shipment is back" — records the closing decision, brings the stock
   * in, refunds what is owed, and releases the order from the shipping-issues
   * card. JWT-only, like collect: any employee who can work the card can finish
   * the job they were assigned.
   */
  @Post(':id/failed-delivery/close')
  async closeFailedDelivery(
    @Param('id') id: string,
    @Body() dto: CloseFailedDeliveryDto,
    @Req() req: any,
  ) {
    const by = req.user?.name || req.user?.username || 'مستخدم';
    return this.transactionsService.closeFailedDelivery(id, dto, by);
  }

  /** "Not yet" — the courier says it is coming; the order stays on the card. */
  @Post(':id/failed-delivery/awaiting')
  async markFailedDeliveryAwaiting(@Param('id') id: string, @Req() req: any) {
    const by = req.user?.name || req.user?.username || 'مستخدم';
    return this.transactionsService.markFailedDeliveryAwaiting(id, by);
  }

  /** Send it out again — new waybill, same transaction, same reference. */
  @Post(':id/failed-delivery/reship')
  async reshipFailedDelivery(
    @Param('id') id: string,
    @Body() dto: ReshipTransactionDto,
    @Req() req: any,
  ) {
    const by = req.user?.name || req.user?.username || 'مستخدم';
    return this.transactionsService.reshipFailedDelivery(id, dto, by);
  }

  /**
   * Opens the processing state on orders that came back before this path
   * existed. Admin-only and previews by default — `{"dryRun": false}` writes.
   */
  @Roles('admin')
  @Post('backfill/ship-issue-state')
  async backfillShipIssueState(@Body() dto: BackfillShipIssueDto) {
    return this.transactionsService.backfillShipIssueState(dto?.refs, dto?.dryRun !== false);
  }

  /**
   * Closes issues the courier already resolved — the mirror of the route above.
   * Admin-only and previews by default: `{"dryRun": false}` writes.
   */
  @Roles('admin')
  @Post('backfill/resolved-ship-issues')
  async backfillResolvedShipIssues(@Body() dto: BackfillShipIssueDto) {
    return this.transactionsService.backfillResolvedShipIssues(dto?.refs, dto?.dryRun !== false);
  }

  /**
   * إغلاق تنبيه تعارض العنوان — إقرار بشري بأن الأمر عولج (اتصال ببوسطا أو إعادة إنشاء
   * الشحنة). لا يُعدّل أي عنوان: العنوان المشحون يبقى كما هو لأنه يصف أين ذهبت الشحنة.
   * JWT فقط — من يستطيع رؤية الفاتورة والتصرف في الشحنة يستطيع إغلاق تنبيهها.
   */
  /** إغلاق تنبيه تعارض شوبيفاي (address | cancel | fulfillment) — إقرار بشري لا أكثر. */
  @Post(':id/shopify-conflict/:kind/resolve')
  async resolveShopifyConflict(
    @Param('id') id: string,
    @Param('kind') kind: string,
    @Req() req: any,
  ) {
    const by = req.user?.name || req.user?.username || 'مستخدم';
    return this.transactionsService.resolveShopifyConflict(id, kind, by);
  }

  @Post(':id/address-conflict/resolve')
  async resolveAddressConflict(@Param('id') id: string, @Req() req: any) {
    const by = req.user?.name || req.user?.username || 'مستخدم';
    return this.transactionsService.resolveAddressConflict(id, by);
  }

  @Post(':id/collect')
  async collect(
    @Param('id') id: string,
    @Body() dto: CollectTransactionDto,
    @Req() req: any,
  ) {
    const by = req.user?.name || req.user?.username || 'مستخدم';
    const callerRole = req.user?.role || '';
    // Perms are forwarded rather than enforced by a route decorator: this endpoint serves both
    // customer collection and supplier payment, and only the loaded transaction knows which.
    const callerPerms: string[] = req.user?.perms || [];
    return this.transactionsService.collect(id, dto, by, callerRole, callerPerms);
  }

  @Post(':id/reverse-collect')
  async reverseCollect(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const reversedBy = req.user?.name || req.user?.username || 'مجهول';
    return this.transactionsService.reverseCollect(id, reversedBy);
  }

  /**
   * Reversing a purchase payment is delegable via `suppliers-reverse`; reversing a sales
   * collection stays admin-only. The route perm is the coarse gate, the service does the
   * type-dependent half — see undoSpecificPayment().
   */
  @RequirePerms('suppliers-reverse')
  @Post(':id/payments/:paymentId/undo')
  async undoPayment(
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    const undoBy = req.user?.name || req.user?.username || 'مجهول';
    return this.transactionsService.undoSpecificPayment(
      id, paymentId, undoBy, body?.reason, req.user?.role || '', req.user?.perms || [],
    );
  }

  /**
   * Close a purchase invoice's unpaid remainder that the supplier waived. Admin-only: it reduces
   * a payable without any cash moving, so the stated reason is the entire audit trail.
   */
  @RequirePerms('suppliers-write-off')
  @Post(':id/write-off-remaining')
  async writeOffRemaining(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user?.name || req.user?.username || 'مجهول';
    return this.transactionsService.writeOffRemaining(id, body?.reason || '', by);
  }

  @Roles('admin')
  @Post(':id/post-discount')
  async applyPostDiscount(
    @Param('id') id: string,
    @Body() dto: PostDiscountDto,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const appliedBy = req.user.name || req.user.username || '';
    return this.transactionsService.applyPostDiscount(
      id,
      dto.amount,
      dto.vaultAccount,
      appliedBy,
      dto.notes,
    );
  }

  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateTransactionDto,
    @Req() req: { user: { name: string; username: string; role?: string } },
    @Query('editedBy') editedByOverride?: string,
    @Query('approvedBy') approvedByOverride?: string,
  ) {
    const approvedBy = approvedByOverride || '';
    const editedBy = editedByOverride || req.user.name || req.user.username || '';
    // مرحلة الشحن هي ما يقفل التعديل (لا حالة الدفع)، والدور يحدد استثناء المدير
    // للأوردر الذي في الطريق — راجع assertEditableByFulfillment.
    const callerRole = req.user?.role || '';
    this.transactionsService.acquireEditLock(id, editedBy);
    try {
      return await this.transactionsService.update(
        id,
        dto,
        editedBy,
        approvedBy,
        callerRole,
      );
    } finally {
      this.transactionsService.releaseEditLock(id);
    }
  }

  @Post(':id/comments')
  async addComments(
    @Param('id') id: string,
    @Body() body: { comments: Array<any> },
  ) {
    return this.transactionsService.addComments(id, body.comments);
  }

  @Patch(':id/tags')
  async updateTags(
    @Param('id') id: string,
    @Body() body: { tags: string[] },
  ) {
    return this.transactionsService.updateTags(id, body.tags);
  }

  @Post(':id/pickup-delivered')
  async markPickupDelivered(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username || 'مستخدم';
    await this.transactionsService.markPickupDelivered(id, by);
    return { ok: true };
  }

  @Post(':id/pickup-revert-delivered')
  async revertPickupDelivered(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const by = req.user.name || req.user.username || 'مستخدم';
    await this.transactionsService.revertPickupDelivered(id, by);
    return { ok: true };
  }

  /**
   * إصلاح بأثر رجعي: ملء `items[].imageUrl` على المعاملات وطلبات المرتجعات
   * (عملاء وموردين) اللي اتخزنت قبل ما الحقل يتعرّف في الـDTO/الـschema
   * (كان بيتشال في صمت بواسطة الـValidationPipe).
   *
   * dryRun افتراضياً true — لازم تبعت {"dryRun": false} عشان يكتب فعلياً.
   * بيملا الفاضي بس، فآمن للتكرار ومابيمسحش صورة اتخزنت وقت البيع.
   */
  @Roles('admin')
  @Post('backfill/item-images')
  async backfillItemImages(@Body('dryRun') dryRun?: boolean) {
    return this.transactionsService.backfillItemImages(dryRun !== false);
  }

  @Roles('admin')
  @Delete('clear')
  async clearAll() {
    await this.transactionsService.clearAll();
    return { message: 'تم مسح كل المعاملات' };
  }

  // Archiving is admin-only, same as its bulk twin (POST bulk-delete). The ⋮ menu already
  // gated this on isAdmin() in both renderers; the route itself was JWT-only.
  @Roles('admin')
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Req() req: { user: { name: string; username: string } },
  ) {
    const archivedBy = req.user.name || req.user.username || '';
    await this.transactionsService.remove(id, archivedBy);
    return { message: 'تم تجميد المعاملة' };
  }
}
