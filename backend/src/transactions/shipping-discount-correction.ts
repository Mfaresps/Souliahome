/**
 * التصحيح التاريخي لتصنيف خصم الشحن (Nov 13, 2026) — Phase 1.
 *
 * فواتير Shopify القديمة شايلة الشحن المجاني جوّه `discount` من غير ما يتقال إنه شحن. التصحيح بيكتب
 * **حقلين جداد بس**: `shippingDiscount` و`shippingDiscountSource` (+ سطر في سجل التعديلات)، ومابيلمسش
 * `discount` ولا `shipCost` ولا `total` ولا `remaining` ولا `deposit` ولا الخزنة ولا المخزون ولا Bosta.
 * الربح الإجمالي مطابق قبل وبعد (shared/sale-discount.util.ts) — والخطة بتتحقق من ده لكل فاتورة.
 *
 * ⚠ نفس الكود ده بيشتغل من endpoint الأدمن ومن `scripts/shipping-discount-dryrun.cjs` على نسخة
 *   تجربة — مفيش نسختين من القاعدة.
 * ⚠ الكتابة مشروطة: الفاتورة لازم تكون لسه زي ما اتقرت (discount/shipCost/total) ومن غير تصنيف.
 *   تشغيل تاني مابيكتبش حاجة. الرجوع بالـ runId بيرجّع كل مستند زي ما كان بالظبط.
 * ⚠ الفواتير الملغية اللي عليها قيود خزنة لسه ماترجعتش بتتعرض لوحدها، ومابتتكتبش إلا لو اتوافق
 *   على كل واحدة بالاسم (`approveCancelledIds`).
 */
import { lineUnitCost } from '../shared/line-cost.util';
import {
  invoiceDiscount, invoiceDiscountRatio, invoiceItemsTotal, invoiceNetSales, invoiceShipCharged, invoiceShippingSubsidyRatio,
} from '../shared/sale-discount.util';
import { clampShippingDiscount, shopifyShippingDiscount, shopifyShippingDiscountCodes } from '../shopify/shopify-discounts.util';

export const CORRECTION_KIND = 'shipping-discount';
const SALES = 'مبيعات';
const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const month = (d: any) => String(d || '').slice(0, 7);

export interface CorrectionRow {
  txId: string; ref: string; date: string; month: string; client: string; cancelled: boolean;
  shopifyOrderId: string;
  /** What Shopify recorded on the shipping line, and what gets written after clamping. */
  shopifyShippingDiscount: number; shippingDiscount: number; clamped: boolean; viaCodes: string[];
  itemsTotal: number; discount: number; shipCost: number; total: number; remaining: number; deposit: number;
  before: Figures; after: Figures;
  /** Gross profit identical before and after (|Δ| ≤ 0.01). */
  grossProfitEqual: boolean;
  /** Cancelled sales only: net of this sale's vault entries (≠ 0 = a posting still unreversed). */
  vaultNet?: number; vaultEntries?: Array<{ txNo: string; date: string; amount: number; source: string; desc: string }>;
  /** Stored values exactly as read — the conditional write compares against these, not the rounded ones. */
  raw: { discount: any; shipCost: any; total: any };
  /** Shopify's current total for the order, and whether the Soulia invoice no longer matches it
   *  (edited in Soulia: items added/removed, orders merged). Listed for the owner to confirm. */
  shopifyTotal: number | null; editedInSoulia: boolean;
}
export interface Figures {
  productDiscount: number; netProductSales: number; shippingCharged: number; shippingSubsidy: number;
  cogs: number; grossProfit: number;
}
export interface SkippedRow { txId: string; ref: string; date: string; reason: string; detail?: string }
export interface MonthTotals { month: string; sales: number; before: Figures; after: Figures; grossProfitEqual: boolean }
export interface CorrectionPlan {
  generatedAt: string; database?: string;
  scope: { shopifySales: number; withShippingDiscount: number };
  affected: CorrectionRow[];
  cancelledReview: CorrectionRow[];
  skipped: SkippedRow[];
  months: MonthTotals[];
  totals: { sales: number; before: Figures; after: Figures; grossProfitEqual: boolean };
  /** Shopify order records (not invoices) that get the same classification, for the order screens. */
  /** `linkedTxIds`: the sales confirmed from this order. Its record is written only together with one of them. */
  orders: Array<{ orderId: string; ref: string; status: string; shippingDiscount: number; linkedTxIds: string[] }>;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
}

