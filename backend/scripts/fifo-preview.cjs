#!/usr/bin/env node
/**
 * FIFO historical preview — READ-ONLY (phase 2 of the FIFO plan, Nov 13, 2026).
 *
 *   node scripts/fifo-preview.cjs --db soulia_fifocheck                      # report + decisions workbook
 *   node scripts/fifo-preview.cjs --db soulia_fifocheck --import edited.xlsx # read the owner's decisions, re-run
 *
 * Compiles src/inventory-costing/fifo-preview.ts on its own (no Nest, no crons), reads the given
 * database and writes, into --out (default ../artifacts/fifo-preview, gitignored):
 *   preview.json · fifo-preview.xlsx (report) · fifo-preview.html · fifo-decisions.xlsx (to fill in)
 *   fifo-decisions.json (only after --import: the decisions the preview used)
 * It never writes to Mongo. ⚠ Refuses the live database name `soulia`.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const dbName = arg('db');
const uri = arg('uri', 'mongodb://127.0.0.1:27018/?replicaSet=souliaDev&directConnection=true');
const order = arg('order', 'created');
const outDir = path.resolve(arg('out', path.join(root, '..', 'artifacts', 'fifo-preview')));
const decisionsPath = path.resolve(arg('decisions', path.join(outDir, 'fifo-decisions.json')));
const importPath = arg('import');
if (!dbName) { console.error('--db is required (a scratch copy, e.g. soulia_fifocheck)'); process.exit(1); }
if (dbName === 'soulia') { console.error('Refusing the live database "soulia". Copy it to a scratch database first.'); process.exit(1); }

const build = fs.mkdtempSync(path.join(os.tmpdir(), 'fifo-preview-'));
execSync(`npx tsc src/inventory-costing/fifo-preview.ts --outDir "${build}" --module commonjs --target es2020 --esModuleInterop --skipLibCheck`, { cwd: root, stdio: 'inherit' });
const { loadFifoHistory, buildFifoPreview } = require(path.join(build, 'inventory-costing', 'fifo-preview.js'));
const { MongoClient } = require(path.join(root, 'node_modules', 'mongodb'));
const ExcelJS = require(path.join(root, 'node_modules', 'exceljs'));

const N = (v) => (typeof v === 'number' ? v : Number(v) || 0);
const f = (v) => N(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SOURCE_AR = { 'card-at-creation': 'سعر الكارت وقت الإنشاء', 'card-unchanged': 'سعر الكارت (ماتغيّرش)', 'supplier-price': 'سعر المورد', missing: 'غير معروف' };
const STATUS_AR = { traced: 'متتبعة لفاتورة/دفعة معتمدة', 'late-entry-verified': 'فاتورة اتسجلت بعد البيع — متأكد', 'opening-pending': 'من رصيد افتتاحي غير معتمد', 'late-entry-unverified': 'فاتورة اتسجلت بعد البيع — غير متأكد', unresolved: 'غير محسوم — بتكلفته الحالية' };
const CAUSE_AR = { 'opening-lowered': 'الرصيد الافتتاحي اتصفّر بعد البيع', 'never-purchased': 'مفيش فاتورة ولا رصيد', 'late-entry-verified': 'الفاتورة اتسجلت متأخر — متأكد', 'late-entry-unverified': 'الفاتورة اتسجلت متأخر — غير متأكد', 'still-open': 'مفتوح', 'non-sale': 'تسوية / مرتجع مورد' };
const TRACE_AR = { invoice: 'فاتورة شراء', 'decided-invoice': 'فاتورة تاريخية (قرار)', 'opening-approved': 'رصيد افتتاحي معتمد', 'opening-decided': 'دفعة افتتاحية (قرار)', 'opening-pending': 'رصيد افتتاحي غير معتمد', adjustment: 'تسوية بتكلفة فاتورة', gift: 'عينات هدية بدون تكلفة (قرار)', untraced: 'بدون مصدر' };

// ── decisions workbook: labels ↔ stored values ──
const OPEN_DEC = { 'معلق': 'pending', 'اعتماد المقترح': 'approve', 'تعديل': 'edit' };
const SHORT_DEC = { 'معلق': 'pending', 'دفعة افتتاحية': 'opening-batch', 'فاتورة شراء تاريخية': 'historical-purchase', 'عينات هدية (بدون تكلفة)': 'gift' };
const REMAINDER = { 'لا يوجد': 'none', 'شطب': 'write-off', 'موجود في المخزن': 'keep' };
const UNK_DEC = { 'معلق': 'pending', 'ربط بصنف': 'map', 'قبول كما هو': 'accept' };
const labelOf = (map, v) => Object.keys(map).find((k) => map[k] === v) || 'معلق';
const list = (map) => [`"${Object.keys(map).join(',')}"`];

const OPEN_COLS = [
  ['الكود', 'code', 22], ['الصنف', 'name', 26], ['الكمية الحالية', 'qtyNow', 10], ['سجل تعديل الرصيد', 'history', 30],
  ['التكلفة المقترحة', 'proposedCost', 12], ['مصدرها', 'src', 20], ['السبب', 'reason', 36],
  ['سعر الكارت الحالي', 'cardCurrent', 11], ['سعر الكارت وقت الإنشاء', 'cardAtCreation', 12], ['سعر المورد', 'supplierPrice', 10], ['أول فاتورة (مرجع فقط)', 'firstRef', 18], ['تنبيهات', 'warnings', 32],
  ['القرار', 'decisionLabel', 15, 'dec'], ['التكلفة المعتمدة', 'approvedCost', 12, 'dec'], ['الكمية المعتمدة (اختياري)', 'qtyOverride', 12, 'dec'], ['ملاحظة', 'decisionNote', 26, 'dec'], ['بواسطة', 'decidedBy', 12, 'dec'],
];
const SHORT_COLS = [
  ['الكود', 'code', 20], ['الصنف', 'name', 26], ['مباع', 'sold', 7], ['الناقص', 'openShortBefore', 8], ['الرصيد الافتتاحي كان', 'openingBefore', 10], ['اتصفّر في', 'loweredOn', 11],
  ['سجل الرصيد', 'openingHistory', 30], ['أول بيع', 'firstSale', 11], ['آخر بيع', 'lastSale', 11], ['سعر الكارت (للمعلومة فقط)', 'cardCost', 11], ['الاقتراح', 'suggestion', 60],
  ['الحل', 'resLabel', 18, 'dec'], ['الكمية', 'qty', 9, 'dec'], ['تكلفة القطعة', 'unitCost', 11, 'dec'], ['الباقي', 'remLabel', 14, 'dec'], ['تاريخ الشطب', 'writeOffDate', 12, 'dec'],
  ['المورد', 'supplier', 14, 'dec'], ['رقم الفاتورة', 'ref', 12, 'dec'], ['تاريخ الفاتورة', 'date', 12, 'dec'], ['ملاحظة', 'note', 26, 'dec'], ['بواسطة', 'by', 12, 'dec'],
];
const UNK_COLS = [['الكود', 'code', 20], ['سطور', 'lines', 7], ['الكمية', 'qty', 8], ['فواتير', 'refs', 30], ['القرار', 'decLabel', 14, 'dec'], ['الكود البديل', 'mapTo', 18, 'dec'], ['ملاحظة', 'note', 30, 'dec']];

async function writeDecisionsWorkbook(p, D, file) {
  const wb = new ExcelJS.Workbook();
  const sheet = (name, cols, rows, lists) => {
    const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1, xSplit: 1 }] });
    ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
    ws.addRows(rows);
    const head = ws.getRow(1); head.font = { bold: true }; head.alignment = { wrapText: true, vertical: 'middle' }; head.height = 32;
    cols.forEach(([, , , kind], i) => {
      const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: kind === 'dec' ? 'FFFFF4D6' : 'FFF1F3F2' } };
      ws.getColumn(i + 1).eachCell((c, r) => { c.fill = fill; if (r > 1) c.alignment = { wrapText: true, vertical: 'top' }; });
    });
    for (const [key, values] of Object.entries(lists || {})) {
      const col = cols.findIndex((c) => c[1] === key) + 1;
      for (let r = 2; r <= rows.length + 1; r++) ws.getCell(r, col).dataValidation = { type: 'list', allowBlank: true, formulae: list(values), showErrorMessage: true };
    }
  };
  const readme = wb.addWorksheet('اقرأني', { views: [{ rightToLeft: true }] });
  readme.getColumn(1).width = 120;
  readme.addRows([
    ['قرارات معاينة FIFO — الأعمدة الصفراء بس هي اللي بتتملي'],
    [''],
    ['قرارات الرصيد الافتتاحي: لكل صنف اختار «اعتماد المقترح» أو «تعديل» واكتب التكلفة المعتمدة. «معلق» = يفضل ظاهر كغير محسوم.'],
    ['الكمية المعتمدة اختيارية — لو اتملت بقيمة غير الحالية، رصيد المخزن هيتغيّر بالفرق والتقرير هيبيّنه.'],
    ['قرارات العجز: «دفعة افتتاحية» لو البضاعة كانت موجودة قبل تشغيل النظام، أو «فاتورة شراء تاريخية» لو اتشرت. تكلفة القطعة مطلوبة — مفيش تكلفة افتراضية.'],
    ['«عينات هدية (بدون تكلفة)»: بضاعة جت مجانًا — تكلفتها صفر بقرار صريح، من غير مورد ولا مديونية. سيب خانة التكلفة فاضية.'],
    ['الباقي (للدفعة الافتتاحية): «شطب» لو الكمية الزيادة عن المباع اتشالت — تاريخ الشطب لو فاضي = تاريخ تصفير الرصيد الافتتاحي.'],
    ['أكواد بدون صنف: «ربط بصنف» واكتب الكود الصحيح، أو «قبول كما هو».'],
    [''],
    ['بعد الملي: node scripts/fifo-preview.cjs --db soulia_fifocheck --import <المسار للملف ده>'],
    ['مفيش أي حاجة بتتكتب في قاعدة البيانات — الملف بيتقرا والمعاينة بتتعاد بس.'],
  ]);
  sheet('قرارات الرصيد الافتتاحي', OPEN_COLS, p.opening.map((r) => {
    const d = D.opening?.[r.code] || {};
    return { ...r, src: SOURCE_AR[r.proposedSource] || r.proposedSource, firstRef: r.firstPurchaseRef ? `#${r.firstPurchaseRef} ${r.firstPurchaseCost}` : '',
      decisionLabel: labelOf(OPEN_DEC, d.decision || 'pending'), approvedCost: d.decision === 'edit' ? d.cost : null, qtyOverride: d.qty ?? null, decisionNote: d.note || '', decidedBy: d.by || '' };
  }), { decisionLabel: OPEN_DEC });
  sheet('قرارات العجز', SHORT_COLS, p.shortfallSkus.filter((s) => !/^late-entry-verified$/.test(s.causes)).map((s) => {
    const d = D.shortfalls?.[s.code] || {};
    return { ...s, resLabel: labelOf(SHORT_DEC, d.resolution || 'pending'), qty: d.qty ?? null, unitCost: d.unitCost ?? null, remLabel: d.remainder ? labelOf(REMAINDER, d.remainder) : '',
      writeOffDate: d.writeOffDate || '', supplier: d.supplier || '', ref: d.ref || '', date: d.date || '', note: d.note || '', by: d.by || '' };
  }), { resLabel: SHORT_DEC, remLabel: REMAINDER });
  sheet('أكواد بدون صنف', UNK_COLS, p.unknownCodes.map((u) => {
    const d = D.unknownCodes?.[u.code] || {};
    return { ...u, decLabel: labelOf(UNK_DEC, d.decision || 'pending'), mapTo: d.mapTo || '', note: d.note || '' };
  }), { decLabel: UNK_DEC });
  await wb.xlsx.writeFile(file);
}

async function readDecisionsWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const cellVal = (v) => {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === 'object') return v.result ?? v.text ?? (v.richText ? v.richText.map((t) => t.text).join('') : '');
    return v;
  };
  const rowsOf = (name, cols) => {
    const ws = wb.getWorksheet(name);
    if (!ws) throw new Error(`الشيت «${name}» مش موجود في الملف`);
    const idx = {};
    ws.getRow(1).eachCell((c, i) => { const col = cols.find((x) => x[0] === String(cellVal(c.value)).trim()); if (col) idx[col[1]] = i; });
    const out = [];
    ws.eachRow((row, r) => {
      if (r === 1) return;
      const o = {};
      for (const [k, i] of Object.entries(idx)) { const v = cellVal(row.getCell(i).value); o[k] = typeof v === 'string' ? v.trim() : v; }
      if (o.code) out.push(o);
    });
    return out;
  };
  const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
  /** A date cell: a Date, an Excel serial number, or typed text (YYYY-MM-DD). */
  const dateCell = (v) => {
    if (v === '' || v === null || v === undefined) return undefined;
    if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    const t = new Date(String(v)); return Number.isFinite(t.getTime()) ? t.toISOString().slice(0, 10) : String(v);
  };
  const at = new Date().toISOString();
  const D = { source: `${path.basename(file)} @ ${at}`, opening: {}, shortfalls: {}, unknownCodes: {} };
  for (const r of rowsOf('قرارات الرصيد الافتتاحي', OPEN_COLS)) {
    const decision = OPEN_DEC[r.decisionLabel] || 'pending';
    if (decision === 'pending' && num(r.qtyOverride) === undefined) continue;
    D.opening[r.code] = { decision, cost: num(r.approvedCost), qty: num(r.qtyOverride), note: r.decisionNote || '', by: r.decidedBy || '', at };
  }
  for (const r of rowsOf('قرارات العجز', SHORT_COLS)) {
    const resolution = SHORT_DEC[r.resLabel] || 'pending';
    if (resolution === 'pending') continue;
    D.shortfalls[r.code] = { resolution, qty: num(r.qty), unitCost: num(r.unitCost), remainder: REMAINDER[r.remLabel] || 'none', writeOffDate: dateCell(r.writeOffDate),
      supplier: r.supplier || '', ref: r.ref ? String(r.ref) : '', date: dateCell(r.date), note: r.note || '', by: r.by || '', at };
  }
  for (const r of rowsOf('أكواد بدون صنف', UNK_COLS)) {
    const decision = UNK_DEC[r.decLabel] || 'pending';
    if (decision !== 'pending') D.unknownCodes[r.code] = { decision, mapTo: r.mapTo || '', note: r.note || '' };
  }
  return D;
}

