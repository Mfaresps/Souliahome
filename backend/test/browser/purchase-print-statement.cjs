/* Printed purchase invoice: «بيان الفاتورة» then, separately, «كشف حساب المورد».
   This invoice: total − earlier payments − supplier returns = remaining (the #900025 case:
   19,608 − 840 return = 18,768). Supplier account: this remaining + other unpaid invoices
   − returns held in the debt ledger outside any invoice = total due. Also checks the
   invoice page / window show the return deduction line. Shipped index.html, API mocked. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), PUB = path.join(root, 'frontend/public');
const out = path.join(root, 'artifacts/purchase-print-statement'); fs.mkdirSync(out, { recursive: true });
let checks = 0;
const ok = (v, m) => { assert.ok(v, m); checks++; };

const items = [['RIVA-TISSUE', 14, 90], ['Code 50W', 10, 200], ['Code 12', 3, 200], ['Code 11', 3, 250], ['Code 28', 5, 120],
  ['Code 31', 5, 140], ['Code 47', 3, 750], ['Code 45', 2, 750], ['Code 21', 6, 380], ['Code 20', 2, 280], ['Code 25', 11, 500],
  ['ORIVA-COSTER-LARGE', 24, 50], ['ORIVA-COSTER-SMALL', 24, 17]].map(([code, qty, price], i) => ({ code, name: code, qty, price, total: qty * price, lineId: 'l' + i }));
const inv = { _id: 'tx-25', type: 'مشتريات', ref: '900025', client: 'Dream Bazaar', supplierId: 'sup-1', date: '2026-11-23', createdAt: '2026-11-23T00:40:00Z',
  items, itemsTotal: 19608, total: 19608, deposit: 0, remaining: 18768, payStatus: 'معلق', payment: 'كاش', depMethod: 'كاش', deposits: [], payments: [],
  supplierReturnOffsets: [{ returnId: 'r7', returnNumber: 'SR-2026-0007', amount: 840, at: '2026-11-23T20:29:56Z' }], employee: 'Souliahome', _fullyHydrated: true };
const other = { _id: 'tx-24', type: 'مشتريات', ref: '900024', client: 'Dream Bazaar', supplierId: 'sup-1', date: '2026-11-18', items: [],
  total: 54312, deposit: 49312, remaining: 5000, deposits: [],
  payments: [{ id: 'p-b', amount: 29901, method: 'Instapay', date: '2026-11-19', batchId: 'b1' }, { id: 'p-c', amount: 24000, method: 'Instapay', date: '2026-11-22' }] };
// Only reachable through the ledger (fully paid, not in memory): fetched by the print refresh.
const old22 = { _id: 'tx-22', type: 'مشتريات', ref: '900022', client: 'Dream Bazaar', supplierId: 'sup-1', date: '2026-11-13', total: 99, remaining: 0, deposits: [],
  payments: [{ id: 'p-v', amount: 14400, method: 'فودافون كاش', date: '2026-11-11' }, { id: 'p-w', amount: 2000, method: 'فودافون كاش', date: '2026-11-11' },
    { id: 'p-a', amount: 99, method: 'Instapay', date: '2026-11-19', batchId: 'b1' }, { id: 'p-x', amount: 400, method: 'كاش', date: '2026-11-14', reversed: true }] };
// Old split payment (before batchId): 600 on #900020 + 14,400 on #900022, booked 1 second apart = one 15,000 transfer.
const old20 = { _id: 'tx-20', type: 'مشتريات', ref: '900020', client: 'Dream Bazaar', supplierId: 'sup-1', date: '2026-11-06', total: 600, remaining: 0, deposits: [],
  payments: [{ id: 'p-u', amount: 600, method: 'فودافون كاش', date: '2026-11-11' }] };
const ledgerRows = [
  { entryType: 'payment', amount: -600, sourceId: 'tx-20', sourceRef: '900020', date: '2026-11-11', createdAt: '2026-11-13T15:55:49Z' },
  { entryType: 'payment', amount: -14400, sourceId: 'tx-22', sourceRef: '900022', date: '2026-11-11', createdAt: '2026-11-13T15:55:50Z' },
  { entryType: 'payment', amount: -2000, sourceId: 'tx-22', sourceRef: '900022', date: '2026-11-11', createdAt: '2026-11-13T17:00:00Z' },
  { entryType: 'advance-deposit', amount: -500, vaultSeg: 'فودافون كاش', date: '2026-11-16', createdAt: '2026-11-16T10:00:00Z' },
  { entryType: 'payment', amount: -400, sourceId: 'tx-22', sourceRef: '900022', date: '2026-11-14', createdAt: '2026-11-14T10:00:00Z', reversed: true },
  { entryType: 'payment', amount: -99, sourceId: 'tx-22', sourceRef: '900022', date: '2026-11-19', createdAt: '2026-11-19T10:00:00Z', meta: { paymentId: 'p-a' } },
  { entryType: 'payment', amount: -29901, sourceId: 'tx-24', sourceRef: '900024', date: '2026-11-19', createdAt: '2026-11-19T10:00:01Z', meta: { paymentId: 'p-b' } },
  { entryType: 'payment', amount: -24000, sourceId: 'tx-24', sourceRef: '900024', date: '2026-11-22', createdAt: '2026-11-22T10:00:00Z' },
  { entryType: 'purchase-debt', amount: 54312, sourceId: 'tx-24', sourceRef: '900024', date: '2026-11-18', createdAt: '2026-11-18T01:00:00Z' },
  { entryType: 'purchase-debt', amount: 19608, sourceId: 'tx-25', sourceRef: '900025', date: '2026-11-23', createdAt: '2026-11-23T01:00:00Z' },
];
// Paid invoice with payments logged + an older unlogged slice + a write-off.
const paidInv = { _id: 'tx-p', type: 'مشتريات', ref: '900030', client: 'Dream Bazaar', supplierId: 'sup-1', date: '2026-11-20', items: items.slice(0, 2),
  total: 3260, deposit: 2500, remaining: 0, payStatus: 'مكتمل', depMethod: 'كاش',
  deposits: [{ amount: 1000, method: 'كاش', date: '2026-11-20' }], payments: [{ amount: 1000, method: 'Instapay', date: '2026-11-21' }],
  writeOff: { amount: 260, reason: 'فرق تقريب' }, _fullyHydrated: true };
const byId = { 'tx-25': inv, 'tx-24': other, 'tx-p': paidInv, 'tx-22': old22, 'tx-20': old20 };
const ledgerDebt = 18768 + 5000 - 420; // SR-2026-0008 (420) offset held outside these invoices

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(PUB, 'index.html'), 'utf8') });
      const local = path.join(PUB, url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && /\.(js|css)$/.test(url.pathname) && fs.existsSync(local))
        return request.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(local) });
      const m = url.pathname.match(/\/transactions\/(tx-[\w-]+)$/);
      if (m && byId[m[1]]) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(byId[m[1]]) });
      if (/\/supplier-ledger\/supplier\/sup-1$/.test(url.pathname)) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(ledgerRows) });
      if (/\/supplier-ledger\/supplier\/sup-1\/balance$/.test(url.pathname)) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ debt: ledgerDebt, credit: 0 }) });
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((a, b, c) => {
      currentUser = { _id: 'u-admin', role: 'admin', perms: [], name: 'Souliahome' }; currentLang = 'ar';
      transactions = [a, b, c]; suppliers = [{ _id: 'sup-1', name: 'Dream Bazaar' }];
      document.querySelector('#app').style.display = ''; document.querySelector('#login-page').style.display = 'none'; document.querySelector('#splash-screen')?.remove();
    }, inv, other, paidInv);

    // 1. Printed invoice #900025 after the pre-print refresh.
    const { html, css } = await page.evaluate(async () => ({ html: buildInvoiceHtml(await _invRefreshForPrint(transactions[0])), css: _invoiceSharedCss() }));
    const text = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    ok(/بيان الفاتورة #900025/.test(text) && /كشف حساب المورد حتى/.test(text) && text.indexOf('بيان الفاتورة') < text.indexOf('كشف حساب المورد'), 'two separate sections, invoice first');
    ok(!/الدفعات على هذه الفاتورة/.test(text) && !/الفواتير غير المسدَّدة/.test(text), 'old detailed tables gone');
    ok(!/class="iv-pay"/.test(html), 'pay strip replaced on a purchase');
    const plainAll = text;
    ok((plainAll.match(/19,608/g) || []).length === 1, 'the invoice total 19,608 is printed once: ' + (plainAll.match(/19,608/g) || []).length);
    ok(!/إجمالي الأصناف/.test(text), 'no «إجمالي الأصناف» when it equals the total');
    ok(/المتبقي على الفاتورة 18,768 كشف حساب المورد/.test(text), 'invoice section ends with its remaining');
    ok(/كشف حساب المورد حتى \S+ البيان المبلغ \(EGP\) المتبقي على الفاتورة #900025 من بيان الفاتورة أعلاه 18,768/.test(text), 'account opens with the invoice remaining carried over');
    ok(!/المتبقي على هذه الفاتورة/.test(text), 'remaining stated once');
    ok(/دفعات سداد سابقة 0/.test(text), 'no earlier payments = 0');
    ok(/مرتجعات للمورد SR-2026-0007 −840/.test(text), 'return SR-2026-0007 −840');
    ok(/المتبقي على الفاتورة 18,768/.test(text), 'remaining 18,768');
    ok(!/مسدَّد سابقاً/.test(text), 'no unexplained line when it adds up');
    ok(/فواتير أخرى غير مسدَّدة \(1\) #900024 \+5,000/.test(text), 'other unpaid invoice +5,000');
    ok(/مرتجعات وتسويات لم تُخصم من فاتورة مسجَّلة في سجل المديونية −420/.test(text), 'ledger-only returns −420');
    ok(/إجمالي المستحق للمورد حسب سجل المديونية 23,348/.test(text), 'total due 23,348');
    ok(/مسدَّدة جزئياً/.test(text), 'chip partly settled');
    ok(/البيان المبلغ \(EGP\)/.test(text), 'description | amount column header');
    const last = text.slice(text.indexOf('آخر دفعات السداد للمورد'));
    ok(last.length > 30, 'latest supplier payments listed');
    ok(/22\/11\/2026 Instapay على #900024 24,000/.test(last), 'newest: 22/11 Instapay 24,000 on #900024');
    ok(/19\/11\/2026 Instapay على #900022 ?، #900024 30,000/.test(last), 'split payment is one row: 30,000 Instapay on two invoices');
    ok(/20\/11\/2026 كاش على #900030 عند تسجيل الفاتورة 1,000/.test(last), 'deposit paid when an invoice was recorded');
    ok(/16\/11\/2026 فودافون كاش دفعة مقدمة 500/.test(last), 'advance payment with its vault');
    ok(!/400/.test(last), 'reversed payment left out');
    ok(last.indexOf('22/11/2026') < last.indexOf('19/11/2026') && last.indexOf('19/11/2026') < last.indexOf('16/11/2026'), 'newest first');

    // 1a. #900024 missing from the in-memory list (paged / stale): still counted, read via the debt ledger.
    const t25b = await page.evaluate(async () => {
      const keep = transactions; transactions = keep.filter(t => t._id !== 'tx-24');
      try { const h = buildInvoiceHtml(await _invRefreshForPrint(keep[0])); return h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); }
      finally { transactions = keep; }
    });
    ok(/فواتير أخرى غير مسدَّدة \(1\) #900024 \+5,000/.test(t25b), 'an open invoice not in memory is still listed');
    ok(!/مبالغ أخرى في سجل المديونية/.test(t25b), 'no false «other ledger amounts» line');

    // 1b. Invoice #900024: the 19/11 payment was one 30,000 transfer split over two invoices —
    // it is stated at its full value, with the part on this invoice beside it.
    const html24 = await page.evaluate(async () => buildInvoiceHtml(await _invRefreshForPrint(transactions[1])));
    const t24 = html24.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const col24 = t24.slice(t24.indexOf('بيان الفاتورة'), t24.indexOf('كشف حساب المورد'));
    ok(/19\/11\/2026 · Instapay · 30,000 \(منها 29,901 على هذه الفاتورة\)/.test(col24), 'split payment shown at its full 30,000');
    ok(/22\/11\/2026 · Instapay · 24,000(?! \()/.test(col24), 'a whole payment has no «منها»');
    ok(/دفعات سداد سابقة \(2\)[^−]*−53,901/.test(col24), 'column arithmetic still uses the part on this invoice (−53,901)');

    // 1c. Invoice #900022: the old 11/11 transfer reads 15,000 (600 went to #900020); a later
    // payment the same day with the same method, an hour apart, stays its own payment.
    const html22 = await page.evaluate(async d => { transactions.push(d); return buildInvoiceHtml(await _invRefreshForPrint(d)); }, old22);
    const t22 = html22.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const col22 = t22.slice(t22.indexOf('بيان الفاتورة'), t22.indexOf('كشف حساب المورد'));
    ok(/11\/11\/2026 · فودافون كاش · 15,000 \(منها 14,400 على هذه الفاتورة\)/.test(col22), 'old split transfer shown as 15,000');
    ok(/11\/11\/2026 · فودافون كاش · 2,000(?! \()/.test(col22), 'an unrelated payment an hour later stays 2,000');

    // 1d. Supplier return SR-2026-0008: the transaction's total is the cash refund (0); the note
    // prints the return value (420), the supplier label, the reason and the settlement.
    const sret = { _id: 'tx-sr8', type: 'مرتجع مشتريات', ref: '900022-SRET', client: 'Dream Bazaar', supplierId: 'sup-1', date: '2026-11-23', createdAt: '2026-11-23T20:31:00Z',
      items: [{ code: 'Code 32', name: 'Ribbon Storage', qty: 2, price: 210, total: 420 }], total: 0, deposit: 0, remaining: 0, payStatus: 'مكتمل',
      notes: 'مرتجع مورد معتمد SR-2026-0008: تلف المنتج | القيمة الإجمالية: 420 ج — خصم من المديونية: 420 ج — رد نقدي: 0 ج — رصيد آجل: 0 ج', _fullyHydrated: true };
    const sr8 = { _id: 'sr8', returnNumber: 'SR-2026-0008', linkedTransactionId: 'tx-sr8', reason: 'تلف المنتج', reasonDetails: 'السلة مكسورة', total: 420, status: 'مكتمل',
      linkedInvoices: [{ transactionId: 'tx-22', ref: '900022', allocatedTotal: 420 }],
      settlement: { returnValue: 420, debtOffsetAmount: 420, creditAmount: 0, refundAmount: 0, settlementType: 'debt-offset', debtBalanceAfter: 18789, decidedAt: '2026-11-23T20:31:42Z',
        invoiceOffsets: [{ transactionId: 'tx-24', ref: '900024', amount: 420 }], unallocatedOffset: 0 } };
    const tsr = await page.evaluate((d, r) => { supplierReturns = [r]; return buildInvoiceHtml(d).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); }, sret, sr8);
    ok(/PURCHASE RETURN/.test(tsr) && /إشعار مرتجع مشتريات/.test(tsr), 'supplier return title');
    ok(/رقم المرتجع SR-2026-0008/.test(tsr), 'return number shown');
    ok(/اسم المورد Dream Bazaar/.test(tsr) && !/اسم العميل/.test(tsr), 'supplier label, not customer');
    ok(/قيمة المرتجع 420 EGP/.test(tsr) && !/قيمة المرتجع 0 /.test(tsr), 'value 420, not the 0 cash refund');
    ok(/فقط أربعمائة وعشرون جنيهاً/.test(tsr), 'words for 420');
    ok(/سبب المرتجع تلف المنتج — السلة مكسورة/.test(tsr) && !/القيمة الإجمالية: 420 ج/.test(tsr), 'reason instead of the machine note');
    ok(/Code 32/.test(tsr) && !/Code Code 32/.test(tsr), 'code not doubled');
    ok(/قيمة المرتجع البضاعة من فاتورة #900022 420/.test(tsr), 'value row names the source invoice');
    ok(/خصم من مديونية فاتورة #900024 −420/.test(tsr), 'settled against invoice #900024');
    ok(/المرتجع مسوّى بالكامل 0/.test(tsr) && /مسوّى بالكامل/.test(tsr), 'fully settled');
    ok(/مديونية المورد بعد هذا المرتجع وقت التسوية · 23\/11\/2026 18,789 EGP/.test(tsr), 'supplier debt after the return');
    ok(!/مدفوعة بالكامل/.test(tsr) && !/المدفوع 0/.test(tsr), 'no paid/total-0 strip');
    const srSheet = await page.evaluate((d, r) => { supplierReturns = [r]; return { html: buildInvoiceHtml(d), css: _invoiceSharedCss() }; }, sret, sr8);
    const p2 = await browser.newPage(); await p2.setViewport({ width: 794, height: 1123 });
    await p2.setContent(`<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><style>${srSheet.css}</style></head><body>${srSheet.html}</body></html>`, { waitUntil: 'load' });
    await p2.screenshot({ path: path.join(out, 'supplier-return.png'), fullPage: true }); await p2.close();
    await page.evaluate(() => { supplierReturns = []; });

    // 2. Paid invoice: payments listed briefly, write-off and unlogged rest named.
    const html2 = await page.evaluate(async () => buildInvoiceHtml(await _invRefreshForPrint(transactions[2])));
    const t2 = html2.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    ok(/دفعات سداد سابقة \(2\) 20\/11\/2026 · كاش · 1,000 ، 21\/11\/2026 · Instapay · 1,000 −2,000/.test(t2), 'two payments with date + method, total −2,000');
    ok(/مسدَّد سابقاً بدون تفاصيل في السجل −1,000/.test(t2), 'unlogged rest −1,000');
    ok(/إقفال المتبقي فرق تقريب −260/.test(t2), 'write-off −260');
    ok(/الفاتورة مسدَّدة بالكامل 0/.test(t2), 'fully settled');

    const own = errors.filter(e => !/SouliaDateRange|io is not|Chart|XLSX/i.test(e));
    assert.equal(own.length, 0, 'page errors: ' + own.join(' | '));

    // 3. Rendered sheet: one box per section, nothing spills, the statement stays short.
    await page.setContent(`<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><style>${css}</style></head><body>${html}</body></html>`, { waitUntil: 'load' });
    await page.setViewport({ width: 794, height: 1123 });
    const geo = await page.evaluate(() => {
      const acct = document.querySelector('.iv-acct'), cols = [...document.querySelectorAll('.iv-acct-col')];
      const pg = document.querySelector('.page');
      return { cols: cols.length, spill: cols.some(c => c.scrollWidth > c.clientWidth + 1), acctW: acct.getBoundingClientRect().width,
        pageH: pg.scrollHeight, pageW: pg.getBoundingClientRect().width,
        rowsSpill: [...document.querySelectorAll('.iv-acct-col .r')].some(r => r.scrollWidth > r.clientWidth + 1) };
    });
    ok(geo.cols === 2, 'two boxes: invoice, then supplier account');
    const reds = await page.evaluate(() => [...document.querySelectorAll('.iv-acct-col .r.is-neg .v')].map(v => [v.textContent.trim(), getComputedStyle(v).color]));
    ok(reds.length === 2 && reds.every(([, c]) => c === 'rgb(180, 35, 24)'), 'returns and ledger deductions in red: ' + JSON.stringify(reds));
    ok(!geo.spill && !geo.rowsSpill, 'nothing spills');
    const secH = await page.evaluate(() => document.querySelector(".iv-sec").getBoundingClientRect().height);
    await page.screenshot({ path: path.join(out, 'sheet-900025.png'), fullPage: true });
    await page.setViewport({ width: 794, height: 1600, deviceScaleFactor: 2 });
    const clip = await page.evaluate(() => { const secs = [...document.querySelectorAll('.iv-sec')]; const a = secs[0].getBoundingClientRect(), b = secs[secs.length - 1].getBoundingClientRect(); return { x: a.left, y: a.top + window.scrollY, width: a.width, height: b.bottom - a.top }; });
    await page.screenshot({ path: path.join(out, 'statement-900025.png'), clip });
    const bands = await page.evaluate(() => [...document.querySelectorAll('.iv-acct-col .t')].map(t => ({ txt: t.textContent.replace(/\s+/g, ' ').trim(), bg: getComputedStyle(t).backgroundColor })));
    const green = b => b.bg === 'rgb(45, 122, 79)';
    ok(bands.length === 1 && /إجمالي المستحق للمورد/.test(bands[0].txt) && green(bands[0]), 'only the final figure is highlighted: ' + JSON.stringify(bands.map(b => b.txt)));
    const totColor = await page.evaluate(() => getComputedStyle(document.querySelector('.iv-tot .g .t')).color);
    ok(totColor !== 'rgb(45, 122, 79)', 'sheet total not green: ' + totColor);
    ok(secH <= 480, `statement is short (${Math.round(secH)}px)`);
    // A short invoice (2 lines) with its statement stays on one A4 sheet.
    await page.setContent(`<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><style>${css}</style></head><body>${html2}</body></html>`, { waitUntil: 'load' });
    const h2 = await page.evaluate(() => { const p = document.querySelector('.page'); return { h: p.scrollHeight, a4: Math.ceil(p.getBoundingClientRect().width * 297 / 210) }; });
    ok(h2.h <= h2.a4 + 2, `short invoice fits one A4 sheet (${h2.h}/${h2.a4}px)`);
    await page.screenshot({ path: path.join(out, 'print-900030.png'), fullPage: true });

    console.log(`PASS purchase print statement: ${checks} checks`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
