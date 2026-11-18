/* An exchange replacement invoice (#3095 case): the returned piece's value (590) was already paid on the
   original invoice, so it is shown as «رصيد المنتج المرتجع», never as cash and never as owed again.
   Invoice page, invoice window and the printed invoice. Shipped index.html, API mocked. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), PUB = path.join(root, 'frontend/public');
const out = path.join(root, 'artifacts/exchange-invoice-credit'); fs.mkdirSync(out, { recursive: true });
let checks = 0;
const ok = (v, m) => { assert.ok(v, m); checks++; };

const repl = { _id: 'tx-repl', type: 'مبيعات', ref: '20268000007', client: 'ماجدة الشرقاوى', phone: '01003955539', date: '2026-11-15', createdAt: '2026-11-15T16:16:00Z',
  items: [{ code: '24', name: 'Twist Basket', qty: 1, price: 1872, total: 1872, lineId: 'a' }, { code: '32', name: 'Ribbon Storage', qty: 1, price: 590, total: 590, lineId: 'b' }],
  itemsTotal: 2462, total: 2462, discount: 0, shipCost: 0, deposit: 1090, remaining: 1372, payStatus: 'معلق', payment: 'تسوية استبدال',
  deposits: [{ id: 'r1', amount: 500, method: 'Instapay', source: 'deposit-receipt', date: '2026-11-15T16:17:00Z', by: 'Souliahome' }],
  depositReceipts: [{ id: 'r1', amount: 500, method: 'Instapay', status: 'معتمد' }], shipCo: 'Bosta', pickupStatus: 'Pending', employee: 'Souliahome',
  notes: 'بديل مرتبط بطلب AS-2026-000013 وفاتورة #3095', _fullyHydrated: true,
  afterSales: { caseId: 'c13', caseRef: 'AS-2026-000013', kind: 'exchange', role: 'replacement', originalRef: '3095', originalTransactionId: 'tx-orig', creditApplied: 590 } };

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
      if (/\/transactions\/tx-repl$/.test(url.pathname)) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(repl) });
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(d => {
      currentUser = { _id: 'u-admin', role: 'admin', perms: [], name: 'Souliahome' }; currentLang = 'ar';
      transactions = [d]; document.querySelector('#app').style.display = ''; document.querySelector('#login-page').style.display = 'none'; document.querySelector('#splash-screen')?.remove();
    }, repl);

    // 1. Invoice page.
    await page.evaluate(() => { window._invoiceViewTxId = 'tx-repl'; navigateTo('invoice-view', { updateHash: false }); renderInvoiceViewPage(); });
    await page.waitForSelector('#inv-view-content .inv2-sum-row');
    const pageText = await page.$eval('#inv-view-content', n => n.textContent.replace(/\s+/g, ' '));
    ok(/رصيد المنتج المرتجع/.test(pageText) && /590/.test(pageText), 'page: return credit 590 stated');
    ok(/#3095/.test(pageText), 'page: names the original invoice');
    ok(/1,372/.test(pageText), 'page: remaining 1,372');
    ok(/مدفوعة في الفاتورة الأصلية #3095/.test(pageText), 'page: credit note says it was already paid');
    const sum = await page.$$eval('#inv-view-content .inv2-sum-row', rows => rows.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
    ok(sum.some(r => /رصيد المنتج المرتجع/.test(r) && /590/.test(r)) && sum.some(r => /العربون المسبق/.test(r) && /500/.test(r)), 'page summary: credit 590 + deposit 500');
    await page.screenshot({ path: path.join(out, 'invoice-page-ar.png'), fullPage: true });

    // 2. Invoice window.
    await page.evaluate(() => showInvoiceDetail('tx-repl'));
    await page.waitForFunction(() => /رصيد المنتج المرتجع/.test(document.querySelector('#inv-detail-content')?.textContent || ''), { timeout: 8000 });
    const win = await page.$eval('#inv-detail-content .inv-breakdown', n => n.textContent.replace(/\s+/g, ' '));
    ok(/590/.test(win) && /500/.test(win) && /1,372/.test(win), 'window: credit, deposit and remaining');

    // 3. Printed invoice.
    const html = await page.evaluate(() => buildInvoiceHtml(transactions[0]));
    const cells = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    ok(/رصيد المنتج المرتجع 590/.test(cells), 'print: credit cell');
    ok(/المدفوع 500/.test(cells), 'print: paid = the 500 cash, not the remaining');
    ok(/المتبقي على العميل 1,372/.test(cells), 'print: remaining 1,372');
    ok(/مدفوعة جزئياً/.test(cells), 'print: partly paid');

    const own = errors.filter(e => !/SouliaDateRange|io is not|Chart|XLSX/i.test(e));
    assert.equal(own.length, 0, 'page errors: ' + own.join(' | '));
    console.log(`PASS exchange invoice credit: ${checks} checks`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