const zero = (): Figures => ({ productDiscount: 0, netProductSales: 0, shippingCharged: 0, shippingSubsidy: 0, cogs: 0, grossProfit: 0 });
const add = (a: Figures, b: Figures) => { for (const k of Object.keys(a) as (keyof Figures)[]) a[k] = r2(a[k] + b[k]); };

/** Figures for one sale under a given shippingDiscount — the same formulas getReports uses. */
function figures(tx: any, sd: number, buyPriceOf: (code: string) => number): Figures {
  const t = { ...tx, shippingDiscount: sd };
  const keep = 1 - invoiceDiscountRatio(t);
  const subsidyRatio = invoiceShippingSubsidyRatio(t);
  let cogs = 0, gp = 0;
  for (const item of tx.items || []) {
    const cost = lineUnitCost(item, buyPriceOf(String(item.code || '')));
    const qty = Number(item.qty) || 0;
    cogs += cost * qty;
    gp += ((Number(item.price) || 0) * (keep - subsidyRatio) - cost) * qty;
  }
  return {
    productDiscount: r2(invoiceDiscount(t)), netProductSales: r2(invoiceNetSales(t)),
    shippingCharged: r2(invoiceShipCharged(t)), shippingSubsidy: r2(sd > 0 ? Math.min(sd, Number(tx.shipCost) || 0, Number(tx.discount) || 0) : 0),
    cogs: r2(cogs), grossProfit: r2(gp),
  };
}

function vaultSigned(v: any): number {
  const amt = Number(v?.amount) || 0;
  // Same rule as the vault screen (normalizeVaultSignedAmount): a customer-return refund is stored positive.
  return /رد مرتجع/.test(String(v?.source || '')) && amt > 0 ? -amt : amt;
}

/** Reads everything the plan needs. Read-only. */
export async function loadCorrectionInputs(db: any) {
  const sales = await db.collection('transactions').find(
    { type: SALES, shopifyOrderId: { $nin: [null, ''] } },
    { projection: { ref: 1, date: 1, client: 1, cancelled: 1, archived: 1, discount: 1, shippingDiscount: 1, shippingDiscountSource: 1,
      shipCost: 1, itemsTotal: 1, total: 1, remaining: 1, deposit: 1, items: 1, shopifyOrderId: 1 } },
  ).toArray();
  const orders = await db.collection('shopifyorders').find({}, {
    projection: { shopifyId: 1, ref: 1, status: 1, cancelled: 1, shipCost: 1, discount: 1, shippingDiscount: 1,
      'rawData.shipping_lines': 1, 'rawData.discount_applications': 1, 'rawData.current_total_price': 1 },
  }).toArray();
  const products = await db.collection('products').find({}, { projection: { code: 1, buyPrice: 1 } }).toArray();
  const cancelledRefs = sales.filter((t: any) => t.cancelled).map((t: any) => String(t.ref || '')).filter(Boolean);
  const cancelledIds = sales.filter((t: any) => t.cancelled).map((t: any) => String(t._id));
  const vault = cancelledRefs.length ? await db.collection('vaultentries').find(
    { $or: [{ ref: { $in: cancelledRefs } }, { linkedTransactionId: { $in: cancelledIds } }, { linkedTransactionRef: { $in: cancelledRefs } }] },
    { projection: { txNo: 1, date: 1, amount: 1, source: 1, desc: 1, ref: 1, linkedTransactionId: 1, linkedTransactionRef: 1 } },
  ).toArray() : [];
  return { sales, orders, products, vault };
}