async function writeReport(p, cleared, file) {
  const wb = new ExcelJS.Workbook();
  const sheet = (name, cols, rows) => {
    const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map(([header, key, width, fmt]) => ({ header, key, width: width || 14, style: fmt ? { numFmt: fmt } : {} }));
    ws.getRow(1).font = { bold: true };
    ws.addRows(rows);
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  };
  const M = '#,##0.00', s = p.summary;
  sheet('الملخص', [['البند', 'k', 50], ['القيمة', 'v', 30]], [
    { k: 'الحالة', v: p.approvable ? 'مفيش موانع — محتاج موافقتك الصريحة' : 'غير قابل للاعتماد — في حالات غير محسومة' },
    ...p.blockers.map((b) => ({ k: 'يمنع الاعتماد', v: b })),
    { k: 'القرارات المستخدمة', v: p.decisionsSource || 'مفيش — كل الحالات معلقة' },
    ...Object.entries(s.traceability).map(([k, v]) => ({ k: `سطور بيع: ${STATUS_AR[k] || k}`, v: `${v.lines} سطر · ${v.qty} قطعة` })),
    { k: 'رصيد افتتاحي (معتمد / معلق)', v: `${s.openingApproved} / ${s.openingPending} صنف — ${s.openingQty} قطعة` },
    { k: 'أصناف العجز (غير محسوم من إجمالي)', v: `${s.shortfallSkusUnresolved} من ${s.shortfallSkus}` },
    { k: 'قطع عجز مفتوح', v: s.openDeficitQty },
    { k: 'سطور اتوقّتت بوقت إضافتها للفاتورة (من سجل الحركة)', v: s.linesTimedByEdit },
    { k: 'تكلفة المبيعات قبل', v: s.cogsBefore }, { k: 'تكلفة المبيعات بعد', v: s.cogsAfter }, { k: 'منها غير محسوم/غير معتمد', v: s.pendingCost }, { k: 'فروق مرتجعات الموردين', v: s.variance },
    { k: 'مجمل الربح قبل', v: s.grossBefore }, { k: 'مجمل الربح بعد', v: s.grossAfter }, { k: 'الفرق', v: Math.round((s.grossAfter - s.grossBefore) * 100) / 100 },
    { k: 'قيمة المخزون قبل', v: s.valueBefore }, { k: 'قيمة المخزون بعد', v: s.valueAfter }, { k: 'منها من دفعات غير معتمدة', v: s.pendingValue },
    { k: 'قيمة الشطب (من القرارات)', v: s.writeOffValue },
    { k: 'أصناف رصيد FIFO = الرصيد المتوقع', v: `${s.reconciledProducts} من ${s.products}` },
  ]);
  sheet('الرصيد الافتتاحي', [['الكود', 'code', 22], ['الصنف', 'name', 26], ['الكمية', 'qty', 8], ['سجل الرصيد', 'history', 30], ['المقترح', 'proposedCost', 10, M], ['مصدره', 'src', 20],
    ['السبب', 'reason', 36], ['الكارت الحالي', 'cardCurrent', 10, M], ['الكارت وقت الإنشاء', 'cardAtCreation', 10, M], ['سعر المورد', 'supplierPrice', 10, M], ['أول فاتورة (مرجع)', 'firstPurchaseCost', 10, M], ['رقمها', 'firstPurchaseRef', 9],
    ['القرار', 'decisionAr', 14], ['المعتمد', 'approvedCost', 10, M], ['الحالة', 'st', 12], ['القيمة', 'value', 11, M], ['تنبيهات', 'warnings', 40], ['ملاحظة', 'decisionNote', 24]],
    p.opening.map((r) => ({ ...r, src: SOURCE_AR[r.proposedSource] || r.proposedSource, st: r.status === 'approved' ? 'معتمد' : 'معلق' })));
  sheet('أصناف العجز', [['الكود', 'code', 20], ['الصنف', 'name', 26], ['مباع', 'sold', 7], ['مشترى', 'purchased', 7], ['الناقص', 'openShortBefore', 8], ['الرصيد الحالي', 'stockNow', 9],
    ['سجل الرصيد الافتتاحي', 'openingHistory', 34], ['أول بيع', 'firstSale', 11], ['آخر بيع', 'lastSale', 11], ['السبب', 'causesAr', 28], ['الاقتراح', 'suggestion', 60],
    ['القرار', 'decisionText', 30], ['ناقص بعد القرار', 'openShortAfter', 10], ['الرصيد بعد القرار', 'stockAfterDecision', 10], ['الحالة', 'st', 12]],
    p.shortfallSkus.map((r) => ({ ...r, causesAr: r.causes.split(', ').map((c) => CAUSE_AR[c] || c).join(' · '), st: r.status === 'resolved' ? 'محسوم' : 'غير محسوم' })));
  sheet('حالات العجز', [['الكود', 'code', 20], ['الفاتورة', 'ref', 9], ['تاريخ البيع', 'saleDate', 11], ['خرج من المخزن', 'stockOutAt', 11], ['ناقص', 'shortQty', 7], ['تكلفته الحالية', 'todayCost', 11, M],
    ['السبب', 'causeAr', 80], ['اتغطى بـ', 'settledBy', 30], ['لسه مفتوح', 'openQty', 9]], p.shortfalls);
  sheet('اتحسمت بالتوقيت', [['الكود', 'code', 22], ['الفاتورة', 'ref', 9], ['الفاتورة اتسجلت', 'enteredAt', 12], ['السطر خرج من المخزن', 'stockOutAt', 13], ['اتصرف من', 'layers', 40], ['قطع ممسوحة من فاتورة', 'scannedFrom', 16], ['الشرح', 'why', 60]], cleared);
  sheet('الأرباح الشهرية', [['الشهر', 'month', 9], ['صافي المبيعات', 'revenue', 13, M], ['تكلفة قبل', 'cogsBefore', 13, M], ['تكلفة بعد', 'cogsAfter', 13, M], ['منها غير محسوم', 'pendingCost', 12, M],
    ['قطع بلا دفعة', 'unresolvedQty', 9], ['فروق مرتجع مورد', 'variance', 11, M], ['مجمل الربح قبل', 'grossBefore', 13, M], ['مجمل الربح بعد', 'grossAfter', 13, M], ['الفرق', 'diff', 11, M], ['نهائي؟', 'fin', 8]],
    p.monthly.map((m) => ({ ...m, fin: m.final ? 'نعم' : 'لا' })));
  sheet('الأصناف', [['الكود', 'code', 22], ['الصنف', 'name', 26], ['افتتاحي', 'opening', 8], ['مشتريات', 'purchased', 8], ['مبيعات', 'sold', 8], ['مرتجع عميل', 'returned', 8], ['مرتجع مورد', 'supplierReturned', 8], ['تسويات', 'adjusted', 8],
    ['رصيد المخزن', 'derivedStock', 9], ['المتوقع بعد القرارات', 'expectedAfterDecisions', 10], ['رصيد FIFO', 'fifoBalance', 9], ['متطابق', 'ok', 7],
    ['قيمة قبل', 'valueBefore', 12, M], ['قيمة بعد', 'valueAfter', 12, M], ['منها غير معتمد', 'pendingValue', 11, M], ['فرق القيمة', 'valueDiff', 11, M],
    ['تكلفة مبيعات قبل', 'cogsBefore', 12, M], ['بعد', 'cogsAfter', 12, M], ['فروق', 'variance', 9, M], ['الفرق', 'cogsDiff', 11, M], ['سطور غير متتبعة', 'linesNotTraced', 9]],
    p.products.map((r) => ({ ...r, ok: r.reconciled ? 'نعم' : 'لا' })));
  sheet('الدفعات', [['الكود', 'code', 22], ['المصدر', 'traceAr', 20], ['المرجع', 'ref', 26], ['المورد', 'supplier', 14], ['تاريخ الفاتورة', 'businessDate', 11], ['دخلت', 'enteredAt', 11],
    ['الكمية', 'originalQty', 8], ['المستهلك', 'consumedQty', 8], ['المتبقي', 'remainingQty', 8], ['تكلفة القطعة', 'unitCost', 11, M], ['قيمة المتبقي', 'remainingValue', 11, M], ['تكلفتها من', 'costFrom', 24]],
    p.layers.map((l) => ({ ...l, traceAr: TRACE_AR[l.trace] || l.trace })));
  sheet('سطور البيع', [['الفاتورة', 'ref', 9], ['التاريخ', 'date', 11], ['خرج من المخزن', 'stockOutAt', 11], ['الكود', 'code', 22], ['الكمية', 'qty', 6], ['السعر', 'price', 9, M],
    ['مصدر التكلفة الأصلي', 'costSourceBefore', 14], ['التكلفة الأصلية', 'costBefore', 11, M], ['تكلفة FIFO', 'costAfter', 11, M], ['منها غير محسوم', 'pendingCost', 10, M],
    ['الحالة', 'statusAr', 26], ['اتصرف من', 'layers', 50], ['قطع ممسوحة من', 'scannedFrom', 14], ['الدليل', 'evidence', 40]],
    p.saleLines.map((l) => ({ ...l, statusAr: STATUS_AR[l.status] || l.status })));
  sheet('مرتجعات الموردين', [['الكود', 'code', 22], ['المرجع', 'ref', 14], ['الطلب', 'order', 13], ['التاريخ', 'date', 11], ['الكمية', 'qty', 7], ['من الفاتورة المذكورة', 'fromNamedInvoice', 10],
    ['تكلفة FIFO', 'fifoCost', 11, M], ['خصم المورد', 'supplierCredit', 11, M], ['الفرق', 'variance', 10, M]], p.supplierReturns);
  sheet('مرتجعات العملاء', [['الكود', 'code', 22], ['المرجع', 'ref', 16], ['التاريخ', 'date', 11], ['الكمية', 'qty', 7], ['رجعت لدفعاتها', 'toOriginalLayers', 11], ['دفعة جديدة', 'asNewLayer', 9], ['البيعة الأصلية', 'originalRef', 11]], p.customerReturns);
  sheet('التسويات', [['الكود', 'code', 22], ['التاريخ', 'date', 11], ['الكمية', 'qty', 7], ['تكلفة القطعة', 'unitCost', 11, M], ['القيمة', 'value', 11, M], ['مصدر التكلفة', 'costFrom', 30], ['السبب', 'reason', 28]], p.adjustments);
  sheet('الشطب', [['الكود', 'code', 22], ['التاريخ', 'date', 11], ['الكمية', 'qty', 7], ['القيمة', 'value', 11, M], ['ملاحظة', 'note', 30]], p.writeOffs);
  sheet('أكواد بدون صنف', [['الكود', 'code', 22], ['سطور', 'lines', 7], ['الكمية', 'qty', 7], ['فواتير', 'refs', 30], ['القرار', 'decision', 12]], p.unknownCodes);
  sheet('أخطاء القرارات', [['النوع', 'area', 14], ['الكود', 'code', 22], ['الخطأ', 'error', 60]], p.decisionErrors);
  await wb.xlsx.writeFile(file);
}

