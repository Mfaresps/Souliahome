import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as ExcelJS from 'exceljs';
import * as crypto from 'crypto';
import {
  Transaction,
  TransactionDocument,
} from './schemas/transaction.schema';
import {
  CarrierStatementFormat,
  MatchKey,
  RowStatus,
  statementFormat,
  normalizeHeader,
  normalizeRef,
  normalizeTracking,
  normalizePhone,
  namesLookAlike,
  parseMoney,
  varianceLevel,
  NET_VALUE_TOLERANCE,
  AMOUNT_TOLERANCE,
  AUTO_SELECTABLE,
} from '../shared/carrier-statement.constants';

/**
 * Reads a carrier's settlement file and says what it MEANS. It never settles anything.
 *
 * ⚠ THIS SERVICE IS READ-ONLY BY DESIGN. It opens no vault entry, writes no transaction and
 *   mutates nothing. Settlement is a separate, explicit step that runs through
 *   `TransactionsService.collect()` — the one place that already owns the vault entry, the
 *   `payments[]` audit row and the `snapshotBefore` that makes an undo possible.
 *
 *   That split is the core safety property of the whole feature: parsing and previewing a file is
 *   free of consequence, so a user can upload, look, close, and upload again without ever having
 *   moved money by accident. Do not add a write to this file — add it to the settlement step,
 *   where the guards and the audit trail already live.
 *
 * The output of `analyze()` is what the review screen renders and what the «تم التعرف» summary
 * is built from: the file's own arithmetic re-checked, every row classified, and — critically —
 * an explicit statement of which spreadsheet column was read as which field, so a mis-mapped
 * column is visible while it is still only a claim on screen rather than after the cash has moved.
 */

/** One row of the carrier's file, matched and classified. */
export interface ParsedRow {
  /** 1-based row number in the sheet, so a message can point at the actual line. */
  row: number;
  ref: string;
  tracking: string;
  carrierStatus: string;
  /** Cash the carrier says it collected from the customer. */
  cod: number | null;
  /** Everything the carrier deducted (shipping + insurance + VAT + …). */
  totalFees: number | null;
  /** The carrier's own figure for what reaches us. Used as a proof line, never as an input. */
  netValue: number | null;
  fees: {
    shipping: number | null;
    insurance: number | null;
    vat: number | null;
    codFees: number | null;
  };
  customerName: string;
  customerPhone: string;
  dropoffCity: string;
  deliveredAt: string;
  payoutId: string;

  status: RowStatus;
  matchedBy: MatchKey;
  /** Populated only when matched. */
  txId?: string;
  txRef?: string;
  txClient?: string;
  txRemaining?: number;
  /** What we billed the customer for shipping — the tariff frozen on the transaction. */
  txShipCost?: number;
  /**
   * The carrier took more than we billed. This is the audit signal, and the reason the whole
   * carrier-variance report exists. Negative差 is kept as 0 — being undercharged is not a finding.
   */
  shipVariance?: number;
  varianceLevel?: 'ok' | 'notable' | 'high';
  /**
   * Name/phone on the file disagree with the matched transaction. NOT a match key — a flag that
   * the REFERENCE may be wrong. See MatchKey in carrier-statement.constants.ts.
   */
  identityMismatch?: boolean;
  /** Pre-ticked in the review screen. Only ever true for AUTO_SELECTABLE statuses. */
  selectable: boolean;
  suggested: boolean;
  /** Human-readable reason, shown on the row. */
  note: string;
}

export interface ColumnMapReport {
  field: string;
  ar: string;
  header: string | null;
  column: number | null;
}

