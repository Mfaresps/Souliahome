import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ReturnRequest,
  ReturnRequestDocument,
} from './schemas/return-request.schema';
import { TransactionDocument } from '../transactions/schemas/transaction.schema';
import { VaultService } from '../vault/vault.service';
import {
  ACTIVE_RETURN_STATUSES,
  NOT_REVERSED_FILTER,
  REFUND_ROUNDING_TOLERANCE,
  RETURN_CONDITION_DAMAGED,
} from './returns.constants';

export interface ReturnLineInput {
  code: string;
  name: string;
  qty: number;
  price?: number;
  total?: number;
  condition?: string;
}

/** Everything the caller needs to bound a refund, plus the intermediate figures, for audit. */
export interface RefundCeiling {
  /** Sum of returned lines valued at the ORIGINAL invoice's unit price. */
  itemsValue: number;
  /** Same, after allocating the invoice-level discount proportionally. */
  effectiveItemsValue: number;
  /** total − remaining on the original invoice: cash the customer actually handed over. */
  amountPaid: number;
  /** Already refunded by earlier non-reversed returns on this invoice. */
  alreadyRefunded: number;
  /** The hard ceiling: min(effectiveItemsValue, amountPaid − alreadyRefunded). */
  maxRefundable: number;
  /** Portion of itemsValue whose units came back تالف — refunded, but never re-enters stock. */
  damagedValue: number;
}

/**
 * Validation for customer returns.
 *
 * This service existed before as 213 lines that were registered as a provider, exported, and
 * **never injected anywhere** — so none of the checks it advertised ran. `ReturnsService.create()`
 * now calls into it. Two of its methods were removed rather than wired: a placeholder inventory
 * check that always reported `available: 0`, and an "audit report" whose validation flags were
 * hardcoded `true`. Both would have read as verification while verifying nothing.
 *
 * The load-bearing rule here: **money and quantity ceilings are derived from the stored original
 * invoice, never from the submitted payload.** Client-supplied prices are only sanity-checked; they
 * are never the basis of a refund cap, because that is precisely the number an attacker controls.
 */
@Injectable()
export class ReturnsValidationService {
  constructor(
    @InjectModel(ReturnRequest.name)
    private readonly returnModel: Model<ReturnRequestDocument>,
    private readonly vaultService: VaultService,
  ) {}

  /** Non-reversed, still-active (معلق/معتمد) returns already filed against this invoice. */
  async findActiveReturnsForInvoice(
    originalTransactionId: string,
    excludeReturnId?: string,
  ): Promise<ReturnRequestDocument[]> {
    const rows = await this.returnModel
      .find({
        originalTransactionId,
        status: { $in: [...ACTIVE_RETURN_STATUSES] },
        ...NOT_REVERSED_FILTER,
      })
      .exec();
    return excludeReturnId
      ? rows.filter((r) => String(r._id) !== String(excludeReturnId))
      : rows;
  }

  /**
   * Unit price to value a returned line at. Prefers total/qty over the `price` field: a line
   * discounted at entry has the concession baked into `total`, and refunding list price would hand
   * back money that was never collected.
   */
  private originalUnitPrice(item: {
    qty?: number;
    price?: number;
    total?: number;
  }): number {
    const qty = Number(item.qty) || 0;
    const total = Number(item.total) || 0;
    if (qty > 0 && total > 0) {
      return total / qty;
    }
    return Number(item.price) || 0;
  }

  private findOriginalLine(
    originalTx: TransactionDocument,
    code: string,
    name: string,
  ) {
    const wantedCode = String(code).trim();
    const wantedName = String(name).trim();
    const byCode = (originalTx.items || []).filter(
      (i) => String(i.code).trim() === wantedCode,
    );
    if (!byCode.length) {
      return undefined;
    }
    // Match on name too when the invoice carries the same code twice, but fall back to the code
    // match: a product renamed since the sale must still be returnable.
    return byCode.find((i) => String(i.name).trim() === wantedName) || byCode[0];
  }

