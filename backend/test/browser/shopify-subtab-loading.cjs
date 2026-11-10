const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const out = path.resolve(__dirname, '../../../artifacts/shopify-subtab-loading');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
        return request.respond({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
      return request.respond({ status: 200, contentType: request.resourceType() === 'script' ? 'text/javascript' : 'application/json', body: request.resourceType() === 'script' ? '' : '[]' });
    });
    for (const [width, lang] of [[1440, 'en'], [390, 'ar']]) {
      await page.setViewport({ width, height: 1000 });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(lang => {
        currentUser = { _id: 'subtab-test', role: 'admin', perms: [] }; localStorage.setItem('token', 'subtab-test');
        currentLang = lang; document.documentElement.dir = document.dir = lang === 'ar' ? 'rtl' : 'ltr';
        qs('#login-page').style.display = 'none'; qs('#app').style.display = ''; qs('#splash-screen')?.remove(); closeSidebar();
        qsa('.page').forEach(el => el.classList.toggle('active', el.id === 'page-shopify-orders'));
        currentPage = 'shopify-orders'; _spServerEnabled = true;
        _shopifyOrders = [{ _id: 'unrelated-order', ref: '3000', status: 'pending', depositReceipts: [] }];
        window.reads = []; window.held = new Map();
        api = url => {
          reads.push(url);
          return new Promise((resolve, reject) => held.set(url.split('?')[0], { resolve, reject }));
        };
        window.reviewOrder = { _id: 'review-order', ref: '3116', client: 'Hagar Hanafy', status: 'pending', total: 2929,
          createdAt: '2026-11-10T09:00:00Z', items: [], depositReceipts: [{ id: 'receipt-1', amount: 500, method: 'Instapay',
            status: 'معلق', workflow: { version: 2, stage: 'requested' }, submittedBy: 'Review', submittedAt: '2026-11-10T09:00:00Z',
            noImage: true, noImageAuth: 'otp', warnings: [], ocr: {} }] };
        for (let i = 0; i < 3; i++) switchShopifySubnav('deposits');
      }, lang);
      assert.equal(await page.evaluate(() => reads.filter(url => url === '/shopify/orders/deposit-review').length), 1);
      assert.equal(await page.$$eval('#sp-deposits-tab-content .spdep-loading-card', els => els.length), 4);
      assert.equal(await page.$eval('#sp-deposits-tab-content', el => el.getAttribute('aria-busy')), 'true');
      await page.screenshot({ path: path.join(out, `deposits-${lang}-${width}.png`) });
      await page.evaluate(() => held.get('/shopify/orders/deposit-review').resolve([reviewOrder]));
      await page.waitForSelector('#sp-deposits-tab-content .spdep-review-pick');
      assert.equal(await page.evaluate(() => reads.includes('/shopify/orders')), false, 'review does not fetch every Shopify order');
      assert.equal(await page.evaluate(() => _shopifyOrders.some(o => o._id === 'unrelated-order')), true, 'queue read preserves the orders page data');
      const stable = await page.evaluate(() => {
        const card = qs('#sp-deposits-tab-content .spdep-review-card');
        loadShopifyOrders();
        return card === qs('#sp-deposits-tab-content .spdep-review-card') && !qs('#sp-deposits-tab-content .ss-skeleton');
      });
      assert.equal(stable, true, 'refresh keeps existing receipts visible');
      await page.evaluate(() => held.get('/shopify/orders/deposit-review').resolve([]));
      await page.waitForFunction(() => !_spDepositReviewRequest);
      assert.equal(await page.$('#sp-deposits-tab-content .spdep-review-pick'), null, 'removed receipts leave the queue');
      await page.evaluate(() => { _spDepositReviewIds = null; loadShopifyOrders(); held.get('/shopify/orders/deposit-review').reject(new Error('Fixture queue unavailable')); });
      await page.waitForSelector('#sp-deposits-tab-content [role=alert]');
      assert.equal(await page.$('#sp-deposits-tab-content .ss-skeleton'), null, 'failed queue exits shimmer');
      await page.evaluate(() => { loadShopifyOrders(); held.get('/shopify/orders/deposit-review').resolve([reviewOrder]); });
      await page.waitForSelector('#sp-deposits-tab-content .spdep-review-pick');
      await page.evaluate(() => switchShopifySubnav('deposit-log'));
      assert.ok(await page.$('#dep-log-results .dep-log-loading .ss-skeleton'));
      assert.equal(await page.$$eval('#dep-log-summary .dep-log-kpi', els => els.length), 4);
      assert.equal(await page.$$eval('.dep-log-loading thead th', els => els.length), 9);
      await page.screenshot({ path: path.join(out, `history-${lang}-${width}.png`) });
      await page.evaluate(() => held.get('/shopify/deposit-receipts/history').resolve({ page: 1, pages: 1, total: 1,
        summary: { totalAmount: 500, pending: 1, approved: 0 }, rows: [{ id: 'receipt-1', orderId: 'review-order', source: 'shopify',
          orderNumber: '3116', client: 'Hagar Hanafy', status: 'معلق', amount: 500, method: 'Instapay', submittedAt: '2026-11-10T09:00:00Z' }] }));
      await page.waitForSelector('#dep-log-results .dep-log-table tbody tr');
      assert.equal(await page.$('#dep-log-results .ss-skeleton'), null);
      await page.evaluate(() => switchShopifySubnav('perf'));
      assert.equal(await page.$$eval('#sp-perf-kpi-row .kpi-val .ss-skeleton', els => els.length), 3);
      assert.equal(await page.$$eval('#sp-perf-table-body tr:first-child td', els => els.length), 11);
      assert.ok(await page.$('#sp-perf-mobile-list .sp-card .ss-skeleton'));
      await page.screenshot({ path: path.join(out, `performance-${lang}-${width}.png`) });
      await page.evaluate(() => {
        window.perfResult = { rows: [{ employeeId: 'staff-1', employeeName: 'Malak Abbas', totalPoints: 30, earnedPoints: 25,
          bonusPoints: 5, prevPeriodPoints: 20, assignedOrdersCount: 10, confirmedOrdersCount: 7, deliveredOrdersCount: 5,
          depositConversionRate: 70 }], periodLabel: 'This month', isCurrentPeriod: true };
        held.get('/employee-performance/dashboard').resolve(perfResult);
      });
      await page.waitForFunction(() => !qs('#sp-perf-dashboard-content .ss-skeleton'));
      assert.ok((await page.$eval('#sp-perf-table-body', el => el.textContent)).includes('Malak Abbas'));
      await page.evaluate(() => { renderPerformanceDashboard(); });
      assert.equal(await page.$('#sp-perf-dashboard-content .ss-skeleton'), null, 'performance refresh retains real values');
      await page.evaluate(() => held.get('/employee-performance/dashboard').reject(new Error('Fixture performance unavailable')));
      await page.waitForSelector('#sp-perf-dashboard-content .sp-perf-load-error');
      assert.ok((await page.$eval('#sp-perf-table-body', el => el.textContent)).includes('Malak Abbas'), 'failed refresh preserves existing scores');
      assert.equal(await page.$eval('#sp-perf-dashboard-content', el => el.getAttribute('aria-busy')), 'false');
      await page.evaluate(() => {
        _perfPeriod = 'week'; renderPerformanceDashboard();
        window.oldPeriodRequest = held.get('/employee-performance/dashboard');
        _perfPeriod = 'year'; renderPerformanceDashboard();
        held.get('/employee-performance/dashboard').resolve({ ...perfResult,
          rows: [{ ...perfResult.rows[0], employeeName: 'Latest period' }] });
      });
      await page.waitForFunction(() => qs('#sp-perf-table-body').textContent.includes('Latest period'));
      await page.evaluate(() => oldPeriodRequest.resolve({ ...perfResult,
        rows: [{ ...perfResult.rows[0], employeeName: 'Obsolete period' }] }));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await page.$eval('#sp-perf-table-body', el => el.textContent.includes('Obsolete period')), false, 'late response cannot replace a newer performance period');
    }
    assert.deepEqual(errors, []);
    console.log('Shopify subtab shimmer: passed (desktop/mobile, Arabic/English, receipt-only reads, refresh, failure and retry)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
