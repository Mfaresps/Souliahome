import {
  Injectable,
  Logger,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CarrierImport,
  CarrierImportDocument,
} from './schemas/carrier-import.schema';
import {
  Transaction,
  TransactionDocument,
} from './schemas/transaction.schema';
import { TransactionsService } from './transactions.service';
import { CarrierStatementService, AnalyzeResult, ParsedRow } from './carrier-statement.service';
import { AMOUNT_TOLERANCE } from '../shared/carrier-statement.constants';

/**
 * Turns a reviewed settlement file into actual collections.
 *
 * ── THE ONE ARCHITECTURAL RULE ────────────────────────────────────────────────────────────────
 * ⚠ EVERY ROW IS SETTLED BY CALLING `TransactionsService.collect()`. This service never writes a
 *   vault entry, never touches `deposit`/`remaining`/`payStatus`, and never pushes a `payments[]`
 *   row itself.
 *
 *   That is not a stylistic preference. `collect()` already owns: the vault posting, the COD
 *   status advance, the `payments[]` audit row and — critically — the `snapshotBefore` that makes
 *   «تراجع» work. A second settlement path that hand-rolled those would be a second place for the
 *   vault to drift from reality, and imported collections would be the ones that cannot be undone.
 *   Because we go through `collect()`, an imported collection reverses exactly like a manual one,
 *   with no new code.
 *
 *   This is the same lesson already recorded in CLAUDE.md about `ShopifyService.approveOrder`
 *   writing transactions straight to `txModel` and thereby skipping every inventory-movement row.
 *   Do not add a direct write here.
 *
 * ── WHY THE FILE IS RE-PARSED AT CONFIRM TIME ─────────────────────────────────────────────────
 * The client sends back the file, not the parsed rows. Trusting a client-supplied row list would
 * let a crafted request settle any invoice for any amount — the review screen is a convenience,
 * never the authority. Re-parsing also means the preview and the settlement provably agree,
 * because they run the identical classifier.
 */

export interface SettleSelection {
  /** Sheet row numbers the user ticked. Only these are considered. */
  rows: number[];
  /** Vault account the cash is posted to. */
  collectMethod: string;
  note?: string;
  /** Set true to proceed even though this exact file was imported before. */
  acknowledgeDuplicate?: boolean;
}

export interface SettleResult {
  importNo: string;
  /** Vault the cash was posted to — the result screen names it, so it must round-trip. */
  collectMethod: string;
  settled: number;
  failed: number;
  skipped: number;
  totalCod: number;
  totalFees: number;
  totalVault: number;
  totalVariance: number;
  rows: {
    row: number;
    ref: string;
    ok: boolean;
    vaultAmount: number;
    error: string;
  }[];
  warnings: string[];
}

/** A single run's ceiling. Well above a real payout, low enough to bound a mistake. */
const MAX_SETTLE_ROWS = 1000;

@Injectable()
export class CarrierSettlementService {
  private readonly logger = new Logger(CarrierSettlementService.name);

  constructor(
    @InjectModel(CarrierImport.name)
    private readonly importModel: Model<CarrierImportDocument>,
    @InjectModel(Transaction.name)
    private readonly txModel: Model<TransactionDocument>,
    private readonly statementService: CarrierStatementService,
    @Inject(forwardRef(() => TransactionsService))
    private readonly transactionsService: TransactionsService,
  ) {}

  /**
   * Preview only. Adds the re-upload warning that `analyze()` cannot know about, since only this
   * service can see previous imports.
   */
  async preview(buffer: Buffer, fileName: string, carrier: string): Promise<
    AnalyzeResult & { previousImport?: { importNo: string; at: string; settled: number } }
  > {
    const result = await this.statementService.analyze(buffer, fileName, carrier);
    const prior = await this.importModel
      .findOne({ fileHash: result.fileHash })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    if (prior) {
      const at = String((prior as any).createdAt || (prior as any).date || '');
      result.warnings.unshift(
        `⚠ هذا الملف تم رفعه من قبل (${(prior as any).importNo}) وتم تحصيل ${
          (prior as any).rowsSettled || 0
        } صف منه — راجع النتيجة قبل المتابعة`,
      );
      return {
        ...result,
        previousImport: {
          importNo: (prior as any).importNo,
          at,
          settled: (prior as any).rowsSettled || 0,
        },
      };
    }
    return result;
  }

