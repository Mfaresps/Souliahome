import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  SupplierLedgerEntry,
  SupplierLedgerEntryDocument,
  SrLedgerEntryType,
} from './schemas/supplier-ledger-entry.schema';
import { VaultService } from '../vault/vault.service';
import { SR_VAULT_SEG_LABELS } from './dto/supplier-ledger.dto';

export interface SrBalanceSummary {
  balance: number;
  debt: number;
  credit: number;
}

interface PostEntryInput {
  supplierId: string;
  supplierName: string;
  date: string;
  entryType: SrLedgerEntryType;
  amount: number;
  desc: string;
  sourceType?: string;
  sourceId?: string;
  sourceRef?: string;
  vaultEntryId?: string;
  /** VaultEntry.txNo — the readable operation number the statement links to. */
  vaultTxNo?: string;
  vaultSeg?: string;
  refNo?: string;
  employee?: string;
  meta?: Record<string, unknown> | null;
}

export interface ReturnSettlementResult {
  entries: SupplierLedgerEntryDocument[];
  debtOffsetAmount: number;
  creditAmount: number;
  refundAmount: number;
  balanceAfter: number;
}

@Injectable()
export class SupplierLedgerService {
  private readonly logger = new Logger(SupplierLedgerService.name);

  constructor(
    @InjectModel(SupplierLedgerEntry.name)
    private readonly ledgerModel: Model<SupplierLedgerEntryDocument>,
    private readonly vaultService: VaultService,
  ) {}

  /** Fast-path: latest entry's runningBalance, or 0 if the supplier has no entries yet. */
  async getCurrentBalance(supplierId: string): Promise<number> {
    if (!supplierId) return 0;
    const last = await this.ledgerModel
      .findOne({ supplierId })
      .sort({ createdAt: -1 })
      .exec();
    return last ? last.runningBalance : 0;
  }

  /** balance > 0 => we owe supplier (debt); balance < 0 => supplier owes us / standing credit. */
  async getBalanceSummary(supplierId: string): Promise<SrBalanceSummary> {
    const balance = await this.getCurrentBalance(supplierId);
    return {
      balance,
      debt: Math.max(0, balance),
      credit: Math.max(0, -balance),
    };
  }

  /**
   * Every supplier's balance in ONE query, keyed by supplierId.
   *
   * The suppliers list shows a debt figure per card. Reading it per supplier would be N round-trips
   * on every page load, which is why that page used to sum tx.remaining instead — and therefore
   * silently ignored every invoice-less entry (manual adjustments, advance deposits, debit charges).
   * That is the exact cause of the card/profile mismatch this endpoint exists to remove.
   *
   * Mirrors getCurrentBalance() exactly — newest entry per supplierId by createdAt, take its
   * runningBalance — so a balance here can never disagree with its single-supplier read.
   * Suppliers with no ledger entries are absent from the map; callers treat that as 0.
   */
  async getAllBalances(): Promise<Record<string, SrBalanceSummary>> {
    const rows = await this.ledgerModel
      .aggregate<{ _id: string; runningBalance: number }>([
        { $sort: { supplierId: 1, createdAt: -1 } },
        {
          $group: {
            _id: '$supplierId',
            runningBalance: { $first: '$runningBalance' },
          },
        },
      ])
      .exec();

    const out: Record<string, SrBalanceSummary> = {};
    for (const r of rows) {
      if (!r._id) continue;
      const balance = Number(r.runningBalance) || 0;
      out[String(r._id)] = {
        balance,
        debt: Math.max(0, balance),
        credit: Math.max(0, -balance),
      };
    }
    return out;
  }

  async findBySupplier(
    supplierId: string,
    opts?: { from?: string; to?: string },
  ): Promise<SupplierLedgerEntryDocument[]> {
    const query: Record<string, unknown> = { supplierId };
    if (opts?.from || opts?.to) {
      query.date = {
        ...(opts.from ? { $gte: opts.from } : {}),
        ...(opts.to ? { $lte: opts.to } : {}),
      };
    }
    return this.ledgerModel.find(query).sort({ createdAt: 1 }).exec();
  }

  async findById(id: string): Promise<SupplierLedgerEntryDocument | null> {
    return this.ledgerModel.findById(id).exec();
  }

