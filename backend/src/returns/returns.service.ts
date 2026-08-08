import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ReturnRequest,
  ReturnRequestDocument,
} from './schemas/return-request.schema';
import { CreateReturnRequestDto } from './dto/return-request.dto';
import { TransactionsService } from '../transactions/transactions.service';
import {
  ReturnsValidationService,
  ReturnLineInput,
} from './returns-validation.service';
import {
  MAX_RETURN_DAYS,
  RETURN_ONLY_REASONS,
  RETURN_CONDITION_SOUND,
  normalizeVaultAccountLabel,
} from './returns.constants';

/**
 * Customer returns.
 *
 * Cash and quantity ceilings are enforced through ReturnsValidationService — which this service
 * previously did not call at all. See that file for why the ceilings are derived from the stored
 * invoice rather than the request payload.
 */
@Injectable()
export class ReturnsService {
  private readonly logger = new Logger(ReturnsService.name);

  constructor(
    @InjectModel(ReturnRequest.name)
    private readonly returnModel: Model<ReturnRequestDocument>,
    private readonly transactionsService: TransactionsService,
    // The vault balance check lives in ReturnsValidationService, which owns VaultService — this
    // service used to inject VaultService as well, and ExpensesService which it never called at all.
    private readonly validation: ReturnsValidationService,
  ) {}

  /** قيمة بنود المرتجع كما أُرسلت — للعرض والتخزين؛ سقف الرد يُحسب من الفاتورة الأصلية لا من هذه. */
  private sumReturnItemsTotal(items: { total?: number }[] | undefined): number {
    return Math.round(
      (items || []).reduce((s, it) => s + (Number(it.total) || 0), 0),
    );
  }

  /**
   * `{ref}-RET` for the first return on an invoice, `{ref}-RET-2` for the second, and so on.
   *
   * Plain `{ref}-RET` was used unconditionally before. That only avoided collisions because a
   * second return on the same invoice was blocked outright — and `assertRetailRefForPersist` skips
   * uniqueness checks for type 'مرتجع' entirely, so nothing downstream would have caught the clash.
   */
  private buildReturnRef(originalRef: string, sequence: number): string {
    const base = String(originalRef || '').trim();
    return sequence <= 1 ? `${base}-RET` : `${base}-RET-${sequence}`;
  }

  async findAll(): Promise<ReturnRequestDocument[]> {
    return this.returnModel.find().sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<ReturnRequestDocument> {
    const ret = await this.returnModel.findById(id).exec();
    if (!ret) {
      throw new NotFoundException('طلب الاسترجاع غير موجود');
    }
    return ret;
  }

  async create(
    rawBody: Record<string, unknown>,
    requestedBy: string,
  ): Promise<ReturnRequestDocument> {
    const dto = plainToInstance(CreateReturnRequestDto, rawBody);
    const validationErrors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: false,
    });
    if (validationErrors.length) {
      const msg = validationErrors
        .flatMap((e) => Object.values(e.constraints || {}))
        .filter(Boolean)
        .join(' — ');
      throw new BadRequestException(msg || 'بيانات الطلب غير صالحة');
    }

    // Exchange is not wired yet (the replacement-sale leg cannot be created — a 'مبيعات' ref must
    // be digits-only). Say so instead of silently downgrading the request to a plain refund, which
    // would refund a customer who asked to swap an item.
    if (String(rawBody.requestKind || '') === 'exchange') {
      throw new BadRequestException(
        'الاستبدال غير متاح حالياً — سجّل استرجاعاً ثم فاتورة بيع جديدة للبديل',
      );
    }

    if (
      !(RETURN_ONLY_REASONS as readonly string[]).includes(String(dto.reason))
    ) {
      throw new BadRequestException(
        `سبب الاسترجاع غير صالح — المسموح: ${RETURN_ONLY_REASONS.join(' / ')}`,
      );
    }

    const tx = await this.transactionsService.findById(
      dto.originalTransactionId,
    );
    if (tx.cancelled) {
      throw new BadRequestException('لا يمكن استرجاع معاملة ملغية');
    }
    if (tx.type !== 'مبيعات') {
      throw new BadRequestException(
        'الاسترجاع متاح لفواتير المبيعات فقط — مرتجع المشتريات له مسار منفصل',
      );
    }