  /**
   * Every returned line must exist on the original invoice.
   *
   * This is the check whose absence let `POST /returns` accept items that were never sold. Return
   * lines are added back to stock, so a fabricated line is a stock-inflation primitive, not just a
   * bad record.
   */
  assertItemsMatchOriginal(
    originalTx: TransactionDocument,
    items: ReturnLineInput[],
  ): void {
    if (!originalTx) {
      throw new NotFoundException('الفاتورة الأصلية غير موجودة');
    }
    if (!originalTx.items?.length) {
      throw new BadRequestException('الفاتورة الأصلية لا تحتوي على أصناف');
    }
    if (!items?.length) {
      throw new BadRequestException('اختر صنفاً واحداً على الأقل للاسترجاع');
    }

    for (const line of items) {
      const original = this.findOriginalLine(originalTx, line.code, line.name);
      if (!original) {
        throw new ConflictException(
          `الصنف «${line.name}» (${line.code}) غير موجود في الفاتورة الأصلية`,
        );
      }
      const qty = Number(line.qty) || 0;
      if (qty <= 0) {
        throw new BadRequestException(
          `كمية الاسترجاع من «${line.name}» يجب أن تكون أكبر من صفر`,
        );
      }
      // Advisory only — the refund ceiling is computed from the invoice regardless of what the
      // client sent, so a mismatching price cannot inflate a refund. Flagging it still catches an
      // operator returning against the wrong invoice.
      const submitted = Number(line.price);
      const originalUnit = this.originalUnitPrice(original);
      if (submitted > 0 && originalUnit > 0) {
        const tolerance = Math.max(1, originalUnit * 0.1);
        if (Math.abs(originalUnit - submitted) > tolerance) {
          throw new ConflictException(
            `سعر «${line.name}» مختلف عن الفاتورة الأصلية: كان ${Math.round(originalUnit)} ج والمُرسل ${Math.round(submitted)} ج`,
          );
        }
      }
    }
  }

  /**
   * Cumulative per-item quantity check across every active return on the invoice.
   *
   * Replaces the old invoice-level block ("مرتجع واحد لكل فاتورة"), which made a second partial
   * return impossible forever. The per-item rule is the correct one and was already written in this
   * file — it just never ran.
   */
  assertQtyWithinRemaining(
    originalTx: TransactionDocument,
    items: ReturnLineInput[],
    existingReturns: ReturnRequestDocument[],
  ): void {
    const soldByCode = new Map<string, number>();
    for (const it of originalTx.items || []) {
      const code = String(it.code).trim();
      soldByCode.set(code, (soldByCode.get(code) || 0) + (Number(it.qty) || 0));
    }

    const alreadyByCode = new Map<string, number>();
    for (const ret of existingReturns) {
      for (const it of ret.items || []) {
        const code = String(it.code).trim();
        alreadyByCode.set(
          code,
          (alreadyByCode.get(code) || 0) + (Number(it.qty) || 0),
        );
      }
    }

    const requestedByCode = new Map<string, number>();
    for (const line of items) {
      const code = String(line.code).trim();
      requestedByCode.set(
        code,
        (requestedByCode.get(code) || 0) + (Number(line.qty) || 0),
      );
    }

    for (const [code, requested] of requestedByCode) {
      const sold = soldByCode.get(code) || 0;
      const already = alreadyByCode.get(code) || 0;
      const remaining = sold - already;
      if (requested > remaining) {
        const name =
          items.find((i) => String(i.code).trim() === code)?.name || code;
        if (remaining <= 0) {
          throw new ConflictException(
            `«${name}» تم استرجاع كامل كميته من هذه الفاتورة مسبقاً (${already} من ${sold})`,
          );
        }
        throw new ConflictException(
          `كمية استرجاع «${name}» (${requested}) تتجاوز المتاح — المبيع ${sold}، المُسترجَع مسبقاً ${already}، المتاح ${remaining}`,
        );
      }
    }
  }