  /**
   * Fills `vaultTxNo` on entries written before the field existed. They already carry
   * `vaultEntryId`, so this is a pure read-across-and-copy — no amount, balance or date is
   * touched, and an entry whose vault row was deleted is reported, never guessed at.
   *
   * dryRun:true (default) only reports what would change. Admin-triggered, never automatic.
   */
  async backfillVaultTxNo(dryRun = true): Promise<{
    dryRun: boolean;
    candidates: number;
    filled: number;
    missingVaultEntry: Array<{ entryId: string; vaultEntryId: string }>;
  }> {
    const candidates = await this.ledgerModel
      .find({
        vaultEntryId: { $nin: ['', null] },
        $or: [{ vaultTxNo: '' }, { vaultTxNo: { $exists: false } }],
      })
      .exec();
    const missingVaultEntry: Array<{ entryId: string; vaultEntryId: string }> = [];
    let filled = 0;
    for (const entry of candidates) {
      const ve = await this.vaultService.findEntryById(entry.vaultEntryId);
      if (!ve || !ve.txNo) {
        missingVaultEntry.push({
          entryId: String(entry._id),
          vaultEntryId: entry.vaultEntryId,
        });
        continue;
      }
      filled++;
      if (!dryRun) {
        entry.vaultTxNo = ve.txNo;
        await entry.save();
      }
    }
    this.logger.log(
      `backfillVaultTxNo(dryRun=${dryRun}): ${candidates.length} candidates, ${filled} fillable, ${missingVaultEntry.length} without a vault entry`,
    );
    return { dryRun, candidates: candidates.length, filled, missingVaultEntry };
  }

  /** Core internal poster — all public post* methods funnel through this so runningBalance bookkeeping lives in ONE place. */
  private async postEntry(
    input: PostEntryInput,
  ): Promise<SupplierLedgerEntryDocument> {
    const currentBalance = await this.getCurrentBalance(input.supplierId);
    const runningBalance = currentBalance + input.amount;
    return this.ledgerModel.create({
      supplierId: input.supplierId,
      supplierName: input.supplierName,
      date: input.date,
      entryType: input.entryType,
      amount: input.amount,
      runningBalance,
      desc: input.desc,
      sourceType: input.sourceType || '',
      sourceId: input.sourceId || '',
      sourceRef: input.sourceRef || '',
      vaultEntryId: input.vaultEntryId || '',
      vaultTxNo: input.vaultTxNo || '',
      vaultSeg: input.vaultSeg || '',
      refNo: input.refNo || '',
      employee: input.employee || '',
      meta: input.meta ?? null,
    });
  }

  /** Called from TransactionsService.create() when a new مشتريات invoice is booked with an unpaid remainder. */
  async postPurchaseDebt(params: {
    supplierId: string;
    supplierName: string;
    transactionId: string;
    transactionRef: string;
    date: string;
    total: number;
    upfrontDeposit: number;
    employee: string;
  }): Promise<SupplierLedgerEntryDocument | null> {
    if (!params.supplierId) {
      this.logger.warn(
        `postPurchaseDebt skipped — no supplierId resolvable for transaction ${params.transactionRef}`,
      );
      return null;
    }
    const amount = Number(params.total) - Number(params.upfrontDeposit || 0);
    if (amount <= 0) return null;
    return this.postEntry({
      supplierId: params.supplierId,
      supplierName: params.supplierName,
      date: params.date,
      entryType: 'purchase-debt',
      amount,
      desc: `فاتورة مشتريات #${params.transactionRef} — ${params.supplierName}`,
      sourceType: 'transaction',
      sourceId: params.transactionId,
      sourceRef: params.transactionRef,
      employee: params.employee,
    });
  }

  /** Called from TransactionsService.collect() after a supplier payment is recorded. */
  async postPayment(params: {
    supplierId: string;
    supplierName: string;
    transactionId: string;
    transactionRef: string;
    date: string;
    amount: number;
    employee: string;
  }): Promise<SupplierLedgerEntryDocument | null> {
    if (!params.supplierId) {
      this.logger.warn(
        `postPayment skipped — no supplierId resolvable for transaction ${params.transactionRef}`,
      );
      return null;
    }
    const amount = Number(params.amount) || 0;
    if (amount <= 0) return null;
    return this.postEntry({
      supplierId: params.supplierId,
      supplierName: params.supplierName,
      date: params.date,
      entryType: 'payment',
      amount: -amount,
      desc: `سداد مشتريات #${params.transactionRef} — ${params.supplierName}`,
      sourceType: 'transaction',
      sourceId: params.transactionId,
      sourceRef: params.transactionRef,
      employee: params.employee,
    });
  }

