// Read-only, populated-data browser profile for the Orders invoice drawer and Pick-Up.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const pairs = Number(process.env.WORKFLOW_PAIRS || 7);
const output = process.env.WORKFLOW_OUTPUT || 'workflow-orders-pickup-before.json';
const round = n => Math.round(n * 10) / 10;

async function measure(page, action, ready, wait = 0) {
  return page.evaluate(async ({ actionSource, readySource, wait }) => {
    performance.clearResourceTimings();
    const started = performance.now();
    const task = Function('return (' + actionSource + ')')()();
    const actionSyncMs = Math.round((performance.now() - started) * 10) / 10;
    const readyFn = Function('return (' + readySource + ')')();
    const until = async predicate => {
      while (!predicate()) {
        if (performance.now() - started > 30000) throw Error('Workflow timed out ' + JSON.stringify({
          currentPage, ordersLoaded: typeof _spOrdersLoaded === 'undefined' ? null : _spOrdersLoaded,
          ordersRows: typeof _spServerResponse === 'undefined' ? null : _spServerResponse?.rows?.length,
          ordersRequest: typeof _spServerRequest === 'undefined' ? null : !!_spServerRequest,
          pickupLoaded: typeof _puOrdersLoaded === 'undefined' ? null : _puOrdersLoaded,
          pickupRequest: typeof _puOrdersRequest === 'undefined' ? null : !!_puOrdersRequest,
        }));
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return Math.round((performance.now() - started) * 10) / 10;
    };
    const visibleMs = await until(readyFn);
    await task;
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const completeMs = Math.round((performance.now() - started) * 10) / 10;
    const entries = performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/'));
    return { visibleMs, completeMs, actionSyncMs, requests: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.decodedBodySize, 0),
      endpoints: entries.map(entry => ({ path: new URL(entry.name).pathname,
        duration: Math.round(entry.duration * 10) / 10, bytes: entry.decodedBodySize })) };
  }, { actionSource: action.toString(), readySource: ready.toString(), wait });
}

