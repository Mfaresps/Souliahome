// Real report markup/renderers; controlled responses, no application server or live data.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), publicDir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/order-audit-performance');
fs.mkdirSync(output, { recursive: true });
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const code = html.slice(html.indexOf('let currentAuditData = null;'), html.indexOf('async function toggleAuditHistory('));
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  const results = [];
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewport({ width, height: 1000 });
      await page.setRequestInterception(true);
      page.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><html dir="rtl" lang="ar"><head></head><body></body></html>' }));
      await page.goto('http://soulia.test/');
      await page.evaluate(html => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        document.body.innerHTML = doc.getElementById('rep-panel-orderaudit').outerHTML;
        document.body.style.padding = '16px';
        document.querySelector('#rep-panel-orderaudit').style.display = 'block';
        document.querySelector('#rep-panel-orderaudit').hidden = false;
      }, html);
      await page.addStyleTag({ content: html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>')) });
      for (const file of ['order-audit-layout.css', 'order-audit-marketing.css', 'order-audit-insights.css']) await page.addStyleTag({ path: path.join(publicDir, file) });
      await page.evaluate(() => {
        Object.assign(window, { qs: selector => document.querySelector(selector), qsa: selector => [...document.querySelectorAll(selector)],
          esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
          fmtNum: value => Number(value || 0).toLocaleString('en-US'), fmtJ: value => Number(value || 0).toLocaleString('en-US') + ' EGP',
          fmtDateTime: date => date.toISOString(), toast: message => window.notices.push(message), notices: [],
          renderPagination: () => {}, _bostaStatusBadge: () => 'Delivered', calls: [], currentLang: 'ar' });
        window.api = (url, options = {}) => new Promise((resolve, reject) => {
          // Deliberately permit late responses after abort to test the version guard too.
          calls.push({ url, options, resolve, reject });
        });
        window.report = marker => ({ from: 1, to: 5000, generatedAt: '2026-11-02T10:00:00Z', period: { fromDate: '2026-10-01', toDate: '2026-10-31' },
          sequence: { expectedCount: 5000, registeredCount: 5000, missingCount: 0, pendingCount: 0, cancelledCount: 0, syncRate: 100 },
          shipping: { source: 'carrier-actual-v1', totalShippingCost: 50000, avgShippingCost: 10, measuredCount: 5000, companies: [], highestOrder: null },
          dateRange: { firstOrder: null, lastOrder: null, durationDays: 31, ordersPerDay: 161, salesPerDay: 16000 }, missingOrders: [],
          rows: Array.from({ length: 5000 }, (_, i) => ({ orderNumber: String(i + 1), client: marker, registered: true, cancelled: false,
            syncStatus: 'synced', syncLabel: 'متزامن', orderTotal: 120, productCost: 40, shippingCost: 20, actualShipCost: 10, actualShippingKnown: true,
            netProfit: 70, products: [{ code: '27', name: 'Woven Basket', qty: 1, price: 100 }], productsLabel: 'Woven Basket', shopifyCreatedAt: '2026-10-10' })) });
      });
      await page.addScriptTag({ content: code });
      for (const file of ['order-audit-financials.js', 'order-audit-insights.js', 'order-audit-marketing.js']) await page.addScriptTag({ path: path.join(publicDir, file) });
      await page.evaluate(() => {
        window.first = runOrderAudit('fromDate=2026-10-01&toDate=2026-10-31');
        window.duplicate = runOrderAudit('fromDate=2026-10-01&toDate=2026-10-31');
      });
      assert.equal(await page.evaluate(() => calls.length), 1, 'duplicate requests are shared');
      const renderMs = await page.evaluate(async () => {
        const started = performance.now(); calls[0].resolve(report('First')); await first; await duplicate;
        return performance.now() - started;
      });
      assert.equal(await page.evaluate(() => calls.length), 1, 'no automatic carrier or previous-period analysis');
      assert.equal(await page.$eval('#oa-tbody', el => el.children.length), 30, '5000 orders remain paginated');
      assert.equal(await page.$eval('#oa-results', el => getComputedStyle(el).display), 'block');
      await page.evaluate(() => { window.refresh = refreshOrderAuditShipping(); });
      assert.match(await page.evaluate(() => calls[1].url), /shippingLive=true/);
      assert.match(await page.$eval('#oa-tbody', el => el.textContent), /First/);
      assert.equal(await page.$eval('#oa-results', el => el.getAttribute('aria-busy')), 'true');
      await page.screenshot({ path: path.join(output, `refresh-${width}.png`) });
      await page.evaluate(() => { window.newer = runOrderAudit('fromDate=2026-11-01&toDate=2026-11-02'); });
      assert.equal(await page.evaluate(() => calls[1].options.signal.aborted), true);
      await page.evaluate(async () => {
        const data = report('Newest'); data.period = { fromDate: '2026-11-01', toDate: '2026-11-02' };
        calls[2].resolve(data); await newer;
        calls[1].resolve(report('Stale')); await refresh;
      });
      assert.match(await page.$eval('#oa-tbody', el => el.textContent), /Newest/);
      assert.doesNotMatch(await page.$eval('#oa-tbody', el => el.textContent), /Stale/);
      await page.evaluate(() => { window.failed = refreshOrderAuditShipping(); });
      await page.evaluate(async () => { calls[3].reject(new Error('offline')); await failed; });
      assert.match(await page.$eval('#oa-tbody', el => el.textContent), /Newest/);
      assert.equal(await page.$eval('#oa-export-excel', el => el.disabled), false);
      assert.equal(await page.$eval('#oa-loading', el => getComputedStyle(el).display), 'none');
      // Previous-period analysis remains available explicitly.
      await page.click('[data-fin-compare]');
      assert.match(await page.evaluate(() => calls[4].url), /marketing-analysis$/);
      assert.equal(await page.evaluate(() => JSON.parse(calls[4].options.body).compare), true);
      await page.evaluate(() => calls[4].resolve({ invoices: [], comparison: null, metrics: {} }));
      await page.waitForFunction(() => !document.querySelector('.oam-status'));
      assert.deepEqual(errors, []);
      results.push({ width, orders: 5000, renderedRows: 30, initialRequests: 1, renderMs, duplicateShared: true, staleResponseIgnored: true, failedRefreshPreserved: true });
      await page.close();
    }
    fs.writeFileSync(path.join(output, 'browser.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
