const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const ORIGIN = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';

const movementPage = {
  pageRows: [], total: 0, page: 1, pageSize: 20, transactionCount: 0, activeCount: 0,
  tabCounts: { all: 0, sales: 0, purchase: 0, returns: 0 },
  facets: { employee: {}, method: {}, status: {}, operation: {}, bosta: {}, pickup: {}, tags: {} },
  kpi: { sales: 0, shipping: 0, shipLoss: 0, purchases: 0, returns: 0,
    remainingCollection: 0, remainingSupplier: 0, pending: 0, completed: 0,
    cancelled: 0, delivered: 0, mini: { sales: 0, purchases: 0, returns: 0 },
    series: { sales: null, purchases: null, remainingCollection: null } },
  orderIds: [],
};

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('token', 'movements-refresh-test');
      localStorage.setItem('user', JSON.stringify({ name: 'Test', role: 'admin', perms: [] }));
    });
    let pageReads = 0;
    let carrierStatus = 'CREATED';
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return request.continue();
      let body = '[]';
      if (pathname === '/api/auth/me') body = JSON.stringify({ name: 'Test', role: 'admin', perms: [] });
      if (pathname === '/api/settings' || pathname === '/api/transactions/dashboard') body = '{}';
      if (pathname === '/api/transactions/startup-overview') body = JSON.stringify({ rows: [], activeCount: 0 });
      if (pathname === '/api/transactions/bosta-test') body = JSON.stringify({
        _id: 'bosta-test', bostaOrderId: 'B1', bostaStatus: carrierStatus,
        editHistory: [],
        bostaLastSync: '2026-11-09T12:00:00.000Z', updatedAt: '2026-11-09T12:00:00.000Z',
      });
      if (pathname === '/api/transactions/movements-page') {
        pageReads++;
        await new Promise(resolve => setTimeout(resolve, 70));
        body = JSON.stringify({ ...movementPage,
          tabCounts: { ...movementPage.tabCounts, all: carrierStatus === 'IN_TRANSIT' ? 1 : 0 } });
      }
      if (pathname.startsWith('/api/shipping/sync/')) body = JSON.stringify({ success: true, status: 'CREATED' });
      return request.respond({ status: 200, contentType: 'application/json', body });
    });
    await page.goto(ORIGIN + '/#transactions', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => currentPage === 'movements' && !!_movServerResponse);
    await new Promise(resolve => setTimeout(resolve, 700));
    await page.evaluate(() => renderMovements());
    await page.evaluate(() => {
      window._movTableMutations = 0;
      new MutationObserver(records => {
        window._movTableMutations += records.filter(record => record.type === 'childList').length;
      }).observe(document.querySelector('#mov-table tbody'), { childList: true });
    });

    const initialReads = pageReads;
    await page.evaluate(() => renderMovements());
    assert.equal(pageReads, initialReads, 'a cached render must not issue another request');
    await page.evaluate(() => loadTransactionSummaries());
    const readsAfterLoader = pageReads;
    await page.evaluate(() => renderMovements());
    assert.equal(pageReads, readsAfterLoader, 'render after the loader must reuse its result');
    assert.equal(await page.evaluate(() => window._movTableMutations), 0,
      'reusing an already painted response must not redraw the table');

    const beforeRefresh = await page.$eval('#mov-table tbody', element => element.innerHTML);
    await page.evaluate(() => { _transactionLiveRevision++; renderMovements(); });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(await page.$eval('#mov-table tbody', element => element.innerHTML), beforeRefresh,
      'background refresh must leave the visible table in place');
    await page.waitForFunction(() => !_movServerRequest);
    assert.equal(pageReads, readsAfterLoader + 1, 'a live revision must request one fresh page');
    assert.equal(await page.evaluate(() => window._movTableMutations), 0,
      'unchanged background data must not redraw the table');

    await page.evaluate(async () => {
      document.querySelector('#mov-search').value = 'missing';
      await renderMovements();
    });
    assert.ok(await page.evaluate(() => window._movTableMutations) >= 1,
      'a changed filter must redraw the table');
    assert.equal(pageReads, readsAfterLoader + 2, 'a changed filter must request one page');
    const beforeLanguage = await page.evaluate(() => window._movTableMutations);
    const revisionBeforeLanguage = await page.evaluate(() => _apiWriteRevision);
    const readsBeforeLanguage = pageReads;
    await page.evaluate(() => { currentLang = 'en'; return renderMovements(); });
    assert.ok(await page.evaluate(() => window._movTableMutations) > beforeLanguage,
      'a language change must redraw the cached response');
    if (revisionBeforeLanguage === await page.evaluate(() => _apiWriteRevision))
      assert.equal(pageReads, readsBeforeLanguage, 'a language change must reuse the cached page');
    const beforeInPlaceChange = await page.evaluate(() => window._movTableMutations);
    await page.evaluate(() => { _movServerResponse.tabCounts.all = 1; return renderMovements(); });
    assert.ok(await page.evaluate(() => window._movTableMutations) > beforeInPlaceChange,
      'an in-place data change must redraw the cached response');

    const readsBeforeSync = pageReads;
    const mutationsBeforeSync = await page.evaluate(() => window._movTableMutations);
    await page.evaluate(async () => {
      transactions = [{ _id: 'bosta-test', bostaOrderId: 'B1', bostaStatus: 'CREATED', hasEditHistory: false }];
      await _bostaAutoSync();
    });
    assert.equal(pageReads, readsBeforeSync, 'an unchanged automatic Bosta sync must not refetch Movements');
    assert.equal(await page.evaluate(() => window._movTableMutations), mutationsBeforeSync,
      'an unchanged automatic Bosta sync must not redraw Movements');
    await page.evaluate(() => _rtFetchTx('bosta-test'));
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(pageReads, readsBeforeSync, 'a carrier timestamp event must not refetch Movements');
    assert.equal(await page.evaluate(() => window._movTableMutations), mutationsBeforeSync,
      'a carrier timestamp event must not redraw Movements');
    carrierStatus = 'IN_TRANSIT';
    const mutationsBeforeChange = await page.evaluate(() => window._movTableMutations);
    await page.evaluate(() => _rtFetchTx('bosta-test'));
    await page.waitForFunction(() => _movRecentlyUpdatedIds.has('bosta-test'));
    await page.waitForFunction(() => !_movServerRequest && _movServerKey === JSON.stringify([
      localStorage.getItem('token'), _apiWriteRevision, _transactionLiveRevision, _movServerState(),
    ]));
    assert.equal(pageReads, readsBeforeSync + 1, 'a changed carrier status must refresh Movements once');
    assert.ok(await page.evaluate(() => window._movTableMutations) > mutationsBeforeChange,
      'changed server data must redraw Movements');
    console.log('PASS: cached calls, background refresh, filters, language, in-place data, and carrier sync.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