export function buildCorrectionPlan(input: Awaited<ReturnType<typeof loadCorrectionInputs>>, database?: string): CorrectionPlan {
  const { sales, orders, products, vault } = input;
  const orderById = new Map<string, any>(orders.map((o: any) => [String(o.shopifyId), o]));
  const buy = new Map<string, number>();
  for (const p of products) if (!buy.has(p.code)) buy.set(p.code, Number(p.buyPrice) || 0);
  const buyPriceOf = (code: string) => buy.get(code) ?? 0;

  const affected: CorrectionRow[] = [], cancelledReview: CorrectionRow[] = [], skipped: SkippedRow[] = [];
  let withSd = 0;
  for (const tx of sales) {
    const base = { txId: String(tx._id), ref: String(tx.ref || ''), date: String(tx.date || '').slice(0, 10) };
    const order = orderById.get(String(tx.shopifyOrderId));
    if (!order?.rawData) { skipped.push({ ...base, reason: 'no-shopify-payload', detail: 'لا يوجد سجل أوردر Shopify مرتبط أو بياناته الخام' }); continue; }
    const raw = shopifyShippingDiscount(order.rawData);
    if (raw <= 0) continue;                       // no free shipping on this order → nothing to classify
    withSd++;
    if ((Number(tx.shippingDiscount) || 0) > 0 || String(tx.shippingDiscountSource || '')) {
      skipped.push({ ...base, reason: 'already-classified', detail: String(tx.shippingDiscountSource || '') }); continue;
    }
    const sd = clampShippingDiscount(raw, tx.shipCost, tx.discount);
    if (sd <= 0) { skipped.push({ ...base, reason: 'nothing-to-move', detail: `Shopify ${raw} لكن discount=${Number(tx.discount) || 0} أو shipCost=${Number(tx.shipCost) || 0}` }); continue; }
    const before = figures(tx, 0, buyPriceOf), after = figures(tx, sd, buyPriceOf);
    const row: CorrectionRow = {
      ...base, month: month(tx.date), client: String(tx.client || ''), cancelled: !!tx.cancelled,
      shopifyOrderId: String(tx.shopifyOrderId), shopifyShippingDiscount: raw, shippingDiscount: sd, clamped: sd !== raw,
      viaCodes: shopifyShippingDiscountCodes(order.rawData),
      itemsTotal: r2(invoiceItemsTotal(tx)), discount: r2(tx.discount), shipCost: r2(tx.shipCost), total: r2(tx.total),
      remaining: r2(tx.remaining), deposit: r2(tx.deposit),
      before, after, grossProfitEqual: Math.abs(before.grossProfit - after.grossProfit) <= 0.01,
      raw: { discount: tx.discount, shipCost: tx.shipCost, total: tx.total },
      shopifyTotal: Number.isFinite(parseFloat(order.rawData.current_total_price)) ? r2(parseFloat(order.rawData.current_total_price)) : null,
      editedInSoulia: false,
    };
    row.editedInSoulia = row.shopifyTotal === null || Math.abs(row.shopifyTotal - row.total) > 0.5;
    if (tx.cancelled) {
      const mine = vault.filter((v: any) => String(v.ref || '') === row.ref || String(v.linkedTransactionId || '') === row.txId
        || String(v.linkedTransactionRef || '') === row.ref);
      row.vaultEntries = mine.map((v: any) => ({ txNo: String(v.txNo || ''), date: String(v.date || '').slice(0, 10), amount: r2(vaultSigned(v)), source: String(v.source || ''), desc: String(v.desc || '') }));
      row.vaultNet = r2(mine.reduce((s: number, v: any) => s + vaultSigned(v), 0));
      if (Math.abs(row.vaultNet) > 0.5) cancelledReview.push(row);
      else skipped.push({ ...base, reason: 'cancelled-fully-reversed', detail: `صافي قيود الخزنة ${row.vaultNet}` });
      continue;
    }
    affected.push(row);
  }

  const byMonth = new Map<string, MonthTotals>();
  const totals = { sales: 0, before: zero(), after: zero(), grossProfitEqual: true };
  for (const row of affected) {
    const m = byMonth.get(row.month) || { month: row.month, sales: 0, before: zero(), after: zero(), grossProfitEqual: true };
    m.sales++; add(m.before, row.before); add(m.after, row.after); byMonth.set(row.month, m);
    totals.sales++; add(totals.before, row.before); add(totals.after, row.after);
  }
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  for (const m of months) m.grossProfitEqual = Math.abs(m.before.grossProfit - m.after.grossProfit) <= 0.01 * Math.max(1, m.sales);
  totals.grossProfitEqual = Math.abs(totals.before.grossProfit - totals.after.grossProfit) <= 0.01 * Math.max(1, totals.sales);

  const salesByOrder = new Map<string, string[]>();
  for (const tx of sales) {
    const k = String(tx.shopifyOrderId);
    salesByOrder.set(k, [...(salesByOrder.get(k) || []), String(tx._id)]);
  }
  const orderRows = orders
    .filter((o: any) => o.rawData && !(Number(o.shippingDiscount) > 0))
    .map((o: any) => ({ orderId: String(o._id), ref: String(o.ref || ''), status: String(o.status || ''),
      shippingDiscount: clampShippingDiscount(shopifyShippingDiscount(o.rawData), o.shipCost, o.discount),
      linkedTxIds: salesByOrder.get(String(o.shopifyId)) || [] }))
    .filter((o: any) => o.shippingDiscount > 0);

  const sum = (f: (r: CorrectionRow) => number) => r2(affected.reduce((s, r) => s + f(r), 0));
  const checks = [
    { name: 'gross profit equal for every sale', pass: affected.every(r => r.grossProfitEqual),
      detail: `${affected.filter(r => !r.grossProfitEqual).length} مختلفة من ${affected.length}` },
    { name: 'gross profit equal for every month', pass: months.every(m => m.grossProfitEqual), detail: `${months.length} شهر` },
    { name: 'product discount + shipping subsidy = stored discount', pass: affected.every(r => Math.abs(r.after.productDiscount + r.after.shippingSubsidy - Math.min(r.discount, r.itemsTotal)) <= 0.01),
      detail: 'لكل فاتورة' },
    { name: 'net product sales + shipping charged = what the customer was charged', pass: affected.every(r => Math.abs(r.after.netProductSales + r.after.shippingCharged - r.total) <= 0.01),
      detail: `مجموع الإجمالي ${sum(r => r.total)}` },
    { name: 'clamped rows (Shopify shipping discount above stored shipping/discount)', pass: true,
      detail: `${affected.filter(r => r.clamped).length} فاتورة` },
    { name: 'invoices edited in Soulia (total differs from Shopify) — listed for confirmation', pass: true,
      detail: `${affected.filter(r => r.editedInSoulia).length} فاتورة` },
  ];
  return {
    generatedAt: new Date().toISOString(), database,
    scope: { shopifySales: sales.length, withShippingDiscount: withSd },
    affected, cancelledReview, skipped, months, totals, orders: orderRows, checks,
  };
}

