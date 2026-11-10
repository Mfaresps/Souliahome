const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
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
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentUser = { _id: 'nav-test', role: 'admin', perms: [] }; localStorage.setItem('token', 'nav-test');
      qs('#login-page').style.display = 'none'; qs('#app').style.display = ''; qs('#splash-screen')?.remove();
      currentLang = 'en'; currentPage = 'dashboard';
      onPageEnter = page => entries.push(page); buildSidebar = () => {}; buildNotifications = () => {};
      window.entries = []; window.toasts = []; toast = message => toasts.push(message);
      window.reads = []; window.held = []; transactions = []; _transactionSummariesComplete = false;
      api = url => {
        reads.push(url);
        return new Promise((resolve, reject) => held.push({ url, resolve, reject }));
      };
      window.started = [];
      window._startupResourceReady = [];
      for (const index of [0, 2, 12]) {
        const state = { settled: false, start() { if (!started.includes(index)) started.push(index); } };
        state.promise = new Promise(resolve => { state.release = () => { state.settled = true; resolve([]); }; });
        window._startupResourceReady[index] = state;
      }
      for (let i = 0; i < 5; i++) navigateTo('transaction');
    });
    assert.equal(await page.evaluate(() => reads.length), 1, 'repeated clicks share one index request');
    assert.deepEqual(await page.evaluate(() => started), [0, 2, 12], 'products, suppliers and stock start alongside the index');
    assert.equal(await page.$eval('#main', el => el.dataset.pendingRoute), 'transaction');
    assert.ok(await page.$('#page-transaction .ss-skeleton'), 'New Transaction responds immediately with real form shimmer');
    await page.evaluate(() => {
      navigateTo('products');
      _startupResourceReady.forEach(state => state?.release());
    });
    await page.waitForFunction(() => currentPage === 'products');
    assert.equal(await page.evaluate(() => reads.length), 1, 'Products opens with the transaction index still held');
    assert.deepEqual(await page.evaluate(() => entries), ['products']);
    await page.evaluate(() => held[0].resolve({ rows: Array.from({ length: 200 }, (_, i) => ({ _id: 'row-' + i, total: 10 })),
      total: 201, snapshot: 'fixed-list' }));
    await page.waitForFunction(() => held.length === 2);
    assert.match(await page.evaluate(() => reads[1]), /snapshot=fixed-list/, 'later pages use the same server snapshot');
    await page.evaluate(() => {
      // Unrelated writes and live changes must not restart a complete list read.
      _apiWriteRevision += 10; _transactionLiveRevision += 10;
      _puMergeLiveTransaction({ _id: 'row-0', total: 777 });
      _puMergeLiveTransaction({ _id: 'live-created', type: 'مشتريات', total: 88 });
      _puMergeLiveTransaction({ _id: 'row-1' }, true);
      held[1].resolve({ rows: [{ _id: 'row-200', total: 10 }], total: 201, snapshot: 'fixed-list' });
      return _transactionSummaryTask;
    });
    const merged = await page.evaluate(() => ({ page: currentPage, complete: _transactionSummariesComplete,
      count: transactions.length, edited: transactions.find(tx => tx._id === 'row-0')?.total,
      created: transactions.find(tx => tx._id === 'live-created')?.total,
      deleted: transactions.some(tx => tx._id === 'row-1'), requests: reads.length, toasts }));
    assert.deepEqual(merged, { page: 'products', complete: true, count: 201, edited: 777, created: 88,
      deleted: false, requests: 2, toasts: [] }, 'live patches survive and cancelled navigation never redirects later');
    await page.evaluate(() => { navigateTo('transaction'); });
    assert.equal(await page.evaluate(() => currentPage), 'transaction');
    assert.deepEqual(await page.evaluate(() => entries), ['products', 'transaction']);
    // Exactly one continuation and error for five clicks while a read fails.
    await page.evaluate(() => {
      navigateTo('products'); _transactionSummariesComplete = false;
      held = []; reads = [];
      for (let i = 0; i < 5; i++) navigateTo('transaction');
      held[0].reject(new Error('Fixture read unavailable'));
    });
    await page.waitForFunction(() => _transactionSummaryTask === null);
    assert.equal(await page.evaluate(() => toasts.length), 1, 'failure appears once');
    assert.equal(await page.evaluate(() => currentPage), 'products', 'a failed pending route does not reset the current page');
    // Retry is usable immediately, even with another burst of background writes.
    await page.evaluate(() => {
      held = []; reads = []; toasts = [];
      for (let i = 0; i < 5; i++) navigateTo('transaction');
      _apiWriteRevision += 10; _transactionLiveRevision += 10;
      held[0].resolve({ rows: [], total: 0, snapshot: 'retry-list' });
    });
    await page.waitForFunction(() => currentPage === 'transaction' && _transactionSummaryTask === null);
    assert.equal(await page.evaluate(() => entries.filter(p => p === 'transaction').length), 2, 'one form initialization per successful navigation');
    // A different account must never receive the result of the old read.
    const session = await page.evaluate(async () => {
      _transactionSummariesComplete = false; held = []; reads = [];
      const task = loadTransactionSummaries({ forceFull: true }).catch(error => error.name);
      localStorage.setItem('token', 'other-account');
      held[0].resolve({ rows: [{ _id: 'private-old-account' }], total: 1 });
      return { outcome: await task, leaked: transactions.some(tx => tx._id === 'private-old-account') };
    });
    assert.deepEqual(session, { outcome: 'AbortError', leaked: false });
    assert.deepEqual(errors, []);
    console.log('Live summary navigation: passed (concurrent clicks, Products independence, snapshots, live patches, retry and account changes)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