function writeHtml(p, cleared, file) {
  const s = p.summary;
  const diffCls = (v) => (N(v) > 0.005 ? 'pos' : N(v) < -0.005 ? 'neg' : '');
  const tbl = (head, rows) => `<div class="tw"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${head.length}" class="mut">—</td></tr>`}</tbody></table></div>`;
  const pill = (ok, yes, no) => `<span class="pill ${ok ? 'ok' : 'warn'}">${ok ? yes : no}</span>`;
  const products = [...p.products].sort((a, b) => Math.abs(b.valueDiff) + Math.abs(b.cogsDiff) - Math.abs(a.valueDiff) - Math.abs(a.cogsDiff));
  const tr = s.traceability;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>معاينة FIFO</title><style>
:root{--bg:#f7f8f7;--card:#fff;--text:#1d2420;--muted:#5f6b64;--border:#e2e6e3;--pos:#137a3a;--neg:#b42318;--warn:#8a5a00;--warnbg:#fff7e6;--okbg:#e9f6ee}
@media (prefers-color-scheme:dark){:root{--bg:#121614;--card:#1a201d;--text:#e6ebe8;--muted:#9aa6a0;--border:#2c3530;--pos:#5fd08a;--neg:#ff8a80;--warn:#f0c060;--warnbg:#2b2416;--okbg:#15281d}}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,"Segoe UI",Tahoma,sans-serif}
main{max-width:1240px;margin:0 auto;padding:24px 16px 64px}h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.1rem;margin:32px 0 6px}
.sub,.mut{color:var(--muted)}.sub{margin:0 0 20px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.kpi{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:12px}
.kpi b{display:block;font-size:1.05rem;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:.85rem}
.block{background:var(--warnbg);border:1px solid var(--border);border-inline-start:4px solid var(--warn);border-radius:8px;padding:12px 16px}.block.ok{background:var(--okbg);border-inline-start-color:var(--pos)}
.tw{overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:var(--card)}table{border-collapse:collapse;width:100%;font-size:.86rem}
th,td{padding:7px 10px;border-bottom:1px solid var(--border);text-align:start;white-space:nowrap;vertical-align:top}th{background:var(--bg);font-weight:600}
td.n,th.n{text-align:end;font-variant-numeric:tabular-nums}td.w{white-space:normal;min-width:280px}.pos{color:var(--pos)}.neg{color:var(--neg)}
bdi,.code{unicode-bidi:isolate}.code{font-family:ui-monospace,Consolas,monospace;font-size:.82rem}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.78rem;border:1px solid var(--border)}.pill.ok{background:var(--okbg);color:var(--pos)}.pill.warn{background:var(--warnbg);color:var(--warn)}
</style></head><body><main>
<h1>معاينة التحويل لـ FIFO</h1>
<p class="sub">قاعدة بيانات تجريبية · ${esc(p.generatedAt.slice(0, 16).replace('T', ' '))} · الترتيب بوقت خروج/دخول البضاعة · القرارات: ${esc(p.decisionsSource || 'مفيش — كل الحالات معلقة')} · قراءة فقط</p>
<div class="block ${p.approvable ? 'ok' : ''}"><b>${p.approvable ? 'مفيش موانع ظاهرة — التحويل محتاج موافقتك الصريحة' : 'غير قابل للاعتماد — الحالات دي لسه مفتوحة:'}</b><ul>${p.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>

<h2>مصدر تكلفة كل سطر بيع</h2>
${tbl(['الحالة', 'سطور', 'قطع'], Object.entries(tr).map(([k, v]) => `<tr><td>${esc(STATUS_AR[k] || k)}</td><td class="n">${v.lines}</td><td class="n">${v.qty}</td></tr>`))}
<p class="mut">السطر «متتبع» لما كل قطعة فيه جاية من فاتورة شراء أو دفعة افتتاحية معتمدة. غير ده بيفضل بتكلفته الحالية من غير تغيير، ومعلّم.</p>

<h2>الأرقام</h2><div class="kpis">
<div class="kpi"><span>مجمل الربح (كل الفترة)</span><b><bdi>${f(s.grossBefore)}</bdi> ← <bdi>${f(s.grossAfter)}</bdi></b><span class="${diffCls(s.grossAfter - s.grossBefore)}">الفرق <bdi>${f(s.grossAfter - s.grossBefore)}</bdi> — ${s.final ? 'نهائي' : 'غير نهائي'}</span></div>
<div class="kpi"><span>تكلفة المبيعات</span><b><bdi>${f(s.cogsBefore)}</bdi> ← <bdi>${f(s.cogsAfter)}</bdi></b><span>منها غير محسوم/غير معتمد <bdi>${f(s.pendingCost)}</bdi></span></div>
<div class="kpi"><span>قيمة المخزون الحالي</span><b><bdi>${f(s.valueBefore)}</bdi> ← <bdi>${f(s.valueAfter)}</bdi></b><span>منها دفعات غير معتمدة <bdi>${f(s.pendingValue)}</bdi></span></div>
<div class="kpi"><span>الرصيد الافتتاحي</span><b>${s.openingApproved} معتمد · ${s.openingPending} معلق</b><span>${s.openingQty} قطعة على ${s.openingProducts} صنف</span></div>
<div class="kpi"><span>أصناف العجز</span><b>${s.shortfallSkusUnresolved} غير محسوم من ${s.shortfallSkus}</b><span>${s.openDeficitQty} قطعة بلا دفعة</span></div>
<div class="kpi"><span>رصيد FIFO = الرصيد المتوقع</span><b>${s.reconciledProducts} من ${s.products}</b><span>${s.purchaseLayers} دفعة شراء · ${s.saleLines} سطر بيع</span></div></div>

<h2>أصناف العجز</h2>
${tbl(['الكود', 'الصنف', 'مباع', 'ناقص', 'الرصيد الحالي', 'سجل الرصيد الافتتاحي', 'السبب', 'الاقتراح', 'القرار', 'الحالة'],
    p.shortfallSkus.map((r) => `<tr><td class="code">${esc(r.code)}</td><td>${esc(r.name)}</td><td class="n">${r.sold}</td><td class="n">${r.openShortBefore || r.shortQty}</td><td class="n ${r.stockNow < 0 ? 'neg' : ''}">${r.stockNow}</td><td class="w">${esc(r.openingHistory) || '—'}</td><td class="w">${esc(r.causes.split(', ').map((c) => CAUSE_AR[c] || c).join(' · '))}</td><td class="w">${esc(r.suggestion)}</td><td class="w">${esc(r.decisionText)}</td><td>${pill(r.status === 'resolved', 'محسوم', 'غير محسوم')}</td></tr>`))}
<p class="mut">سعر الكارت (75) مش مستخدم كتكلفة نهائية لأي قطعة هنا. القطع دي باقية بتكلفتها الحالية في التقارير لحد ما تيجي فاتورة شراء تاريخية أو دفعة افتتاحية معتمدة.</p>

<h2>حالات اتحسمت بالتوقيت الفعلي</h2>
<p class="mut">في المعاينة الأولى كانت بتبان عجز لأن السطر اتحسب بوقت إنشاء الفاتورة. سجل الحركة بيبيّن إن الصنف اتضاف للفاتورة في تعديل بعد ما فاتورة الشراء اتسجلت.</p>
${tbl(['الكود', 'الفاتورة', 'اتسجلت', 'السطر خرج', 'اتصرف من', 'قطع ممسوحة من', 'الشرح'],
    cleared.map((c) => `<tr><td class="code">${esc(c.code)}</td><td>${esc(c.ref)}</td><td>${esc(c.enteredAt)}</td><td>${esc(c.stockOutAt)}</td><td class="w">${esc(c.layers)}</td><td>${esc(c.scannedFrom) || '—'}</td><td class="w">${esc(c.why)}</td></tr>`))}
${p.shortfalls.some((x) => x.cause === 'late-entry-verified') ? `<p class="mut">وحالات اتباعت قبل تسجيل فاتورتها والدليل موجود إن البضاعة كانت متاحة:</p>${tbl(['الكود', 'الفاتورة', 'الشرح'], p.shortfalls.filter((x) => x.cause === 'late-entry-verified').map((x) => `<tr><td class="code">${esc(x.code)}</td><td>${esc(x.ref)}</td><td class="w">${esc(x.causeAr)}</td></tr>`))}` : ''}

<h2>الرصيد الافتتاحي — ${s.openingQty} قطعة</h2>
<p class="mut">المقترح سعر الكارت وقت إنشاء الصنف — مش أول فاتورة شراء، ومش معتمد غير بقرارك في ملف القرارات.</p>
${tbl(['الكود', 'الصنف', 'الكمية', 'المقترح', 'المصدر', 'أول فاتورة (مرجع)', 'سجل الرصيد', 'القرار', 'المستخدم', 'تنبيهات'],
    p.opening.map((r) => `<tr><td class="code">${esc(r.code)}</td><td>${esc(r.name)}</td><td class="n">${r.qty}</td><td class="n">${f(r.proposedCost)}</td><td>${esc(SOURCE_AR[r.proposedSource] || r.proposedSource)}</td><td class="n">${r.firstPurchaseCost === null ? '—' : `${f(r.firstPurchaseCost)} <span class="mut">#${esc(r.firstPurchaseRef)}</span>`}</td><td class="w">${esc(r.history) || '—'}</td><td>${pill(r.status === 'approved', esc(r.decisionAr), 'معلق')}</td><td class="n">${f(r.usedCost)}</td><td class="w">${esc(r.warnings)}</td></tr>`))}

<h2>الأرباح الشهرية</h2>
${tbl(['الشهر', 'صافي المبيعات', 'تكلفة قبل', 'تكلفة بعد', 'منها غير محسوم', 'فروق مرتجع مورد', 'مجمل الربح قبل', 'مجمل الربح بعد', 'الفرق', 'نهائي؟'],
    p.monthly.map((m) => `<tr><td>${m.month}</td><td class="n">${f(m.revenue)}</td><td class="n">${f(m.cogsBefore)}</td><td class="n">${f(m.cogsAfter)}</td><td class="n">${f(m.pendingCost)}</td><td class="n">${f(m.variance)}</td><td class="n">${f(m.grossBefore)}</td><td class="n">${f(m.grossAfter)}</td><td class="n ${diffCls(m.diff)}">${f(m.diff)}</td><td>${pill(m.final, 'نعم', 'لا')}</td></tr>`))}

<h2>الأصناف — قيمة المخزون وتكلفة المبيعات</h2>
${tbl(['الكود', 'الصنف', 'رصيد المخزن', 'المتوقع بعد القرارات', 'رصيد FIFO', 'قيمة قبل', 'قيمة بعد', 'فرق القيمة', 'تكلفة مبيعات قبل', 'بعد (+ فروق)', 'فرق التكلفة', 'سطور غير متتبعة'],
    products.map((r) => `<tr><td class="code">${esc(r.code)}</td><td>${esc(r.name)}</td><td class="n ${r.derivedStock < 0 ? 'neg' : ''}">${r.derivedStock}</td><td class="n">${r.expectedAfterDecisions}</td><td class="n ${r.reconciled ? '' : 'neg'}">${r.fifoBalance}</td><td class="n">${f(r.valueBefore)}</td><td class="n">${f(r.valueAfter)}</td><td class="n ${diffCls(r.valueDiff)}">${f(r.valueDiff)}</td><td class="n">${f(r.cogsBefore)}</td><td class="n">${f(r.cogsAfter + r.variance)}</td><td class="n ${diffCls(-r.cogsDiff)}">${f(r.cogsDiff)}</td><td class="n">${r.linesNotTraced || ''}</td></tr>`))}
${p.unknownCodes.length ? `<h2>أكواد بدون صنف</h2>${tbl(['الكود', 'سطور', 'الكمية', 'فواتير', 'القرار'], p.unknownCodes.map((u) => `<tr><td class="code">${esc(u.code)}</td><td class="n">${u.lines}</td><td class="n">${u.qty}</td><td>${esc(u.refs)}</td><td>${pill(u.decision !== 'pending', esc(u.decision), 'معلق')}</td></tr>`))}` : ''}
${p.decisionErrors.length ? `<h2>قرارات مرفوضة</h2>${tbl(['النوع', 'الكود', 'الخطأ'], p.decisionErrors.map((e) => `<tr><td>${esc(e.area)}</td><td class="code">${esc(e.code)}</td><td class="w">${esc(e.error)}</td></tr>`))}` : ''}
</main></body></html>`;
  fs.writeFileSync(file, html);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  let decisions = {};
  if (importPath) {
    decisions = await readDecisionsWorkbook(path.resolve(importPath));
    fs.writeFileSync(decisionsPath, JSON.stringify(decisions, null, 1));
    console.log('decisions imported →', decisionsPath);
  } else if (fs.existsSync(decisionsPath)) decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
  const client = await MongoClient.connect(uri);
  try {
    const history = await loadFifoHistory(client.db(dbName));
    const preview = buildFifoPreview(history, { order, decisions });
    // cases that only looked short because a line was timed by its invoice's creation
    const naive = buildFifoPreview(history, { order, decisions, ignoreMovementLog: true });
    const key = (x) => `${x.code}|${x.ref}`;
    const real = new Set(preview.baseShortfalls.map(key));
    const cleared = naive.baseShortfalls.filter((x) => !real.has(key(x))).map((x) => {
      const l = preview.saleLines.find((s) => s.code === x.code && s.ref === x.ref) || {};
      return { code: x.code, ref: x.ref, enteredAt: l.enteredAt, stockOutAt: l.stockOutAt, layers: l.layers, scannedFrom: l.scannedFrom,
        why: `الصنف اتضاف للفاتورة في تعديل يوم ${l.stockOutAt} بعد تسجيل فاتورة الشراء اللي غطّته${l.scannedFrom ? ` — والقطع الممسوحة على البيعة من فاتورة ${l.scannedFrom}` : ''}` };
    });
    fs.writeFileSync(path.join(outDir, 'preview.json'), JSON.stringify({ ...preview, clearedByTiming: cleared }, null, 1));
    await writeReport(preview, cleared, path.join(outDir, 'fifo-preview.xlsx'));
    writeHtml(preview, cleared, path.join(outDir, 'fifo-preview.html'));
    await writeDecisionsWorkbook(preview, decisions, path.join(outDir, 'fifo-decisions.xlsx'));
    console.log(JSON.stringify(preview.summary, null, 1));
    console.log('blockers:', preview.blockers);
    console.log('cleared by timing:', cleared.map((c) => `${c.code} #${c.ref}`).join(', '));
    console.log('written to', outDir);
  } finally { await client.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
