#!/usr/bin/env node
'use strict';
/**
 * Shipping-discount reclassification — FINAL APPROVAL REPORT (read only).
 *
 *   node scripts/shipping-discount-approval-report.cjs --db soulia
 *
 * Applies the owner's decisions (Nov 13, 2026) to the current plan and lists exactly what an approved
 * run would write. It only READS (find/aggregate) — no insert, update or delete anywhere — and writes
 * its files to artifacts/shipping-discount/approval/ (the dry-run reports next to it are not touched).
 *
 * Decisions applied:
 *   1. The cancelled sales (review section) are excluded — none are written.
 *   2. #2341 is excluded entirely (both its cancelled and its re-entered sale); +200 flagged for the accountant.
 *   3. #2488 is excluded until the owner confirms the free-shipping removal.
 *   4. Invoices edited in Soulia (total ≠ Shopify) are neither corrected nor excluded: a separate review group.
 * ⚠ Uses the compiled correction module (dist/) — the same plan the admin endpoint builds.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');
const { buildCorrectionPlan, loadCorrectionInputs } = require(path.resolve(__dirname, '../dist/transactions/shipping-discount-correction.js'));

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const URI = arg('uri', 'mongodb://127.0.0.1:27018/?replicaSet=souliaDev&directConnection=true');
const DB = arg('db', 'soulia');
const OUT = path.resolve(__dirname, '../../artifacts/shipping-discount/approval');
const EXCLUDED_REFS = { '2341': 'قرار المالك: لا يُلمس — +200 غير مفسَّر للمراجعة المحاسبية', '2488': 'قرار المالك: بدون تغيير حتى تأكيد إزالة الشحن المجاني' };
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? r2(n) : null; };

const u = new URL(URI.replace(/^mongodb:\/\//, 'http://'));
if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.username || u.password) throw Error('Refusing: local unauthenticated server only.');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 10000 });
  try {
    const db = client.db(DB);
    const plan = buildCorrectionPlan(await loadCorrectionInputs(db), DB);

    // Read-only details for the review group and the exclusions.
    const ids = [...plan.affected, ...plan.cancelledReview].map(r => r.shopifyOrderId);
    const orders = await db.collection('shopifyorders').find({ shopifyId: { $in: ids } }, { projection: {
      shopifyId: 1, 'rawData.total_line_items_price': 1, 'rawData.subtotal_price': 1, 'rawData.current_subtotal_price': 1, 'rawData.total_discounts': 1,
      'rawData.current_total_discounts': 1, 'rawData.total_price': 1, 'rawData.current_total_price': 1, 'rawData.shipping_lines': 1,
      'rawData.line_items': 1, 'rawData.financial_status': 1, 'rawData.cancelled_at': 1 } }).toArray();
    const orderById = new Map(orders.map(o => [String(o.shopifyId), o.rawData || {}]));
    const { ObjectId } = require('mongodb');
    const txIds = plan.affected.filter(r => r.editedInSoulia).map(r => ObjectId.isValid(r.txId) ? new ObjectId(r.txId) : r.txId);
    const txDocs = await db.collection('transactions').find({ _id: { $in: txIds } }, { projection: { items: 1, deposit: 1, remaining: 1, editHistory: 1, createdAt: 1 } }).toArray();
    const txById = new Map(txDocs.map(t => [String(t._id), t]));

    const excludedRows = [];
    const isExcludedRef = (ref) => Object.prototype.hasOwnProperty.call(EXCLUDED_REFS, ref);
    for (const r of plan.cancelledReview) excludedRows.push({ ref: r.ref, txId: r.txId, kind: 'ملغاة', reason: isExcludedRef(r.ref) ? EXCLUDED_REFS[r.ref] : 'قرار المالك: الملغاة مستبعدة — لا تُعدَّل سجلاتها', shippingDiscount: r.shippingDiscount, vaultNet: r.vaultNet });
    for (const s of plan.skipped) if (isExcludedRef(s.ref)) excludedRows.push({ ref: s.ref, txId: s.txId, kind: 'مستبعدة من الخطة', reason: EXCLUDED_REFS[s.ref] + ` (${s.detail || s.reason})` });

    const eligible = [], review = [];
    for (const r of plan.affected) {
      if (isExcludedRef(r.ref)) { excludedRows.push({ ref: r.ref, txId: r.txId, kind: 'مستبعدة', reason: EXCLUDED_REFS[r.ref], shippingDiscount: r.shippingDiscount }); continue; }
      if (r.editedInSoulia) review.push(r); else eligible.push(r);
    }

    const reviewRows = review.map(r => {
      const raw = orderById.get(r.shopifyOrderId) || {};
      const shipLines = raw.shipping_lines || [];
      const lines = (raw.line_items || []).filter(l => Number(l.current_quantity ?? l.quantity) > 0);
      const t = txById.get(r.txId) || {};
      const edits = (t.editHistory || []).filter(h => !h.correctionRunId);
      const last = edits[edits.length - 1];
      // Shopify's ORIGINAL values (at the order) and its CURRENT ones (after edits/refunds in Shopify).
      const shopifyItems = money(raw.total_line_items_price ?? raw.subtotal_price);
      const shopifyOrigTotal = money(raw.total_price);
      const shopifyTotal = money(raw.current_total_price);
      const shopifyCurItems = money(raw.current_subtotal_price);
      const shopifyDiscount = money(raw.total_discounts);
      const shopifyShipDisc = r.shopifyShippingDiscount;
      const reasons = [];
      const shopifyChanged = shopifyOrigTotal !== null && shopifyTotal !== null && Math.abs(shopifyOrigTotal - shopifyTotal) > 0.5;
      const souliaChanged = shopifyOrigTotal === null || Math.abs(shopifyOrigTotal - r.total) > 0.5;
      if (raw.cancelled_at || shopifyTotal === 0) reasons.push(`⚠ الطلب ملغى/مسترد في Shopify (${raw.financial_status || '—'}) بينما الفاتورة في النظام قائمة`);
      else if (shopifyChanged) reasons.push(`تغيّر في Shopify بعد الطلب (الأصلي ${shopifyOrigTotal} ← الحالي ${shopifyTotal}) والنظام احتفظ بقيمته`);
      if (shopifyItems !== null && Math.abs(shopifyItems - r.itemsTotal) > 0.5) reasons.push(`الأصناف عُدّلت في النظام (Shopify الأصلي ${shopifyItems} ← النظام ${r.itemsTotal})`);
      if (shopifyDiscount !== null && Math.abs(shopifyDiscount - r.discount) > 0.5) reasons.push(`الخصم عُدّل في النظام (${shopifyDiscount} ← ${r.discount})`);
      if (Math.abs((money(shipLines[0]?.price) ?? r.shipCost) - r.shipCost) > 0.5) reasons.push(`الشحن عُدّل في النظام (${money(shipLines[0]?.price)} ← ${r.shipCost})`);
      const changedOn = souliaChanged && shopifyChanged ? 'الاثنان' : shopifyChanged ? 'Shopify' : 'النظام';
      const holdsShipDiscount = r.discount + 0.005 >= r.shippingDiscount;
      return {
        ref: r.ref, txId: r.txId, date: r.date, client: r.client,
        shopify: { itemsTotal: shopifyItems, discount: shopifyDiscount, shipping: money(shipLines[0]?.price), shippingDiscount: shopifyShipDisc,
          originalTotal: shopifyOrigTotal, currentItems: shopifyCurItems, total: shopifyTotal,
          lines: lines.length, qty: lines.reduce((s, l) => s + Number(l.current_quantity ?? l.quantity ?? 0), 0),
          financialStatus: raw.financial_status || '', cancelledAt: raw.cancelled_at || '' },
        soulia: { itemsTotal: r.itemsTotal, discount: r.discount, shipCost: r.shipCost, total: r.total, deposit: r2(t.deposit), remaining: r2(t.remaining),
          lines: (t.items || []).length, qty: (t.items || []).reduce((s, i) => s + (Number(i.qty) || 0), 0),
          lastEdit: last ? `${String(last.editedAt || '').slice(0, 10)} — ${last.editedBy || ''}` : '', edits: edits.length },
        proposed: { shippingDiscount: r.shippingDiscount, productDiscount: r.after.productDiscount, shippingCharged: r.after.shippingCharged,
          netProductSales: r.after.netProductSales, grossProfitBefore: r.before.grossProfit, grossProfitAfter: r.after.grossProfit },
        verification: {
          status: holdsShipDiscount ? 'بانتظار تأكيد المالك' : 'لا يمكن التصنيف — الخصم المخزَّن أقل من خصم الشحن',
          storedDiscountHoldsShipping: holdsShipDiscount,
          grossProfitUnchanged: r.grossProfitEqual,
          changedOn,
          why: reasons.length ? reasons.join(' · ') : 'الإجمالي يختلف عن Shopify',
        },
      };
    });

    const sum = (rows, f) => r2(rows.reduce((s, r) => s + f(r), 0));
    const totals = (rows) => ({ count: rows.length, shippingDiscount: sum(rows, r => r.shippingDiscount),
      productDiscountBefore: sum(rows, r => r.before.productDiscount), productDiscountAfter: sum(rows, r => r.after.productDiscount),
      netProductSalesBefore: sum(rows, r => r.before.netProductSales), netProductSalesAfter: sum(rows, r => r.after.netProductSales),
      grossProfitBefore: sum(rows, r => r.before.grossProfit), grossProfitAfter: sum(rows, r => r.after.grossProfit) });
    const eligibleList = eligible.map(r => ({ txId: r.txId, ref: r.ref, date: r.date, month: r.month, client: r.client,
      total: r.total, discount: r.discount, shipCost: r.shipCost, shippingDiscount: r.shippingDiscount,
      productDiscountAfter: r.after.productDiscount, shippingChargedAfter: r.after.shippingCharged, grossProfitUnchanged: r.grossProfitEqual }));
    const listHash = crypto.createHash('sha256').update(JSON.stringify(eligibleList.map(r => [r.txId, r.shippingDiscount, r.total, r.discount, r.shipCost]))).digest('hex');

    const report = {
      generatedAt: new Date().toISOString(), database: DB, readOnly: true,
      decisions: ['الملغاة الأربعة مستبعدة ولا تُعدَّل', '#2341 لا يُلمس — +200 (TXN-003) للمراجعة المحاسبية', '#2488 بدون تغيير حتى تأكيد المالك',
        'الفواتير المعدّلة في النظام: مجموعة مراجعة منفصلة — لا تصحيح ولا استبعاد تلقائي'],
      eligible: { ...totals(eligible), listSha256: listHash, list: eligibleList },
      reviewGroup: { ...totals(review), rows: reviewRows },
      excluded: excludedRows,
      accountantFlags: [{ ref: '2341', amount: 200, entry: 'TXN-003', note: 'زيادة إجمالي مبيعات 1550 ← 1750 على فاتورة مدفوعة بالكامل (9 أغسطس، قبل إصلاح 27 أغسطس) — لم تُعكس عند الإلغاء' }],
      checksFromPlan: plan.checks,
    };
    fs.writeFileSync(path.join(OUT, 'approval-report.json'), JSON.stringify(report, null, 1));
    fs.writeFileSync(path.join(OUT, 'eligible-txids.json'), JSON.stringify({ generatedAt: report.generatedAt, count: eligibleList.length,
      shippingDiscount: report.eligible.shippingDiscount, sha256: listHash, onlyTxIds: eligibleList.map(r => r.txId) }, null, 1));

    // Workbook
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); wb.views = [{ rightToLeft: true }];
    const fmt = '#,##0.00';
    const sheet = (name, cols, rows) => {
      const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
      ws.columns = cols.map(([header, key, width, num]) => ({ header, key, width: width || 14, style: num ? { numFmt: fmt } : {} }));
      ws.getRow(1).font = { bold: true }; rows.forEach(r => ws.addRow(r));
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    };
    const E = report.eligible, R = report.reviewGroup;
    sheet('الملخص', [['البند', 'k', 58], ['القيمة', 'v', 22]], [
      { k: 'الفواتير المؤهلة للتصحيح (بعد الاستبعادات)', v: E.count }, { k: 'إجمالي خصم الشحن للفواتير المؤهلة', v: E.shippingDiscount },
      { k: 'صافي مبيعات المنتجات — قبل', v: E.netProductSalesBefore }, { k: 'صافي مبيعات المنتجات — بعد', v: E.netProductSalesAfter },
      { k: 'الربح الإجمالي — قبل', v: E.grossProfitBefore }, { k: 'الربح الإجمالي — بعد', v: E.grossProfitAfter },
      { k: 'مجموعة المراجعة (معدّلة في النظام) — عدد', v: R.count }, { k: 'مجموعة المراجعة — خصم الشحن', v: R.shippingDiscount },
      { k: 'مستبعدة بقرار المالك', v: report.excluded.length },
      { k: 'بصمة القائمة المؤهلة (sha256)', v: listHash }, { k: 'تاريخ التقرير', v: report.generatedAt }, { k: 'قراءة فقط — لم يُكتب شيء', v: 'نعم' },
    ]);
    sheet('المؤهلة للتصحيح', [['المرجع', 'ref', 9], ['التاريخ', 'date', 11], ['العميل', 'client', 22], ['الإجمالي (ثابت)', 'total', 13, 1],
      ['الخصم المخزَّن (ثابت)', 'discount', 14, 1], ['الشحن (ثابت)', 'shipCost', 11, 1], ['خصم الشحن المقترح', 'shippingDiscount', 14, 1],
      ['خصم المنتجات بعد', 'productDiscountAfter', 14, 1], ['الشحن المحصَّل بعد', 'shippingChargedAfter', 14, 1], ['الربح متطابق', 'eq', 10], ['المعرّف', 'txId', 26]],
      eligibleList.map(r => ({ ...r, eq: r.grossProfitUnchanged ? 'نعم' : 'لا' })));
    sheet('مراجعة — معدّلة في النظام', [['المرجع', 'ref', 9], ['التاريخ', 'date', 11], ['العميل', 'client', 20],
      ['Shopify الأصلي: الأصناف', 'sI', 13, 1], ['Shopify الأصلي: الخصم', 'sD', 12, 1], ['Shopify الأصلي: الشحن', 'sS', 11, 1], ['Shopify الأصلي: خصم الشحن', 'sSD', 13, 1], ['Shopify الأصلي: الإجمالي', 'sOT', 13, 1],
      ['Shopify الحالي: الإجمالي', 'sT', 13, 1], ['Shopify الحالي: سطور/قطع', 'sL', 11], ['Shopify: حالة الدفع', 'sF', 12], ['التغيير حصل في', 'chg', 12],
      ['النظام: الأصناف', 'oI', 13, 1], ['النظام: الخصم', 'oD', 12, 1], ['النظام: الشحن', 'oS', 11, 1], ['النظام: الإجمالي', 'oT', 13, 1], ['النظام: سطور/قطع', 'oL', 11], ['المدفوع', 'oP', 11, 1], ['المتبقي', 'oR', 11, 1], ['آخر تعديل', 'oE', 22],
      ['المقترح: خصم الشحن', 'pSD', 13, 1], ['المقترح: خصم المنتجات', 'pPD', 14, 1], ['المقترح: الشحن المحصَّل', 'pSC', 14, 1], ['الربح متطابق', 'pEq', 10],
      ['حالة التحقق', 'vS', 28], ['سبب المراجعة', 'vW', 60]],
      reviewRows.map(x => ({ ref: x.ref, date: x.date, client: x.client,
        sI: x.shopify.itemsTotal, sD: x.shopify.discount, sS: x.shopify.shipping, sSD: x.shopify.shippingDiscount, sOT: x.shopify.originalTotal,
        sT: x.shopify.total, sL: `${x.shopify.lines}/${x.shopify.qty}`, sF: x.shopify.financialStatus, chg: x.verification.changedOn,
        oI: x.soulia.itemsTotal, oD: x.soulia.discount, oS: x.soulia.shipCost, oT: x.soulia.total, oL: `${x.soulia.lines}/${x.soulia.qty}`, oP: x.soulia.deposit, oR: x.soulia.remaining, oE: x.soulia.lastEdit,
        pSD: x.proposed.shippingDiscount, pPD: x.proposed.productDiscount, pSC: x.proposed.shippingCharged, pEq: x.verification.grossProfitUnchanged ? 'نعم' : 'لا',
        vS: x.verification.status, vW: x.verification.why })));
    sheet('مستبعدة', [['المرجع', 'ref', 9], ['النوع', 'kind', 16], ['السبب', 'reason', 70], ['خصم الشحن', 'shippingDiscount', 12, 1], ['صافي قيود الخزنة', 'vaultNet', 14, 1], ['المعرّف', 'txId', 26]], report.excluded);
    sheet('للمحاسب', [['المرجع', 'ref', 9], ['المبلغ', 'amount', 10, 1], ['القيد', 'entry', 10], ['الملاحظة', 'note', 90]], report.accountantFlags);
    await wb.xlsx.writeFile(path.join(OUT, 'approval-report.xlsx'));

    console.log(JSON.stringify({ eligible: { count: E.count, shippingDiscount: E.shippingDiscount, grossProfitEqual: E.grossProfitBefore === E.grossProfitAfter },
      review: { count: R.count, shippingDiscount: R.shippingDiscount }, excluded: report.excluded.map(x => x.ref), sha256: listHash, out: OUT }, null, 1));
  } finally { await client.close(); }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