    const items: ReturnLineInput[] = (dto.items || []).map((it) => ({
      code: it.code,
      name: it.name,
      qty: Number(it.qty) || 0,
      price: Number(it.price) || 0,
      total: Number(it.total) || 0,
      condition: it.condition || RETURN_CONDITION_SOUND,
    }));

    // ── The four checks that previously did not run ──
    this.validation.assertItemsMatchOriginal(tx, items);
    const existingReturns = await this.validation.findActiveReturnsForInvoice(
      dto.originalTransactionId,
    );
    this.validation.assertQtyWithinRemaining(tx, items, existingReturns);
    const ceiling = this.validation.computeRefundCeiling(
      tx,
      items,
      existingReturns,
    );
    this.validation.assertRefundWithinCeiling(dto.total, ceiling);

    // Advisory only — daysRemaining may go negative and is stored/displayed as a "past the usual
    // window" indicator, never a hard block. Unchanged behaviour, kept deliberately.
    const diffDays = Math.floor(
      (Date.now() - new Date(tx.date).getTime()) / (1000 * 60 * 60 * 24),
    );
    const daysRemaining = MAX_RETURN_DAYS - diffDays;

    const vaultRefundAccount =
      normalizeVaultAccountLabel(
        typeof rawBody.vaultRefundAccount === 'string'
          ? rawBody.vaultRefundAccount
          : undefined,
      ) || normalizeVaultAccountLabel(String(tx.depMethod || ''));
    if (!vaultRefundAccount) {
      throw new BadRequestException(
        'حدد قسم الخزنة الذي يُسحب منه مبلغ الرد للعميل (كاش، فودافون كاش، Instapay، أو تحويل بنكي)',
      );
    }

    const sequence = existingReturns.length + 1;
    const originalRef = dto.originalRef || dto.originalTransactionId;

