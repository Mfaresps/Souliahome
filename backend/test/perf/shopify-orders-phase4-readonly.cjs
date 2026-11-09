// Read-only Phase 4 verification against the configured populated database.
require('dotenv').config();
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const { performance } = require('node:perf_hooks');
const { visibleReceipts } = require('../../dist/shopify/deposit-receipts.util.js');

const API = process.env.TEST_API || 'http://127.0.0.1:4000/api';
const ORIGIN = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const observed = [];

async function read(path, token) {
  const start = performance.now();
  const response = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.text();
  assert.equal(response.status, 200, `${path}: ${response.status} ${body.slice(0, 160)}`);
  const result = JSON.parse(body);
  observed.push({ path: path.split('?')[0], ms: Math.round(performance.now() - start), bytes: Buffer.byteLength(body) });
  return result;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia');
  const admin = await mongoose.connection.db.collection('users').findOne({ role: 'admin', isActive: { $ne: false } },
    { projection: { _id: 1, username: 1, name: 1, role: 1, perms: 1 } });
  assert(admin, 'Active admin test user required');
  const token = jwt.sign({ sub: String(admin._id), username: admin.username },
    process.env.JWT_SECRET || 'soulia_jwt_default_secret', { expiresIn: '5m' });
  const user = { _id: String(admin._id), username: admin.username, name: admin.name, role: admin.role, perms: admin.perms || [] };
  const full = await read('/shopify/orders', token);
  const page1 = await read('/shopify/orders/summary-page?page=1&limit=30', token);
  const page2 = await read('/shopify/orders/summary-page?page=2&limit=30', token);
  const page50 = await read('/shopify/orders/summary-page?page=1&limit=50', token);
  assert.equal(page50.rows.length, 50);
  assert.equal(page50.total, page1.total);
  const revalidatePath = '/shopify/orders/summary-page?page=1&limit=30';
  const cacheHeaders = { Authorization: `Bearer ${token}` };
  const firstCached = await fetch(API + revalidatePath, { headers: cacheHeaders });
  const etag = firstCached.headers.get('etag');
  await firstCached.arrayBuffer();
  assert(etag, 'Summary response must provide an ETag');
  const unchanged = await fetch(API + revalidatePath, { headers: { ...cacheHeaders, 'If-None-Match': etag } });
  assert.equal(unchanged.status, 304);
  assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
  assert.equal(full.length, page1.allCount);
  assert.equal(page1.rows.length, 30);
  assert(page1.rows.every(row => !('rawData' in row) && !('editHistory' in row)));
  assert(page2.rows.every(row => !page1.rows.some(first => first._id === row._id)));
  const detail = await read(`/shopify/orders/detail/${page1.rows[0]._id}`, token);
  assert.equal(detail._id, page1.rows[0]._id);
  assert.equal(detail.ref, page1.rows[0].ref);
  assert.equal(!!detail.rawData, !!full.find(row => row._id === detail._id).rawData);
  const receiptFixture = { depositReceipts: [
    { id: 'private', status: 'مسودة', submittedById: 'owner' },
    { id: 'public', status: 'معتمد', submittedById: 'owner' },
  ] };
  assert.deepEqual(visibleReceipts(receiptFixture, 'other').depositReceipts.map(receipt => receipt.id), ['public']);
  assert.deepEqual(visibleReceipts(receiptFixture, 'owner').depositReceipts.map(receipt => receipt.id), ['private', 'public']);
  let receiptPermission = 'draft-rule-verified-with-fixture';
  const draftOrder = full.find(order => (order.depositReceipts || []).some(receipt => receipt.status === 'مسودة'));
  if (draftOrder) {
    const draft = draftOrder.depositReceipts.find(receipt => receipt.status === 'مسودة');
    const staff = await mongoose.connection.db.collection('users').findOne({ role: { $ne: 'admin' },
      isActive: { $ne: false }, _id: { $ne: mongoose.Types.ObjectId.isValid(draft.submittedById)
        ? new mongoose.Types.ObjectId(draft.submittedById) : admin._id } },
    { projection: { _id: 1, username: 1 } });
    if (staff) {
      const staffToken = jwt.sign({ sub: String(staff._id), username: staff.username },
        process.env.JWT_SECRET || 'soulia_jwt_default_secret', { expiresIn: '5m' });
      const staffDetail = await read(`/shopify/orders/detail/${draftOrder._id}`, staffToken);
      assert(!(staffDetail.depositReceipts || []).some(receipt => receipt.id === draft.id));
      receiptPermission = 'draft-hidden-from-other-staff';
    }
  }
  const staff = await mongoose.connection.db.collection('users').findOne({ role: { $ne: 'admin' },
    isActive: { $ne: false } }, { projection: { _id: 1, username: 1 } });
  if (staff) {
    const staffToken = jwt.sign({ sub: String(staff._id), username: staff.username },
      process.env.JWT_SECRET || 'soulia_jwt_default_secret', { expiresIn: '5m' });
    const staffPage = await read('/shopify/orders/summary-page?page=1&limit=30', staffToken);
    const staffDetail = await read(`/shopify/orders/detail/${page1.rows[0]._id}`, staffToken);
    assert.equal(staffPage.total, page1.total);
    assert.equal(staffDetail._id, detail._id);
  }

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const failures = [], ordersRequests = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('requestfailed', request => {
      if (!/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/.test(request.failure()?.errorText || ''))
        failures.push(`${request.url()}: ${request.failure()?.errorText}`);
    });
    page.on('response', async response => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith('/api/shopify/orders') && url.pathname !== '/api/transactions/summary-page') return;
      const record = { path: url.pathname, bytes: 0, status: response.status(),
        page: url.searchParams.get('page'), search: url.searchParams.get('search'),
        prevTo: url.searchParams.get('kpiPrevTo') };
      ordersRequests.push(record);
      record.bytes = (await response.buffer().catch(() => Buffer.alloc(0))).length;
    });
    await page.evaluateOnNewDocument((t, u) => {
      localStorage.setItem('token', t);
      localStorage.setItem('user', JSON.stringify(u));
    }, token, user);
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
        return request.abort('blockedbyclient');
      request.continue();
    });
    await page.goto(ORIGIN + '/#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => currentPage === 'dashboard' &&
      getComputedStyle(document.querySelector('#app')).display !== 'none', { timeout: 15000 }).catch(async error => {
      console.error('Browser state:', await page.evaluate(() => ({ page: window.currentPage,
        app: document.querySelector('#app')?.style.display,
        login: document.querySelector('#login-page')?.style.display,
        splash: document.querySelector('#splash-screen')?.style.display,
        hash: location.hash })));
      console.error('Requests:', ordersRequests);
      console.error('Failures:', failures);
      throw error;
    });
    const start = performance.now();
    await page.evaluate(() => navigateTo('shopify-orders'));
    await page.waitForFunction(() => _spServerResponse?.rows?.length === 30 &&
      document.querySelectorAll('#shopify-orders-table-body tr').length >= 30, { timeout: 30000 });
    const readyMs = Math.round(performance.now() - start);
    const state = await page.evaluate(() => ({ currentPage, rows: _shopifyOrders.length,
      total: _spServerResponse.total, all: _spServerResponse.allCount,
      rendered: document.querySelectorAll('#shopify-orders-table-body tr').length }));
    await page.evaluate(() => socket?.disconnect());
    const detailStart = performance.now();
    await page.evaluate(id => openSpOrderPeek(id), page1.rows[0]._id);
    await page.waitForFunction(id => _spFullOrderCache.has(id), { timeout: 15000 }, page1.rows[0]._id);
    const detailMs = Math.round(performance.now() - detailStart);
    await page.evaluate(() => { shopifyPage = 2; renderShopifyOrders(); });
    await page.waitForFunction(() => _spServerResponse?.page === 2, { timeout: 15000 });
    assert.equal(await page.evaluate(() => _shopifyOrders[0]._id), page2.rows[0]._id);
    const searchStart = performance.now();
    await page.evaluate(ref => {
      const input = document.querySelector('#shopify-search');
      input.value = String(ref).replace(/^#+/, '');
      input.focus(); shopifyPage = 1; renderShopifyOrders();
    }, page1.rows[0].ref);
    await page.waitForFunction(id => _spServerResponse?.rows?.some(row => row._id === id),
      { timeout: 15000 }, page1.rows[0]._id);
    const searchMs = Math.round(performance.now() - searchStart);
    await page.evaluate(() => { document.querySelector('#shopify-search').value = ''; shopifyPage = 1; renderShopifyOrders(); });
    await page.waitForFunction(() => _spServerResponse?.page === 1 && _spServerResponse?.total > 1, { timeout: 15000 });
    const beforeRedraw = ordersRequests.length;
    await page.evaluate(() => { renderShopifyOrders(); renderShopifyOrders(); });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(ordersRequests.length, beforeRedraw, 'Unchanged list renders must not refetch');
    assert.equal(ordersRequests.filter(r => r.path === '/api/transactions/summary-page').length, 0);
    assert.equal(ordersRequests.filter(r => r.path === '/api/shopify/orders').length, 0);
    const initialRequests = ordersRequests.slice();
    await page.evaluate(() => switchShopifySubnav('deposits'));
    await page.waitForFunction(() => _shopifyOrders.length === 891, { timeout: 10000 }).catch(async error => {
      console.error('Deposit tab state:', await page.evaluate(() => ({ tab: _spSubnavTab,
        server: _spServerEnabled, rows: _shopifyOrders.length, loadError: _spReceiptLoadError })));
      console.error('Order requests:', ordersRequests.slice(initialRequests.length));
      console.error('Failures:', failures);
      throw error;
    });
    await page.waitForSelector('#sp-deposits-tab-content .spdep-review', { timeout: 10000 });
    assert.equal(ordersRequests.filter(r => r.path === '/api/shopify/orders').length, 1,
      'Deposit review explicitly loads the full queue once');
    await page.evaluate(() => switchShopifySubnav('orders'));
    await page.waitForFunction(() => _shopifyOrders.length === 30 && _spServerResponse?.page === 1,
      { timeout: 15000 });
    await page.evaluate(id => editShopifyOrder(id), page1.rows[0]._id);
    await page.waitForSelector('#shopify-edit-modal', { timeout: 15000 });
    await page.evaluate(() => _spCloseEdit());

    const [inventory, tickets] = await Promise.all([
      read('/transactions/inventory', token), read('/followups', token),
    ]);
    await page.evaluate((orders, products, followupRows) => {
      _spServerRequest?.controller.abort();
      _spServerEnabled = false;
      _shopifyOrders = orders;
      inventoryCache = products;
      followUps = followupRows;
      _spkFilter = '';
    }, full, inventory, tickets);
    const cases = [
      { name: 'pending', tab: 'pending' },
      { name: 'all', tab: 'all' },
      { name: 'contact', tab: 'pending', panel: { status: ['contact'] } },
      { name: 'confirmed', tab: 'pending', panel: { status: ['confirmed'] } },
      { name: 'deposit-paid', tab: 'pending', card: 'deposit-paid' },
      { name: 'stock-blocked', tab: 'pending', card: 'stock-blocked' },
      { name: 'deposit-review', tab: 'all', column: 'deposit-review' },
      { name: 'search', tab: 'all', search: page1.rows[0].ref },
      { name: 'phone-search', tab: 'all', search: String(full.find(row => row.phone)?.phone || '').replace(/\D/g, '').slice(-6) },
      { name: 'date-day', tab: 'all', date: page1.rows[0].shopifyCreatedAt || page1.rows[0].createdAt },
      { name: 'starred', tab: 'all', starred: true },
    ];
    const parity = [];
    for (const test of cases) {
      const local = await page.evaluate(test => {
        _shopifyTab = test.tab;
        _shopifyStatusFilter = test.card || '';
        _spColumnStatusFilter = test.column || '';
        _spStarOnly = !!test.starred;
        _spPanel = { ..._spPanelEmpty(), ...(test.panel || {}) };
        const chosen = test.date ? new Date(test.date) : null;
        _shopifyDateFilter = { from: chosen, to: chosen };
        shopifyPage = 1;
        document.querySelector('#shopify-search').value = test.search || '';
        renderShopifyOrders();
        return { query: _spServerQuery(), ids: _spSelectionScope.map(row => row._id) };
      }, test);
      const remote = await read('/shopify/orders/summary-page?' + local.query, token);
      const remoteIds = remote.rows.map(row => row._id);
      parity.push({ name: test.name, local: local.ids.length, remote: remote.total,
        firstPageMatches: JSON.stringify(local.ids.slice(0, 30)) === JSON.stringify(remoteIds) });
      assert.equal(remote.total, local.ids.length, `${test.name} total mismatch`);
      assert.deepEqual(remoteIds, local.ids.slice(0, 30), `${test.name} page mismatch`);
    }
    const legacyPage = await browser.newPage();
    await legacyPage.evaluateOnNewDocument((t, u) => {
      localStorage.setItem('token', t);
      localStorage.setItem('user', JSON.stringify(u));
    }, token, user);
    await legacyPage.setRequestInterception(true);
    legacyPage.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/') && request.method() !== 'GET') return request.abort('blockedbyclient');
      request.continue();
    });
    try {
      await legacyPage.goto(ORIGIN + '/#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await legacyPage.waitForFunction(() => currentPage === 'dashboard' &&
        getComputedStyle(document.querySelector('#app')).display !== 'none', { timeout: 30000 });
      await legacyPage.evaluate(async () => {
        await _transactionSummaryTask?.catch(() => {});
        await window._startupBackgroundReady?.catch(() => {});
        socket?.disconnect();
      });
      const legacyLoadRenderMs = await legacyPage.evaluate(async () => {
        currentPage = 'shopify-orders';
        _spSubnavTab = 'orders';
        _spServerEnabled = false;
        document.querySelector('#page-dashboard')?.classList.remove('active');
        document.querySelector('#page-shopify-orders')?.classList.add('active');
        const started = performance.now();
        const [orders, ...pages] = await Promise.all([
          api('/shopify/orders'),
          ...Array.from({ length: 6 }, (_, index) => api(`/transactions/summary-page?page=${index + 1}&limit=200`)),
        ]);
        _shopifyOrders = orders;
        transactions = pages.flatMap(part => part.rows);
        _spOrdersLoaded = true;
        renderShopifyOrders();
        return Math.round(performance.now() - started);
      });
      assert.equal(await legacyPage.evaluate(() => _shopifyOrders.length), 891);
      assert.equal(await legacyPage.$$eval('#shopify-orders-table-body tr.sp-order-row', rows => rows.length), 30);
      var legacy = { loadRenderMs: legacyLoadRenderMs, fullRequests: 1, transactionPages: 6,
        orderBytes: observed.find(row => row.path === '/shopify/orders')?.bytes || 0 };
    } finally { await legacyPage.close(); }
    const transactionBodies = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      fetch(`${API}/transactions/summary-page?page=${i + 1}&limit=200`,
        { headers: { Authorization: `Bearer ${token}` } }).then(async response => {
          assert.equal(response.status, 200);
          return response.text();
        })));
    legacy.transactionBytes = transactionBodies.reduce((n, body) => n + Buffer.byteLength(body), 0);
    console.log(JSON.stringify({ orders: full.length, state, readyMs, detailMs, searchMs,
      receiptPermission, legacy,
      conditionalCache: { status: unchanged.status, bodyBytes: 0 },
      requests: initialRequests, parity, direct: observed, failures }, null, 2));
    assert.deepEqual(failures, []);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