  /**
   * Called from SupplierReturnsService.complete(). Posts up to 3 entries depending on the split:
   * debt-offset portion, credit portion, refund-paid audit row.
   */
  async postReturnSettlement(params: {
    supplierId: string;
    supplierName: string;
    returnId: string;
    returnNumber: string;
    date: string;
    debtOffsetAmount: number;
    creditAmount: number;
    refundAmount: number;
    vaultEntryId?: string;
    vaultTxNo?: string;
    /**
     * Ref of the مرتجع مشتريات transaction that moved the refund cash. The vault entry is created
     * deep inside TransactionsService, so the caller never holds it — resolving it here (this
     * service already injects VaultService) keeps SupplierReturnsService free of a VaultModule
     * dependency it does not otherwise need.
     */
    refundTxRef?: string;
    employee: string;
  }): Promise<ReturnSettlementResult> {
    const entries: SupplierLedgerEntryDocument[] = [];
    let refundVaultId = params.vaultEntryId || '';
    let refundVaultTxNo = params.vaultTxNo || '';
    if (params.refundAmount > 0 && !refundVaultTxNo && params.refundTxRef) {
      try {
        const ve = await this.vaultService.findLatestByRef(params.refundTxRef);
        if (ve) {
          refundVaultId = refundVaultId || String(ve._id);
          refundVaultTxNo = ve.txNo || '';
        }
      } catch (err) {
        // A missing back-reference must never fail the settlement — the money already moved.
        this.logger.warn(
          `Could not resolve the vault entry for refund ref ${params.refundTxRef}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (params.debtOffsetAmount > 0) {
      entries.push(
        await this.postEntry({
          supplierId: params.supplierId,
          supplierName: params.supplierName,
          date: params.date,
          entryType: 'return-debt-offset',
          amount: -params.debtOffsetAmount,
          desc: `مرتجع مورد ${params.returnNumber} — خصم من المديونية`,
          sourceType: 'supplier-return',
          sourceId: params.returnId,
          sourceRef: params.returnNumber,
          employee: params.employee,
        }),
      );
    }
    if (params.creditAmount > 0) {
      entries.push(
        await this.postEntry({
          supplierId: params.supplierId,
          supplierName: params.supplierName,
          date: params.date,
          entryType: 'return-credit',
          amount: -params.creditAmount,
          desc: `مرتجع مورد ${params.returnNumber} — رصيد آجل للمورد`,
          sourceType: 'supplier-return',
          sourceId: params.returnId,
          sourceRef: params.returnNumber,
          employee: params.employee,
        }),
      );
    }
    if (params.refundAmount > 0) {
      entries.push(
        await this.postEntry({
          supplierId: params.supplierId,
          supplierName: params.supplierName,
          date: params.date,
          entryType: 'refund-paid',
          amount: 0,
          desc: `مرتجع مورد ${params.returnNumber} — رد نقدي (${params.refundAmount} ج)`,
          sourceType: 'supplier-return',
          sourceId: params.returnId,
          sourceRef: params.returnNumber,
          // بلا هذين الحقلين يصبح هذا الصف بلا رقم ولا مبلغ في العمودين (قيمته صفر
          // لأن المرتجع خصم المديونية قبله) — سطر يقول «تحرّكت نقدية» بلا أي أثر يُتحقق منه.
          vaultEntryId: refundVaultId,
          vaultTxNo: refundVaultTxNo,
          employee: params.employee,
          meta: { refundAmount: params.refundAmount },
        }),
      );
    }
    const balanceAfter = await this.getCurrentBalance(params.supplierId);
    return {
      entries,
      debtOffsetAmount: params.debtOffsetAmount,
      creditAmount: params.creditAmount,
      refundAmount: params.refundAmount,
      balanceAfter,
    };
  }

  /** Consumed against a NEW purchase using standing supplier credit. Not called anywhere yet in Phase 1 (Phase 2 wires this into purchase creation), but must exist and be usable. */
  async postCreditUsed(params: {
    supplierId: string;
    supplierName: string;
    transactionId: string;
    transactionRef: string;
    date: string;
    amount: number;
    employee: string;
  }): Promise<SupplierLedgerEntryDocument | null> {
    const amount = Number(params.amount) || 0;
    if (amount <= 0) return null;
    return this.postEntry({
      supplierId: params.supplierId,
      supplierName: params.supplierName,
      date: params.date,
      entryType: 'credit-used',
      amount,
      desc: `استخدام رصيد آجل في فاتورة مشتريات #${params.transactionRef}`,
      sourceType: 'transaction',
      sourceId: params.transactionId,
      sourceRef: params.transactionRef,
      employee: params.employee,
    });
  }

  /**
   * Supplier balance adjustment (advance deposit / debit charge).
   *
   * A 'deposit' is cash actually paid to the supplier ahead of any invoice: it withdraws from the
   * chosen vault segment AND reduces the payable balance (going negative = standing credit, which
   * `getBalanceSummary().credit` then exposes and purchase creation can apply via creditApplied).
   * A 'debit' is cash-neutral and increases what we owe.
   *
   * Ordering matters: the vault withdrawal runs FIRST, so if the segment lacks funds
   * (VaultService.addEntry throws) no ledger entry is posted and no phantom credit appears. The
   * reverse order could credit a supplier with money that never left the vault. Since the codebase
   * has no cross-collection transaction infra, a failure in the second step is compensated by
   * rolling the vault entry back explicitly rather than left inconsistent.
   */
  async postBalanceAdjustment(params: {
    supplierId: string;
    supplierName: string;
    kind: 'deposit' | 'debit';
    amount: number;
    date: string;
    desc: string;
    refNo?: string;
    vaultSeg?: string;
    employee: string;
  }): Promise<SupplierLedgerEntryDocument> {
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('قيمة التسوية غير صالحة');
    }
    if (!params.desc || !params.desc.trim()) {
      throw new BadRequestException('يجب إدخال وصف التسوية');
    }

    const isDeposit = params.kind === 'deposit';
    let vaultEntryId = '';
    let vaultTxNo = '';

    if (isDeposit) {
      if (!params.vaultSeg) {
        throw new BadRequestException('يجب تحديد مصدر السيولة للعربون');
      }
      const vaultEntry = await this.vaultService.addEntry(
        {
          amount: -amount, // negative = withdrawal; addEntry enforces sufficiency itself
          seg: params.vaultSeg,
          method: SR_VAULT_SEG_LABELS[params.vaultSeg] || params.vaultSeg,
          date: params.date,
          desc: `عربون/دفعة مقدمة لمورد ${params.supplierName}${params.refNo ? ` — مرجع ${params.refNo}` : ''}`,
          accountingJustification: params.desc,
          entityLabel: params.supplierName,
        },
        params.employee,
      );
      vaultEntryId = String(vaultEntry._id);
      vaultTxNo = vaultEntry.txNo || '';
    }

    try {
      return await this.postEntry({
        supplierId: params.supplierId,
        supplierName: params.supplierName,
        date: params.date,
        entryType: isDeposit ? 'advance-deposit' : 'debit-adjustment',
        // Deposit reduces the payable balance (may push it negative = standing credit);
        // debit increases it.
        amount: isDeposit ? -amount : amount,
        desc: isDeposit
          ? `عربون/دفعة مقدمة — ${params.desc}`
          : `خصم على الحساب — ${params.desc}`,
        sourceType: 'manual',
        sourceRef: params.refNo || '',
        vaultEntryId,
        vaultTxNo,
        vaultSeg: isDeposit ? params.vaultSeg || '' : '',
        refNo: params.refNo || '',
        employee: params.employee,
      });
    } catch (err) {
      // Compensate the already-committed vault withdrawal so cash and ledger don't diverge.
      if (vaultEntryId) {
        try {
          await this.vaultService.cancelEntry(
            vaultEntryId,
            params.employee,
            'فشل تسجيل قيد العربون في دفتر المورد — تم استرجاع المبلغ',
          );
        } catch (rollbackErr) {
          this.logger.error(
            `CRITICAL: supplier ${params.supplierId} vault withdrawal ${vaultEntryId} (${amount} ج) succeeded but the ledger entry failed AND the rollback failed — vault and supplier ledger are now inconsistent, manual correction required.`,
            rollbackErr instanceof Error ? rollbackErr.stack : String(rollbackErr),
          );
        }
      }
      throw err;
    }
  }

