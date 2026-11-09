const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const summary = { rows: [], page: 1, limit: 30, total: 0, allCount: 0,
  pendingCount: 0, tabCount: 0, filterCounts: {}, baseCount: 0,
  starredCount: 0, filteredIds: [], selectionRows: [],
  depositSummary: { instapay: 0, vodafone: 0, paidCount: 0, unpaidCount: 0 },
  panelFacets: { status: {}, staff: {}, tags: {}, comments: 0, stock: {} },
  pendingCancelCount: 0, pendingEditCount: 0, kpiStats: null };

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    for (const { role, hash, tab, width } of [
      { role: 'admin', hash: '#dashboard', tab: 'orders' },
      { role: 'admin', hash: '#dashboard', tab: 'orders', width: 390 },
      { role: 'staff', hash: '#dashboard', tab: 'orders' },
      { role: 'admin', hash: '#shopify-orders/perf', tab: 'perf' },
      { role: 'admin', hash: '#shopify-orders/deposits/log', tab: 'deposit-log' },
    ]) {
      const page = await browser.newPage();
      await page.setViewport({ width: width || 1280, height: 844 });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.evaluateOnNewDocument(userRole => {
        const perms = userRole === 'staff' ? ['dashboard', 'shopify-orders'] : [];
        localStorage.setItem('token', 'shopify-subnav-summary-test');
        localStorage.setItem('user', JSON.stringify({ _id: 'test-user', name: 'Test', role: userRole, perms }));
      }, role);
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.pathname === '/vendor/socket.io-4.7.5.min.js')
          return request.respond({ status: 200, contentType: 'text/javascript',
            body: 'window.io=()=>({on(){},emit(){},disconnect(){}});' });
        if (!url.pathname.startsWith('/api/')) return request.continue();
        let body = [];
        if (url.pathname === '/api/auth/me') body = { _id: 'test-user', name: 'Test', role,
          perms: role === 'staff' ? ['dashboard', 'shopify-orders'] : [] };
        if (url.pathname === '/api/settings') body = {};
        if (url.pathname === '/api/transactions/startup-overview') body = { rows: [], activeCount: 0 };
        if (url.pathname === '/api/shopify/orders/summary-page') body = summary;
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(origin + '/' + hash, { waitUntil: 'domcontentloaded' });
      if (hash === '#dashboard') {
        await page.waitForFunction(() => currentPage === 'dashboard' && window.souliaPushAppReady);
        await page.evaluate(() => navigateTo('shopify-orders'));
      }
      await page.waitForFunction(expected => currentPage === 'shopify-orders'
        && _spSubnavTab === expected && (expected !== 'orders' || _spOrdersLoaded), { timeout: 15000 }, tab);
      const visible = await page.$$eval('#sp-subnav [role="tab"]', tabs => tabs
        .filter(tab => !tab.hidden && getComputedStyle(tab).display !== 'none').map(tab => tab.id));
      assert.deepEqual(visible, role === 'admin'
        ? ['sp-subnav-orders', 'sp-subnav-deposits', 'sp-subnav-deposit-log', 'sp-subnav-perf']
        : ['sp-subnav-orders'], `${role} ${hash}: summary route tabs`);
      await page.click('#sp-subnav-shell > summary');
      await page.waitForFunction(() => document.querySelector('#sp-subnav-shell')?.open);
      const menuVisible = await page.$$eval('#sp-subnav [role="tab"]', tabs => tabs
        .filter(tab => !tab.hidden && tab.getClientRects().length).map(tab => tab.id));
      assert.deepEqual(menuVisible, visible, `${role} ${hash} ${width || 1280}: opened menu`);
      assert.equal(await page.$eval('#sp-subnav [role="tab"].active', el => el.id),
        'sp-subnav-' + tab, `${role} ${hash}: selected tab`);
      assert.deepEqual(errors, [], `${role} ${hash}: browser errors`);
      await page.close();
    }
    console.log('PASS: Orders summary and direct routes show admin tabs, preserve staff restriction, and select the requested tab.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
