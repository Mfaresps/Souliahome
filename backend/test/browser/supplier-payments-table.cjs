/* Supplier profile «سجل المدفوعات»: one row per payment (a split payment is one row with its
   invoices as chips carrying each share), method shown with its name, undo in the ⋮ menu,
   summary figures above. Data shaped like Dream Bazaar (Nov 2026). Shipped index.html, API mocked. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), PUB = path.join(root, 'frontend/public');
const out = path.join(root, 'artifacts/supplier-payments-table'); fs.mkdirSync(out, { recursive: true });
let checks = 0;
const ok = (v, m) => { assert.ok(v, m); checks++; };

const pay = (id, amount, method, date, by, batchId) => ({ id, amount, method, date: date + 'T00:00:00.000Z', by, ...(batchId ? { batchId } : {}) });
const txs = [
  { _id: 't20', type: 'مشتريات', ref: '900020', payments: [pay('p1', 600, 'فودافون كاش', '2026-11-11', 'Souliahome')], deposits: [] },
  { _id: 't22', type: 'مشتريات', ref: '900022', deposits: [], payments: [
    pay('p2', 14400, 'فودافون كاش', '2026-11-11', 'Souliahome'), pay('p3', 10000, 'Instapay', '2026-11-11', 'Souliahome'),
    pay('p4', 30000, 'Instapay', '2026-11-15', 'Souliahome', 'b15'), pay('p5', 99, 'Instapay', '2026-11-19', 'Fares', 'b19')] },
  { _id: 't24', type: 'مشتريات', ref: '900024', deposits: [], payments: [
    pay('p6', 29901, 'Instapay', '2026-11-19', 'Fares', 'b19'), { ...pay('p7', 24000, 'Instapay', '2026-11-22', 'Souliahome'), note: 'تحويل من حساب الشركة' }] },
];

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
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    const render = async (lang, dark) => page.evaluate((d, lang, dark) => {
      currentUser = { _id: 'u-admin', role: 'admin', perms: [], name: 'Souliahome' }; currentLang = lang;
      document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
      document.body.classList.toggle('dark-mode', !!dark);
      document.querySelector('#app').style.display = ''; document.querySelector('#login-page').style.display = 'none'; document.querySelector('#splash-screen')?.remove();
      let host = document.querySelector('#spx-host');
      if (!host) {
        host = document.createElement('div'); host.id = 'spx-host'; host.style.cssText = 'position:fixed;inset:0;z-index:950;overflow:auto;padding:24px;background:var(--bg)';
        host.innerHTML = '<div style="max-width:1180px;margin:0 auto"><div id="sp-panel-payments-x"></div></div>';
        document.body.appendChild(host);
        document.querySelectorAll('#sp-panel-payments').forEach(n => n.id = 'sp-panel-payments-orig');
        host.querySelector('#sp-panel-payments-x').id = 'sp-panel-payments';
      }
      renderSpPaymentsPanel(d);
    }, txs, lang, dark);

    await render('ar', false);
    const info = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#sp-panel-payments .spx-tbl tbody tr')];
      const card = document.querySelector('#sp-panel-payments .sl-scroll');
      return {
        rows: rows.map(r => r.textContent.replace(/\s+/g, ' ').trim()),
        chips: rows.map(r => r.querySelectorAll('.spx-inv').length),
        kpis: [...document.querySelectorAll('.spx-kpi')].map(k => k.textContent.replace(/\s+/g, ' ').trim()),
        overflow: card.scrollWidth > card.clientWidth + 1,
        buttonsInRows: rows.reduce((n, r) => n + r.querySelectorAll('td button.btn').length, 0),
      };
    });
    ok(info.rows.length === 5, 'five payments, one row each: ' + info.rows.length);
    ok(/24,000/.test(info.rows[0]) && /10,000/.test(info.rows[4]), 'newest first');
    ok(/Instapay/.test(info.rows[0]) && /24,000/.test(info.rows[0]) && /تحويل من حساب الشركة/.test(info.rows[0]), 'row: method name, amount, note');
    ok(/دفعة واحدة على 2 فواتير/.test(info.rows[1]) && /30,000/.test(info.rows[1]) && info.chips[1] === 2, 'split 30,000 = one row with 2 invoice chips');
    ok(/#900022\s*99/.test(info.rows[1]) && /#900024\s*29,901/.test(info.rows[1]), 'each chip carries its share');
    ok(/فودافون كاش/.test(info.rows[3]) && /15,000/.test(info.rows[3]) && info.chips[3] === 2, 'old split 600 + 14,400 = 15,000 on 2 invoices');
    ok(/بواسطة Fares/.test(info.rows[1]), 'who recorded it');
    ok(info.buttonsInRows === 0, 'no undo buttons in the rows (moved to the ⋮ menu)');
    ok(/إجمالي المسدَّد.*109,000.*5 دفعة/.test(info.kpis[0]), 'total paid 109,000 over 5 payments: ' + info.kpis[0]);
    ok(/آخر دفعة.*24,000.*Instapay/.test(info.kpis[1]), 'last payment');
    ok(/أكثر طريقة دفع.*Instapay/.test(info.kpis[2]), 'most used method');
    ok(!info.overflow, 'no sideways scroll at 1180px');
    const order = await page.evaluate(() => [...document.querySelectorAll('#sp-panel-payments .spx-tbl thead th')].map(th => th.className));
    ok(order.join(',') === 'spx-c-date,spx-c-inv,spx-c-amt,spx-c-method,spx-c-note,spx-c-act', 'method comes right after the amount: ' + order);
    const fits = await page.evaluate(() => [...document.querySelectorAll('#sp-panel-payments .spx-tbl tbody td.spx-c-date')].every(td => [...td.children].every(c => c.scrollWidth <= td.clientWidth + 1)));
    ok(fits, 'dates fit their column');
    ok(/19 نوفمبر 2026/.test(info.rows[1]) && /الخميس · بواسطة Fares/.test(info.rows[1]), 'date on one line, weekday + who beneath');

    // ⋮ menu on the split payment: whole payment + each part.
    await page.evaluate(() => document.querySelectorAll('#sp-panel-payments .spx-tbl tbody tr')[1].querySelector('.dd-toggle').click());
    const menu = await page.evaluate(() => [...document.querySelectorAll('.dd-menu-portal .dd-item')].map(i => i.textContent.replace(/\s+/g, ' ').trim()));
    ok(menu.length === 3 && /تراجع عن الدفعة كلها/.test(menu[0]) && /#900022 · 99/.test(menu[1]) && /#900024 · 29,901/.test(menu[2]), 'menu: whole + 2 parts: ' + JSON.stringify(menu));
    const ico = await page.evaluate(() => { const i = document.querySelector('.dd-menu-portal .spx-undo-ico'); const r = i.getBoundingClientRect(); return { w: r.width, h: r.height, paths: i.querySelectorAll('path').length }; });
    ok(ico.w >= 14 && ico.h >= 14 && ico.paths === 2, 'undo icon: arrow, 16px ' + JSON.stringify(ico));
    { const r = await page.evaluate(() => { const m = document.querySelector('.dd-menu-portal').getBoundingClientRect(); return { x: m.left - 8, y: m.top - 8, width: m.width + 16, height: m.height + 16 }; });
      await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 2 }); }
    await page.evaluate(() => { closeAllMenus(); document.querySelectorAll('.dd-menu-portal').forEach(n => n.remove()); document.querySelectorAll('#sp-panel-payments .spx-tbl tbody tr')[1].querySelector('.dd-toggle').click(); });
    await new Promise(r => setTimeout(r, 400));
    { const r = await page.evaluate(() => { const m = (document.querySelector('.dd-menu-portal.show') || document.querySelector('.dd-menu-portal')).getBoundingClientRect(); return { x: m.left - 8, y: m.top - 8, width: m.width + 16, height: m.height + 16 }; });
      await page.screenshot({ path: path.join(out, 'menu.png'), clip: r }); }
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.evaluate(() => closeAllMenus());
    await page.screenshot({ path: path.join(out, 'ar-light.png'), fullPage: false });

    // Chip opens the invoice.
    const opened = await page.evaluate(() => { let id = null; const o = window.openOrderView; window.openOrderView = x => { id = x; }; document.querySelector('#sp-panel-payments .spx-inv').click(); window.openOrderView = o; return id; });
    ok(opened === 't24', 'invoice chip opens its invoice');

    // Without the perm the undo stays visible but disabled.
    await page.evaluate(() => { currentUser = { _id: 'u2', role: 'staff', perms: ['suppliers-tab-payments'], name: 'X' }; });
    await page.evaluate(d => { document.querySelectorAll('.dd-menu-portal').forEach(n => n.remove()); renderSpPaymentsPanel(d); document.querySelector('#sp-panel-payments .dd-toggle').click(); }, txs);
    const dis = await page.evaluate(() => [...document.querySelectorAll('.dd-menu-portal .dd-item')].every(i => i.classList.contains('is-disabled') && !i.getAttribute('onclick')));
    ok(dis, 'no perm: undo shown disabled with no action');
    await page.evaluate(() => closeAllMenus());

    await render('ar', true);
    await page.screenshot({ path: path.join(out, 'ar-dark.png') });
    await render('en', false);
    const en = await page.evaluate(() => document.querySelector('#sp-panel-payments').textContent.replace(/\s+/g, ' '));
    ok(/One payment over 2 invoices/.test(en) && /Total paid/.test(en), 'English labels');
    await page.screenshot({ path: path.join(out, 'en-light.png') });

    const own = errors.filter(e => !/SouliaDateRange|io is not|Chart|XLSX/i.test(e));
    assert.equal(own.length, 0, 'page errors: ' + own.join(' | '));
    console.log(`PASS supplier payments table: ${checks} checks`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