export interface ApplyOptions {
  runId: string; approvedBy: string;
  /** ⚠ Required: the exact sales the owner approved (the approval report's list). Nothing else is written. */
  onlyTxIds: string[];
  approveCancelledIds?: string[]; excludeTxIds?: string[];
}
export interface ApplyResult { runId: string; written: number; ordersWritten: number; skippedChanged: string[]; cancelledWritten: number }

/**
 * Writes the plan. ⚠ Only after the owner approved the dry run — the caller enforces that.
 * Each write is conditional on the invoice being unchanged since the plan was built.
 */
export async function applyCorrectionPlan(db: any, plan: CorrectionPlan, opts: ApplyOptions): Promise<ApplyResult> {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(opts.runId || '')) throw new Error('runId required');
  if (!String(opts.approvedBy || '').trim()) throw new Error('approvedBy required');
  const approvedCancelled = new Set((opts.approveCancelledIds || []).map(String));
  const excluded = new Set((opts.excludeTxIds || []).map(String));
  const only = new Set((opts.onlyTxIds || []).map(String));
  if (!only.size) throw new Error('onlyTxIds required — the exact approved list');
  const candidates = [...plan.affected, ...plan.cancelledReview.filter(r => approvedCancelled.has(r.txId))];
  // An approved id the current plan does not contain means the data changed since the report: stop.
  const known = new Set(candidates.map(r => r.txId));
  const unknown = [...only].filter(id => !known.has(id));
  if (unknown.length) throw new Error(`approved ids not in the current plan: ${unknown.slice(0, 10).join(', ')}`);
  const rows = candidates.filter(r => only.has(r.txId) && !excluded.has(r.txId));
  const writtenTx = new Set<string>();
  const at = new Date().toISOString();
  const source = `correction:${opts.runId}`;
  const txs = db.collection('transactions'), log = db.collection('financialcorrections'), ordersCol = db.collection('shopifyorders');
  const { ObjectId } = require('mongodb');
  const idOf = (id: string) => (ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : id);
  let written = 0, cancelledWritten = 0, ordersWritten = 0;
  const skippedChanged: string[] = [];
  for (const row of rows) {
    const current = await txs.findOne({ _id: idOf(row.txId) }, { projection: { editHistory: 1, shippingDiscount: 1, shippingDiscountSource: 1 } });
    if (!current) { skippedChanged.push(row.ref || row.txId); continue; }
    const has = (k: string) => Object.prototype.hasOwnProperty.call(current, k);
    const prior = { hadHistory: Array.isArray(current.editHistory),
      shippingDiscount: has('shippingDiscount') ? { value: current.shippingDiscount } : null,
      shippingDiscountSource: has('shippingDiscountSource') ? { value: current.shippingDiscountSource } : null };
    const entry = {
      editedAt: at, editedBy: opts.approvedBy, approvedBy: opts.approvedBy, action: 'تصحيح تصنيف محاسبي',
      correctionRunId: opts.runId,
      before: { shippingDiscount: 0, productDiscount: row.before.productDiscount, shippingCharged: row.before.shippingCharged },
      after: { shippingDiscount: row.shippingDiscount, productDiscount: row.after.productDiscount, shippingCharged: row.after.shippingCharged },
      changes: [`خصم الشحن (شحن مجاني): 0 ← ${row.shippingDiscount} — تصنيف فقط، الإجمالي والخزنة بدون تغيير`],
    };
    const res = await txs.updateOne(
      { _id: idOf(row.txId), discount: row.raw.discount, shipCost: row.raw.shipCost, total: row.raw.total,
        $and: [{ $or: [{ shippingDiscount: { $exists: false } }, { shippingDiscount: { $in: [null, 0] } }] },
          { $or: [{ shippingDiscountSource: { $exists: false } }, { shippingDiscountSource: { $in: [null, ''] } }] }] },
      { $set: { shippingDiscount: row.shippingDiscount, shippingDiscountSource: source }, $push: { editHistory: entry } },
    );
    if (!res.modifiedCount) { skippedChanged.push(row.ref || row.txId); continue; }
    await log.insertOne({ runId: opts.runId, kind: CORRECTION_KIND, target: 'transaction', txId: row.txId, ref: row.ref,
      before: prior, after: { shippingDiscount: row.shippingDiscount, shippingDiscountSource: source },
      figuresBefore: row.before, figuresAfter: row.after, approvedBy: opts.approvedBy, approvedAt: at, rolledBackAt: null });
    written++; writtenTx.add(row.txId); if (row.cancelled) cancelledWritten++;
  }
  for (const o of plan.orders) {
    // A confirmed order's record follows its sale: untouched unless that sale was written in this run
    // (keeps excluded sales — cancelled, #2341, #2488, the edited ones — fully untouched). An order that
    // never became a sale carries no financial record and gets the label for the order screens.
    if (o.linkedTxIds.length && !o.linkedTxIds.some(id => writtenTx.has(id))) continue;
    const current = await ordersCol.findOne({ _id: idOf(o.orderId) }, { projection: { shippingDiscount: 1 } });
    if (!current || Number(current.shippingDiscount) > 0) continue;
    const had = Object.prototype.hasOwnProperty.call(current, 'shippingDiscount');
    const res = await ordersCol.updateOne({ _id: idOf(o.orderId), $or: [{ shippingDiscount: { $exists: false } }, { shippingDiscount: { $in: [null, 0] } }] },
      { $set: { shippingDiscount: o.shippingDiscount } });
    if (!res.modifiedCount) continue;
    await log.insertOne({ runId: opts.runId, kind: CORRECTION_KIND, target: 'shopifyorder', orderId: o.orderId, ref: o.ref,
      before: { hadField: had, value: had ? current.shippingDiscount : null }, after: { shippingDiscount: o.shippingDiscount },
      approvedBy: opts.approvedBy, approvedAt: at, rolledBackAt: null });
    ordersWritten++;
  }
  return { runId: opts.runId, written, ordersWritten, skippedChanged, cancelledWritten };
}