export interface AnalyzeResult {
  ok: boolean;
  carrier: string;
  fileName: string;
  /** SHA-256 of the uploaded bytes — the re-upload guard. */
  fileHash: string;
  sheet: string;
  totalRows: number;
  /** What we read as what. The «تم التعرف» message is rendered from this. */
  columns: ColumnMapReport[];
  unresolved: string[];
  /** Rows whose own arithmetic (COD − fees === net) did not reconcile. */
  proofFailures: number;
  rows: ParsedRow[];
  summary: {
    byStatus: Record<string, { count: number; amount: number }>;
    /** Cash that would enter the vault if every suggested row were settled. */
    suggestedCount: number;
    suggestedCod: number;
    suggestedFees: number;
    suggestedNet: number;
    /** Fees deducted with nothing collected — money leaving on returned shipments. */
    feeOnlyCount: number;
    feeOnlyAmount: number;
    highVarianceCount: number;
    varianceTotal: number;
  };
  warnings: string[];
}

/** Hard ceilings. A settlement file is tens-to-hundreds of rows; anything past this is a mistake. */
const MAX_ROWS = 5000;
const MAX_BYTES = 10 * 1024 * 1024;

@Injectable()
export class CarrierStatementService {
  private readonly logger = new Logger(CarrierStatementService.name);

  constructor(
    @InjectModel(Transaction.name)
    private readonly txModel: Model<TransactionDocument>,
  ) {}