    return this.returnModel.create({
      originalTransactionId: dto.originalTransactionId,
      originalRef,
      originalDate: dto.originalDate,
      client: dto.client,
      phone: dto.phone,
      items,
      total: Math.round(Number(dto.total) || 0),
      itemsTotal: this.sumReturnItemsTotal(items),
      actualShipCost: Math.max(0, Math.round(Number(dto.actualShipCost) || 0)),
      maxRefundable: ceiling.maxRefundable,
      damagedValue: ceiling.damagedValue,
      reason: dto.reason,
      reasonDetails: dto.reasonDetails,
      requestKind: 'return',
      exchangeItems: [],
      exchangeTotal: 0,
      priceDifference: 0,
      vaultRefundAccount,
      vaultCollectAccount: '',
      returnShipCo: dto.returnShipCo || '',
      returnTrackingNumber: dto.returnTrackingNumber || '',
      sequence,
      returnTxRef: this.buildReturnRef(originalRef, sequence),
      requestedBy,
      status: 'معلق',
      daysRemaining,
      maxReturnDays: MAX_RETURN_DAYS,
    });
  }

  /**
   * Approval order is deliberate: validate → flip status → create the transaction → **revert the
   * status if the transaction failed**.
   *
   * The old order flipped the status and then created the transaction with no compensation, so a
   * failure left the request 'معتمد' with no transaction: no cash out, no stock in, yet the reports
   * still subtracted it from net sales. Creating the transaction first is worse, not better — the
   * cash and stock would already have moved while the request still read 'معلق', so a retry would
   * refund twice.
   */
  async approve(
    id: string,
    approvedBy: string,
  ): Promise<ReturnRequestDocument> {
    const ret = await this.returnModel.findById(id).exec();
    if (!ret) {
      throw new NotFoundException('طلب الاسترجاع غير موجود');
    }
    if (ret.status !== 'معلق') {
      throw new BadRequestException('الطلب ليس معلقاً');
    }

    const originalTx = await this.transactionsService.findById(
      String(ret.originalTransactionId),
    );
    if (originalTx.cancelled) {
      throw new BadRequestException(
        'الفاتورة الأصلية أُلغيت — لا يمكن اعتماد الاسترجاع',
      );
    }

    const items: ReturnLineInput[] = (ret.items || []).map((it) => ({
      code: it.code,
      name: it.name,
      qty: Number(it.qty) || 0,
      price: Number(it.price) || 0,
      total: Number(it.total) || 0,
      condition: it.condition || RETURN_CONDITION_SOUND,
    }));

    // Re-validated at approval, not just at creation: the request may have sat pending while
    // another return consumed the same units, or the invoice was edited.
    const otherReturns = await this.validation.findActiveReturnsForInvoice(
      String(ret.originalTransactionId),
      String(ret._id),
    );
    this.validation.assertItemsMatchOriginal(originalTx, items);
    this.validation.assertQtyWithinRemaining(originalTx, items, otherReturns);
    const ceiling = this.validation.computeRefundCeiling(
      originalTx,
      items,
      otherReturns,
    );

    const refundTotal = Math.round(Number(ret.total) || 0);
    this.validation.assertRefundWithinCeiling(refundTotal, ceiling);

    const refundAccount =
      normalizeVaultAccountLabel(ret.vaultRefundAccount) ||
      normalizeVaultAccountLabel(String(originalTx.depMethod || '')) ||
      'كاش';
    await this.validation.assertVaultFundsAvailable(refundAccount, refundTotal);

    // Recompute the suffix against what actually exists now, so two requests created before either
    // was approved cannot both land on `{ref}-RET`.
    const sequence = otherReturns.length + 1;
    const returnRef = this.buildReturnRef(ret.originalRef, sequence);

    const previousStatus = ret.status;
    ret.status = 'معتمد';
    ret.approvedBy = approvedBy;
    ret.approvedAt = new Date().toISOString();
    ret.sequence = sequence;
    ret.returnTxRef = returnRef;
    ret.maxRefundable = ceiling.maxRefundable;
    ret.damagedValue = ceiling.damagedValue;
    await ret.save();

    const damagedNote =
      ceiling.damagedValue > 0
        ? ` | تالف لا يدخل المخزون: ${ceiling.damagedValue} ج`
        : '';
    const returnTx = {
      date: new Date().toISOString(),
      type: 'مرتجع' as const,
      client: ret.client,
      phone: ret.phone || '',
      ref: returnRef,
      notes:
        `مرتجع معتمد: ${ret.reason}${ret.reasonDetails ? ' — ' + ret.reasonDetails : ''}` +
        ` | مبلغ الرد: ${refundTotal} ج من ${refundAccount}${damagedNote}`,
      items: ret.items,
      total: refundTotal,
      itemsTotal: Math.round(Number(ret.itemsTotal) || 0),
      employee: approvedBy,
      deposit: 0,
      remaining: 0,
      depMethod: refundAccount,
      payment: 'كاش',
      payStatus: 'مكتمل',
      discount: 0,
      shipCost: 0,
      returnShipCo: ret.returnShipCo || '',
      returnTrackingNumber: ret.returnTrackingNumber || '',
      returnRequestId: String(ret._id),
    };

    let createdTx: { _id: unknown; ref?: string };
    try {
      createdTx = (await this.transactionsService.create(
        returnTx as never,
      )) as unknown as { _id: unknown; ref?: string };
    } catch (e) {
      // Put the request back where it was. Without this the request stays 'معتمد' forever with no
      // transaction behind it — counted by the reports, backed by nothing.
      ret.status = previousStatus;
      ret.approvedBy = '';
      ret.approvedAt = '';
      try {
        await ret.save();
      } catch (revertErr) {
        this.logger.error(
          `[approve] RETURN_APPROVE_REVERT_FAILED id=${String(ret._id)} ref=${returnRef}: ${(revertErr as Error).message}`,
        );
      }
      throw e;
    }

    // Best-effort link. The ref is already stored above, and the reversal lookup falls back to it,
    // so a failure here degrades the audit trail rather than breaking reversal.
    try {
      ret.returnTxId = String(createdTx._id);
      await ret.save();
    } catch (e) {
      this.logger.warn(
        `[approve] RETURN_TX_LINK_FAILED id=${String(ret._id)} tx=${String(createdTx._id)}: ${(e as Error).message}`,
      );
    }

    return ret;
  }

  async reject(
    id: string,
    approvedBy: string,
    rejectedReason = '',
  ): Promise<ReturnRequestDocument> {
    const ret = await this.returnModel.findById(id).exec();
    if (!ret) {
      throw new NotFoundException('طلب الاسترجاع غير موجود');
    }
    if (ret.status !== 'معلق') {
      throw new BadRequestException('الطلب ليس معلقاً');
    }
    ret.status = 'مرفوض';
    ret.approvedBy = approvedBy;
    ret.approvedAt = new Date().toISOString();
    ret.rejectedReason = rejectedReason;
    return ret.save();
  }

  async updateVaultAccount(
    id: string,
    vaultRefundAccount?: string,
    vaultCollectAccount?: string,
  ): Promise<ReturnRequestDocument> {
    const ret = await this.returnModel.findById(id).exec();
    if (!ret) {
      throw new NotFoundException('طلب الاسترجاع غير موجود');
    }
    if (ret.status !== 'معلق') {
      throw new BadRequestException('لا يمكن تعديل الخزنة — الطلب ليس معلقاً');
    }
    if (vaultRefundAccount) {
      const normalized = normalizeVaultAccountLabel(vaultRefundAccount);
      if (!normalized) {
        throw new BadRequestException('قسم الخزنة غير صالح');
      }
      ret.vaultRefundAccount = normalized;
    }
    if (vaultCollectAccount) {
      const normalized = normalizeVaultAccountLabel(vaultCollectAccount);
      if (!normalized) {
        throw new BadRequestException('قسم الخزنة غير صالح');
      }
      ret.vaultCollectAccount = normalized;
    }
    return ret.save();
  }

  /**
   * How much of each line on an invoice is still returnable — feeds the return form so an operator
   * can see that 2 of 3 units already went back, instead of discovering it on submit.
   */
  async getReturnableQuantities(originalTransactionId: string): Promise<{
    originalTransactionId: string;
    amountPaid: number;
    alreadyRefunded: number;
    refundableCash: number;
    lines: {
      code: string;
      name: string;
      sold: number;
      returned: number;
      remaining: number;
      unitPrice: number;
    }[];
  }> {
    const tx = await this.transactionsService.findById(originalTransactionId);
    const existing = await this.validation.findActiveReturnsForInvoice(
      originalTransactionId,
    );

    const returnedByCode = new Map<string, number>();
    for (const ret of existing) {
      for (const it of ret.items || []) {
        const code = String(it.code).trim();
        returnedByCode.set(
          code,
          (returnedByCode.get(code) || 0) + (Number(it.qty) || 0),
        );
      }
    }

    const soldByCode = new Map<
      string,
      { name: string; qty: number; total: number }
    >();
    for (const it of tx.items || []) {
      const code = String(it.code).trim();
      const prev = soldByCode.get(code);
      soldByCode.set(code, {
        name: prev?.name || it.name,
        qty: (prev?.qty || 0) + (Number(it.qty) || 0),
        total: (prev?.total || 0) + (Number(it.total) || 0),
      });
    }

    const amountPaid = Math.max(
      0,
      Math.round(
        (Number(tx.total) || 0) - Math.max(0, Number(tx.remaining) || 0),
      ),
    );
    const alreadyRefunded = Math.round(
      existing.reduce((s, r) => s + (Number(r.total) || 0), 0),
    );

    return {
      originalTransactionId,
      amountPaid,
      alreadyRefunded,
      refundableCash: Math.max(0, amountPaid - alreadyRefunded),
      lines: [...soldByCode.entries()].map(([code, v]) => {
        const returned = returnedByCode.get(code) || 0;
        return {
          code,
          name: v.name,
          sold: v.qty,
          returned,
          remaining: Math.max(0, v.qty - returned),
          unitPrice: v.qty > 0 ? Math.round(v.total / v.qty) : 0,
        };
      }),
    };
  }

  /**
   * Reversal is NOT handled here. `TransactionsService.performCancellation` writes the flag through
   * the ReturnRequest model it already injects — routing it through this service would need
   * TransactionsService to depend on ReturnsService, and ReturnsModule already imports
   * TransactionsModule, so that is a module cycle. See `markReturnRequestReversed` there.
   */
}
