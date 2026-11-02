const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

// The secondary collection is deliberately left pending. Each direct route
// must become usable from its own data without waiting for that collection.
const routes = [
  ['/#transactions', 'movements'],
  ['/#pickup-orders', 'pickup-orders'],
  ['/#shopify-orders', 'shopify-orders'],
  ['/#transactions/orders/view/sales-123', 'invoice-view'],
];

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    for (const [url, expectedPage] of routes) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.evaluateOnNewDocument(() => {
        localStorage.setItem('token', 'startup-route-test');
        localStorage.setItem('user', JSON.stringify({ name: 'Test', role: 'admin', perms: [] }));
      });
      await page.setRequestInterception(true);
      let expensesRequested = false;
      const routeReads = { '/api/shopify/orders': 0, '/api/transactions/pickup-orders': 0 };
      page.on('request', request => {
        const pathname = new URL(request.url()).pathname;
        if (!pathname.startsWith('/api/')) return request.continue();
        if (pathname in routeReads) routeReads[pathname]++;
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
        if (pathname === '/api/auth/me') body = JSON.stringify({ name: 'Test', role: 'admin', perms: [] });
        if (pathname === '/api/settings' || pathname === '/api/transactions/dashboard') body = '{}';
        return request.respond({ status: 200, contentType: 'application/json', body });
      });

      await page.goto('http://127.0.0.1:8080' + url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForFunction(expected => currentPage === expected
        && document.querySelector('#page-' + expected)?.classList.contains('active')
        && !document.querySelector('#splash-screen'), { timeout: 10000 }, expectedPage);
      assert.equal(expensesRequested, true, `${expectedPage}: background read was not started`);
      assert.equal(await page.evaluate(() => !!window._startupBackgroundReady), true,
        `${expectedPage}: first view waited for the unrelated read`);
      if (expectedPage === 'shopify-orders') assert.equal(routeReads['/api/shopify/orders'], 1,
        'Shopify route must reuse its startup read');
      if (expectedPage === 'pickup-orders') assert.equal(routeReads['/api/transactions/pickup-orders'], 1,
        'Pick-up route must reuse its startup read');
      if (expectedPage === 'movements') {
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