  /**
   * Parses and classifies. Pure with respect to the database: it only ever READS transactions.
   */
  async analyze(
    buffer: Buffer,
    fileName: string,
    carrier = 'bosta',
  ): Promise<AnalyzeResult> {
    if (!buffer?.length) throw new BadRequestException('الملف فارغ');
    if (buffer.length > MAX_BYTES) {
      throw new BadRequestException('حجم الملف أكبر من الحد المسموح (10 ميجابايت)');
    }

    const fmt = statementFormat(carrier);
    if (!fmt) {
      throw new BadRequestException(`لا يوجد تنسيق معروف لملفات شركة الشحن «${carrier}»`);
    }

    const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const warnings: string[] = [];

    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as any);
    } catch {
      throw new BadRequestException(
        'تعذّر قراءة الملف — تأكد أنه ملف Excel صالح (.xlsx) وغير تالف',
      );
    }

    const ws =
      fmt.sheets.map((s) => wb.getWorksheet(s)).find(Boolean) || wb.worksheets[0];
    if (!ws) throw new BadRequestException('الملف لا يحتوي على أي صفحات');

    // ── Header recognition ────────────────────────────────────────────────────────────────────
    // A file is only accepted as this carrier's when every `required` header is present. Guessing
    // past a missing settlement column would mean settling on a number we invented.
    const headerRow = ws.getRow(1);
    const idx: Record<string, number> = {};
    for (let c = 1; c <= ws.columnCount; c++) {
      const h = normalizeHeader(headerRow.getCell(c).text);
      if (h && !(h in idx)) idx[h] = c;
    }
    const missing = fmt.required.filter((r) => !(r in idx));
    if (missing.length) {
      throw new BadRequestException(
        `الملف لا يبدو ملف تسوية ${carrier} — أعمدة مفقودة: ${missing.join('، ')}`,
      );
    }

    const pick = (names: string[]): number | null => {
      for (const n of names) if (n in idx) return idx[n];
      return null;
    };
    const headerOf = (c: number | null) =>
      c ? String(headerRow.getCell(c).text || '').trim() : null;

    const C = {
      ref: pick(fmt.columns.ref),
      tracking: pick(fmt.columns.tracking),
      status: pick(fmt.columns.status),
      cod: pick(fmt.columns.cod),
      totalFees: pick(fmt.columns.totalFees),
      netValue: pick(fmt.columns.netValue),
      shipping: pick(fmt.columns.shippingFees),
      insurance: pick(fmt.columns.insuranceFees),
      vat: pick(fmt.columns.vat),
      codFees: pick(fmt.columns.codFees),
      name: pick(fmt.columns.customerName),
      phone: pick(fmt.columns.customerPhone),
      city: pick(fmt.columns.dropoffCity),
      deliveredAt: pick(fmt.columns.deliveredAt),
      payoutId: pick(fmt.columns.payoutId),
    };

    const LABELS: Record<string, string> = {
      ref: 'رقم المرجع',
      tracking: 'رقم التتبع',
      status: 'حالة الشحنة',
      cod: 'المبلغ المحصَّل',
      totalFees: 'إجمالي الخصم',
      netValue: 'الصافي',
      shipping: 'رسوم الشحن',
      insurance: 'رسوم التأمين',
      vat: 'الضريبة',
      codFees: 'رسوم التحصيل',
      name: 'اسم العميل',
      phone: 'هاتف العميل',
      city: 'المحافظة',
      deliveredAt: 'تاريخ التسليم',
      payoutId: 'رقم التسوية',
    };
    const columns: ColumnMapReport[] = Object.entries(C).map(([field, col]) => ({
      field,
      ar: LABELS[field] || field,
      header: headerOf(col),
      column: col,
    }));
    const unresolved = columns.filter((c) => !c.column).map((c) => c.ar);

    // ── Read rows ─────────────────────────────────────────────────────────────────────────────
    const raw: ParsedRow[] = [];
    const lastRow = Math.min(ws.rowCount, MAX_ROWS + 1);
    if (ws.rowCount > MAX_ROWS + 1) {
      warnings.push(
        `الملف يحتوي على ${ws.rowCount - 1} صف — تمت قراءة أول ${MAX_ROWS} فقط`,
      );
    }

    const txt = (r: ExcelJS.Row, c: number | null) =>
      c ? String(r.getCell(c).text ?? '').trim() : '';

    for (let r = 2; r <= lastRow; r++) {
      const row = ws.getRow(r);
      const ref = normalizeRef(txt(row, C.ref));
      const tracking = normalizeTracking(txt(row, C.tracking));
      const cod = parseMoney(txt(row, C.cod));
      const totalFees = parseMoney(txt(row, C.totalFees));
      const netValue = parseMoney(txt(row, C.netValue));

      // A row with no identifier at all is blank padding, not data.
      if (!ref && !tracking && cod === null && totalFees === null) continue;

      raw.push({
        row: r,
        ref,
        tracking,
        carrierStatus: txt(row, C.status),
        cod,
        totalFees,
        netValue,
        fees: {
          shipping: parseMoney(txt(row, C.shipping)),
          insurance: parseMoney(txt(row, C.insurance)),
          vat: parseMoney(txt(row, C.vat)),
          codFees: parseMoney(txt(row, C.codFees)),
        },
        customerName: txt(row, C.name),
        customerPhone: txt(row, C.phone),
        dropoffCity: txt(row, C.city),
        deliveredAt: txt(row, C.deliveredAt),
        payoutId: txt(row, C.payoutId),
        status: 'invalid',
        matchedBy: 'none',
        selectable: false,
        suggested: false,
        note: '',
      });
    }

    // ── Duplicate identifiers WITHIN the file ─────────────────────────────────────────────────
    // Two rows naming the same shipment would settle it twice in one run. Caught before matching,
    // because after matching they would look like two perfectly valid rows.
    // ⚠ EVERY row of a duplicate set is flagged, including the FIRST one. Marking only the later
    //   copies would leave the first `matched` and pre-ticked — i.e. the file is internally
    //   ambiguous about a shipment and we would quietly settle one interpretation of it. Which
    //   copy is authoritative is a question only a human can answer, so none of them is suggested.
    const seenRef = new Map<string, number>();
    const seenTrk = new Map<string, number>();
    const dupRows = new Set<number>();
    const flagBoth = (first: number | undefined, current: number) => {
      if (first !== undefined) dupRows.add(first);
      dupRows.add(current);
    };
    for (const p of raw) {
      if (p.ref) {
        if (seenRef.has(p.ref)) flagBoth(seenRef.get(p.ref), p.row);
        else seenRef.set(p.ref, p.row);
      }
      if (p.tracking) {
        if (seenTrk.has(p.tracking)) flagBoth(seenTrk.get(p.tracking), p.row);
        else seenTrk.set(p.tracking, p.row);
      }
    }

    // ── Resolve transactions in bulk ──────────────────────────────────────────────────────────
    const refs = [...new Set(raw.map((p) => p.ref).filter(Boolean))];
    const trks = [...new Set(raw.map((p) => p.tracking).filter(Boolean))];
    const docs = refs.length || trks.length
      ? await this.txModel
          .find({
            $or: [
              ...(refs.length ? [{ ref: { $in: refs } }] : []),
              ...(trks.length ? [{ bostaTrackingNumber: { $in: trks } }] : []),
            ],
          })
          .lean()
          .exec()
      : [];

    const byRef = new Map<string, any>();
    const byTrk = new Map<string, any>();
    for (const d of docs as any[]) {
      const rf = normalizeRef(d.ref);
      if (rf && !byRef.has(rf)) byRef.set(rf, d);
      const tk = normalizeTracking(d.bostaTrackingNumber);
      if (tk && !byTrk.has(tk)) byTrk.set(tk, d);
    }

    // ── Classify ──────────────────────────────────────────────────────────────────────────────
    for (const p of raw) {
      this.classify(p, byRef, byTrk, dupRows, fmt);
    }

    // ── Summarise ─────────────────────────────────────────────────────────────────────────────
    const byStatus: Record<string, { count: number; amount: number }> = {};
    let suggestedCount = 0;
    let suggestedCod = 0;
    let suggestedFees = 0;
    let feeOnlyCount = 0;
    let feeOnlyAmount = 0;
    let highVarianceCount = 0;
    let varianceTotal = 0;
    let proofFailures = 0;

    for (const p of raw) {
      const b = (byStatus[p.status] ||= { count: 0, amount: 0 });
      b.count++;
      b.amount += p.cod ?? 0;
      if (p.suggested) {
        suggestedCount++;
        suggestedCod += p.cod ?? 0;
        suggestedFees += p.totalFees ?? 0;
      }
      if (p.status === 'fee_only') {
        feeOnlyCount++;
        feeOnlyAmount += p.totalFees ?? 0;
      }
      if (p.shipVariance && p.shipVariance > 0) varianceTotal += p.shipVariance;
      // Includes fee_only rows: their variance is real cost even though nothing is collected.
      if (p.varianceLevel === 'high') highVarianceCount++;
      if (p.note.includes('لا يطابق الصافي')) proofFailures++;
    }

    // ⚠ Deliberately NOT pushed as a warning. `proofFailures` is returned as its own field and the
    //   UI renders it as a permanent proof line — stating it here too printed the same sentence
    //   twice on screen, in two different wordings, which reads as two separate problems.
    if (dupRows.size) {
      warnings.push(`${dupRows.size} صف مكرر داخل الملف نفسه — تم استبعادها`);
    }
    if (unresolved.length) {
      warnings.push(`أعمدة لم يتم التعرف عليها: ${unresolved.join('، ')}`);
    }

    const round = (n: number) => Math.round(n * 100) / 100;

    return {
      ok: true,
      carrier,
      fileName,
      fileHash,
      sheet: ws.name,
      totalRows: raw.length,
      columns,
      unresolved,
      proofFailures,
      rows: raw,
      summary: {
        byStatus,
        suggestedCount,
        suggestedCod: round(suggestedCod),
        suggestedFees: round(suggestedFees),
        suggestedNet: round(suggestedCod - suggestedFees),
        feeOnlyCount,
        feeOnlyAmount: round(feeOnlyAmount),
        highVarianceCount,
        varianceTotal: round(varianceTotal),
      },
      warnings,
    };
  }

  /**
   * Decides one row's status.
   *
   * Order matters: the cheapest disqualifying checks run first, so a row that is structurally
   * unusable never reaches the matching stage and cannot be reported as «غير موجود» when the real
   * problem was an unreadable amount.
   */
  private classify(
    p: ParsedRow,
    byRef: Map<string, any>,
    byTrk: Map<string, any>,
    dupRows: Set<number>,
    fmt: CarrierStatementFormat,
  ): void {
    const fail = (note: string, status: RowStatus = 'invalid') => {
      p.status = status;
      p.note = note;
      p.selectable = false;
      p.suggested = false;
    };

    if (dupRows.has(p.row)) return fail('صف مكرر داخل الملف');
    if (!p.ref && !p.tracking) return fail('لا يوجد رقم مرجع ولا رقم تتبع');

    // parseMoney returns null (not 0) for unreadable cells — see its comment. An unknown amount
    // must never be treated as zero: that would claim nothing was collected or deducted.
    if (p.cod === null) return fail('المبلغ المحصَّل غير مقروء');
    if (p.totalFees === null) return fail('إجمالي الخصم غير مقروء');

    // ⚠ The file's own arithmetic is the proof that we mapped its columns correctly. If it does
    //   not reconcile, the honest conclusion is that WE misread the file — so the row is refused
    //   rather than settled on a figure we cannot reproduce.
    if (p.netValue !== null && Math.abs(p.cod - p.totalFees - p.netValue) > NET_VALUE_TOLERANCE) {
      return fail('حسابات الصف لا يطابق الصافي المعلن من الشركة');
    }

    // ⚠ Checked BEFORE matching, on purpose. Fees deducted with nothing collected is money that
    //   has already left us, and that is true whether or not the shipment resolves to a
    //   transaction we hold. Ordering this after the match would file such a row as «غير موجود» —
    //   a status that reads as "nothing to do here" and would hide a real cash loss from the
    //   carrier-audit report.
    //
    // ⚠ COD = 0 HAS TWO COMPLETELY DIFFERENT CAUSES, and calling both "returned" is wrong:
    //     · PREPAID — the customer already paid us (deposit === total, remaining 0), so the
    //       carrier had nothing to collect and simply billed us for delivery. Verified on live
    //       data: 307 sales are prepaid and 101 of them carry NO actualShipCost at all, i.e. a
    //       real 12,540 EGP of shipping that no report could see.
    //     · RETURNED — the shipment came back, nothing was collected, and the carrier still
    //       charged for the attempt.
    //   Both are «خصم بدون تحصيل» and neither can be settled as a collection, but only the first
    //   is a normal cost of doing business — so the note distinguishes them, and BOTH now record
    //   their shipping variance instead of being dropped from the audit.
    if (p.cod <= 0 && (p.totalFees ?? 0) > 0) {
      const mR = p.ref ? byRef.get(p.ref) : undefined;
      const mT = p.tracking ? byTrk.get(p.tracking) : undefined;
      const m = mR || mT;
      let prepaid = false;
      if (m) {
        p.matchedBy = mR ? 'ref' : 'tracking';
        p.txId = String(m._id);
        p.txRef = m.ref || '';
        p.txClient = m.client || '';
        p.txRemaining = Number(m.remaining) || 0;
        p.txShipCost = Number(m.shipCost) || 0;
        // The carrier collected nothing because WE already had the money.
        prepaid = (Number(m.deposit) || 0) > 0 && (Number(m.remaining) || 0) <= 0;
        // Shipping variance is recorded here too — this is the cost the audit was blind to.
        p.shipVariance = Math.round(Math.max(0, (p.totalFees ?? 0) - p.txShipCost) * 100) / 100;
        p.varianceLevel = varianceLevel(p.txShipCost, p.totalFees ?? 0).code;
      }
      return fail(
        prepaid
          ? `الطلب مدفوع مسبقاً — لم تحصّل الشركة شيئاً وخصمت ${p.totalFees} ج أجرة شحن`
          : `الشركة خصمت ${p.totalFees} ج دون تحصيل — شحنة مرتجعة، تُراجع مع الشركة`,
        'fee_only',
      );
    }

    // ── Match: reference first, then tracking. NEVER name or phone (see MatchKey). ────────────
    const mRef = p.ref ? byRef.get(p.ref) : undefined;
    const mTrk = p.tracking ? byTrk.get(p.tracking) : undefined;

    if (mRef && mTrk && String(mRef._id) !== String(mTrk._id)) {
      p.matchedBy = 'none';
      return fail(
        `رقم المرجع يشير للمعاملة ${mRef.ref} ورقم التتبع يشير للمعاملة ${mTrk.ref} — يلزم مراجعة يدوية`,
        'conflict',
      );
    }

    const tx = mRef || mTrk;
    if (!tx) {
      p.matchedBy = 'none';
      return fail('لا توجد معاملة بهذا المرجع أو رقم التتبع', 'not_found');
    }
    p.matchedBy = mRef ? 'ref' : 'tracking';
    p.txId = String(tx._id);
    p.txRef = tx.ref || '';
    p.txClient = tx.client || '';
    p.txRemaining = Number(tx.remaining) || 0;
    p.txShipCost = Number(tx.shipCost) || 0;

    // Shipping variance — recorded for EVERY matched row, whatever its settlement status, because
    // the carrier-audit report must measure what the carrier charged even on rows we do not settle.
    const variance = Math.max(0, (p.totalFees ?? 0) - p.txShipCost);
    p.shipVariance = Math.round(variance * 100) / 100;
    p.varianceLevel = varianceLevel(p.txShipCost, p.totalFees ?? 0).code;

    // Identity confirmation. Never decides the match — only flags that the reference may be wrong.
    const phoneFile = normalizePhone(p.customerPhone);
    const phoneTx = normalizePhone((tx as any).phone || (tx as any).clientPhone);
    const phoneClash = !!phoneFile && !!phoneTx && phoneFile !== phoneTx;
    const nameClash = !!p.customerName && !!tx.client && !namesLookAlike(p.customerName, tx.client);
    p.identityMismatch = phoneClash || nameClash;

    // ── Carrier-side state ────────────────────────────────────────────────────────────────────
    const st = String(p.carrierStatus || '').trim().toLowerCase();
    if (st && !fmt.deliveredStatuses.includes(st)) {
      return fail(`حالة الشحنة لدى الشركة «${p.carrierStatus}» — لم تُسلَّم بعد`, 'not_deliverable');
    }

    // ── Our side ──────────────────────────────────────────────────────────────────────────────
    if (tx.cancelled) return fail('المعاملة ملغية', 'invalid');
    if (tx.type !== 'مبيعات') return fail('المعاملة ليست عملية بيع', 'invalid');

    // The re-upload guard at row level, and the single most likely real-world case.
    if (tx.payStatus === 'مكتمل' || p.txRemaining <= 0) {
      return fail('تم تحصيل هذه المعاملة بالفعل', 'already_settled');
    }

    // `collect()` refuses an amount greater than `remaining`; catching it here means the review
    // screen explains it instead of the settlement failing later with a raw error.
    if (p.cod - p.txRemaining > AMOUNT_TOLERANCE) {
      return fail(
        `المبلغ المحصَّل (${p.cod} ج) أكبر من المتبقي على المعاملة (${p.txRemaining} ج)`,
        'amount_mismatch',
      );
    }
    if (Math.abs(p.cod - p.txRemaining) > AMOUNT_TOLERANCE) {
      return fail(
        `الشركة حصّلت ${p.cod} ج والمتبقي ${p.txRemaining} ج — يلزم قرار`,
        'amount_mismatch',
      );
    }

    p.status = 'matched';
    p.selectable = true;
    // ⚠ An identity clash is matched-but-not-suggested: the row can be settled, but only after a
    //   human looks at it. This is the check that catches a mistyped reference before cash moves.
    p.suggested = AUTO_SELECTABLE.includes('matched') && !p.identityMismatch;
    p.note = p.identityMismatch
      ? 'مطابق — لكن بيانات العميل مختلفة عن المعاملة، يُرجى التأكد'
      : 'مطابق';
  }
}
