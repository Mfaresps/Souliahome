/**
 * Historical FIFO preview — phase 2 of the FIFO plan (Nov 13, 2026). READ-ONLY.
 *
 * Replays the whole stock history of every product through `FifoBook` and reports what FIFO
 * would change: each sale line's cost, monthly gross profit, inventory value, the opening stock
 * (every cost candidate and its source) and every point where history sold more than it had.
 *
 * ⚠ Nothing here writes. No module imports this file and no route serves it; it is run by
 *   `scripts/fifo-preview.cjs` against a scratch copy. Applying a migration is a later phase.
 *
 * The owner's rules (Nov 13, 2026):
 * - **Every cost must trace to a purchase invoice or an approved opening batch.** A sale line is
 *   `traced` only then. Anything else is listed with its status and is never silently costed:
 *   `opening-pending` (opening batch not yet approved — shown at the proposed cost, marked),
 *   `unresolved` (sold with no batch behind it — keeps today's cost UNCHANGED, marked).
 * - Opening costs are decided per product (`decisions.opening`): approve the proposal, edit it,
 *   or leave it pending. The card price is never adopted automatically.
 * - Shortfall SKUs are resolved by decision only (`decisions.shortfalls`): an opening batch (goods
 *   that existed before the system) or a historical purchase invoice. Until then they stay open.
 * - Original sale and purchase records are only read. Decisions are simulated as extra layers.
 *
 * Timing: a line leaves (or enters) stock when the movement log says its quantity did — a product
 * added to an invoice in a later edit left stock at that edit, not when the invoice was created.
 * Without movement rows the transaction's entry time is used.
 *
 * "Before" mirrors the live rules exactly: stock events = `getInventory()`, line cost =
 * `lineUnitCost(item, card)`, gross profit = the getReports formula (sales by `date`, returns by
 * `createdAt`).
 */
import { FifoBook, FifoLayer } from '../shared/fifo.util';
import { lineUnitCost } from '../shared/line-cost.util';
import { purchaseLotsByCode, currentUnitCost } from '../shared/avg-cost.util';
import { invoiceDiscountRatio } from '../shared/sale-discount.util';
import { dateOnly } from '../shared/date-window.util';

type Doc = Record<string, any>;
export interface FifoHistory {
  products: Doc[];
  transactions: Doc[];
  returnRequests: Doc[];
  supplierReturnOrders: Doc[];
  adjustments: Doc[];
  movements: Doc[];
  units: Doc[];
  productSuppliers: Doc[];
  suppliers: Doc[];
}

export interface OpeningDecision { decision: 'approve' | 'edit' | 'pending'; cost?: number; qty?: number; note?: string; by?: string; at?: string }
export interface ShortfallDecision {
  /** gift = free samples received at no cost: an explicit, approved zero — never inferred. */
  resolution: 'opening-batch' | 'historical-purchase' | 'gift' | 'pending';
  qty?: number; unitCost?: number; supplier?: string; ref?: string; date?: string;
  remainder?: 'none' | 'write-off' | 'keep'; writeOffDate?: string; note?: string; by?: string; at?: string;
}
export interface UnknownCodeDecision { decision: 'map' | 'accept' | 'pending'; mapTo?: string; note?: string }
export interface FifoDecisions {
  opening?: Record<string, OpeningDecision>;
  shortfalls?: Record<string, ShortfallDecision>;
  unknownCodes?: Record<string, UnknownCodeDecision>;
  source?: string;
}
export interface FifoPreviewOptions {
  order?: 'created' | 'date';
  decisions?: FifoDecisions;
  /** Time lines by their transaction only — used to show which cases the movement log clears. */
  ignoreMovementLog?: boolean;
}

/** Reads everything the preview needs. Pass a `Db` from the mongodb driver (scratch copy). */
export async function loadFifoHistory(db: any): Promise<FifoHistory> {
  const col = (n: string) => db.collection(n);
  return {
    products: await col('products').find({}, { projection: { code: 1, name: 1, buyPrice: 1, avgCost: 1, openingBalance: 1, createdAt: 1, isActive: 1, 'activityLog.changes': 1, 'activityLog.at': 1, 'activityLog.by': 1 } }).toArray(),
    transactions: await col('transactions').find({ cancelled: { $ne: true }, archived: { $ne: true } }, {
      projection: { type: 1, ref: 1, notes: 1, date: 1, createdAt: 1, shippedAt: 1, discount: 1, itemsTotal: 1, total: 1, shipCost: 1, supplierId: 1, supplier: 1, client: 1,
        'items.code': 1, 'items.name': 1, 'items.qty': 1, 'items.price': 1, 'items.total': 1, 'items.condition': 1, 'items.unitCost': 1, 'items.costSource': 1 },
    }).toArray(),
    returnRequests: await col('returnrequests').find({ status: 'معتمد', $or: [{ reversedAt: null }, { reversedAt: { $exists: false } }] }).toArray(),
    supplierReturnOrders: await col('supplierreturnorders').find({}).toArray(),
    adjustments: await col('inventorymovements').find({ sourceType: 'manual-adjustment' }).toArray(),
    movements: await col('inventorymovements').find({ sourceType: { $in: ['transaction-create', 'transaction-update', 'transaction-restore'] } },
      { projection: { sourceTransactionId: 1, productCode: 1, qtyDelta: 1, createdAt: 1 } }).toArray(),
    units: await col('inventoryunits').find({ 'origin.kind': 'purchase' }, { projection: { productId: 1, 'origin.purchaseTransactionId': 1, 'assignment.transactionId': 1 } }).toArray(),
    productSuppliers: await col('productsuppliers').find({ active: { $ne: false } }).toArray(),
    suppliers: await col('suppliers').find({}, { projection: { name: 1 } }).toArray(),
  };
}

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const ms = (v: any) => { const t = new Date(v).getTime(); return Number.isFinite(t) ? t : 0; };
/** YYYY-MM-DD from a stored string or a Date object (`dateOnly(Date)` would print «Fri Apr 24»). */
const day = (v: any) => (v instanceof Date ? (Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : '') : dateOnly(v));
const month = (v: any) => { const d = day(v); return d ? d.slice(0, 7) : 'unknown'; };
const isoDay = (t: number) => (t ? new Date(t).toISOString().slice(0, 10) : '');
const isoMonth = (t: number) => (t ? new Date(t).toISOString().slice(0, 7) : 'unknown');
const trimCode = (c: any) => String(c || '').trim();

// mirrors of TransactionsService private rules (stock derivation)
const approvedReturnNotes = (n: any) => { const s = String(n || ''); return s.includes('مرتجع معتمد (طلب كان معلقاً)') || s.startsWith('استبدال — مرتجع:'); };
const isSupplierPurchase = (tx: Doc) => tx.type === 'مشتريات' && !(/-RET$/i.test(trimCode(tx.ref)) || approvedReturnNotes(tx.notes));
const isReturnToStock = (tx: Doc) => tx.type === 'مرتجع مبيعات' || tx.type === 'مرتجع' || (tx.type === 'مشتريات' && (/-RET$/i.test(trimCode(tx.ref)) || approvedReturnNotes(tx.notes)));
const soundQty = (item: Doc) => (String(item.condition || '').trim() === 'تالف' ? 0 : Number(item.qty) || 0);