  /**
   * Settles the selected rows.
   *
   * Rows are processed ONE AT A TIME and a failure never aborts the run: some rows will have moved
   * cash before a later one fails, and reporting a single pass/fail for the batch would hide that.
   * Every outcome — settled, skipped or failed with its reason — is recorded on the import.
   */
  async settle(
    buffer: Buffer,
    fileName: string,
    carrier: string,
    sel: SettleSelection,
    by: string,
    callerRole: string,
    callerPerms: string[],
  ): Promise<SettleResult> {
    if (!sel?.collectMethod) {
      throw new BadRequestException('اختر الخزنة التي سيُضاف إليها المبلغ');
    }
    const wanted = [...new Set((sel.rows || []).map(Number).filter((n) => n > 0))];
    if (!wanted.length) throw new BadRequestException('لم يتم اختيار أي صف للتحصيل');
    if (wanted.length > MAX_SETTLE_ROWS) {
      throw new BadRequestException(
        `عدد الصفوف المختارة (${wanted.length}) أكبر من الحد المسموح (${MAX_SETTLE_ROWS})`,
      );
    }

    // ⚠ Re-parsed from the uploaded bytes, never taken from the client. See the class comment.
    const analysis = await this.statementService.analyze(buffer, fileName, carrier);

    // Re-upload guard. Refuses by default; proceeding is an explicit, logged decision.
    const prior = await this.importModel
      .findOne({ fileHash: analysis.fileHash })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    if (prior && !sel.acknowledgeDuplicate) {
      throw new BadRequestException(
        `هذا الملف تم رفعه من قبل باسم ${(prior as any).importNo} — أكّد الرفع المتكرر للمتابعة`,
      );
    }

    const byRow = new Map<number, ParsedRow>(analysis.rows.map((r) => [r.row, r]));
    const warnings = [...analysis.warnings];
    const outRows: SettleResult['rows'] = [];
    const recorded: any[] = [];

    let settled = 0;
    let failed = 0;
    let skipped = 0;
    let totalCod = 0;
    let totalFees = 0;
    let totalVault = 0;
    let totalVariance = 0;

    for (const rowNo of wanted) {
      const p = byRow.get(rowNo);
      if (!p) {
        skipped++;
        outRows.push({ row: rowNo, ref: '', ok: false, vaultAmount: 0, error: 'الصف غير موجود في الملف' });
        continue;
      }

      // A status that is not settleable was either never selectable or the user forced it. Either
      // way the classifier's verdict wins — the review screen is not an override.
      if (p.status !== 'matched' || !p.txId) {
        skipped++;
        recorded.push(this.toRow(p, false, 0, p.note || 'الصف غير قابل للتحصيل'));
        outRows.push({
          row: rowNo,
          ref: p.ref,
          ok: false,
          vaultAmount: 0,
          error: p.note || 'الصف غير قابل للتحصيل',
        });
        continue;
      }

      // ⚠ RE-VALIDATION AGAINST THE LIVE DOCUMENT, not the parsed snapshot.
      //   The review screen may have been open for a long time, and a colleague may have collected
      //   the same order manually in the meantime. Settling on the stale snapshot would double-post
      //   to the vault. This is the check that makes the preview safe to leave open.
      const live: any = await this.txModel.findById(p.txId).lean().exec();
      if (!live) {
        failed++;
        recorded.push(this.toRow(p, false, 0, 'المعاملة لم تعد موجودة'));
        outRows.push({ row: rowNo, ref: p.ref, ok: false, vaultAmount: 0, error: 'المعاملة لم تعد موجودة' });
        continue;
      }
      const liveRemaining = Number(live.remaining) || 0;
      if (live.cancelled || live.payStatus === 'مكتمل' || liveRemaining <= 0) {
        skipped++;
        const why = live.cancelled ? 'المعاملة أُلغيت' : 'تم تحصيلها بالفعل';
        recorded.push(this.toRow(p, false, 0, `${why} — تغيّرت الحالة بعد المعاينة`));
        outRows.push({ row: rowNo, ref: p.ref, ok: false, vaultAmount: 0, error: `${why} بعد المعاينة` });
        continue;
      }
      if (Math.abs((p.cod ?? 0) - liveRemaining) > AMOUNT_TOLERANCE) {
        skipped++;
        const why = `تغيّر المتبقي بعد المعاينة (${liveRemaining} ج) ولا يطابق المحصَّل (${p.cod} ج)`;
        recorded.push(this.toRow(p, false, 0, why));
        outRows.push({ row: rowNo, ref: p.ref, ok: false, vaultAmount: 0, error: why });
        continue;
      }

      // ── Settle through the one authoritative path ──────────────────────────────────────────
      try {
        const saved: any = await this.transactionsService.collect(
          p.txId,
          {
            collectMethod: sel.collectMethod,
            collectNote: this.rowNote(p, sel.note),
            collectAmount: p.cod ?? 0,
            // The carrier's real deduction. `collect()` books the excess over the billed tariff to
            // `shipLoss` — which is exactly the manual «تكلفة الشحن الفعلية» field this replaces.
            actualShipCost: p.totalFees ?? 0,
          } as any,
          by,
          callerRole,
          callerPerms,
        );

        const lastPay = (saved?.payments || [])[(saved?.payments || []).length - 1] || {};
        const vaultAmount = Number(lastPay.amount) || 0;

        settled++;
        totalCod += p.cod ?? 0;
        totalFees += p.totalFees ?? 0;
        totalVault += vaultAmount;
        totalVariance += p.shipVariance ?? 0;

        recorded.push(this.toRow(p, true, vaultAmount, ''));
        outRows.push({ row: rowNo, ref: p.ref, ok: true, vaultAmount, error: '' });
      } catch (err: any) {
        // One row failing must never stop the rest: earlier rows have already moved real cash.
        failed++;
        const msg = String(err?.message || 'فشل التحصيل');
        this.logger.warn(`carrier-settle row ${rowNo} ref=${p.ref} failed: ${msg}`);
        recorded.push(this.toRow(p, false, 0, msg));
        outRows.push({ row: rowNo, ref: p.ref, ok: false, vaultAmount: 0, error: msg });
      }
    }

    // Unselected rows are recorded too — a fee-only deduction or a conflict is evidence, and the
    // carrier-audit report reads it from here.
    for (const p of analysis.rows) {
      if (wanted.includes(p.row)) continue;
      recorded.push(this.toRow(p, false, 0, p.note));
    }

    const round = (n: number) => Math.round(n * 100) / 100;
    const importNo = await this.nextImportNo();

    const doc = await this.importModel.create({
      importNo,
      carrier,
      fileName,
      fileHash: analysis.fileHash,
      sheet: analysis.sheet,
      collectMethod: sel.collectMethod,
      by,
      rowsRead: analysis.totalRows,
      rowsMatched: analysis.rows.filter((r) => r.status === 'matched').length,
      rowsSettled: settled,
      rowsFailed: failed,
      rowsSkipped: skipped,
      totalCod: round(totalCod),
      totalFees: round(totalFees),
      totalVault: round(totalVault),
      totalVariance: round(totalVariance),
      feeOnlyCount: analysis.summary.feeOnlyCount,
      feeOnlyAmount: analysis.summary.feeOnlyAmount,
      rows: recorded,
      warnings,
      date: new Date().toISOString().split('T')[0],
    });

    this.logger.log(
      `carrier-settle ${importNo} — settled=${settled} failed=${failed} skipped=${skipped} vault=${round(
        totalVault,
      )} by=${by}`,
    );

    return {
      importNo: doc.importNo,
      collectMethod: sel.collectMethod,
      settled,
      failed,
      skipped,
      totalCod: round(totalCod),
      totalFees: round(totalFees),
      totalVault: round(totalVault),
      totalVariance: round(totalVariance),
      rows: outRows,
      warnings,
    };
  }