  /**
   * The refund ceiling, derived entirely from stored data.
   *
   * An invoice-level discount is allocated proportionally across lines (the Shopify/Odoo rule):
   * refunding the undiscounted line total hands back money the customer never paid, and would then
   * be subtracted from net sales in the reports, understating them by the difference.
   */
  computeRefundCeiling(
    originalTx: TransactionDocument,
    items: ReturnLineInput[],
    existingReturns: ReturnRequestDocument[],
  ): RefundCeiling {
    let itemsValue = 0;
    let damagedRaw = 0;
    for (const line of items) {
      const original = this.findOriginalLine(originalTx, line.code, line.name);
      const unit = original ? this.originalUnitPrice(original) : 0;
      const lineValue = unit * (Number(line.qty) || 0);
      itemsValue += lineValue;
      if (String(line.condition || '') === RETURN_CONDITION_DAMAGED) {
        damagedRaw += lineValue;
      }
    }

    const invoiceItemsTotal =
      Number(originalTx.itemsTotal) ||
      (originalTx.items || []).reduce((s, i) => s + (Number(i.total) || 0), 0);
    const invoiceDiscount = Math.max(0, Number(originalTx.discount) || 0);
    const discountRatio =
      invoiceItemsTotal > 0
        ? Math.min(1, invoiceDiscount / invoiceItemsTotal)
        : 0;
    const effectiveItemsValue = itemsValue * (1 - discountRatio);
    // Discount-adjusted like effectiveItemsValue, deliberately: damagedValue is the slice of the
    // REFUND that bought back nothing sellable, so it has to sit on the same basis as the refund.
    // Reporting it gross while capping the refund net made the two disagree (100 vs 90 on a 10%
    // discount) and put the backend out of step with the frontend mirror.
    const damagedValue = damagedRaw * (1 - discountRatio);

    const invoiceTotal = Number(originalTx.total) || 0;
    const invoiceRemaining = Math.max(0, Number(originalTx.remaining) || 0);
    const amountPaid = Math.max(0, invoiceTotal - invoiceRemaining);

    const alreadyRefunded = existingReturns.reduce(
      (s, r) => s + (Number(r.total) || 0),
      0,
    );

    const maxRefundable = Math.max(
      0,
      Math.round(
        Math.min(effectiveItemsValue, amountPaid - alreadyRefunded),
      ),
    );

    return {
      itemsValue: Math.round(itemsValue),
      effectiveItemsValue: Math.round(effectiveItemsValue),
      amountPaid: Math.round(amountPaid),
      alreadyRefunded: Math.round(alreadyRefunded),
      maxRefundable,
      damagedValue: Math.round(damagedValue),
    };
  }

  /**
   * The check that was missing entirely: the refund was whatever the operator typed, validated only
   * as `> 0`. A typo therefore moved real cash out of the vault and permanently distorted net sales,
   * since the reports subtract this figure.
   */
  assertRefundWithinCeiling(requested: number, ceiling: RefundCeiling): void {
    const amount = Math.round(Number(requested) || 0);
    if (amount <= 0) {
      throw new BadRequestException('يجب تحديد مبلغ الرد للعميل');
    }
    if (ceiling.maxRefundable <= 0) {
      if (ceiling.amountPaid - ceiling.alreadyRefunded <= 0) {
        throw new BadRequestException(
          `لا يوجد مبلغ قابل للرد على هذه الفاتورة — المدفوع ${ceiling.amountPaid} ج وتم رد ${ceiling.alreadyRefunded} ج مسبقاً`,
        );
      }
      throw new BadRequestException('قيمة الأصناف المرتجعة صفر — راجع الأصناف');
    }
    if (amount > ceiling.maxRefundable + REFUND_ROUNDING_TOLERANCE) {
      throw new BadRequestException(
        `مبلغ الرد (${amount} ج) يتجاوز الحد المسموح ${ceiling.maxRefundable} ج — ` +
          `قيمة الأصناف المرتجعة ${ceiling.effectiveItemsValue} ج، ` +
          `المدفوع على الفاتورة ${ceiling.amountPaid} ج` +
          (ceiling.alreadyRefunded > 0
            ? `، ومردود مسبقاً ${ceiling.alreadyRefunded} ج`
            : ''),
      );
    }
  }

  /** Wraps the vault check with a message that tells the approver what to do about it. */
  async assertVaultFundsAvailable(
    vaultAccount: string,
    refundAmount: number,
  ): Promise<void> {
    if (refundAmount <= 0) {
      return;
    }
    try {
      await this.vaultService.assertSufficientBalance(
        vaultAccount,
        refundAmount,
      );
    } catch (e) {
      throw new BadRequestException(
        `رصيد الخزنة غير كافٍ للرد: ${(e as Error).message}. يرجى إضافة رصيد قبل الموافقة`,
      );
    }
  }
}