/** Where a layer's cost comes from — the traceability the owner asked for. */
type Trace = 'invoice' | 'decided-invoice' | 'opening-approved' | 'opening-decided' | 'gift' | 'opening-pending' | 'adjustment' | 'return' | 'untraced';
interface LayerMeta { trace: Trace; ref: string; costFrom?: string }

type Ev =
  | { k: 'buy'; t: number; code: string; qty: number; unitCost: number; tx?: Doc; decided?: ShortfallDecision; timedBy: string }
  | { k: 'sell'; t: number; tx: Doc; code: string; qty: number; idx: number; timedBy: string }
  | { k: 'ret'; t: number; tx: Doc; code: string; qty: number; item: Doc }
  | { k: 'sret'; t: number; tx: Doc; code: string; qty: number; item: Doc }
  | { k: 'adj'; t: number; mv: Doc; code: string; qty: number }
  | { k: 'wo'; t: number; code: string; layerId: string; note: string };

const KIND_ORDER: Record<string, number> = { buy: 0, ret: 1, adj: 2, sell: 3, sret: 4, wo: 5 };
const evId = (e: any) => String(e.tx?._id || e.mv?._id || e.layerId || '');

export function buildFifoPreview(h: FifoHistory, opts: FifoPreviewOptions = {}) {
  const order = opts.order || 'created';
  const D: FifoDecisions = opts.decisions || {};
  const decisionErrors: Doc[] = [];
  const productByCode = new Map<string, Doc>();
  for (const p of h.products) { const c = trimCode(p.code); if (c && !productByCode.has(c)) productByCode.set(c, p); }
  const cardOf = (code: string) => { const p = productByCode.get(code); return p ? Number(p.buyPrice) || 0 : 0; };
  const supplierName = new Map(h.suppliers.map((s) => [String(s._id), s.name]));
  const txById = new Map(h.transactions.map((t) => [String(t._id), t]));
  const timeOf = (tx: Doc) => ms(order === 'date' ? tx.date || tx.createdAt : tx.createdAt || tx.date);

  // unknown codes: mapped to a product only by an explicit decision
  const codeOf = (raw: any) => {
    const c = trimCode(raw);
    const d = D.unknownCodes?.[c];
    if (!productByCode.has(c) && d?.decision === 'map' && d.mapTo && productByCode.has(trimCode(d.mapTo))) return trimCode(d.mapTo);
    return c;
  };
  for (const [c, d] of Object.entries(D.unknownCodes || {})) if (d.decision === 'map' && !productByCode.has(trimCode(d.mapTo))) decisionErrors.push({ area: 'unknown-code', code: c, error: `الكود البديل «${d.mapTo || ''}» مش موجود` });

  // movement log → when each (transaction, product) line really moved
  const movesByKey = new Map<string, Array<{ t: number; delta: number }>>();
  for (const m of h.movements) {
    const key = `${m.sourceTransactionId}|${trimCode(m.productCode)}`;
    const arr = movesByKey.get(key) || [];
    arr.push({ t: ms(m.createdAt), delta: Number(m.qtyDelta) || 0 });
    movesByKey.set(key, arr);
  }
  for (const arr of movesByKey.values()) arr.sort((a, b) => a.t - b.t);
  /** First moment the log shows the line's full quantity moved; else the transaction time. */
  const lineTime = (tx: Doc, rawCode: string, qty: number, dir: 1 | -1): { t: number; timedBy: string } => {
    const base = timeOf(tx);
    if (order === 'date') return { t: base, timedBy: 'invoice-date' };
    if (opts.ignoreMovementLog) return { t: base, timedBy: 'transaction' };
    const arr = movesByKey.get(`${tx._id}|${trimCode(rawCode)}`);
    if (!arr) return { t: base, timedBy: 'transaction' };
    let c = 0;
    for (const m of arr) { c += dir * m.delta; if (c >= qty - 1e-9) return { t: Math.max(base, m.t), timedBy: m.t > base + 60000 ? 'movement-log-later' : 'movement-log' }; }
    return { t: base, timedBy: 'transaction' };
  };

  // ── opening history from the product activity log ──
  const openingHistory = new Map<string, Array<{ at: number; from: number; to: number; by: string }>>();
  for (const [code, p] of productByCode) {
    const rows = (p.activityLog || []).flatMap((a: Doc) => (a.changes || []).filter((c: Doc) => c.field === 'openingBalance')
      .map((c: Doc) => ({ at: ms(a.at), from: Number(c.oldValue) || 0, to: Number(c.newValue) || 0, by: a.by || '' })));
    if (rows.length) openingHistory.set(code, rows.sort((a: any, b: any) => a.at - b.at));
  }
  const historyText = (code: string) => (openingHistory.get(code) || []).map((x) => `${isoDay(x.at)}: ${x.from} → ${x.to}${x.by ? ` (${x.by})` : ''}`).join(' · ');

  // ── events ──
  const events: Ev[] = [];
  const unknownCodes = new Map<string, { lines: number; qty: number; refs: string[] }>();
  const noteUnknown = (code: string, qty: number, ref: string) => {
    const u = unknownCodes.get(code) || { lines: 0, qty: 0, refs: [] };
    u.lines++; u.qty += qty; if (u.refs.length < 8) u.refs.push(ref); unknownCodes.set(code, u);
  };
  for (const tx of h.transactions) {
    if (isSupplierPurchase(tx)) {
      const items = (tx.items || []).map((i: Doc) => ({ ...i, code: codeOf(i.code) }));
      for (const [code, lot] of purchaseLotsByCode(items, Number(tx.discount) || 0)) {
        if (!productByCode.has(code)) { noteUnknown(code, lot.qty, trimCode(tx.ref)); continue; }
        const tm = lineTime(tx, code, lot.qty, 1);
        events.push({ k: 'buy', t: tm.t, timedBy: tm.timedBy, tx, code, qty: lot.qty, unitCost: lot.unitCost });
      }
    } else if (isReturnToStock(tx)) {
      for (const item of tx.items || []) {
        const code = codeOf(item.code), qty = soundQty(item);
        if (!qty) continue;
        if (!productByCode.has(code)) { noteUnknown(code, qty, trimCode(tx.ref)); continue; }
        events.push({ k: 'ret', t: timeOf(tx), tx, code, qty, item });
      }
    } else if (tx.type === 'مبيعات' || tx.type === 'مرتجع مشتريات') {
      const perCode = new Map<string, number>();
      for (const it of tx.items || []) perCode.set(codeOf(it.code), (perCode.get(codeOf(it.code)) || 0) + (Number(it.qty) || 0));
      (tx.items || []).forEach((item: Doc, idx: number) => {
        const code = codeOf(item.code), qty = Number(item.qty) || 0;
        if (!qty) return;
        if (!productByCode.has(code)) { noteUnknown(code, qty, trimCode(tx.ref)); return; }
        if (tx.type === 'مبيعات') {
          const tm = lineTime(tx, item.code, perCode.get(code) || qty, -1);
          events.push({ k: 'sell', t: tm.t, timedBy: tm.timedBy, tx, code, qty, idx });
        } else events.push({ k: 'sret', t: timeOf(tx), tx, code, qty, item });
      });
    }
  }
  for (const mv of h.adjustments) {
    const code = codeOf(mv.productCode), qty = Number(mv.qtyDelta) || 0;
    if (!qty || !code) continue;
    if (!productByCode.has(code)) { noteUnknown(code, qty, 'adjustment'); continue; }
    events.push({ k: 'adj', t: ms(mv.createdAt), mv, code, qty });
  }

  // ── opening stock: every candidate + the owner's decision; the card is never adopted by itself ──
  const firstPurchase = new Map<string, Ev & { k: 'buy' }>();
  for (const e of [...events].sort((a, b) => a.t - b.t)) if (e.k === 'buy' && !firstPurchase.has(e.code)) firstPurchase.set(e.code, e as any);
  const openingRows: Doc[] = [];
  const openingPlan = new Map<string, { qty: number; cost: number; status: 'approved' | 'pending' }>();
  for (const [code, p] of productByCode) {
    const qtyNow = Math.max(0, Math.floor(Number(p.openingBalance) || 0));
    const hist = openingHistory.get(code) || [];
    const dec = D.opening?.[code];
    if (!qtyNow && !dec) continue;   // zeroed openings with no stock left are shortfall SKUs, handled below
    const priceChanges = (p.activityLog || []).flatMap((a: Doc) => (a.changes || []).filter((c: Doc) => c.field === 'buyPrice').map((c: Doc) => ({ ...c, at: a.at })))
      .sort((a: Doc, b: Doc) => ms(a.at) - ms(b.at));
    const cardAtCreation = priceChanges.length ? Number(priceChanges[0].oldValue) || 0 : Number(p.buyPrice) || 0;
    const sp = h.productSuppliers.filter((r) => String(r.productId) === String(p._id) && Number(r.price) > 0).sort((a, b) => Number(!!b.primary) - Number(!!a.primary))[0];
    const fp = firstPurchase.get(code);
    let proposal: { cost: number; source: string; reason: string };
    if (cardAtCreation > 0) proposal = priceChanges.length
      ? { cost: cardAtCreation, source: 'card-at-creation', reason: `سعر الشراء في الكارت قبل أول تعديل له (${day(priceChanges[0].at)})` }
      : { cost: cardAtCreation, source: 'card-unchanged', reason: 'سعر الشراء في الكارت — ماتغيّرش من وقت إنشاء الصنف' };
    else if (sp) proposal = { cost: Number(sp.price), source: 'supplier-price', reason: `سعر المورد ${supplierName.get(String(sp.supplierId)) || ''}` };
    else proposal = { cost: 0, source: 'missing', reason: 'مفيش سعر شراء معروف — لازم يتحدد يدويًا' };

    let status: 'approved' | 'pending' = 'pending', cost = proposal.cost, qty = qtyNow, decisionAr = 'معلق';
    if (dec?.decision === 'approve') {
      if (proposal.cost > 0) { status = 'approved'; decisionAr = 'اعتماد المقترح'; }
      else decisionErrors.push({ area: 'opening', code, error: 'اعتماد مقترح بدون تكلفة — لازم تكلفة معدّلة' });
    } else if (dec?.decision === 'edit') {
      if (Number(dec.cost) > 0) { status = 'approved'; cost = Number(dec.cost); decisionAr = 'تكلفة معدّلة'; }
      else decisionErrors.push({ area: 'opening', code, error: 'تعديل بدون تكلفة صحيحة' });
    }
    if (dec && dec.qty !== undefined && dec.qty !== null && String(dec.qty) !== '') {
      if (Number.isInteger(Number(dec.qty)) && Number(dec.qty) >= 0) qty = Number(dec.qty);
      else decisionErrors.push({ area: 'opening', code, error: `كمية غير صحيحة: ${dec.qty}` });
    }
    const warnings: string[] = [];
    if (fp && proposal.cost > 0 && Math.abs(fp.unitCost - proposal.cost) / proposal.cost > 0.2) warnings.push('المقترح يختلف عن أول فاتورة شراء بأكثر من 20%');
    if (fp && ms(p.createdAt) > ms(fp.tx?.createdAt)) warnings.push('الصنف اتعمل بعد أول فاتورة شراء له');
    if (hist.length) warnings.push('الرصيد الافتتاحي اتعدّل بعد إدخاله — راجع السجل');
    if (proposal.source === 'missing') warnings.push('بدون تكلفة مقترحة');
    if (qty !== qtyNow) warnings.push(`الكمية المعتمدة (${qty}) غير الحالية (${qtyNow}) — هتغيّر رصيد المخزن بـ ${qty - qtyNow}`);
    openingPlan.set(code, { qty, cost, status });
    openingRows.push({
      code, name: p.name, qtyNow, qty, originalQty: hist.length ? hist[0].from : qtyNow, history: historyText(code), productCreatedAt: day(p.createdAt),
      cardCurrent: Number(p.buyPrice) || 0, cardAtCreation: priceChanges.length ? cardAtCreation : null,
      cardChanges: priceChanges.map((c: Doc) => `${day(c.at)}: ${c.oldValue} → ${c.newValue}`).join(' · '),
      supplierPrice: sp ? Number(sp.price) : null, supplierPriceSupplier: sp ? supplierName.get(String(sp.supplierId)) || '' : '',
      firstPurchaseCost: fp ? fp.unitCost : null, firstPurchaseRef: fp ? trimCode(fp.tx?.ref) : '', firstPurchaseDate: fp ? day(fp.tx?.date) : '',
      proposedCost: proposal.cost, proposedSource: proposal.source, reason: proposal.reason,
      decision: dec?.decision || 'pending', decisionAr, approvedCost: status === 'approved' ? cost : null, usedCost: cost, status,
      decisionNote: dec?.note || '', decidedBy: dec?.by || '', decidedAt: dec?.at || '',
      value: r2(qty * cost), warnings: warnings.join(' · '),
    });
  }

  // ── shortfall decisions → simulated layers (originals untouched) ──
  const decisionEvents: Ev[] = [];
  const decidedOpeningBatches = new Map<string, { qty: number; cost: number; gift?: boolean }>();
  const shortfallDecisionRows: Doc[] = [];
  for (const [code, d] of Object.entries(D.shortfalls || {})) {
    if (!d || d.resolution === 'pending') continue;
    const err = (e: string) => decisionErrors.push({ area: 'shortfall', code, error: e });
    if (!productByCode.has(code)) { err('الصنف مش موجود'); continue; }
    const qty = Number(d.qty), cost = Number(d.unitCost);
    if (!(Number.isInteger(qty) && qty > 0)) { err('الكمية لازم تكون رقم صحيح أكبر من صفر'); continue; }
    if (d.resolution === 'gift') {
      // the only decision that carries a zero cost — stated by the owner, never a fallback
      if (d.unitCost !== undefined && d.unitCost !== null && String(d.unitCost) !== '' && cost !== 0) { err('عينات الهدية تكلفتها صفر — امسح التكلفة أو اختار حل تاني'); continue; }
      decidedOpeningBatches.set(code, { qty, cost: 0, gift: true });
      shortfallDecisionRows.push({ code, ...d, unitCost: 0 });
      continue;
    }
    if (!(cost > 0)) { err('تكلفة القطعة مطلوبة — مفيش تكلفة افتراضية'); continue; }
    if (d.resolution === 'opening-batch') {
      let wo: Ev | null = null;
      if (d.remainder === 'write-off') {
        const zeroed = (openingHistory.get(code) || []).filter((x) => x.to < x.from).pop();
        const t = d.writeOffDate ? ms(d.writeOffDate) : zeroed ? zeroed.at : 0;
        if (!t) { err('شطب الباقي محتاج تاريخ'); continue; }
        wo = { k: 'wo', t, code, layerId: `decision-opening:${code}`, note: d.note || 'شطب باقي الدفعة الافتتاحية' };
      }
      decidedOpeningBatches.set(code, { qty, cost });
      if (wo) decisionEvents.push(wo);
    } else if (d.resolution === 'historical-purchase') {
      if (!d.date || !ms(d.date)) { err('تاريخ الفاتورة التاريخية مطلوب'); continue; }
      decisionEvents.push({ k: 'buy', t: ms(d.date), timedBy: 'decision', code, qty, unitCost: cost, decided: d });
    } else { err(`حل غير معروف: ${(d as any).resolution}`); continue; }
    shortfallDecisionRows.push({ code, ...d });
  }

  // ── replay ──
  const replay = (withShortfallDecisions: boolean) => {
    const meta = new Map<string, LayerMeta>();
    const books = new Map<string, FifoBook>();
    const evs = [...events, ...(withShortfallDecisions ? decisionEvents : [])]
      .sort((a, b) => a.t - b.t || KIND_ORDER[a.k] - KIND_ORDER[b.k] || evId(a).localeCompare(evId(b)));
    const book = (code: string) => {
      let b = books.get(code);
      if (b) return b;
      b = new FifoBook(code, () => ({ cost: cardOf(code), source: 'card-current' }));
      const op = openingPlan.get(code);
      if (op && op.qty > 0) {
        b.addLayer({ id: `opening:${code}`, kind: 'opening', at: 0, originalQty: op.qty, unitCost: op.cost, confidence: 'card', sourceRef: 'رصيد افتتاحي' });
        meta.set(`opening:${code}`, { trace: op.status === 'approved' ? 'opening-approved' : 'opening-pending', ref: 'رصيد افتتاحي' });
      }
      const ob = withShortfallDecisions ? decidedOpeningBatches.get(code) : undefined;
      if (ob) {
        const ref = ob.gift ? 'عينات هدية بدون تكلفة (قرار)' : 'دفعة افتتاحية (قرار)';
        b.addLayer({ id: `decision-opening:${code}`, kind: 'opening', at: 1, originalQty: ob.qty, unitCost: ob.cost, confidence: 'card', sourceRef: ref });
        meta.set(`decision-opening:${code}`, { trace: ob.gift ? 'gift' : 'opening-decided', ref });
      }
      books.set(code, b);
      return b;
    };
    for (const code of productByCode.keys()) book(code);

    const sales: Doc[] = [];
    const deficitSale = new Map<string, Doc>();
    const supplierReturnRows: Doc[] = [], adjustmentRows: Doc[] = [], returnRows: Doc[] = [], writeOffRows: Doc[] = [], flags: Doc[] = [];
    const purchaseCount = new Map<string, number>();
    const srOrderByTx = new Map(h.supplierReturnOrders.filter((o) => o.linkedTransactionId).map((o) => [String(o.linkedTransactionId), o]));
    const rrFor = (tx: Doc) => h.returnRequests.find((r) => String(r.returnTxId || '') === String(tx._id) || (r.returnTxRef && r.returnTxRef === tx.ref))
      || h.returnRequests.find((r) => !r.returnTxId && r.originalRef && `${r.originalRef}-RET` === trimCode(tx.ref));
    const newestCostLayer = (b: FifoBook) => { for (let i = b.layers.length - 1; i >= 0; i--) if (b.layers[i].kind !== 'customer-return') return b.layers[i]; return null; };

    for (const e of evs) {
      const b = book(e.code);
      if (e.k === 'buy') {
        purchaseCount.set(e.code, (purchaseCount.get(e.code) || 0) + 1);
        if (e.decided) {
          const id = `decision-purchase:${e.code}:${e.decided.ref || e.t}`;
          b.addLayer({ id, kind: 'purchase', at: e.t, originalQty: e.qty, unitCost: e.unitCost, confidence: 'actual', sourceRef: `${e.decided.ref || 'فاتورة تاريخية'} (قرار)`, supplierName: e.decided.supplier || '', businessDate: day(e.decided.date) });
          meta.set(id, { trace: 'decided-invoice', ref: `${e.decided.ref || 'فاتورة تاريخية'} (قرار)` });
        } else {
          const tx = e.tx!, sid = String(tx.supplierId || ''), id = `${tx._id}:${e.code}`;
          b.addLayer({ id, kind: 'purchase', at: e.t, originalQty: e.qty, unitCost: e.unitCost, confidence: 'actual',
            sourceTxId: String(tx._id), sourceRef: trimCode(tx.ref), supplierId: sid, supplierName: supplierName.get(sid) || tx.supplier || tx.client || '', businessDate: day(tx.date) });
          meta.set(id, { trace: 'invoice', ref: `#${trimCode(tx.ref)}` });
        }
      } else if (e.k === 'sell') {
        const item = e.tx.items[e.idx];
        const key = `${e.tx._id}:${e.idx}`;
        const r = b.consume(key, e.qty, e.t);
        const row: Doc = { key, txId: String(e.tx._id), tx: e.tx, item, code: e.code, qty: e.qty, t: e.t, timedBy: e.timedBy, hadPurchase: (purchaseCount.get(e.code) || 0) > 0, result: r };
        sales.push(row);
        for (const a of r.allocations) if (a.deficitId) deficitSale.set(a.deficitId, row);
      } else if (e.k === 'ret') {
        const rr = rrFor(e.tx);
        const orig = rr ? txById.get(String(rr.originalTransactionId))
          : h.transactions.find((t) => t.type === 'مبيعات' && `${trimCode(t.ref)}-RET` === trimCode(e.tx.ref));
        let left = e.qty, released = 0;
        if (orig) (orig.items || []).forEach((it: Doc, idx: number) => {
          if (left <= 0 || codeOf(it.code) !== e.code) return;
          const res = b.release(`${orig._id}:${idx}`, left, e.t, `ret:${e.tx._id}`);
          left -= res.releasedQty; released += res.releasedQty;
        });
        if (left > 0) {
          const cost = lineUnitCost(e.item, cardOf(e.code)), id = `ret:${e.tx._id}:${e.code}:${e.t}`;
          b.addLayer({ id, kind: 'customer-return', at: e.t, originalQty: left, unitCost: cost, confidence: 'line-cost', sourceTxId: String(e.tx._id), sourceRef: trimCode(e.tx.ref) });
          meta.set(id, { trace: 'untraced', ref: trimCode(e.tx.ref), costFrom: 'سطر المرتجع' });
          flags.push({ code: e.code, ref: trimCode(e.tx.ref), kind: 'return-unlinked', detail: `${left} قطعة مرتجعة مالقيناش بيعتها الأصلية — دخلت كدفعة بتكلفة ${cost}` });
        }
        returnRows.push({ code: e.code, ref: trimCode(e.tx.ref), date: day(e.tx.createdAt), qty: e.qty, toOriginalLayers: released, asNewLayer: left, originalRef: orig ? trimCode(orig.ref) : '' });
      } else if (e.k === 'sret') {
        const ord = srOrderByTx.get(String(e.tx._id));
        const line = ord ? (ord.items || []).find((i: Doc) => codeOf(i.code) === e.code) : null;
        const allocs = line && Array.isArray(line.allocations) ? line.allocations.filter((a: Doc) => Number(a.qty) > 0) : [];
        const prefer = allocs.map((a: Doc) => ({ layerId: `${a.sourceTransactionId}:${e.code}`, qty: Number(a.qty) }));
        const r = b.consume(`sret:${e.tx._id}:${e.code}`, e.qty, e.t, { prefer });
        const refund = allocs.length ? allocs.reduce((s: number, a: Doc) => s + Number(a.qty) * (Number(a.unitCost) || 0), 0) * (e.qty / allocs.reduce((s: number, a: Doc) => s + Number(a.qty), 0))
          : e.qty * (Number(e.item.price) || 0);
        const variance = r2(r.totalCost - refund);
        if (variance) b.variances.push({ at: e.t, kind: 'supplier-return', eventKey: `sret:${e.tx._id}:${e.code}`, qty: e.qty, amount: variance });
        const fromNamed = r.allocations.filter((a) => prefer.some((p2: Doc) => p2.layerId === a.layerId)).reduce((s, a) => s + a.qty, 0);
        supplierReturnRows.push({ code: e.code, ref: trimCode(e.tx.ref), order: ord?.returnNumber || '', date: day(e.tx.createdAt), qty: e.qty,
          fromNamedInvoice: fromNamed, fifoCost: r.totalCost, supplierCredit: r2(refund), variance, shortQty: r.shortQty });
      } else if (e.k === 'adj') {
        if (e.qty > 0) {
          const src = newestCostLayer(b), id = `adj:${e.mv._id}`;
          const cost = src ? src.unitCost : cardOf(e.code);
          const srcMeta = src ? meta.get(src.id) : undefined;
          b.addLayer({ id, kind: 'adjustment', at: e.t, originalQty: e.qty, unitCost: cost, confidence: 'implied', sourceRef: `تسوية ${day(e.mv.createdAt)}` });
          const trace: Trace = !src ? 'untraced' : srcMeta?.trace === 'opening-pending' ? 'opening-pending' : 'adjustment';
          meta.set(id, { trace, ref: `تسوية ${day(e.mv.createdAt)} بتكلفة ${srcMeta?.ref || src?.sourceRef || '—'}`, costFrom: src ? `${srcMeta?.ref || src.sourceRef || src.id}` : 'سعر الكارت (بدون مصدر)' });
          adjustmentRows.push({ code: e.code, date: day(e.mv.createdAt), qty: e.qty, unitCost: cost, value: r2(cost * e.qty),
            costFrom: src ? `بتكلفة ${srcMeta?.ref || src.sourceRef || src.id}${trace === 'opening-pending' ? ' (غير معتمد)' : ''}` : 'بدون مصدر — غير محسوم', traced: trace === 'adjustment', reason: e.mv.reason || '' });
        } else {
          const r = b.consume(`adj:${e.mv._id}`, -e.qty, e.t);
          adjustmentRows.push({ code: e.code, date: day(e.mv.createdAt), qty: e.qty, unitCost: r.unitCost, value: -r.totalCost, costFrom: 'FIFO', traced: !r.shortQty, reason: e.mv.reason || '', shortQty: r.shortQty });
        }
      } else if (e.k === 'wo') {
        const layer = b.getLayer(e.layerId);
        const q = layer ? layer.remainingQty : 0;
        if (q > 0) {
          const r = b.consume(`wo:${e.layerId}`, q, e.t, { prefer: [{ layerId: e.layerId, qty: q }] });
          writeOffRows.push({ code: e.code, date: isoDay(e.t), qty: q, value: r.totalCost, note: e.note });
        }
      }
    }
    return { books, meta, sales, deficitSale, supplierReturnRows, adjustmentRows, returnRows, writeOffRows, flags, evs };
  };

  const base = replay(false);
  const decided = shortfallDecisionRows.length > 0;
  const R = decided ? replay(true) : base;
  const { books, meta, sales } = R;

  // ── evidence that goods existed when a line sold before its covering invoice was entered ──
  const unitsBySaleAndInvoice = new Set(h.units.filter((u) => u.assignment?.transactionId && u.origin?.purchaseTransactionId)
    .map((u) => `${u.assignment.transactionId}|${u.origin.purchaseTransactionId}`));
  const settledEvidence = (sale: Doc, layer: FifoLayer | undefined) => {
    if (!layer) return null;
    if (layer.sourceTxId && unitsBySaleAndInvoice.has(`${sale.txId}|${layer.sourceTxId}`)) return `قطع ممسوحة على البيعة من فاتورة #${layer.sourceRef}`;
    const shipped = ms(sale.tx.shippedAt);
    if (shipped && shipped >= layer.at) return `البيعة اتشحنت ${isoDay(shipped)} بعد تسجيل الفاتورة #${layer.sourceRef} (${isoDay(layer.at)})`;
    return null;
  };

  const codeByProductId = new Map([...productByCode].map(([c, p]) => [String(p._id), c]));
  const scannedInvoices = new Map<string, Set<string>>();
  for (const u of h.units) {
    if (!u.assignment?.transactionId || !u.origin?.purchaseTransactionId) continue;
    const key = `${u.assignment.transactionId}|${codeByProductId.get(String(u.productId)) || ''}`;
    const set = scannedInvoices.get(key) || new Set<string>();
    set.add(trimCode(txById.get(String(u.origin.purchaseTransactionId))?.ref) || String(u.origin.purchaseTransactionId));
    scannedInvoices.set(key, set);
  }

  // ── each sale line: cost after, its status, and where every piece's cost comes from ──
  const STATUS_RANK: Record<string, number> = { traced: 0, 'late-entry-verified': 1, 'opening-pending': 2, 'late-entry-unverified': 3, unresolved: 4 };
  const saleLines: Doc[] = [];
  for (const s of sales) {
    const b = books.get(s.code)!;
    const before = lineUnitCost(s.item, cardOf(s.code));
    let cost = 0, pendingCost = 0, unresolvedQty = 0, status = 'traced';
    const parts: string[] = [], evidence: string[] = [];
    const worse = (st: string) => { if (STATUS_RANK[st] > STATUS_RANK[status]) status = st; };
    for (const a of s.result.allocations) {
      if (a.layerId) {
        const m = meta.get(a.layerId), layer = b.getLayer(a.layerId);
        cost += a.qty * a.unitCost;
        if (m?.trace === 'opening-pending') { pendingCost += a.qty * a.unitCost; worse('opening-pending'); }
        if (m?.trace === 'untraced') { pendingCost += a.qty * a.unitCost; worse('unresolved'); }
        parts.push(`${m?.ref || layer?.sourceRef || a.layerId}×${a.qty}@${a.unitCost}${m?.trace === 'opening-pending' ? ' (غير معتمد)' : ''}`);
      } else {
        const d = b.deficits.find((x) => x.id === a.deficitId);
        const settled = d ? d.settlements.filter((x) => x.qty > 0) : [];
        let settledLeft = Math.min(a.qty, settled.reduce((x, y) => x + y.qty, 0));
        for (const st of settled) {
          const q = Math.min(st.qty, settledLeft); if (q <= 0) break; settledLeft -= q;
          const layer = b.getLayer(st.layerId), ev = settledEvidence(s, layer);
          if (ev) { cost += q * st.actualCost; worse('late-entry-verified'); evidence.push(ev); parts.push(`${meta.get(st.layerId)?.ref || layer?.sourceRef}×${q}@${st.actualCost} (اتسجلت بعد البيع — متأكد)`); }
          else { cost += q * before; pendingCost += q * before; worse('late-entry-unverified'); parts.push(`عجز اتغطى بـ${meta.get(st.layerId)?.ref || layer?.sourceRef}×${q} — غير متأكد، بتكلفته الحالية`); }
        }
        const open = Math.max(0, a.qty - Math.min(a.qty, settled.reduce((x, y) => x + y.qty, 0)));
        if (open > 0) { cost += open * before; pendingCost += open * before; unresolvedQty += open; worse('unresolved'); parts.push(`عجز ×${open} — غير محسوم، بتكلفته الحالية ${before}`); }
      }
    }
    saleLines.push({
      key: s.key, txId: s.txId, ref: trimCode(s.tx.ref), date: day(s.tx.date), enteredAt: day(s.tx.createdAt), stockOutAt: isoDay(s.t), timedBy: s.timedBy, month: month(s.tx.date),
      code: s.code, name: productByCode.get(s.code)?.name || '', qty: s.qty, price: Number(s.item.price) || 0, keep: 1 - invoiceDiscountRatio(s.tx),
      costSourceBefore: s.item.costSource || (cardOf(s.code) > 0 ? 'live-card' : 'missing'),
      unitCostBefore: before, costBefore: r2(before * s.qty), costAfter: r2(cost), unitCostAfter: s.qty ? r2(cost / s.qty) : 0,
      pendingCost: r2(pendingCost), unresolvedQty, status, layers: parts.join(' + '), evidence: evidence.join(' · '),
      scannedFrom: [...(scannedInvoices.get(`${s.txId}|${s.code}`) || [])].map((r) => `#${r}`).join(' '),
    });
  }

  // ── shortfall cases (every deficit) and the per-SKU summary, before and after decisions ──
  const describeDeficits = (run: ReturnType<typeof replay>) => {
    const rows: Doc[] = [];
    for (const [code, b] of run.books) for (const d of b.deficits) {
      const sale = run.deficitSale.get(d.id);
      const first = d.settlements[0];
      const settleLayer = first ? b.getLayer(first.layerId) : undefined;
      const days = settleLayer ? Math.max(0, Math.round((settleLayer.at - d.at) / 86400000)) : 0;
      const lowered = (openingHistory.get(code) || []).filter((x) => x.to < x.from);
      let cause: string, causeAr: string;
      if (!sale) { cause = 'non-sale'; causeAr = 'تسوية نقص أو مرتجع مورد بكمية أكبر من الرصيد'; }
      else if (settleLayer) {
        const ev = settledEvidence(sale, settleLayer);
        cause = ev ? 'late-entry-verified' : 'late-entry-unverified';
        causeAr = `اتباع قبل تسجيل فاتورة #${settleLayer.sourceRef} بـ${days} يوم — ${ev ? `متأكد: ${ev}` : 'مفيش دليل إن البضاعة كانت موجودة وقت البيع'}`;
      } else if (lowered.length) {
        cause = 'opening-lowered';
        causeAr = `الرصيد الافتتاحي اتعدّل بعد البيع (${lowered.map((x) => `${isoDay(x.at)}: ${x.from} → ${x.to}`).join(' · ')}) — البيعة كانت من الرصيد اللي اتشال`;
      } else if (!sale.hadPurchase) { cause = 'never-purchased'; causeAr = 'مفيش أي فاتورة شراء ولا رصيد افتتاحي للصنف'; }
      else { cause = 'still-open'; causeAr = 'لسه مفيش رصيد يغطيه لحد النهارده'; }
      rows.push({
        code, name: productByCode.get(code)?.name || '', ref: sale ? trimCode(sale.tx.ref) : d.eventKey, saleDate: sale ? day(sale.tx.date) : '', stockOutAt: isoDay(d.at),
        shortQty: d.originalQty, todayCost: sale ? lineUnitCost(sale.item, cardOf(code)) : cardOf(code), cause, causeAr,
        settledBy: d.settlements.filter((s) => s.qty > 0).map((s) => `${b.getLayer(s.layerId)?.sourceRef || s.layerId} ×${s.qty} @${s.actualCost} (${isoDay(s.at)})`).join(' + '),
        openQty: d.qty, cancelledQty: d.cancelledQty,
      });
    }
    return rows;
  };
  const baseShortfalls = describeDeficits(base);
  const shortfalls = decided ? describeDeficits(R) : baseShortfalls;
  const skuCodes = new Set([...baseShortfalls.map((x) => x.code), ...Object.keys(D.shortfalls || {})]);
  const shortfallSkus: Doc[] = [];
  for (const code of skuCodes) {
    const p = productByCode.get(code); if (!p) continue;
    const bRows = baseShortfalls.filter((x) => x.code === code), aRows = shortfalls.filter((x) => x.code === code);
    const sold = base.sales.filter((s) => s.code === code).reduce((x, s) => x + s.qty, 0);
    const purchased = events.filter((e) => e.k === 'buy' && e.code === code).reduce((x, e) => x + (e as any).qty, 0);
    const hist = openingHistory.get(code) || [];
    const openShort = bRows.reduce((x, r) => x + r.openQty, 0);
    const dec = D.shortfalls?.[code];
    const applied = shortfallDecisionRows.find((x) => x.code === code);
    const decErr = decisionErrors.filter((x) => x.area === 'shortfall' && x.code === code).map((x) => x.error).join(' · ');
    const lowered = hist.filter((x) => x.to < x.from).pop();
    const onlyLate = bRows.length > 0 && bRows.every((r) => r.cause === 'late-entry-verified');
    const suggestion = onlyLate ? 'الفاتورة اتسجلت بعد البيع والدليل موجود — مفيش قرار مطلوب'
      : lowered
        ? `كان عليه رصيد افتتاحي ${lowered.from} واتصفّر ${isoDay(lowered.at)}. لو البضاعة كانت موجودة قبل تشغيل النظام: دفعة افتتاحية ${lowered.from} قطعة وشطب الباقي بتاريخ ${isoDay(lowered.at)} — أو دفعة بالكمية الناقصة بس (${openShort}) لو الباقي ماكانش موجود. لو اتشرت: فاتورة شراء تاريخية بالكمية والتاريخ الحقيقيين. التكلفة لازم تتحدد منك.`
        : `لو اتشرت: فاتورة شراء تاريخية بالكمية (${openShort} على الأقل) والتاريخ الحقيقيين. لو كانت موجودة قبل النظام: دفعة افتتاحية. التكلفة لازم تتحدد منك.`;
    const openAfter = aRows.reduce((x, r) => x + r.openQty, 0);
    const unverifiedAfter = aRows.some((r) => r.cause === 'late-entry-unverified');
    shortfallSkus.push({
      code, name: p.name, active: p.isActive !== false, sold, purchased, openingNow: Number(p.openingBalance) || 0, openingHistory: historyText(code),
      openingBefore: lowered ? lowered.from : null, loweredOn: lowered ? isoDay(lowered.at) : '',
      cases: bRows.length, shortQty: bRows.reduce((x, r) => x + r.shortQty, 0), openShortBefore: openShort, stockNow: base.books.get(code)!.balance(),
      firstSale: bRows.map((r) => r.saleDate).sort()[0] || '', lastSale: bRows.map((r) => r.saleDate).sort().pop() || '', cardCost: cardOf(code),
      causes: [...new Set(bRows.map((r) => r.cause))].join(', '), suggestion, decision: dec?.resolution || 'pending',
      decisionText: applied ? (applied.resolution === 'gift' ? `عينات هدية بدون تكلفة — ${applied.qty} قطعة` : applied.resolution === 'opening-batch'
        ? `دفعة افتتاحية ${applied.qty} × ${applied.unitCost}${applied.remainder === 'write-off' ? ' + شطب الباقي' : ''}`
        : `فاتورة تاريخية ${applied.ref || ''} ${applied.qty} × ${applied.unitCost} بتاريخ ${applied.date}`)
        : decErr ? `قرار مرفوض: ${decErr}` : onlyLate ? 'محسوم بالدليل' : 'معلق — غير محسوم',
      openShortAfter: openAfter, stockAfterDecision: R.books.get(code)!.balance(),
      status: openAfter === 0 && !unverifiedAfter && (applied || onlyLate) ? 'resolved' : 'unresolved',
    });
  }

  // ── monthly gross profit, before vs after ──
  const months = new Map<string, Doc>();
  const M = (m: string) => { let o = months.get(m); if (!o) { o = { month: m, revenue: 0, cogsBefore: 0, cogsAfter: 0, pendingCost: 0, unresolvedQty: 0, retProfitBefore: 0, retProfitAfter: 0, variance: 0, lines: 0, tracedLines: 0 }; months.set(m, o); } return o; };
  for (const s of saleLines) {
    const o = M(s.month);
    o.revenue += s.price * s.keep * s.qty; o.cogsBefore += s.costBefore; o.cogsAfter += s.costAfter; o.pendingCost += s.pendingCost; o.unresolvedQty += s.unresolvedQty;
    o.lines++; if (s.status === 'traced' || s.status === 'late-entry-verified') o.tracedLines++;
  }
  // sale lines whose code matches no product (and no mapping decision): no batch — they keep their cost and stay listed
  for (const tx of h.transactions) if (tx.type === 'مبيعات') (tx.items || []).forEach((item: Doc) => {
    if (productByCode.has(codeOf(item.code))) return;
    const o = M(month(tx.date)), q = Number(item.qty) || 0, c = lineUnitCost(item, 0) * q;
    o.revenue += (Number(item.price) || 0) * (1 - invoiceDiscountRatio(tx)) * q;
    o.cogsBefore += c; o.cogsAfter += c; o.lines++;
    if (D.unknownCodes?.[trimCode(item.code)]?.decision === 'accept') o.tracedLines++; else { o.pendingCost += c; o.unresolvedQty += q; }
  });
  const fifoUnitOfOriginal = (origId: string, code: string) => {
    const rows = saleLines.filter((s) => s.txId === origId && s.code === code);
    const q = rows.reduce((s, r) => s + r.qty, 0);
    return q ? rows.reduce((s, r) => s + r.costAfter, 0) / q : null;
  };
  for (const ret of h.returnRequests) {
    const o = M(isoMonth(ms(ret.createdAt)));
    let lines = 0, before = 0, after = 0;
    for (const it of ret.items || []) {
      const code = codeOf(it.code), qty = Number(it.qty) || 0;
      lines += (Number(it.price) || 0) * qty;
      if (String(it.condition || '').trim() === 'تالف') continue;
      const b = lineUnitCost(it, cardOf(code)), a = fifoUnitOfOriginal(String(ret.originalTransactionId), code);
      before += b * qty; after += (a ?? b) * qty;
    }
    const refund = Number(ret.total) > 0 ? Number(ret.total) : lines;
    o.retProfitBefore += refund - before; o.retProfitAfter += refund - after;
  }
  // only supplier-return differences enter profit; deficit settlements are folded into the line (verified) or not accepted
  const varianceRows: Doc[] = [];
  for (const [code, b] of books) for (const v of b.variances) {
    if (v.kind !== 'supplier-return') continue;
    M(isoMonth(v.at)).variance += v.amount;
    varianceRows.push({ code, month: isoMonth(v.at), kind: v.kind, qty: v.qty, amount: v.amount, eventKey: v.eventKey });
  }
  const monthly = [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((o) => {
    const grossBefore = o.revenue - o.cogsBefore - o.retProfitBefore;
    const grossAfter = o.revenue - o.cogsAfter - o.retProfitAfter - o.variance;
    return { ...o, revenue: r2(o.revenue), cogsBefore: r2(o.cogsBefore), cogsAfter: r2(o.cogsAfter), pendingCost: r2(o.pendingCost), retProfitBefore: r2(o.retProfitBefore), retProfitAfter: r2(o.retProfitAfter),
      variance: r2(o.variance), grossBefore: r2(grossBefore), grossAfter: r2(grossAfter), diff: r2(grossAfter - grossBefore), final: o.tracedLines === o.lines };
  });

  // ── per product: quantities, stock reconciliation, value, profit ──
  const productsOut: Doc[] = [];
  const layersOut: Doc[] = [];
  for (const [code, p] of productByCode) {
    const b = books.get(code)!;
    const q = { purchased: 0, sold: 0, returned: 0, supplierReturned: 0, adjusted: 0 };
    for (const e of events) if (e.code === code) {
      if (e.k === 'buy') q.purchased += e.qty; else if (e.k === 'sell') q.sold += e.qty; else if (e.k === 'ret') q.returned += e.qty;
      else if (e.k === 'sret') q.supplierReturned += e.qty; else if (e.k === 'adj') q.adjusted += e.qty;
    }
    const opening = Math.max(0, Math.floor(Number(p.openingBalance) || 0));
    const derived = opening + q.purchased + q.returned - q.sold - q.supplierReturned + q.adjusted;
    const plan = openingPlan.get(code);
    const decidedIn = (plan ? plan.qty - opening : 0)
      + (decided ? (decidedOpeningBatches.get(code)?.qty || 0) + decisionEvents.filter((e) => e.code === code && e.k === 'buy').reduce((x, e) => x + (e as any).qty, 0) : 0)
      - R.writeOffRows.filter((w) => w.code === code).reduce((x, w) => x + w.qty, 0);
    const lines = saleLines.filter((s) => s.code === code);
    const unitBefore = currentUnitCost(p as any) ?? 0;
    const valueBefore = r2(Math.max(0, derived) * unitBefore);
    const pendingValue = r2(b.layers.filter((l) => ['opening-pending', 'untraced'].includes(meta.get(l.id)?.trace || '')).reduce((x, l) => x + l.remainingQty * l.unitCost, 0));
    productsOut.push({
      code, name: p.name, opening, ...q, derivedStock: derived, expectedAfterDecisions: derived + decidedIn, fifoBalance: b.balance(),
      reconciled: derived + decidedIn === b.balance(),
      openLayers: b.layers.filter((l) => l.remainingQty > 0).length, openDeficitQty: b.openDeficitQty(),
      unitCostBefore: unitBefore, valueBefore, valueAfter: b.value(), pendingValue, valueDiff: r2(b.value() - valueBefore),
      cogsBefore: r2(lines.reduce((s, l) => s + l.costBefore, 0)), cogsAfter: r2(lines.reduce((s, l) => s + l.costAfter, 0)),
      variance: r2(b.variances.filter((v) => v.kind === 'supplier-return').reduce((s, v) => s + v.amount, 0)),
      linesNotTraced: lines.filter((l) => !['traced', 'late-entry-verified'].includes(l.status)).length,
    });
    for (const l of b.layers) {
      const m = meta.get(l.id);
      layersOut.push({ code, name: p.name, id: l.id, kind: l.kind, ref: m?.ref || l.sourceRef || '', supplier: l.supplierName || '', businessDate: l.businessDate || '',
        enteredAt: l.at > 1 ? isoDay(l.at) : 'قبل أي حركة', originalQty: l.originalQty, consumedQty: l.originalQty - l.remainingQty, remainingQty: l.remainingQty,
        unitCost: l.unitCost, remainingValue: r2(l.remainingQty * l.unitCost), status: l.remainingQty > 0 ? 'open' : 'exhausted', trace: m?.trace || 'untraced', costFrom: m?.costFrom || '' });
    }
  }
  productsOut.forEach((r) => { r.cogsDiff = r2(r.cogsAfter + r.variance - r.cogsBefore); });

  // ── traceability + blockers ──
  const statusCount: Record<string, { lines: number; qty: number }> = {};
  for (const s of saleLines) { const o = (statusCount[s.status] ||= { lines: 0, qty: 0 }); o.lines++; o.qty += s.qty; }
  const sum = (rows: Doc[], k: string) => r2(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0));
  const unknownOut = [...unknownCodes].map(([code, u]) => ({ code, ...u, refs: u.refs.join(', '), decision: D.unknownCodes?.[code]?.decision || 'pending', note: D.unknownCodes?.[code]?.note || '' }));
  const blockers: string[] = [];
  const pendingOpening = openingRows.filter((r) => r.status !== 'approved');
  const unresolvedSkus = shortfallSkus.filter((r) => r.status !== 'resolved');
  const unverified = shortfalls.filter((r) => r.cause === 'late-entry-unverified');
  const unreconciled = productsOut.filter((r) => !r.reconciled);
  const untracedAdj = R.adjustmentRows.filter((a) => !a.traced);
  if (pendingOpening.length) blockers.push(`${pendingOpening.length} صنف رصيده الافتتاحي تكلفته لسه مش معتمدة (${pendingOpening.reduce((s, r) => s + r.qty, 0)} قطعة)`);
  if (unresolvedSkus.length) blockers.push(`${unresolvedSkus.length} صنف فيه عجز غير محسوم (${unresolvedSkus.reduce((s, r) => s + r.openShortAfter, 0)} قطعة)`);
  if (unverified.length) blockers.push(`${unverified.length} حالة بيع قبل تسجيل الفاتورة من غير دليل إن البضاعة كانت موجودة`);
  if (unknownOut.some((u) => u.decision === 'pending')) blockers.push(`${unknownOut.filter((u) => u.decision === 'pending').length} كود في الحركات مالوش صنف`);
  if (untracedAdj.length) blockers.push(`${untracedAdj.length} تسوية تكلفتها مش راجعة لفاتورة أو دفعة معتمدة`);
  if (unreconciled.length) blockers.push(`${unreconciled.length} صنف رصيد FIFO بتاعه مختلف عن رصيد المخزن المتوقع`);
  if (decisionErrors.length) blockers.push(`${decisionErrors.length} قرار مرفوض — راجع «أخطاء القرارات»`);
  if (R.flags.length) blockers.push(`${R.flags.length} مرتجع مالقيناش بيعته الأصلية`);

  return {
    generatedAt: new Date().toISOString(), order, decisionsSource: D.source || '',
    summary: {
      products: productByCode.size, events: R.evs.length, saleLines: saleLines.length,
      purchaseLayers: layersOut.filter((l) => l.trace === 'invoice').length,
      openingProducts: openingRows.filter((r) => r.qty > 0).length, openingQty: openingRows.reduce((s, r) => s + r.qty, 0), openingValue: sum(openingRows, 'value'),
      openingApproved: openingRows.filter((r) => r.status === 'approved').length, openingPending: pendingOpening.length,
      shortfallSkus: shortfallSkus.length, shortfallSkusUnresolved: unresolvedSkus.length,
      shortfallCasesBefore: baseShortfalls.length, shortfallQtyBefore: baseShortfalls.reduce((s, r) => s + r.shortQty, 0),
      openDeficitQty: shortfalls.reduce((s, r) => s + r.openQty, 0),
      linesTimedByEdit: saleLines.filter((s) => s.timedBy === 'movement-log-later').length,
      cogsBefore: sum(saleLines, 'costBefore'), cogsAfter: sum(saleLines, 'costAfter'), pendingCost: sum(saleLines, 'pendingCost'), variance: sum(varianceRows, 'amount'),
      grossBefore: sum(monthly, 'grossBefore'), grossAfter: sum(monthly, 'grossAfter'),
      valueBefore: sum(productsOut, 'valueBefore'), valueAfter: sum(productsOut, 'valueAfter'), pendingValue: sum(productsOut, 'pendingValue'),
      writeOffValue: sum(R.writeOffRows, 'value'),
      reconciledProducts: productsOut.length - unreconciled.length, unknownCodes: unknownOut.length,
      traceability: statusCount, final: blockers.length === 0,
    },
    blockers, approvable: blockers.length === 0, decisionErrors,
    opening: openingRows, shortfallSkus, shortfalls, baseShortfalls, monthly, products: productsOut, layers: layersOut, saleLines,
    variances: varianceRows, supplierReturns: R.supplierReturnRows, customerReturns: R.returnRows, adjustments: R.adjustmentRows, writeOffs: R.writeOffRows,
    flags: R.flags, unknownCodes: unknownOut,
  };
}
