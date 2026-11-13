#!/usr/bin/env node
'use strict';
/**
 * Shipping-discount reclassification — Dry Run on an isolated scratch copy (Phase 1, Nov 13, 2026).
 *
 *   node scripts/shipping-discount-dryrun.cjs --source soulia --stamp 20261113
 *
 * What it does (and only this):
 *   1. Copies the local database (`--source`, read only) into soulia_shipdisc_<stamp> and
 *      soulia_shipdisc_<stamp>_apply on the SAME local server ($out — exact bytes).
 *   2. Blanks every credential in both copies (Shopify, Bosta, R2, push subscriptions) and turns
 *      the Shopify sync configs off, then prints what is left (must be nothing).
 *   3. Fingerprints the money/stock collections and the protected fields of every sale.
 *   4. Dry run on copy 1 → artifacts/shipping-discount/dryrun.{json,xlsx} + summary.md. Writes nothing.
 *   5. Apply test on copy 2 only: apply → protected fingerprints identical, only the new fields
 *      changed → second run writes 0 → rollback → every collection byte-identical to before.
 *   6. Drops both copies (unless --keep).
 *
 * ⚠ Never starts NestJS (no scheduled job, no Shopify/Bosta/push call). Never reads backend/.env.
 * ⚠ Refuses anything that is not 127.0.0.1/localhost, and any target not named soulia_shipdisc_*.
 * ⚠ Uses the compiled correction module (dist/) — the same code the admin endpoint runs.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MongoClient, BSON } = require('mongodb');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes('--' + k);
const URI = arg('uri', 'mongodb://127.0.0.1:27018/?replicaSet=souliaDev&directConnection=true');
const SOURCE = arg('source', 'soulia');
const STAMP = arg('stamp', new Date().toISOString().slice(0, 10).replace(/-/g, ''));
const DRY = `soulia_shipdisc_${STAMP}`;
const APPLY = `soulia_shipdisc_${STAMP}_apply`;
const OUT = path.resolve(__dirname, '../../artifacts/shipping-discount');

function guard() {
  const u = new URL(URI.replace(/^mongodb:\/\//, 'http://'));
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.username || u.password) throw Error('Refusing: only an unauthenticated local server (127.0.0.1) is allowed.');
  for (const d of [DRY, APPLY]) {
    if (!/^soulia_shipdisc_[A-Za-z0-9_]+$/.test(d) || d === 'soulia') throw Error(`Refusing target database name ${d}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(SOURCE)) throw Error('Bad --source');
}

const dist = (p) => path.resolve(__dirname, '../dist', p);
const { buildCorrectionPlan, loadCorrectionInputs, applyCorrectionPlan, rollbackCorrection } = require(dist('transactions/shipping-discount-correction.js'));

const MONEY_STOCK = ['vaultentries', 'vaultbalances', 'inventorymovements', 'inventoryunits', 'inventorywriteoffs', 'carrierpayouts',
  'carrierimports', 'supplierledgerentries', 'expenses', 'returnrequests', 'settings', 'productcostevents', 'products'];
const TX_PROTECTED = { ref: 1, type: 1, total: 1, remaining: 1, deposit: 1, deposits: 1, payments: 1, discount: 1, shipCost: 1,
  itemsTotal: 1, items: 1, carrierSettlement: 1, bostaStatus: 1, actualShipCost: 1, shipLoss: 1, shipSaving: 1, payStatus: 1,
  cancelled: 1, depMethod: 1, codCollectionStatus: 1 };

async function rawHash(db, name, projection) {
  const h = crypto.createHash('sha256'); let n = 0;
  const cur = projection
    ? db.collection(name).find({}, { projection }).sort({ _id: 1 })
    : db.collection(name).find({}, { raw: true }).sort({ _id: 1 });
  for await (const doc of cur) { h.update(projection ? BSON.serialize(doc) : doc); n++; }
  return { count: n, sha256: h.digest('hex') };
}
async function fingerprint(db) {
  const out = {};
  const names = new Set((await db.listCollections().toArray()).map(c => c.name));
  for (const c of MONEY_STOCK) if (names.has(c)) out[c] = await rawHash(db, c);
  out['transactions:protected-fields'] = await rawHash(db, 'transactions', TX_PROTECTED);
  out['shopifyorders:except-shippingDiscount'] = await rawHash(db, 'shopifyorders', { shippingDiscount: 0 });
  return out;
}
async function fullFingerprint(db) {
  const out = {};
  for (const c of (await db.listCollections().toArray()).map(c => c.name).sort()) out[c] = await rawHash(db, c);
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const diffKeys = (a, b) => Object.keys({ ...a, ...b }).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]));

async function copyDb(client, from, to) {
  const src = client.db(from), dst = client.db(to);
  await dst.dropDatabase();
  for (const c of await src.listCollections({ type: 'collection' }).toArray()) {
    if (c.name.startsWith('system.')) continue;
    await src.collection(c.name).aggregate([{ $match: {} }, { $out: { db: to, coll: c.name } }]).toArray();
  }
  return (await dst.listCollections().toArray()).length;
}

const SECRET_FIELDS = ['bostaApiKey', 'bostaWebhookSecret', 'shopifyWebhookSecret', 'shopifyAccessToken', 'shopifyClientId',
  'shopifyClientSecret', 'shopifyStoreName', 'r2AccountId', 'r2AccessKeyId', 'r2SecretAccessKey', 'r2Bucket'];
async function blankCredentials(db) {
  const $set = Object.fromEntries(SECRET_FIELDS.map(k => [k, '']));
  await db.collection('settings').updateMany({}, { $set: { ...$set, r2Enabled: false } });
  const names = new Set((await db.listCollections().toArray()).map(c => c.name));
  for (const c of ['notificationaccounts', 'notificationjobs']) if (names.has(c)) await db.collection(c).deleteMany({});
  if (names.has('shopifysyncconfigs')) await db.collection('shopifysyncconfigs').updateMany({}, { $set: { enabled: false } });
  // What remains — must be empty.
  const left = [];
  for (const s of await db.collection('settings').find({}).toArray()) for (const k of SECRET_FIELDS) if (s[k]) left.push(`settings.${k}`);
  for (const c of ['notificationaccounts', 'notificationjobs']) if (names.has(c) && await db.collection(c).countDocuments()) left.push(c);
  return left;
}

async function writeXlsx(plan, file) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.views = [{ rightToLeft: true }];
  const money = '#,##0.00';
  const sheet = (name, columns, rows) => {
    const ws = wb.addWorksheet(name, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map(([header, key, width, numeric]) => ({ header, key, width: width || 14, style: numeric ? { numFmt: money } : {} }));
    ws.getRow(1).font = { bold: true };
    rows.forEach(r => ws.addRow(r));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  };
  const figCols = (p) => [
    [`خصم المنتجات ${p}`, `${p}_pd`, 14, 1], [`صافي مبيعات المنتجات ${p}`, `${p}_ns`, 18, 1],
    [`الشحن المحصَّل ${p}`, `${p}_sc`, 14, 1], [`دعم الشحن ${p}`, `${p}_ss`, 12, 1], [`الربح الإجمالي ${p}`, `${p}_gp`, 16, 1]];
  const figVals = (p, f) => ({ [`${p}_pd`]: f.productDiscount, [`${p}_ns`]: f.netProductSales, [`${p}_sc`]: f.shippingCharged, [`${p}_ss`]: f.shippingSubsidy, [`${p}_gp`]: f.grossProfit });
  const rowCols = [['المرجع', 'ref', 10], ['التاريخ', 'date', 12], ['الشهر', 'month', 9], ['العميل', 'client', 22],
    ['إجمالي الأصناف', 'itemsTotal', 14, 1], ['الخصم المخزَّن', 'discount', 13, 1], ['الشحن المخزَّن', 'shipCost', 13, 1],
    ['الإجمالي (ثابت)', 'total', 13, 1], ['المتبقي (ثابت)', 'remaining', 13, 1], ['المدفوع (ثابت)', 'deposit', 13, 1],
    ['خصم الشحن في Shopify', 'shopifyShippingDiscount', 14, 1], ['خصم الشحن المكتوب', 'shippingDiscount', 14, 1],
    ['من كود', 'codes', 12], ['إجمالي Shopify', 'shopifyTotal', 13, 1], ['معدّلة في النظام', 'edited', 12],
    ...figCols('قبل'), ...figCols('بعد'), ['الربح متطابق', 'eq', 10]];
  const rowOf = (r) => ({ ...r, codes: (r.viaCodes || []).join(', '), edited: r.editedInSoulia ? 'نعم' : 'لا',
    ...figVals('قبل', r.before), ...figVals('بعد', r.after), eq: r.grossProfitEqual ? 'نعم' : 'لا' });

  const t = plan.totals;
  sheet('الملخص', [['البند', 'k', 46], ['قبل', 'b', 18, 1], ['بعد', 'a', 18, 1], ['الفرق', 'd', 16, 1]], [
    ...[['خصم المنتجات', 'productDiscount'], ['صافي مبيعات المنتجات', 'netProductSales'], ['الشحن المحصَّل من العملاء', 'shippingCharged'],
      ['دعم الشحن (شحن مجاني تحمّلته الشركة)', 'shippingSubsidy'], ['تكلفة المنتجات', 'cogs'], ['الربح الإجمالي', 'grossProfit']]
      .map(([k, f]) => ({ k, b: t.before[f], a: t.after[f], d: Math.round((t.after[f] - t.before[f]) * 100) / 100 })),
    { k: `عدد الفواتير المتأثرة: ${t.sales}` }, { k: `ملغاة للمراجعة: ${plan.cancelledReview.length}` }, { k: `مستبعدة: ${plan.skipped.length}` },
    { k: `قاعدة البيانات: ${plan.database} — ${plan.generatedAt}` },
  ]);
  sheet('الفواتير المتأثرة', rowCols, plan.affected.map(rowOf));
  sheet('معدّلة في النظام — للتأكيد', rowCols, plan.affected.filter(r => r.editedInSoulia).map(rowOf));
  sheet('الإجماليات الشهرية', [['الشهر', 'month', 10], ['عدد الفواتير', 'sales', 12], ...figCols('قبل'), ...figCols('بعد'), ['الربح متطابق', 'eq', 10]],
    plan.months.map(m => ({ month: m.month, sales: m.sales, ...figVals('قبل', m.before), ...figVals('بعد', m.after), eq: m.grossProfitEqual ? 'نعم' : 'لا' })));
  sheet('ملغاة — مراجعة', [...rowCols, ['صافي قيود الخزنة', 'vaultNet', 14, 1], ['القيود', 'entries', 60]],
    plan.cancelledReview.map(r => ({ ...rowOf(r), vaultNet: r.vaultNet, entries: (r.vaultEntries || []).map(v => `${v.txNo} ${v.date} ${v.amount} ${v.source}`).join(' | ') })));
  sheet('مستبعدة', [['المرجع', 'ref', 10], ['التاريخ', 'date', 12], ['السبب', 'reason', 26], ['التفاصيل', 'detail', 60]], plan.skipped);
  sheet('أوردرات Shopify', [['المرجع', 'ref', 10], ['الحالة', 'status', 12], ['خصم الشحن', 'shippingDiscount', 12, 1]], plan.orders);
  sheet('الفحوص', [['الفحص', 'name', 60], ['النتيجة', 'pass', 10], ['التفاصيل', 'detail', 40]], plan.checks.map(c => ({ ...c, pass: c.pass ? 'نجح' : 'فشل' })));
  await wb.xlsx.writeFile(file);
}

(async () => {
  guard();
  fs.mkdirSync(OUT, { recursive: true });
  const client = await MongoClient.connect(URI, { serverSelectionTimeoutMS: 10000 });
  const log = [];
  const step = (s) => { console.log(s); log.push(s); };
  try {
    const src = client.db(SOURCE);
    const srcBefore = await fingerprint(src);

    step(`1. Copy ${SOURCE} → ${DRY} and ${APPLY}`);
    step(`   ${await copyDb(client, SOURCE, DRY)} / ${await copyDb(client, SOURCE, APPLY)} collections`);
    const dry = client.db(DRY), app = client.db(APPLY);

    step('2. Blank credentials');
    const leftDry = await blankCredentials(dry), leftApp = await blankCredentials(app);
    step(`   remaining credentials: ${[...leftDry, ...leftApp].length ? [...leftDry, ...leftApp].join(', ') : 'none'}`);
    if (leftDry.length || leftApp.length) throw Error('Credentials still present — stopping.');

    step('3. Fingerprint (copy 1)');
    const fpBefore = await fingerprint(dry);

    step('4. Dry run on copy 1 (writes nothing)');
    const plan = buildCorrectionPlan(await loadCorrectionInputs(dry), DRY);
    const fpAfterDry = await fingerprint(dry);
    const dryUnchanged = same(fpBefore, fpAfterDry);
    step(`   affected ${plan.affected.length}, cancelled review ${plan.cancelledReview.length}, skipped ${plan.skipped.length}, orders ${plan.orders.length}`);
    step(`   database unchanged by the dry run: ${dryUnchanged}`);

    step('5. Apply test on copy 2');
    const fullBefore = await fullFingerprint(app);
    const protBefore = await fingerprint(app);
    // The copy's own sales just before the apply — the comparison baseline (never the source, which may be live).
    const preTx = new Map((await app.collection('transactions').find({}).toArray()).map(d => [String(d._id), d]));
    const planApp = buildCorrectionPlan(await loadCorrectionInputs(app), APPLY);
    const runId = `scratch-${STAMP}-${crypto.randomBytes(3).toString('hex')}`;
    const r1 = await applyCorrectionPlan(app, planApp, { runId, approvedBy: 'scratch apply test — not a real approval',
      onlyTxIds: [...planApp.affected, ...planApp.cancelledReview].map(r => r.txId),
      approveCancelledIds: planApp.cancelledReview.map(r => r.txId) });
    const protAfter = await fingerprint(app);
    const protectedUnchanged = same(protBefore, protAfter);
    // Only the two new fields and the one history line may differ on a written sale.
    let onlyNewFields = true; const offenders = [];
    const strip = (d) => { const c = { ...d }; delete c.shippingDiscount; delete c.shippingDiscountSource;
      if (Array.isArray(c.editHistory)) c.editHistory = c.editHistory.filter(e => e && e.correctionRunId !== runId); return c; };
    for (const d of await app.collection('transactions').find({ shippingDiscountSource: `correction:${runId}` }).toArray()) {
      const o = preTx.get(String(d._id));
      const a = strip(d), b = strip(o || {});
      if (!o?.editHistory) delete a.editHistory; // the run created the array
      if (BSON.serialize(a).toString('hex') !== BSON.serialize(b).toString('hex')) { onlyNewFields = false; offenders.push(d.ref); }
    }
    const replan = buildCorrectionPlan(await loadCorrectionInputs(app), APPLY);
    // Everything is classified now, so the plan is empty; a rerun with the first run's list must write nothing.
    const r2 = replan.affected.length || replan.cancelledReview.length
      ? await applyCorrectionPlan(app, replan, { runId: runId + 'b', approvedBy: 'scratch rerun',
          onlyTxIds: [...replan.affected, ...replan.cancelledReview].map(r => r.txId), approveCancelledIds: replan.cancelledReview.map(r => r.txId) })
      : { written: 0, ordersWritten: 0 };
    const rb = await rollbackCorrection(app, runId, 'scratch rollback test');
    const fullAfter = await fullFingerprint(app);
    const ignored = ['financialcorrections'];   // the audit log itself is expected to remain
    const rollbackExact = diffKeys(fullBefore, fullAfter).filter(k => !ignored.includes(k));
    step(`   written ${r1.written} sales (+${r1.cancelledWritten} cancelled), ${r1.ordersWritten} order records, conflicts ${r1.skippedChanged.length}`);
    step(`   money/stock/protected fields unchanged after apply: ${protectedUnchanged}`);
    step(`   only the new fields + history line changed: ${onlyNewFields}${offenders.length ? ' — ' + offenders.slice(0, 10).join(',') : ''}`);
    step(`   second run wrote: ${r2.written} sales, ${r2.ordersWritten} orders`);
    step(`   rollback: ${rb.transactions} sales, ${rb.orders} orders; collections differing afterwards: ${rollbackExact.length ? rollbackExact.join(', ') : 'none'}`);

    const srcAfter = await fingerprint(src);
    const sourceUntouched = same(srcBefore, srcAfter);
    step(`6. Source database ${SOURCE} untouched: ${sourceUntouched}`);

    const scratchChecks = [
      { name: 'credentials blanked in both copies', pass: !leftDry.length && !leftApp.length, detail: 'Shopify, Bosta, R2, push' },
      { name: 'dry run wrote nothing', pass: dryUnchanged, detail: 'fingerprints before = after' },
      { name: 'apply: vault, inventory, Bosta settlement, deposits, remaining, totals unchanged', pass: protectedUnchanged, detail: Object.keys(protBefore).join(', ') },
      { name: 'apply: only shippingDiscount, shippingDiscountSource and one history line changed', pass: onlyNewFields, detail: offenders.join(',') },
      { name: 'second run writes nothing', pass: r2.written === 0 && r2.ordersWritten === 0, detail: `${r2.written}/${r2.ordersWritten}` },
      { name: 'rollback restores every collection byte for byte', pass: rollbackExact.length === 0, detail: rollbackExact.join(', ') || 'all identical' },
      { name: `source database ${SOURCE} untouched`, pass: sourceUntouched, detail: 'read only' },
    ];
    plan.checks.push(...scratchChecks);

    fs.writeFileSync(path.join(OUT, 'dryrun.json'), JSON.stringify(plan, null, 1));
    await writeXlsx(plan, path.join(OUT, 'dryrun.xlsx'));
    const t = plan.totals;
    const md = [
      `# Shipping-discount reclassification — Dry Run`, '',
      `Source: local \`${SOURCE}\` (copied to \`${DRY}\`). Generated ${plan.generatedAt}.`, '',
      `| | Before | After |`, `|---|---:|---:|`,
      ...[['Product discount', 'productDiscount'], ['Net product sales', 'netProductSales'], ['Shipping collected', 'shippingCharged'],
        ['Shipping subsidy', 'shippingSubsidy'], ['Gross profit', 'grossProfit']].map(([l, f]) => `| ${l} | ${t.before[f]} | ${t.after[f]} |`), '',
      `Affected sales ${t.sales} · cancelled for review ${plan.cancelledReview.length} · skipped ${plan.skipped.length}`, '',
      ...plan.checks.map(c => `- ${c.pass ? 'PASS' : 'FAIL'} — ${c.name} (${c.detail})`), '', '## Log', ...log.map(l => '    ' + l),
    ].join('\n');
    fs.writeFileSync(path.join(OUT, 'summary.md'), md);
    step(`Reports: ${OUT}`);
    if (!plan.checks.every(c => c.pass)) process.exitCode = 2;
  } finally {
    if (!flag('keep')) { await client.db(DRY).dropDatabase(); await client.db(APPLY).dropDatabase(); console.log('Scratch copies dropped.'); }
    await client.close();
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
