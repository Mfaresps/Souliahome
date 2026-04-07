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

const MAX_RETURN_DAYS = 14;

const RETURN_REASONS = ['تلف الشحنة', 'شحنة خاطئة', 'سبب آخر'] as const;

const EXCHANGE_REASONS = [
  'مقاس أو لون مختلف',
  'رغبة العميل بصنف آخر',
  'عيب مصنع',
  'سبب آخر',
] as const;

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
    const kind = dto.requestKind === 'exchange' ? 'exchange' : 'return';
    if (kind === 'return') {
      if (!RETURN_REASONS.includes(dto.reason as (typeof RETURN_REASONS)[number])) {
        throw new BadRequestException('سبب الاسترجاع غير صالح');
      }
    } else {
      if (!EXCHANGE_REASONS.includes(dto.reason as (typeof EXCHANGE_REASONS)[number])) {
        throw new BadRequestException('سبب الاستبدال غير صالح');
      }
      if (!dto.exchangeItems?.length) {
        throw new BadRequestException('أضف صنفاً بديلاً واحداً على الأقل');
      }
    }
    const exchangeTotal =
      kind === 'exchange'
        ? Math.round(
            dto.exchangeItems!.reduce((s, it) => s + it.total, 0),
          )
        : 0;
    const returnTotalFromItems = this.sumReturnItemsTotal(dto.items);
    if (returnTotalFromItems <= 0) {
      throw new BadRequestException(
        'قيمة المرتجع يجب أن تُحسب من الأصناف المختارة (مجموع البنود)',
      );
    }
    const priceDifference =
      kind === 'exchange' ? returnTotalFromItems - exchangeTotal : 0;
    const needsRefundVault =
      kind === 'return' ||
      (kind === 'exchange' && returnTotalFromItems > exchangeTotal);
    const needsCollectVault =
      kind === 'exchange' && exchangeTotal > returnTotalFromItems;
    if (needsRefundVault && !vaultRefundAccount) {
      const dep = normalizeVaultAccountLabel(String(tx.depMethod || '').trim());
      if (dep) {
        vaultRefundAccount = dep;
      }
    }
    if (needsCollectVault && !vaultCollectAccount) {
      vaultCollectAccount = 'كاش';
    }
    if (needsRefundVault && !vaultRefundAccount) {
      throw new BadRequestException(
        'حدد قسم الخزنة الذي يُسحب منه مبلغ الرد للعميل (كاش، فودافون كاش، Instapay، أو تحويل بنكي)',
      );
    }
    if (needsCollectVault && !vaultCollectAccount) {
      throw new BadRequestException(
        'حدد قسم الخزنة الذي يُودَع فيه مبلغ تحصيل الفرق لصالح الشركة',
      );
    }
    return this.returnModel.create({
      originalTransactionId: dto.originalTransactionId,
      originalRef: dto.originalRef,
      originalDate: dto.originalDate,
      client: dto.client,
      phone: dto.phone,
      items: dto.items,
      total: returnTotalFromItems,
      reason: dto.reason,
      reasonDetails: dto.reasonDetails,
      requestKind: kind,
      exchangeItems: kind === 'exchange' ? dto.exchangeItems! : [],
      exchangeTotal: kind === 'exchange' ? exchangeTotal : 0,
      priceDifference,
      vaultRefundAccount: needsRefundVault ? vaultRefundAccount! : '',
      vaultCollectAccount: needsCollectVault ? vaultCollectAccount! : '',
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
    ret.status = 'معتمد';
    ret.approvedBy = approvedBy;
    ret.approvedAt = new Date().toISOString();
    const saved = await ret.save();
    const returnDate = new Date().toISOString();
    const originalTx = await this.transactionsService.findById(
      String(ret.originalTransactionId),
    );
    const refundSegStored = String(ret.vaultRefundAccount || '').trim();
    const collectSegStored = String(ret.vaultCollectAccount || '').trim();
    const refundAccount =
      normalizeVaultAccountLabel(refundSegStored) ||
      normalizeVaultAccountLabel(String(originalTx.depMethod || '').trim()) ||
      'كاش';
    const collectAccount =
      normalizeVaultAccountLabel(collectSegStored) || 'كاش';
    const isExchange = ret.requestKind === 'exchange' && ret.exchangeItems?.length;
    if (isExchange) {
      const returnTotal = this.sumReturnItemsTotal(ret.items);
      if (returnTotal <= 0) {
        throw new BadRequestException('قيمة أصناف المرتجع في الطلب غير صالحة');
      }
      const exTotal = Math.round(ret.exchangeTotal || 0);
      const net = Math.round(exTotal - returnTotal);

      // Create return transaction (مرتجع)
      const returnTx = {
        date: returnDate,
        type: 'مرتجع' as const,
        client: ret.client,
        phone: ret.phone || '',
        ref: `${ret.originalRef}-RET`,
        notes:
          `استبدال — مرتجع: ${ret.reason}${ret.reasonDetails ? ' — ' + ret.reasonDetails : ''} | قيمة المرتجع ${returnTotal} ج | بدائل ${exTotal} ج | الفرق: ${net > 0 ? 'على العميل ' + net : net < 0 ? 'لصالح العميل ' + Math.abs(net) : 'صفر'} ج` +
          ` | المخزن: إعادة أصناف المرتجع`,
        items: ret.items,
        total: returnTotal,
        itemsTotal: returnTotal,
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

      // Create exchange/sale transaction (مبيعات)
      const customerOwesCompany = net > 0;
      const saleRemaining = customerOwesCompany ? net : 0;
      const salePayComplete = !customerOwesCompany;
      const saleTx = {
        date: returnDate,
        type: 'مبيعات' as const,
        client: ret.client,
        phone: ret.phone || '',
        ref: `${ret.originalRef}-EXC`,
        notes:
          `بيع استبدال — مقابل مرتجع ${ret.originalRef} | قيمة المرتجع: ${returnTotal} ج | قيمة البدائل: ${exTotal} ج` +
          (net > 0
            ? ` | الفرق لصالح الشركة: ${net} ج (على العميل)`
            : net < 0
              ? ` | الفرق لصالح العميل: ${Math.abs(net)} ج`
              : ` | لا فرق نقدي`),
        items: ret.exchangeItems,
        total: exTotal,
        itemsTotal: exTotal,
        employee: approvedBy,
        shipCo: '',
        shipZone: 'cairo',
        shipCost: 0,
        deposit: 0,
        remaining: saleRemaining,
        depMethod: customerOwesCompany ? collectAccount : 'كاش',
        payment: customerOwesCompany ? 'آجل' : 'كاش',
        payStatus: salePayComplete ? 'مكتمل' : 'معلق',
        discount: 0,
      };
      await this.transactionsService.create(saleTx as never);

      // Handle price difference vault entries
      const dateStr = returnDate.split('T')[0];

      if (net > 0) {
        // Customer owes company - collect additional payment
        await this.vaultService.addSystemEntry(
          net,
          collectAccount,
          `تحصيل فرق استبدال — العميل ${ret.client} يدفع ${net} ج`,
          dateStr,
          'تحصيل',
          `${ret.originalRef}-EXC`,
          { customer: ret.client },
          approvedBy,
        );
      } else if (net < 0) {
        // Company owes customer - refund difference
        const refundAmount = Math.abs(net);
        await this.vaultService.addSystemEntry(
          -refundAmount,
          refundAccount,
          `رد فرق استبدال — العميل ${ret.client} يستحق ${refundAmount} ج`,
          dateStr,
          'رد مرتجع',
          `${ret.originalRef}-EXC`,
          { customer: ret.client },
          approvedBy,
        );
      }
    } else {
      // Simple return (not exchange)
      const refundTotal = this.sumReturnItemsTotal(ret.items);
      if (refundTotal <= 0) {
        throw new BadRequestException(
          'لا يمكن اعتماد الاسترجاع دون أصناف بقيمة صالحة للرد',
        );
      }
      const returnTx = {
        date: returnDate,
        type: 'مرتجع' as const,
        client: ret.client,
        phone: ret.phone || '',
        ref: ret.originalRef + '-RET',
        notes:
          `مرتجع معتمد: ${ret.reason}${ret.reasonDetails ? ' — ' + ret.reasonDetails : ''}` +
          ` | قيمة المرتجع: ${refundTotal} ج` +
          ` | المخزن: إعادة الأصناف | الخزنة: خصم ${refundTotal} ج من ${refundAccount}`,
        items: ret.items,
        total: refundTotal,
        itemsTotal: refundTotal,
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

      // Create vault entry for refund
      const dateStr = returnDate.split('T')[0];
      await this.vaultService.addSystemEntry(
        -refundTotal,
        refundAccount,
        `رد مرتجع — العميل ${ret.client} يستحق ${refundTotal} ج`,
        dateStr,
        'رد مرتجع',
        ret.originalRef + '-RET',
        { customer: ret.client },
        approvedBy,
      );
    }
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
}