/** Undoes one run exactly: removes the two fields and the history line it added. */
export async function rollbackCorrection(db: any, runId: string, by: string): Promise<{ transactions: number; orders: number }> {
  const log = db.collection('financialcorrections');
  const { ObjectId } = require('mongodb');
  const idOf = (id: string) => (ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : id);
  let transactions = 0, orders = 0;
  for (const c of await log.find({ runId, kind: CORRECTION_KIND, rolledBackAt: null }).toArray()) {
    if (c.target === 'transaction') {
      const filter = { _id: idOf(c.txId), shippingDiscountSource: `correction:${runId}` };
      // Each field goes back to exactly what it was: absent, or its previous value.
      const $set: any = {}, $unset: any = {};
      for (const k of ['shippingDiscount', 'shippingDiscountSource']) {
        if (c.before?.[k]) $set[k] = c.before[k].value; else $unset[k] = '';
      }
      const res = await db.collection('transactions').updateOne(filter,
        { ...(Object.keys($set).length ? { $set } : {}), ...(Object.keys($unset).length ? { $unset } : {}),
          $pull: { editHistory: { correctionRunId: runId } } });
      if (res.modifiedCount && !c.before?.hadHistory) {
        await db.collection('transactions').updateOne({ _id: idOf(c.txId), editHistory: { $size: 0 } }, { $unset: { editHistory: '' } });
      }
      if (res.modifiedCount) transactions++;
    } else if (c.target === 'shopifyorder') {
      const update = c.before?.hadField ? { $set: { shippingDiscount: c.before.value } } : { $unset: { shippingDiscount: '' } };
      const res = await db.collection('shopifyorders').updateOne({ _id: idOf(c.orderId), shippingDiscount: c.after.shippingDiscount }, update);
      if (res.modifiedCount) orders++;
    }
    await log.updateOne({ _id: c._id }, { $set: { rolledBackAt: new Date().toISOString(), rolledBackBy: by } });
  }
  return { transactions, orders };
}

