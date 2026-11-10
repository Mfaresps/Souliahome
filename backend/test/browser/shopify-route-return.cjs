const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const out = path.resolve(__dirname, '../../../artifacts/shopify-route-return');
fs.mkdirSync(out, { recursive: true });

function summary(total = 100) {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    _id: String(i + 1).padStart(24, '0'), ref: String(3000 - i), client: 'Customer ' + i,
    status: 'pending', total, items: [], comments: [], depositReceipts: [],
    createdAt: '2026-11-10T09:00:00Z',
  }));
  return { rows, page: 1, limit: 30, total: rows.length, allCount: rows.length,
    pendingCount: rows.length, tabCount: rows.length, filterCounts: {}, baseCount: rows.length,
    starredCount: 0, filteredIds: rows.map(row => row._id), selectionRows: [],
    depositSummary: { instapay: 0, vodafone: 0, paidCount: 0, unpaidCount: rows.length },
    panelFacets: { status: {}, staff: {}, tags: {}, comments: 0, stock: {} },
    pendingCancelCount: 0, pendingEditCount: 0, kpiStats: null };
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    for (const [width, lang] of [[1440, 'en'], [390, 'ar']]) {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.setViewport({ width, height: 900 });
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep)
            && fs.existsSync(file) && fs.statSync(file).isFile())
          return request.respond({ status: 200, contentType: file.endsWith('.html') ? 'text/html'
            : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
        return request.respond({ status: 200, contentType: request.resourceType() === 'script'
          ? 'text/javascript' : 'application/json', body: request.resourceType() === 'script' ? '' : '[]' });
      });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(lang => {
        currentUser = { _id: 'route-test', role: 'admin', perms: [] };
        localStorage.setItem('token', 'route-test');
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
        window._startupResourceReady = null;
        const enter = onPageEnter;
        onPageEnter = page => { if (page === 'shopify-orders') return enter(page); };
        window.reads = []; window.held = []; window.legacyReads = 0;
        api = url => {
          if (url === '/shopify/orders') legacyReads++;
          if (!url.startsWith('/shopify/orders/summary-page')) return Promise.resolve([]);
          reads.push(url);
          return new Promise((resolve, reject) => held.push({ resolve, reject }));
        };
        window.timeOffset = 0; const now = Date.now;
        Date.now = () => now() + timeOffset;
        window.socketEvents = {};
        window.io = () => ({ on(name, fn) { socketEvents[name] = fn; }, emit() {}, disconnect() {} });
        connectSocket();
        navigateTo('shopify-orders');
      }, lang);
      assert.equal(await page.evaluate(() => reads.length), 1);
      assert.equal(await page.$eval('#page-shopify-orders', el => el.classList.contains('sp-nav-pending')), true);
      await page.evaluate(result => held[0].resolve(result), summary());
      await page.waitForFunction(() => _spOrdersLoaded && !_spServerRequest);
      const remember = await page.evaluate(() => {
        window.rowSelector = innerWidth > 768 ? '#shopify-orders-table-body tr[data-sp-order-id]'
          : '#sp-mobile-list [data-sp-order-id]';
        window.firstRow = qs(rowSelector);
        const box = qs('.sp-table-scroll'); if (box) box.scrollTop = 100;
        window.savedScroll = box?.scrollTop;
        _shopifySelectedIds.add(_shopifyOrders[0]._id);
        navigateTo('movements'); navigateTo('shopify-orders');
        return { sameRow: firstRow === qs(rowSelector), pending: qs('#page-shopify-orders').classList.contains('sp-nav-pending'),
          reads: reads.length, scroll: qs('.sp-table-scroll')?.scrollTop, savedScroll,
          selected: _shopifySelectedIds.size };
      });
      assert.equal(remember.pending, false, `${width}: returning must not mask the populated page`);
      assert.equal(remember.reads, 1, `${width}: a recent page is reused without refetching`);
      assert.equal(remember.sameRow, true, `${width}: existing rows are preserved`);
      assert.equal(remember.scroll, remember.savedScroll);
      assert.equal(remember.selected, 1);
      // A stale page remains usable while exactly one revalidation is pending.
      await page.evaluate(() => { timeOffset += 31000; navigateTo('movements'); navigateTo('shopify-orders'); });
      assert.equal(await page.evaluate(() => reads.length), 2);
      assert.equal(await page.evaluate(() => firstRow === qs(rowSelector)
        && !qs('#page-shopify-orders').classList.contains('sp-nav-pending') && qs('#sp-orders-loading').hidden), true);
      await page.screenshot({ path: path.join(out, `background-refresh-${lang}-${width}.png`) });
      await page.evaluate(() => { navigateTo('movements'); navigateTo('shopify-orders'); });
      assert.equal(await page.evaluate(() => reads.length), 2, 'rapid returns share a pending refresh');
      // Completion while away is cached, without navigating back or marking the page seen.
      await page.evaluate(result => { navigateTo('movements'); held[1].resolve(result); }, summary(200));
      await page.waitForFunction(() => !_spServerRequest);
      assert.equal(await page.evaluate(() => currentPage), 'movements');
      await page.evaluate(() => navigateTo('shopify-orders'));
      assert.equal(await page.evaluate(() => reads.length), 2);
      assert.equal(await page.evaluate(() => _shopifyOrders[0].total), 200);
      // A live event received while away must invalidate the snapshot immediately.
      await page.evaluate(() => {
        navigateTo('movements');
        socketEvents['shopify:order-created']({ id: 'new-order' });
        for (const name of ['shopify:deposit-changed', 'shopify:phone-changed', 'shopify:client-changed',
          'shopify:items-changed', 'shopify:order-cancel-conflict', 'shopify:edit-changed', 'connect']) socketEvents[name]();
        navigateTo('shopify-orders');
      });
      assert.equal(await page.evaluate(() => legacyReads), 0, 'events on Movements must not download complete Shopify history');
      assert.equal(await page.evaluate(() => reads.length), 3);
      assert.equal(await page.evaluate(() => qs('#sp-orders-loading').hidden), true);
      await page.evaluate(() => held[2].reject(new Error('Fixture background refresh failed')));
      await page.waitForFunction(() => !_spServerRequest);
      assert.equal(await page.evaluate(() => !!qs(rowSelector)
        && !qs('#page-shopify-orders').classList.contains('sp-nav-pending') && qs('#sp-orders-loading').hidden), true,
        'background failure keeps the last rows visible');
      await page.evaluate(result => { refreshShopifyOrders(); held[3].resolve(result); }, summary(300));
      await page.waitForFunction(() => !_spServerRequest);
      assert.equal(await page.evaluate(() => _shopifyOrders[0].total), 300, 'manual refresh still reads current data');
      await page.evaluate(() => {
        navigateTo('movements'); qs('#shopify-search').value = '4000'; navigateTo('shopify-orders');
      });
      assert.equal(await page.evaluate(() => reads.length), 5);
      assert.equal(await page.evaluate(() => new URLSearchParams(reads[4].split('?')[1]).get('search')), '4000');
      assert.equal(await page.$eval('#page-shopify-orders', el => el.classList.contains('sp-nav-pending')), true,
        'a different filter cannot reuse an unrelated cached view');
      await page.evaluate(result => held[4].resolve(result), summary(350));
      await page.waitForFunction(() => !_spServerRequest);
      // An old account's data must never be used as the next account's cached view.
      await page.evaluate(() => { navigateTo('movements'); localStorage.setItem('token', 'different-account'); navigateTo('shopify-orders'); });
      assert.equal(await page.evaluate(() => reads.length), 6);
      assert.equal(await page.$eval('#page-shopify-orders', el => el.classList.contains('sp-nav-pending')), true);
      await page.evaluate(result => held[5].resolve(result), summary(400));
      await page.waitForFunction(() => !_spServerRequest);
      assert.deepEqual(errors, [], `${width}: browser errors`);
      await page.close();
    }
    console.log('PASS: Shopify route return reuses rows, preserves selection/scroll, refreshes stale/live data in the background, retains off-page responses, handles failures, and isolates accounts.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