  /**
   * The note stamped on the transaction's `payments[]` row.
   *
   * ⚠ This string is what classifies a collection as imported in سجل التحصيلات. It carries the
   *   import number so a payment can be traced back to the file that produced it — otherwise an
   *   imported collection is indistinguishable from a manual one after the fact.
   */
  private rowNote(p: ParsedRow, extra?: string): string {
    const parts = [`تحصيل من ملف شركة الشحن — صف ${p.row}`];
    if (p.totalFees) parts.push(`خصم الشركة ${p.totalFees} ج`);
    if (p.shipVariance && p.shipVariance > 0) parts.push(`زيادة عن التعريفة ${p.shipVariance} ج`);
    if (extra) parts.push(extra);
    return parts.join(' — ');
  }

  private toRow(p: ParsedRow, settled: boolean, vaultAmount: number, error: string) {
    return {
      row: p.row,
      ref: p.ref,
      tracking: p.tracking,
      status: p.status,
      matchedBy: p.matchedBy,
      txId: p.txId || '',
      txRef: p.txRef || '',
      client: p.txClient || p.customerName || '',
      cod: p.cod ?? 0,
      totalFees: p.totalFees ?? 0,
      netValue: p.netValue ?? 0,
      fees: {
        shipping: p.fees.shipping ?? 0,
        insurance: p.fees.insurance ?? 0,
        vat: p.fees.vat ?? 0,
        codFees: p.fees.codFees ?? 0,
      },
      billedShip: p.txShipCost ?? 0,
      shipVariance: p.shipVariance ?? 0,
      varianceLevel: p.varianceLevel || 'ok',
      city: p.dropoffCity || '',
      identityMismatch: !!p.identityMismatch,
      settled,
      vaultAmount,
      error,
      note: p.note,
    };
  }

  /**
   * Next operation number. Derived from the highest existing one rather than a document count, so
   * a deleted record can never cause a number to be reused.
   */
  private async nextImportNo(): Promise<string> {
    const last = await this.importModel
      .findOne({})
      .sort({ importNo: -1 })
      .select('importNo')
      .lean()
      .exec();
    const n = last ? Number(String((last as any).importNo).replace(/\D/g, '')) || 0 : 0;
    return `IMP-${String(n + 1).padStart(3, '0')}`;
  }

  /** Import history, newest first. Rows are omitted — the list view never needs them. */
  async list(limit = 50): Promise<any[]> {
    return this.importModel
      .find({})
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(1, limit), 200))
      .select('-rows')
      .lean()
      .exec();
  }

  /** One import with every row and its outcome. */
  async getOne(importNo: string): Promise<any> {
    return this.importModel.findOne({ importNo }).lean().exec();
  }
}