async function run(browser, token, user, pair) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (process.env.WORKFLOW_TRACE_SUMMARIES) page.on('console', message => { if (message.text().startsWith('TX_SUMMARY_STACK')) console.log(message.text()); });
  page.on('requestfailed', request => errors.push('request failed ' + request.url() + ' ' + request.failure()?.errorText));
  page.on('response', response => { if (response.status() >= 400) errors.push('HTTP ' + response.status() + ' ' + response.url()); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument((auth, account) => {
    localStorage.setItem('token', auth);
    localStorage.setItem('user', JSON.stringify(account));
    localStorage.removeItem('soulia_adb_autoshow_enabled');
  }, token, user);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/') && request.method() !== 'GET'
        && !(pathname === '/api/transactions/movements-page' && request.method() === 'POST'))
      return request.respond({ status: 405, contentType: 'application/json', body: '{}' });
    if (pathname.startsWith('/api/shipping/sync/'))
      return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
    request.continue();
  });
  try {
    await page.goto(origin + '/#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await page.waitForFunction(() => window.souliaPushAppReady && currentPage === 'dashboard'
        && _dashFuLoaded && followUps.length > 0 && transactions.length > 0, { timeout: 30000 });
    } catch (error) {
      console.error('dashboard readiness diagnostics', await page.evaluate(() => ({
        ready: window.souliaPushAppReady, currentPage, dashFuLoaded: _dashFuLoaded,
        followUps: followUps.length, transactions: transactions.length,
        scripts: [...document.scripts].map(s => s.src).filter(Boolean),
      })).catch(e => e.message), errors);
      throw error;
    }
    const orders = await measure(page,
      () => navigateTo('shopify-orders'),
      () => currentPage === 'shopify-orders' && _spOrdersLoaded && !!_spServerResponse && !_spServerRequest);
    let ordersRender = null;
    if (process.env.WORKFLOW_MEASURE_RENDER) ordersRender = await page.evaluate(() => {
      const resources = performance.getEntriesByType('resource')
        .filter(entry => /shopify-orders-route\.js|shopify-kpis\.js/.test(entry.name))
        .map(entry => ({ path: new URL(entry.name).pathname,
          ms: Math.round(entry.duration * 10) / 10, bytes: entry.decodedBodySize }));
      const timings = {};
      const originals = {};
      for (const name of ['_spEnsureOrdersLayout', '_spkRender', '_spBuildInvIndex',
        '_spBuildCustomerOrderIndex', '_unshippedSiblingIndex', '_spRenderFilterDropdown',
        '_renderShopifyDepositSummary', '_spItemsCell', '_spCustOrdersChipHtml',
        '_spContactLinksHtml', '_spConfirmationStatusHtml', '_spRenderToolbarState',
        '_spPaintLiveOrderTable', '_spPaintLiveOrderCards', '_spRevealOrders',
        'applyShopifyColsVisibility', '_syncSpTableMinWidth', '_syncSpNoteClamps']) {
        originals[name] = window[name];
        window[name] = function (...args) {
          const started = performance.now();
          try { return originals[name].apply(this, args); }
          finally { timings[name] = Math.round(((timings[name] || 0) + performance.now() - started) * 10) / 10; }
        };
      }
      const start = performance.now();
      renderShopifyOrders();
      for (const name of Object.keys(originals)) window[name] = originals[name];
      return { repaintMs: Math.round((performance.now() - start) * 10) / 10,
        rows: document.querySelector('#shopify-orders-table-body')?.children.length || 0,
        timings, resources };
    });
    if (process.env.WORKFLOW_CHECK_NOTES) {
      const notes = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('#shopify-orders-table-body .sp-note-txt')]
          .filter(el => !el.classList.contains('is-open') && el.nextElementSibling);
        return { count: rows.length, mismatches: rows.filter(el =>
          (el.nextElementSibling.style.display === 'block') !== (el.scrollHeight > el.clientHeight + 1)).length };
      });
      assert.equal(notes.mismatches, 0, 'Note expansion visibility must match clipping');
      console.log('note visibility', JSON.stringify(notes));
    }
    const ids = await page.evaluate(() => (_spServerResponse?.rows || []).filter(row => row?._id).slice(0, 2).map(row => String(row._id)));
    if (ids.length < 2) throw Error('Populated Orders page needs two orders');
    await page.evaluate(orderIds => { window.__workflowOrderIds = orderIds; }, ids);
    const drawer = await measure(page,
      () => openSpOrderPeek(window.__workflowOrderIds[0]),
      () => !!document.querySelector('#sp-peek')?.classList.contains('is-open'), 70);
    const firstInvoice = await page.evaluate(() => ({
      order: document.querySelector('#sp-peek .sp-peek')?.dataset.order,
      detailCached: _spFullOrderCache.has(window.__workflowOrderIds[0]),
      printAction: !!document.querySelector('#sp-peek [onclick^="printSpPeekPreview"]'),
    }));
    assert.equal(firstInvoice.order, ids[0]);
    assert(firstInvoice.detailCached && firstInvoice.printAction, 'Full invoice and print action must be ready');
    await page.evaluate(() => closeSpOrderPeek());
    await new Promise(resolve => setTimeout(resolve, 260));
    const switchInvoice = await measure(page,
      () => openSpOrderPeek(window.__workflowOrderIds[1]),
      () => !!document.querySelector('#sp-peek')?.classList.contains('is-open'), 70);
    assert.equal(await page.evaluate(() => document.querySelector('#sp-peek .sp-peek')?.dataset.order), ids[1]);
    await page.evaluate(() => closeSpOrderPeek());
    await new Promise(resolve => setTimeout(resolve, 260));
    const reopen = await measure(page,
      () => openSpOrderPeek(window.__workflowOrderIds[0]),
      () => !!document.querySelector('#sp-peek')?.classList.contains('is-open'), 70);
    await page.evaluate(() => closeSpOrderPeek());
    // Read-only replay of the refresh sequence after a successful transfer.
    // The approval PATCH and all database writes are intentionally excluded.
    await page.evaluate(() => {
      window.__workflowTxId = transactions.find(row => row._id && row.type === 'مبيعات')?._id
        || transactions.find(row => row._id)?._id;
    });
    const transferRefresh = await measure(page,
      async () => _spRefreshAfterTransfer(window.__workflowTxId), () => true);
    if (process.env.WORKFLOW_TRACE_SUMMARIES) await page.evaluate(() => {
      const original = loadTransactionSummaries;
      loadTransactionSummaries = (...args) => { console.log('TX_SUMMARY_STACK', new Error().stack); return original(...args); };
    });
    const pickup = await measure(page,
      () => navigateTo('pickup-orders'),
      () => currentPage === 'pickup-orders' && _puOrdersLoaded && !_puOrdersRequest);
    const pickupData = await page.evaluate(() => ({ orders: _pickupOrders.length,
      boardNodes: document.querySelector('#pu-board-view')?.querySelectorAll('*').length || 0,
      view: _puBoardView }));
    const search = await page.evaluate(() => {
      const row = _pickupOrders.find(order => order.ref);
      if (!row) return null;
      const input = document.querySelector('#pu-board-search');
      input.value = String(row.ref).replace(/^#+/, '');
      const start = performance.now();
      _puPaintCurrentView();
      return Math.round((performance.now() - start) * 10) / 10;
    });
    const revisit = await measure(page,
      () => { navigateTo('dashboard'); navigateTo('pickup-orders'); },
      () => currentPage === 'pickup-orders' && _puOrdersLoaded && !_puOrdersRequest);
    let statusParity = null;
    if (process.env.WORKFLOW_CHECK_STATUS) statusParity = await page.evaluate(async () => {
      const searchInput = document.querySelector('#pu-board-search');
      if (searchInput) searchInput.value = '';
      renderReadyToShipTable();
      const cells = () => [...document.querySelectorAll('#pu-ready-tbl-body tr')]
        .filter(row => row.cells.length > 1)
        .map(row => [row.cells[0]?.textContent.trim(), row.cells[6]?.innerHTML]);
      const withoutFullHistory = cells();
      transactions = await loadTransactionSummaries({ forceFull: true });
      renderReadyToShipTable();
      const withFullHistory = cells();
      return { rows: withoutFullHistory.length,
        same: JSON.stringify(withoutFullHistory) === JSON.stringify(withFullHistory),
        mismatches: withoutFullHistory.map((row, i) => JSON.stringify(row) === JSON.stringify(withFullHistory[i]) ? null : row[0]).filter(Boolean).slice(0, 10) };
    });
    return { pair, orders, ordersRender, drawer, switchInvoice, reopen, transferRefresh, pickup, search, pickupData, revisit, statusParity, errors };
  } finally { await context.close(); }
}

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
    const runs = [];
    for (let pair = 1; pair <= pairs; pair++) {
      const result = await run(browser, token, user, pair);
      runs.push(result);
      console.log(`run ${pair}: Orders ${result.orders.completeMs}ms, invoice ${result.drawer.visibleMs}/${result.drawer.completeMs}ms, transfer refresh ${result.transferRefresh.completeMs}ms, Pickup ${result.pickup.completeMs}ms ${result.pickupData.orders} orders`);
    }
    const file = path.resolve(__dirname, '../../../artifacts', output);
    fs.writeFileSync(file, JSON.stringify({ runs }, null, 2));
    console.log('saved ' + file);
  } finally { await browser?.close(); await mongoose.disconnect(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
