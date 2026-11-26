/* Shopify report permissions (Nov 26, 2026), over the SHIPPED index.html + shopify-kpis.js +
 * the real date-range picker, in Chromium. Every request is intercepted.
 * Run: node backend/test/browser/shopify-report-perms.cjs
 */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const PUB = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
let checks = 0;
const errors = [];
function check(c, m) { assert.ok(c, m); checks++; console.log('  ✓ ' + m); }
const LOCAL = { '/shopify-kpis.js': 'text/javascript', '/shopify-kpis.css': 'text/css', '/designme/date-range-picker/soulia-range.js': 'text/javascript',
  '/designme/date-range-picker/soulia-range.css': 'text/css', '/soulia-logo.svg': 'image/svg+xml', '/shopify-edit-approvals.js': 'text/javascript',
  '/shopify-confirm-deferral.js': 'text/javascript' };

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setRequestInterception(true);
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', req => {
      const url = new URL(req.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/') return req.respond({ status: 200, contentType: 'text/html', body: html });
      if (url.pathname === '/config.js') return req.respond({ status: 200, contentType: 'text/javascript', body: 'window.__ENV__={API_BASE_URL:""};' });
      if (LOCAL[url.pathname]) return req.respond({ status: 200, contentType: LOCAL[url.pathname], body: fs.readFileSync(path.join(PUB, url.pathname.slice(1))) });
      if (url.origin === 'http://soulia.test' && url.pathname.endsWith('.css') && fs.existsSync(path.join(PUB, url.pathname.slice(1))))
        return req.respond({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(PUB, url.pathname.slice(1))) });
      if (url.pathname.startsWith('/api/')) return req.respond({ status: 200, contentType: 'application/json', body: '[]' });
      if (req.resourceType() === 'script') return req.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return req.respond({ status: 200, contentType: 'text/plain', body: '' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 10000 });
    const as = (perms, role = 'staff') => page.evaluate((perms, role) => {
      localStorage.setItem('token', 't');
      currentUser = { _id: 'u1', name: 'Reem', username: 'reem', role, perms };
      currentLang = 'ar'; document.documentElement.dir = 'rtl';
      const n = new Date();
      _shopifyOrders = [0, -1, -5, -20].map((d, i) => ({ _id: 'o' + i, ref: String(2700 + i), client: 'C', status: 'pending', total: 500,
        shopifyCreatedAt: new Date(n.getFullYear(), n.getMonth(), n.getDate() + d, 0, 30).toISOString(),
        depositReceipts: [{ id: 'r' + i, status: 'معتمد', amount: 200, method: 'Instapay' }], items: [] }));
      followUps = []; transactions = []; inventoryCache = [];
      _spServerEnabled = false; _spkPeriod = 'today'; _spkFilter = '';
      try { localStorage.setItem(_colsPrefKey('soulia_sp_kpi_hidden'), '0'); } catch (_) {}
      qs('#login-page').style.display = 'none'; qs('#app').style.display = ''; qs('#splash-screen')?.remove();
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      qs('#page-shopify-orders').classList.add('active'); currentPage = 'shopify-orders';
      renderShopifyOrders();
    }, perms, role);
    const tiles = () => page.$$eval('#sp-kpi .spk-tile', t => t.length);

    // 1) No report key: no strip, no toggle, no report menu item.
    await as(['shopify-orders']);
    check(await tiles() === 0 && await page.$eval('#sp-kpi', e => e.hidden), 'no report key → the summary is not shown');
    check(await page.$eval('#sp-kpi-toggle', e => e.hidden) && await page.$eval('#sp-tools-report', e => e.hidden), 'no key → show/hide and «تقرير الأوردرات» are hidden');
    await page.evaluate(() => _spkOpenReport());
    check(await page.evaluate(() => !document.querySelector('#spk-rep-prev')), 'the report cannot be opened from the console');

    // 2) Today only: today's figures, no comparison, no report button, calendar limited.
    await as(['shopify-orders', 'shopify-reports-today']);
    check(await tiles() === 5, 'today key → five tiles');
    check(await page.$eval('#sp-kpi .is-received .spk-val', e => e.textContent.trim() === '1'), 'today counts 1 order');
    check(await page.$$eval('#sp-kpi .is-received .spk-sub', e => !e.length || !e[0].textContent.trim()), 'no comparison with yesterday');
    check(!(await page.$('#sp-kpi .spk-report-btn')), 'no share key → no «تقرير» button');
    await page.evaluate(() => _spkSetPeriod('week'));
    check(await page.evaluate(() => _spkPeriod === 'today'), 'a wider period is refused');
    await page.click('#spk-period-btn');
    await page.waitForSelector('.drx-d');
    const cal = await page.evaluate(() => {
      const t = new Date(), iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const y = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1);
      const btn = s => document.querySelector(`.drx-d[data-date="${s}"]`);
      return { today: btn(iso(t))?.disabled, yesterday: btn(iso(y))?.disabled,
        presets: [...document.querySelectorAll('.drx-p')].map(p => p.dataset.p), note: document.querySelector('.spk-drx-limit')?.textContent || '' };
    });
    check(cal.today === false && cal.yesterday === true, 'calendar: today open, yesterday disabled');
    check(cal.presets.join() === 'today', 'only the «اليوم» preset is offered');
    check(/اليوم فقط/.test(cal.note), 'the calendar states the permission limit');
    await page.evaluate(() => SouliaDateRange.close());

    // 3) 7 days + share: week allowed, older refused, report opens.
    await as(['shopify-orders', 'shopify-reports-7d', 'shopify-reports-share']);
    await page.evaluate(() => _spkSetPeriod('week'));
    check(await page.evaluate(() => _spkPeriod === 'week'), '7-day key → last 7 days allowed');
    check(await page.$eval('#sp-kpi .is-received .spk-val', e => e.textContent.trim() === '3'), 'week counts 3 orders (the 20-day-old one excluded)');
    check(await page.$$eval('#sp-kpi .is-received .spk-sub', e => !e.length || !e[0].textContent.trim()), 'comparison with the previous 7 days hidden (outside window)');
    check(!!(await page.$('#sp-kpi .spk-report-btn')) && await page.$eval('#sp-tools-report', e => !e.hidden), 'share key → «تقرير» shown');
    await page.evaluate(() => { _spkCustomFrom = '2000-01-01'; _spkCustomTo = '2000-01-02'; _spkPeriod = 'custom'; _spkRender(); });
    check(await page.evaluate(() => _spkPeriod === 'today'), 'an out-of-window custom period falls back to today');
    await page.evaluate(() => { _spkOpenReport(); });
    await page.waitForSelector('#spk-rep-prev', { timeout: 5000 });
    check(true, 'report opens for an allowed period');
    check(await page.evaluate(() => /بواسطة Reem/.test(_spkReportText(_spkStats(_spkPeriod)))), 'copied text names who made the report');
    check(await page.evaluate(() => /أُنشئ \d+\/\d+\/\d{4} · \d{2}:\d{2} · بواسطة Reem/.test(_spkStamp())), 'image footer carries date, time and the name');
    await page.waitForFunction(() => document.querySelector('#spk-rep-prev img'), { timeout: 8000 });
    check(true, 'report image is drawn with the stamp');
    if (process.argv.includes('--shots')) {
      const dir = process.argv[process.argv.indexOf('--shots') + 1];
      const data = await page.$eval('#spk-rep-prev img', i => i.src.split(',')[1]);
      require('fs').writeFileSync(require('path').join(dir, 'report-author.png'), Buffer.from(data, 'base64'));
    }
    await page.evaluate(() => closeModal());

    // 4) Admin: any period, comparison kept.
    await as([], 'admin');
    await page.evaluate(() => _spkSetPeriod('week'));
    check(await page.evaluate(() => _spkPeriod === 'week') && await page.$eval('#sp-kpi .is-received .spk-sub', e => !!e.textContent.trim()), 'admin: any period with its comparison');

    const own = errors.filter(e => /spk|_spRep|drx|SouliaDateRange/.test(e));
    check(own.length === 0, 'no page errors from this code' + (own.length ? ': ' + own.join(' | ') : ''));
    console.log(`\n${checks} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
