// Live populated-data assertions; Chromium blocks all API writes.
require('dotenv').config({ quiet: true });
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia');
  let browser;
  try {
    const admin = await mongoose.connection.db.collection('users').findOne(
      { role: 'admin', isActive: { $ne: false } }, { projection: { _id: 1, username: 1, name: 1, role: 1 } });
    if (!admin) throw Error('No active admin account');
    const token = jwt.sign({ sub: String(admin._id), username: admin.username },
      process.env.JWT_SECRET || 'soulia_jwt_default_secret', { expiresIn: '30m' });
    const user = { _id: String(admin._id), username: admin.username, name: admin.name, role: admin.role };
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const reads = [];
    const errors = [];
    let failOrders = false, failMovements = false;
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluateOnNewDocument((jwtToken, account) => {
      localStorage.setItem('token', jwtToken);
      localStorage.setItem('user', JSON.stringify(account));
      localStorage.removeItem('soulia_adb_autoshow_enabled');
    }, token, user);
    await page.setRequestInterception(true);
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/')) reads.push({ pathname, method: request.method() });
      if ((pathname === '/api/shopify/orders/summary-page' && failOrders) ||
          (pathname === '/api/transactions/movements-page' && failMovements))
        return request.respond({ status: 500, contentType: 'application/json', body: '{"message":"test failure"}' });
      if (pathname.startsWith('/api/') && request.method() !== 'GET' &&
          !(pathname === '/api/transactions/movements-page' && request.method() === 'POST'))
        return request.respond({ status: 405, contentType: 'application/json', body: '{}' });
      if (pathname.startsWith('/api/shipping/sync/'))
        return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
      request.continue();
    });
    const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8081';
    await page.goto(origin + '/#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.souliaPushAppReady && currentPage === 'dashboard' && _dashFuLoaded);
    const enter = async (route, predicate) => {
      await page.evaluate(name => navigateTo(name), route);
      await page.waitForFunction(predicate, { timeout: 30000 });
    };
    await enter('followups', () => currentPage === 'followups' && followUps.some(f => Array.isArray(f.comments)) && _fuPage === 1);
    await page.evaluate(() => _fuTabLoadPromise);
    const followupPaint = await page.evaluate(() => {
      const repaint = [], compare = [];
      for (let i = 0; i < 7; i++) {
        let start = performance.now();
        const snapshot = JSON.stringify(followUps);
        compare.push(performance.now() - start);
        start = performance.now();
        renderFollowUps();
        repaint.push(performance.now() - start);
        void snapshot;
      }
      const median = rows => rows.sort((a, b) => a - b)[3];
      return { compareMs: Math.round(median(compare) * 10) / 10,
        repaintMs: Math.round(median(repaint) * 10) / 10 };
    });
    const initialFollowupRead = reads.filter(r => r.pathname === '/api/followups').length;
    const firstRow = await page.evaluate(() => {
      setFuPage(2);
      window.__phase11FollowupRow = document.querySelector('#fu-tbody tr');
      return { page: _fuPage, rows: document.querySelectorAll('#fu-tbody tr').length };
    });
    assert.equal(firstRow.page, 2);
    assert(firstRow.rows > 0);
    await enter('dashboard', () => currentPage === 'dashboard');
    await enter('followups', () => currentPage === 'followups' && _fuPage === 2);
    await page.evaluate(() => _fuTabLoadPromise);
    assert.equal(reads.filter(r => r.pathname === '/api/followups').length, initialFollowupRead,
      'quick Follow-ups return must reuse its full list');
    assert.equal(await page.evaluate(() => document.querySelector('#fu-tbody tr') === window.__phase11FollowupRow), true,
      'unchanged Follow-ups must keep existing rows');
    await page.evaluate(() => { document.querySelector('#fu-search').value = 'phase11-no-match'; _fuFilterChange(); });
    await enter('dashboard', () => currentPage === 'dashboard');
    await enter('followups', () => currentPage === 'followups');
    assert.equal(await page.evaluate(() => document.querySelector('#fu-search').value), 'phase11-no-match');
    assert.equal(await page.evaluate(() => _fuPage), 1);
    await page.evaluate(() => {
      document.querySelector('#fu-from').value = '2020-01-01';
      document.querySelector('#fu-to').value = '2030-12-31';
      _fuFilterChange();
    });
    await enter('dashboard', () => currentPage === 'dashboard');
    await enter('followups', () => currentPage === 'followups');
    assert.deepEqual(await page.evaluate(() => [qs('#fu-from').value, qs('#fu-to').value]),
      ['2020-01-01', '2030-12-31'], 'Follow-ups dates must survive navigation');
    await page.evaluate(() => { _apiWriteRevision++; document.querySelector('#fu-search').value = ''; _fuFilterChange(); });
    const beforeWriteInvalidation = reads.filter(r => r.pathname === '/api/followups').length;
    await enter('dashboard', () => currentPage === 'dashboard');
    await enter('followups', () => currentPage === 'followups');
    await page.evaluate(() => _fuTabLoadPromise);
    assert.equal(reads.filter(r => r.pathname === '/api/followups').length, beforeWriteInvalidation + 1,
      'a write revision must invalidate Follow-ups reuse');
    await page.evaluate(() => { _followUpsLiveRevision++; });
    const beforeLiveInvalidation = reads.filter(r => r.pathname === '/api/followups').length;
    await enter('dashboard', () => currentPage === 'dashboard');
    await enter('followups', () => currentPage === 'followups');
    await page.evaluate(() => _fuTabLoadPromise);
    assert.equal(reads.filter(r => r.pathname === '/api/followups').length, beforeLiveInvalidation + 1,
      'a live event must invalidate Follow-ups reuse');

    await enter('shopify-orders', () => currentPage === 'shopify-orders' && _spServerResponse?.rows?.length > 0);
    await page.evaluate(async () => { shopifyPage = 2; await _spLoadServerPage(true); });
    assert.equal(await page.evaluate(() => shopifyPage), 2);
    const orderPaint = await page.evaluate(() => {
      const repaint = [], compare = [];
      for (let i = 0; i < 7; i++) {
        let start = performance.now();
        const snapshot = JSON.stringify(_spServerResponse);
        compare.push(performance.now() - start);
        start = performance.now();
        _spServerPainting = true;
        try { renderShopifyOrders(); } finally { _spServerPainting = false; }
        repaint.push(performance.now() - start);
        void snapshot;
      }
      const median = rows => rows.sort((a, b) => a - b)[3];
      return { compareMs: Math.round(median(compare) * 10) / 10,
        repaintMs: Math.round(median(repaint) * 10) / 10 };
    });
    const beforeOrderReturn = reads.filter(r => r.pathname === '/api/shopify/orders/summary-page').length;
    const beforeSalesReturn = reads.filter(r => r.pathname === '/api/transactions/sales-overview').length;
    await page.evaluate(() => navigateTo('dashboard'));
    assert.equal(await page.evaluate(() => qs('#dash-sales-overview')?.classList.contains('is-loading')), true,
      'Dashboard financial totals must wait for a fresh server read');
    assert.equal(await page.evaluate(() => {
      const metric = qs('#so-metrics .so-metric-value');
      return !!metric && getComputedStyle(metric).visibility === 'hidden';
    }), true, 'cached financial totals must be masked during revalidation');
    await page.waitForFunction(() => currentPage === 'dashboard' &&
      !qs('#dash-sales-overview')?.classList.contains('is-loading'), { timeout: 30000 });
    assert.equal(reads.filter(r => r.pathname === '/api/transactions/sales-overview').length,
      beforeSalesReturn + 1, 'Dashboard return must revalidate sales totals');
    await page.evaluate(() => navigateTo('shopify-orders'));
    assert.equal(await page.evaluate(() => qs('#page-shopify-orders')?.classList.contains('sp-nav-pending')), true,
      'Orders financial status must wait for a fresh server read');
    assert.equal(await page.evaluate(() => getComputedStyle(qs('#shopify-orders-table-wrap')).display),
      'none', 'cached order status must be masked during revalidation');
    assert.equal(await page.evaluate(() => !qs('#sp-orders-loading').hidden && qs('#sp-orders-loading').dataset.state),
      'loading', 'the skeleton stands in for the table during revalidation');
    await page.waitForFunction(() => currentPage === 'shopify-orders' && _spServerResponse?.page === 2 &&
      !_spServerRequest && !qs('#page-shopify-orders')?.classList.contains('sp-nav-pending'), { timeout: 30000 });
    assert.equal(await page.evaluate(() => shopifyPage), 2);
    assert.equal(reads.filter(r => r.pathname === '/api/shopify/orders/summary-page').length, beforeOrderReturn + 1,
      'Orders must revalidate financial and order status on return');
    await page.evaluate(async () => {
      qs('#shopify-search').value = 'phase11-no-match';
      shopifyPage = 1;
      await _spLoadServerPage(true);
    });
    await enter('dashboard', () => currentPage === 'dashboard');
    await enter('shopify-orders', () => currentPage === 'shopify-orders' &&
      _spServerResponse?.total === 0 && !_spServerRequest);
    assert.equal(await page.evaluate(() => qs('#shopify-search').value), 'phase11-no-match',
      'Orders search must survive navigation');

    await enter('movements', () => currentPage === 'movements' && _movServerResponse?.pageRows?.length > 0 && !_movServerRequest);
    await page.evaluate(async () => {
      movPage = 2;
      fxState.mov.dateFrom = '2020-01-01';
      fxState.mov.dateTo = '2030-12-31';
      await renderMovements();
    });
    assert.equal(await page.evaluate(() => movPage), 2);
    await enter('dashboard', () => currentPage === 'dashboard');
    const beforeMovReturn = reads.filter(r => r.pathname === '/api/transactions/movements-page').length;
    await page.evaluate(() => navigateTo('movements'));
    assert.equal(await page.evaluate(() => qs('#page-movements').classList.contains('mov-nav-pending')), true,
      'financial content must be hidden while revalidating');
    assert.equal(await page.evaluate(() => getComputedStyle(qs('#mov-table tbody td[data-col="status"]')).visibility),
      'hidden', 'cached transaction status must be masked during revalidation');
    await page.waitForFunction(() => currentPage === 'movements' && !_movServerRequest &&
      !qs('#page-movements').classList.contains('mov-nav-pending'), { timeout: 30000 });
    assert.equal(reads.filter(r => r.pathname === '/api/transactions/movements-page').length, beforeMovReturn + 1);
    const movState = await page.evaluate(() => ({ page: movPage, from: fxState.mov.dateFrom, to: fxState.mov.dateTo }));
    assert.deepEqual(movState, { page: 2, from: '2020-01-01', to: '2030-12-31' });
    const txId = await page.evaluate(() => _movServerResponse.pageRows.find(row => row.k === 'tx')?.tx?._id);
    if (!txId) throw Error('No transaction row on Movements page 2');
    const beforeDetails = reads.filter(r => r.pathname === '/api/transactions/' + txId).length;
    await page.evaluate(id => { window.__phase11DetailStart = performance.now(); showInvoiceDetail(id); }, txId);
    await page.waitForFunction(id => qs('#inv-detail-overlay')?.classList.contains('active') &&
      String(window._currentInvoiceTxId) === String(id), { timeout: 30000 }, txId);
    const firstDetailMs = await page.evaluate(() => Math.round(performance.now() - window.__phase11DetailStart));
    await page.evaluate(() => closeInvoiceDetail());
    await page.evaluate(id => { window.__phase11DetailStart = performance.now(); showInvoiceDetail(id); }, txId);
    await page.waitForFunction(id => qs('#inv-detail-overlay')?.classList.contains('active') &&
      String(window._currentInvoiceTxId) === String(id), { timeout: 30000 }, txId);
    const repeatDetailMs = await page.evaluate(() => Math.round(performance.now() - window.__phase11DetailStart));
    assert.equal(reads.filter(r => r.pathname === '/api/transactions/' + txId).length, beforeDetails + 2,
      'transaction details must revalidate on every open');
    const cachedEquivalentMs = await page.evaluate(id => {
      closeInvoiceDetail();
      const start = performance.now();
      showInvoiceDetail(id, undefined, true);
      return Math.round(performance.now() - start);
    }, txId);
    await page.evaluate(() => { closeInvoiceDetail(); navigateTo('dashboard'); });
    failMovements = true;
    await page.evaluate(() => navigateTo('movements'));
    await page.waitForFunction(() => currentPage === 'movements' && !_movServerRequest &&
      qs('#page-movements')?.classList.contains('mov-nav-error'), { timeout: 30000 });
    assert.equal(await page.evaluate(() => getComputedStyle(qs('#mov-kpi-strip')).visibility), 'hidden',
      'failed Movements revalidation must not reveal old financial KPIs');
    failMovements = false;
    await page.evaluate(() => navigateTo('dashboard'));
    failOrders = true;
    await page.evaluate(() => navigateTo('shopify-orders'));
    await page.waitForFunction(() => currentPage === 'shopify-orders' && !_spServerRequest &&
      qs('#sp-orders-loading')?.dataset.state === 'error', { timeout: 30000 });
    assert.equal(await page.evaluate(() => getComputedStyle(qs('#shopify-orders-table-wrap')).visibility), 'hidden',
      'failed Orders revalidation must not reveal old deposit status');
    assert.deepEqual(errors, [], 'browser console must have no uncaught errors');
    console.log(JSON.stringify({ followups: await page.evaluate(() => followUps.length), orderPage: 2,
      movementPage: movState.page, transactionDetailReads: 2, firstDetailMs, repeatDetailMs,
      cachedEquivalentMs, orderPaint, followupPaint, errors: errors.length }));
  } finally { await browser?.close(); await mongoose.disconnect(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
