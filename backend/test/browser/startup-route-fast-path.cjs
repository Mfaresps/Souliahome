const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const ORIGIN = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';

// The secondary collection is deliberately left pending. Each direct route
// must become usable from its own data without waiting for that collection.
const routes = [
  ['/#transactions', 'movements'],
  ['/#transactions', 'movements', false, true],
  ['/#pickup-orders', 'pickup-orders'],
  ['/#shopify-orders', 'shopify-orders'],
  ['/#shopify-orders', 'shopify-orders', false, false, true],
  ['/#warehouse-management', 'barcodes'],
  ['/#barcodes', 'barcodes'],
  ['/#warehouse-management/layout', 'barcodes'],
  ['/#warehouse-management/layout', 'barcodes', true],
  ['/#barcodes/layout', 'barcodes'],
  ['/#warehouse-layout', 'barcodes'],
  ['/#transactions/orders/view/sales-123', 'invoice-view'],
];

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    for (const [url, expectedPage, productsOnly = false, nullTransactions = false, nullOrders = false] of routes) {
      const page = await browser.newPage();
      const errors = [];
      const consoleErrors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
      await page.evaluateOnNewDocument(productsOnly => {
        localStorage.setItem('token', 'startup-route-test');
        localStorage.setItem('user', JSON.stringify({ name: 'Test', role: productsOnly ? 'staff' : 'admin', perms: productsOnly ? ['products'] : [] }));
      }, productsOnly);
      await page.setRequestInterception(true);
      let expensesRequested = false;
      const routeReads = { '/api/transactions/startup-overview': 0, '/api/shopify/orders': 0, '/api/shopify/orders/summary-page': 0,
        '/api/transactions/pickup-orders': 0, '/api/transactions/pickup-orders/workspace': 0,
        '/api/transactions/movements-page': 0, '/api/transactions/summary-page': 0 };
      page.on('request', request => {
        const pathname = new URL(request.url()).pathname;
        if (!pathname.startsWith('/api/')) return request.continue();
        if (pathname in routeReads) routeReads[pathname]++;
        // A slow overview must not hold these independently paged workspaces.
        if (pathname === '/api/transactions/startup-overview'
            && ['movements', 'pickup-orders', 'shopify-orders'].includes(expectedPage)) return;
        if (pathname === '/api/test-stall') return;
        if (pathname === '/api/test-unavailable') return request.respond({
          status: 502, contentType: 'application/json',
          body: JSON.stringify({ error: 'Backend connection failed' }),
        });
        if (pathname === '/api/expenses') {
          expensesRequested = true;
          return;
        }
        let body = '[]';
        if (pathname === '/api/auth/me') body = JSON.stringify({ name: 'Test', role: productsOnly ? 'staff' : 'admin', perms: productsOnly ? ['products'] : [] });
        if (pathname === '/api/warehouse-layout') body = JSON.stringify({ warehouses: [{ code: 'MAIN', name: 'Main warehouse' }], locations: [], labelSizes: [{ id: '80x40', widthMm: 80, heightMm: 40 }] });
        if (pathname === '/api/settings' || pathname === '/api/transactions/dashboard') body = '{}';
        if (pathname === '/api/transactions/startup-overview') body = JSON.stringify({ rows: [], activeCount: 0 });
        if (pathname === '/api/transactions/movements-page') body = nullTransactions ? 'null' : JSON.stringify({
          pageRows: [], total: 0, page: 1, pageSize: 20, transactionCount: 0, activeCount: 0,
          tabCounts: { all: 0, sales: 0, purchase: 0, returns: 0 },
          facets: { employee: {}, method: {}, status: {}, operation: {}, bosta: {}, pickup: {}, tags: {} },
          kpi: { sales: 0, shipping: 0, shipLoss: 0, purchases: 0, returns: 0,
            remainingCollection: 0, remainingSupplier: 0, pending: 0, completed: 0,
            cancelled: 0, delivered: 0, mini: { sales: 0, purchases: 0, returns: 0 },
            series: { sales: null, purchases: null, remainingCollection: null } }, orderIds: [],
        });
        if (pathname === '/api/transactions/summary-page') body = nullTransactions
          ? 'null' : JSON.stringify({ rows: [], total: 0, page: 1, pageSize: 200 });
        if (pathname === '/api/shopify/orders/summary-page') body = nullOrders ? 'null' : JSON.stringify({
          rows: [], page: 1, limit: 30, total: 0, allCount: 0, pendingCount: 0, tabCount: 0,
          filterCounts: {}, baseCount: 0, starredCount: 0, filteredIds: [], selectionRows: [],
          depositSummary: { instapay: 0, vodafone: 0, paidCount: 0, unpaidCount: 0 },
          panelFacets: { status: {}, staff: {}, tags: {}, comments: 0, stock: {} },
          pendingCancelCount: 0, pendingEditCount: 0, kpiStats: null,
        });
        return request.respond({ status: 200, contentType: 'application/json', body });
      });

      await page.goto(ORIGIN + url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      try {
        await page.waitForFunction(expected => currentPage === expected
          && document.querySelector('#page-' + expected)?.classList.contains('active')
          && !document.querySelector('#splash-screen'), { timeout: 10000 }, expectedPage);
      } catch (error) {
        const state = await page.evaluate(() => ({ hash: location.hash, page: window.currentPage, active: [...document.querySelectorAll('.page.active')].map(node => node.id), splash: !!document.querySelector('#splash-screen') }));
        throw new Error(`${url}: ${error.message}; ${JSON.stringify(state)}; page errors: ${errors.join(' | ')}`);
      }
      if (url.includes('/layout') || url.includes('#warehouse-layout')) {
        await page.waitForSelector('#page-barcodes #page-warehouse-layout .wl-grid');
        assert.equal(await page.$eval('#iu-tab-layout', element => element.getAttribute('aria-selected')), 'true');
        assert.equal(await page.evaluate(() => location.hash), '#warehouse-management/layout');
        if (productsOnly) assert.equal(await page.$$eval('#page-barcodes [data-iu-tab]:not([hidden])', tabs => tabs.length), 1);
      }
      if (url === '/#barcodes') assert.equal(await page.evaluate(() => location.hash), '#warehouse-management');
      if (url === '/#warehouse-management') {
        for (const [lang, expected] of [['ar', 'إدارة المخازن'], ['en', 'Warehouse management']]) {
          const labels = await page.evaluate(async language => {
            currentLang = language;
            buildSidebar();
            await window.renderBarcodeManagement();
            return { heading: document.querySelector('#page-barcodes h1')?.textContent,
              navigation: document.querySelector('#sidebar [data-page="barcodes"]')?.textContent?.trim() };
          }, lang);
          assert.equal(labels.heading, expected);
          assert.equal(labels.navigation, expected);
        }
      }
      assert.equal(expensesRequested, true, `${expectedPage}: background read was not started`);
      assert.equal(await page.evaluate(() => !!window._startupBackgroundReady), true,
        `${expectedPage}: first view waited for the unrelated read`);
      if (nullTransactions) {
        assert.equal(await page.evaluate(() => Array.isArray(transactions)), true, 'null transaction response must not replace the list');
        assert.equal(await page.evaluate(() => !!document.querySelector('#mov-grid-list')?.textContent), true,
          'invalid Movements response must show a retryable error');
        assert.equal(consoleErrors.some(message => message.includes("Cannot read properties of null (reading 'filter')")), false);
      }
      if (nullOrders) {
        await page.waitForFunction(() => !!_spReceiptLoadError);
        assert.equal(await page.evaluate(() => Array.isArray(_shopifyOrders)), true, 'null Shopify response must not replace the list');
        assert.equal(await page.$eval('#sp-orders-loading', el => el.dataset.state), 'error');
      }
      if (expectedPage === 'shopify-orders') {
        assert.equal(routeReads['/api/shopify/orders/summary-page'], 1,
          'Shopify route must request one summary page');
        assert.equal(routeReads['/api/shopify/orders'], 0,
          'Shopify route must not load complete orders');
        assert.equal(routeReads['/api/transactions/summary-page'], 0,
          'Shopify route must not load transaction history');
      }
      if (expectedPage === 'pickup-orders') {
        assert.equal(routeReads['/api/transactions/pickup-orders/workspace'], 1,
          'Pick-up route must reuse its startup read');
        assert.equal(routeReads['/api/transactions/summary-page'], 0,
          'Pick-up must not download transaction history before opening');
      }
      if (expectedPage === 'movements') {
        assert.equal(routeReads['/api/transactions/movements-page'], 1, 'Movements must request one page');
        assert.equal(routeReads['/api/transactions/summary-page'], 0, 'Movements must not load all summary pages');
        const timeoutCode = await page.evaluate(async () => {
          const originalSetTimeout = window.setTimeout;
          window.setTimeout = (callback, ms, ...args) =>
            originalSetTimeout(callback, ms === 30000 ? 10 : ms, ...args);
          try {
            await api('/test-stall');
            return 'unexpected success';
          } catch (error) {
            return error.code;
          } finally {
            window.setTimeout = originalSetTimeout;
          }
        });
        assert.equal(timeoutCode, 'TIMEOUT', 'a stalled read must finish with a retryable error');
        const unavailable = await page.evaluate(async () => {
          try { await api('/test-unavailable'); return null; }
          catch (error) { return { code: error.code, message: error.message }; }
        });
        assert.equal(unavailable.code, 'BACKEND_UNAVAILABLE');
        assert.match(unavailable.message, /الخادم غير متاح/);
      }
      assert.deepEqual(errors, [], `${expectedPage}: browser errors`);
      await page.close();
    }
    console.log('PASS: direct routes bypass unrelated startup data, reuse route reads, and time out stalled reads.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
