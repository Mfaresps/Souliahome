import {
  Injectable,
  NotFoundException,
  BadRequestException,
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
import { ExpensesService } from '../expenses/expenses.service';
import { VaultService } from '../vault/vault.service';
// #region agent log
import { debugLog } from '../debug-log.util';
// #endregion

const MAX_RETURN_DAYS = 14;

const RETURN_REASONS = ['تلف الشحنة', 'شحنة خاطئة', 'سبب آخر'] as const;

const VAULT_AR_LABELS = [
  'كاش',
  'فودافون كاش',
  'Instapay',
  'تحويل بنكي',
] as const;

const VAULT_CODE_TO_AR: Record<string, (typeof VAULT_AR_LABELS)[number]> = {
  cash: 'كاش',
  vodafone: 'فودافون كاش',
  instapay: 'Instapay',
  bank: 'تحويل بنكي',
};

/** يقبل التسمية العربية أو رمز الترويسة (cash, bank, …) لضمان سحب الخزنة من الجهة المختارة. */
function normalizeVaultAccountLabel(
  v: string | undefined,
): (typeof VAULT_AR_LABELS)[number] | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  const t = String(v).trim();
  if (!t) {
    return undefined;
  }
  if ((VAULT_AR_LABELS as readonly string[]).includes(t)) {
    return t as (typeof VAULT_AR_LABELS)[number];
  }
  const mapped = VAULT_CODE_TO_AR[t.toLowerCase()];
  return mapped;
}

/** عند الاستبدال: priceDifference = قيمة المرتجع − قيمة البدائل؛ صافي التحصيل = تقريب(البدائل − المرتجع). */
@Injectable()
export class ReturnsService {
  constructor(
    @InjectModel(ReturnRequest.name)
    private readonly returnModel: Model<ReturnRequestDocument>,
    private readonly transactionsService: TransactionsService,
    private readonly expensesService: ExpensesService,
    private readonly vaultService: VaultService,
  ) {}

  /** قيمة المرتجع النقدية = مجموع بنود الأصناف فقط (لا شحن ولا خصم على مستوى الفاتورة). */
  private sumReturnItemsTotal(
    items: { total?: number }[] | undefined,
  ): number {
    return Math.round(
      (items || []).reduce((s, it) => s + (Number(it.total) || 0), 0),
    );
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
    let vaultRefundAccount: string | undefined = normalizeVaultAccountLabel(
      typeof rawBody.vaultRefundAccount === 'string'
        ? rawBody.vaultRefundAccount
        : undefined,
    );
    let vaultCollectAccount: string | undefined = normalizeVaultAccountLabel(
      typeof rawBody.vaultCollectAccount === 'string'
        ? rawBody.vaultCollectAccount
        : undefined,
    );
    const tx = await this.transactionsService.findById(
      dto.originalTransactionId,
    );
    if (tx.cancelled) {
      throw new BadRequestException('لا يمكن استرجاع حركة ملغية');
    }
    const txDate = new Date(tx.date);
    const now = new Date();
    const diffMs = now.getTime() - txDate.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const daysRemaining = MAX_RETURN_DAYS - diffDays;
    if (daysRemaining <= 0) {
      throw new BadRequestException(
        `انتهت مدة الاسترجاع (${MAX_RETURN_DAYS} يوم) — مرّ ${diffDays} يوم على الحركة`,
      );
    }
    const duplicate = await this.returnModel
      .findOne({
        originalTransactionId: dto.originalTransactionId,
        status: { $in: ['معلق', 'معتمد'] },
      })
      .exec();
    if (duplicate) {
      throw new BadRequestException(
        'لا يُسمح إلا بعملية استرجاع أو استبدال واحدة لكل فاتورة — يوجد طلب سابق لهذه الفاتورة',
      );
    }
    // فقط الاسترجاع العادي (Return) متاح
    if (!RETURN_REASONS.includes(dto.reason as (typeof RETURN_REASONS)[number])) {
      throw new BadRequestException('سبب الاسترجاع غير صالح');
    }

    if (!dto.total || dto.total <= 0) {
      throw new BadRequestException(
        'يجب تحديد مبلغ الرد للعميل',
      );
    }

    // تحديد حساب الخزنة للرد
    if (!vaultRefundAccount) {
      const dep = normalizeVaultAccountLabel(String(tx.depMethod || '').trim());
      if (dep) {
        vaultRefundAccount = dep;
      }
    }
    if (!vaultRefundAccount) {
      throw new BadRequestException(
        'حدد قسم الخزنة الذي يُسحب منه مبلغ الرد للعميل (كاش، فودافون كاش، Instapay، أو تحويل بنكي)',
      );
    }
    return this.returnModel.create({
      originalTransactionId: dto.originalTransactionId,
      originalRef: dto.originalRef || dto.originalTransactionId,
      originalDate: dto.originalDate,
      client: dto.client,
      phone: dto.phone,
      items: dto.items,
      total: dto.total,
      reason: dto.reason,
      reasonDetails: dto.reasonDetails,
      requestKind: 'return', // فقط الاسترجاع العادي
      exchangeItems: [],
      exchangeTotal: 0,
      priceDifference: 0,
      vaultRefundAccount: vaultRefundAccount!,
      vaultCollectAccount: '',
      requestedBy,
      status: 'معلق',
      daysRemaining,
      maxReturnDays: MAX_RETURN_DAYS,
    });
  }

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

    const returnDate = new Date().toISOString();
    const originalTx = await this.transactionsService.findById(
      String(ret.originalTransactionId),
    );
    const refundSegStored = String(ret.vaultRefundAccount || '').trim();
    const refundAccount =
      normalizeVaultAccountLabel(refundSegStored) ||
      normalizeVaultAccountLabel(String(originalTx.depMethod || '').trim()) ||
      'كاش';

    // ret.total = المبلغ اليدوي المحدد من الموظف
    const refundTotal = Number(ret.total);
    if (refundTotal <= 0) {
      throw new BadRequestException('لا يمكن اعتماد الاسترجاع — مبلغ الرد غير صالح');
    }

    // التحقق من رصيد الخزنة قبل الاعتماد
    await this.vaultService.assertSufficientBalance(refundAccount, refundTotal);

    ret.status = 'معتمد';
    ret.approvedBy = approvedBy;
    ret.approvedAt = new Date().toISOString();
    const saved = await ret.save();

    const returnTx = {
      date: returnDate,
      type: 'مرتجع' as const,
      client: ret.client,
      phone: ret.phone || '',
      ref: ret.originalRef + '-RET',
      notes: `مرتجع معتمد: ${ret.reason}${ret.reasonDetails ? ' — ' + ret.reasonDetails : ''} | مبلغ الرد: ${refundTotal} ج من ${refundAccount}`,
      items: ret.items,
      total: refundTotal,
      employee: approvedBy,
      deposit: 0,
      remaining: 0,
      depMethod: refundAccount,
      payment: 'كاش',
      payStatus: 'مكتمل',
      discount: 0,
      shipCost: 0,
    };
    await this.transactionsService.create(returnTx as never);
    // #region agent log
    debugLog('returns.service.ts:approve', 'RETURN_APPROVED', {
      hypothesisId: 'INV',
      returnId: String(saved._id),
      originalRef: ret.originalRef,
      client: ret.client,
      reason: ret.reason,
      refundTotal,
      refundAccount,
      inventoryImpact: 'إضافة للمخزن (إرجاع من عميل)',
      items: (ret.items || []).map((it: any) => ({ code: it.code, name: it.name, qty: it.qty })),
      createdReturnTxRef: ret.originalRef + '-RET',
    });
    // #endregion
    return saved;
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
}