/**
 * Applies the owner-approved list ONCE (APPROVED_SHIPPING_CORRECTION). Safe to call on every start:
 * - a run marker (`_id` = runId, kind 'shipping-discount-run') is claimed with an atomic insert, so a
 *   second start — or a second instance — does nothing;
 * - only approved ids that are still in the current plan as eligible sales are written (never a
 *   cancelled sale, never an id outside the list), each conditional on the invoice being unchanged;
 * - an approved id that is missing or changed is reported in the marker, never guessed.
 */
export async function applyApprovedShippingCorrection(db: any, approval: { runId: string; approvedBy: string; sha256: string; onlyTxIds: readonly string[] }) {
  const markers = db.collection('financialcorrections');
  try {
    await markers.insertOne({ _id: approval.runId, kind: 'shipping-discount-run', runId: approval.runId, status: 'running',
      startedAt: new Date().toISOString(), approvedCount: approval.onlyTxIds.length, listSha256: approval.sha256 });
  } catch (e: any) {
    if (e?.code === 11000) return { skipped: 'already-run' as const };
    throw e;
  }
  try {
    const plan = buildCorrectionPlan(await loadCorrectionInputs(db), db.databaseName || db.name);
    const eligible = new Set(plan.affected.map(r => r.txId));
    const approved = approval.onlyTxIds.map(String);
    const present = approved.filter(id => eligible.has(id));
    const missing = approved.filter(id => !eligible.has(id));
    const result = present.length
      ? await applyCorrectionPlan(db, plan, { runId: approval.runId, approvedBy: approval.approvedBy, onlyTxIds: present })
      : { runId: approval.runId, written: 0, ordersWritten: 0, skippedChanged: [] as string[], cancelledWritten: 0 };
    await markers.updateOne({ _id: approval.runId }, { $set: { status: 'done', finishedAt: new Date().toISOString(),
      written: result.written, ordersWritten: result.ordersWritten, skippedChanged: result.skippedChanged,
      missingFromPlan: missing } });
    return { skipped: null, ...result, missingFromPlan: missing };
  } catch (e: any) {
    await markers.updateOne({ _id: approval.runId }, { $set: { status: 'failed', error: String(e?.message || e), finishedAt: new Date().toISOString() } });
    throw e;
  }
}