  /**
   * The supplier waived the unpaid remainder of ONE invoice — a credit memo, not an edit.
   *
   * Why this is not `update()`-ing the invoice total: a purchase invoice is a document exchanged
   * with the supplier. Rewriting its total makes our copy disagree with theirs and hides the reason
   * inside a changed number. Every real AP system issues a separate credit note instead, which is
   * what this is: the invoice keeps its original value, this entry cancels the outstanding part, and
   * the invoice closes.
   *
   * Distinct entryType (not 'manual-adjustment') so the statement can label it correctly and so the
   * write-off is traceable to its invoice via sourceId/sourceRef.
   */
  async postInvoiceWriteOff(params: {
    supplierId: string;
    supplierName: string;
    transactionId: string;
    transactionRef: string;
    date: string;
    amount: number;
    reason: string;
    employee: string;
  }): Promise<SupplierLedgerEntryDocument> {
    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('قيمة الإقفال غير صالحة');
    }
    if (!params.reason || !params.reason.trim()) {
      throw new BadRequestException('يجب إدخال سبب إقفال المتبقي');
    }
    return this.postEntry({
      supplierId: params.supplierId,
      supplierName: params.supplierName,
      date: params.date,
      entryType: 'invoice-write-off',
      amount: -amount, // reduces the payable
      desc: `إقفال متبقي فاتورة #${params.transactionRef} — ${params.reason}`,
      sourceType: 'transaction',
      sourceId: params.transactionId,
      sourceRef: params.transactionRef,
      employee: params.employee,
      meta: { writeOffAmount: amount, reason: params.reason },
    });
  }

  /** Admin-only manual correction, always requires a reason. */
  async postManualAdjustment(params: {
    supplierId: string;
    supplierName: string;
    date: string;
    amount: number;
    reason: string;
    employee: string;
  }): Promise<SupplierLedgerEntryDocument> {
    if (!params.reason || !params.reason.trim()) {
      throw new BadRequestException('يجب إدخال سبب التعديل اليدوي');
    }
    if (!Number.isFinite(params.amount) || params.amount === 0) {
      throw new BadRequestException('قيمة التعديل غير صالحة');
    }
    return this.postEntry({
      supplierId: params.supplierId,
      supplierName: params.supplierName,
      date: params.date,
      entryType: 'manual-adjustment',
      amount: params.amount,
      desc: `تعديل يدوي: ${params.reason}`,
      sourceType: 'manual',
      employee: params.employee,
    });
  }

  /**
   * Reverses every not-yet-reversed ledger entry originally posted by postReturnSettlement() for
   * one supplier return. Built on reverseEntry() (called once per row) so runningBalance
   * bookkeeping stays in the single existing place. Filtering reversed:{$ne:true} makes this safe
   * to re-invoke on a partially-reversed set — it only reverses what's left, never errors on
   * already-reversed rows — which is what makes SupplierReturnsService.reverseReturn() retryable.
   */
  async reverseReturnSettlement(params: {
    returnId: string;
    by: string;
    reason: string;
  }): Promise<{
    reversedEntries: SupplierLedgerEntryDocument[];
    balanceAfter: number;
    supplierId: string;
  }> {
    const originals = await this.ledgerModel
      .find({
        sourceType: 'supplier-return',
        sourceId: params.returnId,
        reversed: { $ne: true },
      })
      .sort({ createdAt: 1 })
      .exec();
    const reversedEntries: SupplierLedgerEntryDocument[] = [];
    for (const original of originals) {
      reversedEntries.push(
        await this.reverseEntry(String(original._id), params.by, params.reason),
      );
    }
    const supplierId = originals[0]?.supplierId ?? '';
    const balanceAfter = supplierId ? await this.getCurrentBalance(supplierId) : 0;
    return { reversedEntries, balanceAfter, supplierId };
  }

  /** Reversal helper — posts a compensating entry and flags the original as reversed. */
  async reverseEntry(
    entryId: string,
    by: string,
    reason: string,
  ): Promise<SupplierLedgerEntryDocument> {
    const original = await this.ledgerModel.findById(entryId).exec();
    if (!original) {
      throw new BadRequestException('قيد الدفتر غير موجود');
    }
    if (original.reversed) {
      throw new BadRequestException('تم عكس هذا القيد بالفعل');
    }
    const reversal = await this.postEntry({
      supplierId: original.supplierId,
      supplierName: original.supplierName,
      date: new Date().toISOString(),
      entryType: 'manual-adjustment',
      amount: -original.amount,
      desc: `عكس قيد: ${original.desc}${reason ? ' — ' + reason : ''}`,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      sourceRef: original.sourceRef,
      employee: by,
      meta: { reversalOf: String(original._id) },
    });
    original.reversed = true;
    await original.save();
    reversal.reversalOfEntryId = String(original._id);
    await reversal.save();
    return reversal;
  }
}
