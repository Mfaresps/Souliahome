// Read-only navigation profile against the populated database. API writes are blocked in Chromium.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8081';
const count = Number(process.env.PHASE11_PAIRS || 7);
const round = n => Math.round(n * 10) / 10;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function route(page, name, routeName, ready) {
  const result = await page.evaluate(async ({ routeName, readySource }) => {
    const round = n => Math.round(n * 10) / 10;
    performance.clearResourceTimings();
    const start = performance.now();
    const before = {
      orders: typeof _spServerResponse !== 'undefined' ? _spServerResponse : null,
      movements: typeof _movServerResponse !== 'undefined' ? _movServerResponse : null,
      followups: window._followUpsLastReadAt || 0,
    };
    const host = document.querySelector(routeName === 'followups' ? '#fu-tbody'
      : routeName === 'movements' ? '#mov-table tbody'
      : routeName === 'orders' ? '#shopify-orders-table-body' : '#page-dashboard');
    let removed = 0, added = 0;
    const observer = new MutationObserver(records => records.forEach(record => {
      removed += record.removedNodes.length;
      added += record.addedNodes.length;
    }));
    if (host) observer.observe(host, { childList: true, subtree: true });
    navigateTo(routeName === 'orders' ? 'shopify-orders' : routeName);
    const ready = Function('return (' + readySource + ')')();
    const until = async predicate => {
      while (!predicate()) {
        if (performance.now() - start > 30000) throw Error('Timed out: ' + routeName);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return round(performance.now() - start);
    };
    const visibleMs = await until(() => ready() && (host?.children.length || 0) > 0
      && getComputedStyle(host).visibility !== 'hidden' && getComputedStyle(host).display !== 'none');
    const freshMs = routeName === 'followups' ? await (async () => {
      await _fuTabLoadPromise;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return round(performance.now() - start);
    })() : await until(() => {
      if (routeName === 'orders') return _spServerResponse && _spServerResponse !== before.orders && !_spServerRequest;
      if (routeName === 'movements') return _movServerResponse && _movServerResponse !== before.movements && !_movServerRequest;
      if (routeName === 'dashboard') return ready() && !document.querySelector('#dash-sales-overview')?.classList.contains('is-loading');
      return ready();
    });
    await new Promise(resolve => setTimeout(resolve, 120));
    observer.disconnect();
    const resources = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/'));
    return { visibleMs, freshMs, added, removed, requests: resources.length,
      transferBytes: resources.reduce((n, e) => n + e.transferSize, 0),
      decodedBytes: resources.reduce((n, e) => n + e.decodedBodySize, 0),
      endpoints: resources.map(e => new URL(e.name).pathname),
      page: routeName, rows: host?.children.length || 0,
      filters: routeName === 'followups' ? { page: _fuPage, search: document.querySelector('#fu-search')?.value || '' }
        : routeName === 'movements' ? { page: movPage, search: document.querySelector('#mov-search')?.value || '' }
        : routeName === 'orders' ? { page: shopifyPage, search: document.querySelector('#shopify-search')?.value || '' } : {} };
  }, { routeName, readySource: ready });
  result.name = name;
  return result;
}

async function run(browser, token, user, pair) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument((jwtToken, account) => {
    localStorage.setItem('token', jwtToken);
    localStorage.setItem('user', JSON.stringify(account));
    localStorage.removeItem('soulia_adb_autoshow_enabled');
  }, token, user);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const route = new URL(request.url()).pathname;
    if (route.startsWith('/api/') && request.method() !== 'GET' &&
        !(route === '/api/transactions/movements-page' && request.method() === 'POST'))
      return request.respond({ status: 405, contentType: 'application/json', body: '{}' });
    if (route.startsWith('/api/shipping/sync/'))
      return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
    request.continue();
  });
  try {
    await page.goto(origin + '/#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.souliaPushAppReady && currentPage === 'dashboard' &&
      _dashFuLoaded && followUps.length > 0 && transactions.length > 0, { timeout: 30000 });
    await sleep(200);
    const flows = [];
    flows.push(await route(page, 'dashboard-orders', 'orders', '() => currentPage === "shopify-orders" && document.querySelectorAll("#shopify-orders-table-body tr").length > 0'));
    const order = await page.evaluate(() => _spServerResponse.rows.find(row => row._id)?._id);
    if (order) {
      const detail = await page.evaluate(async id => {
        const round = n => Math.round(n * 10) / 10;
        performance.clearResourceTimings(); const start = performance.now();
        await openSpOrderPeek(id);
        return { name: 'orders-detail', visibleMs: round(performance.now()-start), freshMs: round(performance.now()-start),
          requests: performance.getEntriesByType('resource').filter(e => e.name.includes('/api/')).length };
      }, order);
      flows.push(detail);
      await page.evaluate(() => closeSpOrderPeek());
    }
    flows.push(await route(page, 'orders-dashboard', 'dashboard', '() => currentPage === "dashboard" && document.querySelector("#page-dashboard")?.classList.contains("active")'));
    flows.push(await route(page, 'dashboard-movements', 'movements', '() => currentPage === "movements" && document.querySelectorAll("#mov-table tbody tr").length > 0'));
    flows.push(await route(page, 'movements-dashboard', 'dashboard', '() => currentPage === "dashboard" && document.querySelector("#page-dashboard")?.classList.contains("active")'));
    flows.push(await route(page, 'dashboard-followups', 'followups', '() => currentPage === "followups" && document.querySelectorAll("#fu-tbody tr").length > 0'));
    flows.push(await route(page, 'followups-dashboard', 'dashboard', '() => currentPage === "dashboard" && document.querySelector("#page-dashboard")?.classList.contains("active")'));
    flows.push(await route(page, 'dashboard-orders-return', 'orders', '() => currentPage === "shopify-orders" && document.querySelectorAll("#shopify-orders-table-body tr").length > 0'));
    flows.push(await route(page, 'orders-movements', 'movements', '() => currentPage === "movements" && document.querySelectorAll("#mov-table tbody tr").length > 0'));
    flows.push(await route(page, 'movements-followups', 'followups', '() => currentPage === "followups" && document.querySelectorAll("#fu-tbody tr").length > 0'));
    return { pair, flows, errors };
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
    for (let pair=1; pair<=count; pair++) {
      const result = await run(browser, token, user, pair);
      runs.push(result);
      console.log(`run ${pair}: ${result.flows.map(x => `${x.name} ${x.visibleMs}/${x.freshMs}ms ${x.requests}req`).join(', ')}`);
    }
    const out = path.resolve(__dirname, '../../../artifacts', process.env.PHASE11_OUTPUT || 'phase11-navigation-before.json');
    fs.writeFileSync(out, JSON.stringify({ runs }, null, 2));
    console.log('saved ' + out);
  } finally { await browser?.close(); await mongoose.disconnect(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
