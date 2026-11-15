/* Movements: «استبدال» is its own tab, and return / exchange rows show paid / remaining / status from their
   after-sales case (shared/after-sales-money.util.ts). Real index.html + the compiled page builder; mocked HTTP.
   Needs `npx nest build` first (reads dist/). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { buildMovementsPage } = require('../../dist/transactions/movements-page.util');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const out = path.resolve(__dirname, '../../../artifacts/movements-after-sales-money');
fs.mkdirSync(out, { recursive: true });
let checks = 0;
const ok = (v, m) => { assert.ok(v, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };

const quote = extra => ({ credit: 1812, replacement: 1812, customerFee: 0, collectDue: 0, refundDue: 0, creditApplied: 1812, ...extra });
const cases = [
  { _id: 'c5', requestKind: 'exchange', workflow: { version: 2, ref: 'AS-2026-000005', replacementRef: '202680000005', quote: quote() } },
  { _id: 'c4', requestKind: 'exchange', workflow: { version: 2, ref: 'AS-2026-000004', replacementRef: '202680000004', quote: quote({ credit: 2451, replacement: 2000, creditApplied: 2000, refundDue: 451 }) } },
  { _id: 'c3', requestKind: 'return', workflow: { version: 2, ref: 'AS-2026-000003', quote: { credit: 1752, replacement: 0, customerFee: 50, collectDue: 0, refundDue: 1702, creditApplied: 0 }, refund: { amount: 1702 } } },
];
const id = n => String(n).padStart(24, '0');
const rt = (n, ref, caseId, kind, total, client) => ({ _id: id(n), type: 'مرتجع', ref, client, total, deposit: 0, remaining: 0, payStatus: 'مكتمل',
  items: [{ code: 'X', name: 'منتج', qty: 1, total }], comments: [], date: '2026-11-14', transactionDate: '2026-11-14', createdAt: `2026-11-14T2${n}:00:00Z`,
  afterSales: { caseId, caseRef: 'AS', kind, role: 'return' } });
const rows = () => [
  rt(1, 'RT-2026-000005', 'c5', 'exchange', 1812, 'REHAB FAWZY'),
  rt(2, 'RT-2026-000004', 'c4', 'exchange', 2451, 'Nour Fathy'),
  rt(3, 'RT-2026-000003', 'c3', 'return', 1752, 'Asmaa Email'),
  { _id: id(9), type: 'مبيعات', ref: '3163', client: 'Customer', total: 900, deposit: 900, remaining: 0, payStatus: 'مكتمل', pickupStatus: 'Pending',
    items: [], comments: [], date: '2026-11-14', transactionDate: '2026-11-14', createdAt: '2026-11-14T08:00:00Z' },
];

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
        return request.respond({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
      return request.respond({ status: 200, contentType: request.resourceType() === 'script' ? 'text/javascript' : 'application/json', body: request.resourceType() === 'script' ? '' : '[]' });
    });
    await page.exposeFunction('buildPage', state => buildMovementsPage(rows(), cases, [], state));
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentUser = { _id: 'mov-as-test', role: 'admin', perms: [] };
      localStorage.setItem('token', 'mov-as-test');
      currentLang = 'ar'; document.documentElement.dir = 'rtl';
      qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      window._startupResourceReady = null;
      const enter = onPageEnter;
      onPageEnter = p => { if (p === 'movements') return enter(p); };
      window.reads = [];
      _apiRequest = (url, options = {}) => {
        if (url !== '/transactions/movements-page') return Promise.resolve([]);
        const state = JSON.parse(options.body); reads.push(state);
        return window.buildPage(state);
      };
      movViewMode = 'list';
      navigateTo('movements');
    });
    const settle = () => page.waitForFunction(() => !!_movServerResponse && !_movServerRequest && !qs('#page-movements').classList.contains('mov-nav-pending'));
    await settle();
    await page.waitForSelector('#mov-table tbody tr');
    const cell = (ref, col) => page.evaluate(([r, c]) => {
      const row = [...document.querySelectorAll('#mov-table tbody tr')].find(tr => tr.textContent.includes(r));
      return row ? row.querySelector(`[data-col="${c}"]`).textContent.replace(/\s+/g, ' ').trim() : null;
    }, [ref, col]);

    // Tabs: «مرتجعات» holds the plain return only, «استبدال» the two exchanges.
    eq(await page.$eval('#mov-count-return', n => (n.dataset.animatedNumberFinal || n.textContent).trim()), '1', 'returns tab counts plain returns only');
    eq(await page.$eval('#mov-count-exchange', n => (n.dataset.animatedNumberFinal || n.textContent).trim()), '2', 'exchange tab count');

    // Settled exchange: credit applied to the replacement.
    ok(/1,812/.test(await cell('RT-2026-5', 'paid')), 'exchange: paid = credit applied');
    ok(/^EGP 0$|^0 EGP$|\b0\b/.test(await cell('RT-2026-5', 'remaining')), 'exchange: nothing left');
    ok(/مكتمل/.test(await cell('RT-2026-5', 'status')), 'exchange: completed');
    // Cheaper replacement: 451 still owed to the customer.
    ok(/2,000/.test(await cell('RT-2026-4', 'paid')), 'cheaper exchange: 2,000 applied');
    ok(/451/.test(await cell('RT-2026-4', 'remaining')), 'cheaper exchange: 451 owed');
    ok(/بانتظار الرد/.test(await cell('RT-2026-4', 'status')), 'cheaper exchange: refund due');
    ok(await page.evaluate(() => !!document.querySelector('#mov-table .mov-col-remaining-pos.is-to-customer')), 'owed-to-customer colour');
    // Plain return refunded.
    ok(/1,702/.test(await cell('RT-2026-3', 'paid')), 'return: refund paid');
    ok(/تم الرد/.test(await cell('RT-2026-3', 'status')), 'return: refunded');
    await page.screenshot({ path: path.join(out, 'all-ar-1440.png') });

    // The «استبدال» tab filters on the server.
    await page.evaluate(() => setMovTypeTab('استبدال', qs('[data-mov-type="استبدال"]')));
    await page.waitForFunction(() => reads.at(-1)?.type === 'استبدال');
    await settle();
    const refs = await page.$$eval('#mov-table tbody tr', trs => trs.map(tr => tr.textContent).join(' '));
    ok(/RT-2026-5/.test(refs) && /RT-2026-4/.test(refs) && !/RT-2026-3/.test(refs) && !/3163/.test(refs), 'exchange tab rows');
    eq(await page.$eval('#mov-type-dd-label', n => n.textContent.trim()), 'استبدال', 'dropdown names the tab');
    await page.evaluate(() => setMovTypeTab('مرتجع', qs('[data-mov-type="مرتجع"]')));
    await page.waitForFunction(() => reads.at(-1)?.type === 'مرتجع');
    await settle();
    const retRefs = await page.$$eval('#mov-table tbody tr', trs => trs.map(tr => tr.textContent).join(' '));
    ok(/RT-2026-3/.test(retRefs) && !/RT-2026-4/.test(retRefs), 'returns tab rows');

    // English + the dropdown open.
    await page.evaluate(() => { currentLang = 'en'; applyLang(); setMovTypeTab('all', qs('[data-mov-type="all"]')); });
    await settle();
    ok(/Refund due/.test(await cell('RT-2026-4', 'status')), 'English status');
    await page.evaluate(() => toggleMovTypeDd());
    ok(/Exchanges/.test(await page.$eval('#mov-command-tabs', n => n.textContent)), 'English tab label');
    await page.screenshot({ path: path.join(out, 'dropdown-en-1440.png') });

    const own = errors.filter(e => !/SouliaDateRange|io is not|Chart|XLSX/i.test(e));
    eq(own.length, 0, 'no page errors: ' + own.join(' | '));
    console.log(`PASS movements after-sales money: ${checks} checks`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
