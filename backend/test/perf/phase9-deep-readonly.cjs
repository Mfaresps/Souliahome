// Read-only Phase 9 browser profile. No API writes are allowed to reach the server.
require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const puppeteer = require('puppeteer');
const { performance } = require('node:perf_hooks');

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8081';
const apiOrigin = process.env.TEST_API || 'http://127.0.0.1:4000';
const out = path.resolve(__dirname, '../../../artifacts');
const pairs = Number(process.env.PHASE9_PAIRS || 7);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round(value * 10) / 10;

async function measureRoute(page, name, ready) {
  const started = await page.evaluate(route => {
    window.__phase9RouteStart = performance.now();
    navigateTo(route);
    return window.__phase9RouteStart;
  }, name);
  await page.waitForFunction(ready, { timeout: 30000 });
  await sleep(100);
  const result = await page.evaluate(() => ({
    ms: performance.now() - window.__phase9RouteStart,
    nodes: document.getElementsByTagName('*').length,
    heap: performance.memory?.usedJSHeapSize || null,
  }));
  return { ms: round(result.ms), nodes: result.nodes, heap: result.heap, started };
}

async function runPage(browser, token, user, pair, mode, previous) {
  const context = previous?.context || await browser.createBrowserContext();
  const page = previous?.page || await context.newPage();
  if (!previous) {
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument((jwtToken, account) => {
      localStorage.setItem('token', jwtToken);
      localStorage.setItem('user', JSON.stringify(account));
      localStorage.removeItem('soulia_adb_autoshow_enabled');
      window.__phase9 = { longTasks: [], lcp: 0, interactive: 0 };
      new PerformanceObserver(list => list.getEntries().forEach(entry =>
        window.__phase9.longTasks.push({ start: entry.startTime, duration: entry.duration })))
        .observe({ type: 'longtask', buffered: true });
      new PerformanceObserver(list => list.getEntries().forEach(entry =>
        window.__phase9.lcp = entry.startTime))
        .observe({ type: 'largest-contentful-paint', buffered: true });
      const tick = () => {
        if (!window.__phase9.interactive && window.souliaPushAppReady === true &&
            document.querySelector('#app')?.style.display === 'block' &&
            !document.querySelector('#splash-screen')) window.__phase9.interactive = performance.now();
        if (!window.__phase9.interactive) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
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
  } else {
    await page.evaluate(() => history.replaceState(null, '', location.pathname + '#dashboard'));
  }
  const cdp = await page.target().createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Performance.enable');
  const requests = new Map(), api = [], errors = [];
  cdp.on('Network.requestWillBeSent', event => {
    if (!event.request.url.includes('/api/')) return;
    const url = new URL(event.request.url);
    const row = { path: url.pathname + url.search, at: event.timestamp, initiator: event.initiator?.type,
      stack: event.initiator?.stack?.callFrames?.slice(0, 3).map(frame => `${frame.functionName}:${frame.lineNumber + 1}`) || [] };
    requests.set(event.requestId, row); api.push(row);
  });
  cdp.on('Network.responseReceived', event => {
    const row = requests.get(event.requestId);
    if (!row) return;
    row.status = event.response.status;
    row.headerMs = round((event.timestamp - row.at) * 1000);
    const timing = event.response.timing;
    if (timing) {
      row.browserWaitMs = round(timing.receiveHeadersEnd - timing.sendEnd);
      row.downloadMs = round(timing.responseEnd - timing.receiveHeadersEnd || 0);
      row.serverTiming = event.response.headers?.['server-timing'] || null;
    }
  });
  cdp.on('Network.loadingFinished', event => {
    const row = requests.get(event.requestId);
    if (row) { row.totalMs = round((event.timestamp - row.at) * 1000); row.transferBytes = event.encodedDataLength; }
  });
  const responseTasks = [];
  const onResponse = response => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/')) return;
    responseTasks.push(response.buffer().then(body => {
      const row = [...api].reverse().find(item => item.path === url.pathname + url.search && item.bytes === undefined);
      if (row) row.bytes = body.length;
    }).catch(() => {}));
  };
  const onError = error => errors.push(error.message);
  page.on('response', onResponse); page.on('pageerror', onError);
  let profile = null;
  if (pair === 1 && mode === 'cold') {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,blink,disabled-by-default-devtools.timeline,v8,cc',
      transferMode: 'ReturnAsStream' });
  }
  const start = performance.now();
  if (previous) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  else await page.goto(origin + '/#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.souliaPushAppReady && currentPage === 'dashboard' &&
    _dashFuLoaded && followUps.length > 0 && transactions.length > 0, { timeout: 30000 });
  const dataReady = round(performance.now() - start);
  await sleep(350);
  if (pair === 1 && mode === 'cold') {
    profile = (await cdp.send('Profiler.stop')).profile;
    await cdp.send('Profiler.disable');
    const traceDone = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const stream = (await traceDone).stream;
    let trace = '';
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: stream });
      trace += chunk.data;
      if (chunk.eof) break;
    }
    await cdp.send('IO.close', { handle: stream });
    const tracePrefix = process.env.PHASE9_TRACE_PREFIX || 'phase9';
    fs.writeFileSync(path.join(out, tracePrefix + '-cold-trace.json'), trace);
    fs.writeFileSync(path.join(out, tracePrefix + '-cold-cpu.json'), JSON.stringify(profile));
  }
  const startupCount = api.length;
  const startup = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const firstPaint = performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0;
    return { dcl: nav?.domContentLoadedEventEnd || 0, fcp: firstPaint, lcp: window.__phase9.lcp,
      interactive: window.__phase9.interactive, domNodes: document.getElementsByTagName('*').length,
      notificationPanelNodes: document.querySelector('#notif-panel')?.getElementsByTagName('*').length || 0,
      heap: performance.memory?.usedJSHeapSize || null,
      longTasks: window.__phase9.longTasks,
      tbt: window.__phase9.longTasks.filter(t => t.start >= firstPaint && t.start < window.__phase9.interactive)
        .reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0),
      followups: followUps.length, transactions: transactions.length };
  });
  startup.resources = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter(entry => /\/runtime\/|app-core|shopify-orders-route|\.css|\.js/.test(entry.name))
    .map(entry => ({ path: new URL(entry.name).pathname, duration: Math.round(entry.duration),
      transferBytes: entry.transferSize, decodedBytes: entry.decodedBodySize,
      responseEnd: Math.round(entry.responseEnd) })).sort((a, b) => b.decodedBytes - a.decodedBytes));
  const perf = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(r => [r.name, r.value]));
  const counters = await cdp.send('Memory.getDOMCounters').catch(() => ({}));
  startup.scriptMs = round((perf.ScriptDuration || 0) * 1000);
  startup.taskMs = round((perf.TaskDuration || 0) * 1000);
  startup.layoutMs = round((perf.LayoutDuration || 0) * 1000);
  startup.styleMs = round((perf.RecalcStyleDuration || 0) * 1000);
  startup.dataReadyMs = dataReady;
  startup.domCounters = counters;
  const routes = {};
  routes.orders = await measureRoute(page, 'shopify-orders', () => currentPage === 'shopify-orders' &&
    _spServerResponse?.rows?.length > 0 && document.querySelectorAll('#shopify-orders-table-body tr').length > 0);
  routes.dashboardReturn1 = await measureRoute(page, 'dashboard', () => currentPage === 'dashboard' &&
    document.querySelector('#page-dashboard')?.classList.contains('active'));
  routes.movements = await measureRoute(page, 'movements', () => currentPage === 'movements' &&
    _movServerResponse?.pageRows?.length > 0 && document.querySelectorAll('#mov-table tbody tr').length > 0);
  routes.dashboardReturn2 = await measureRoute(page, 'dashboard', () => currentPage === 'dashboard' &&
    document.querySelector('#page-dashboard')?.classList.contains('active'));
  routes.followups = await measureRoute(page, 'followups', () => currentPage === 'followups' &&
    followUps.length > 0 && document.querySelectorAll('#fu-tbody tr').length > 0 &&
    followUps.some(row => Array.isArray(row.comments)));
  routes.dashboardReturn3 = await measureRoute(page, 'dashboard', () => currentPage === 'dashboard' &&
    document.querySelector('#page-dashboard')?.classList.contains('active'));
  routes.ordersReturn = await measureRoute(page, 'shopify-orders', () => currentPage === 'shopify-orders' &&
    _spServerResponse?.rows?.length > 0 && document.querySelectorAll('#shopify-orders-table-body tr').length > 0);
  routes.movementsReturn = await measureRoute(page, 'movements', () => currentPage === 'movements' &&
    _movServerResponse?.pageRows?.length > 0 && document.querySelectorAll('#mov-table tbody tr').length > 0);
  routes.followupsReturn = await measureRoute(page, 'followups', () => currentPage === 'followups' &&
    followUps.length > 0 && document.querySelectorAll('#fu-tbody tr').length > 0);
  const notificationOpen = await page.evaluate(() => {
    const before = performance.now();
    openNotifCenter();
    return { renderMs: Math.round((performance.now() - before) * 10) / 10,
      centerNodes: document.querySelector('#nc-overlay')?.getElementsByTagName('*').length || 0,
      centerCards: document.querySelectorAll('#nc-main [data-notification-id]').length,
      totalNotifications: _ncAllNotifs.length,
      panelNodes: document.querySelector('#notif-panel')?.getElementsByTagName('*').length || 0 };
  });
  await page.evaluate(() => closeNotifCenter({ navigation: true }));
  notificationOpen.closedAgainNodes = await page.evaluate(() =>
    document.querySelector('#nc-overlay')?.getElementsByTagName('*').length || 0);
  await Promise.all(responseTasks);
  const result = { pair, mode, startup, startupCount, startupApiBytes: api.slice(0, startupCount)
    .reduce((sum, row) => sum + (row.bytes || 0), 0),
    startupRealCount: api.slice(0, startupCount).filter(row => !row.path.startsWith('/api/shipping/sync/')).length,
    startupRealBytes: api.slice(0, startupCount).filter(row => !row.path.startsWith('/api/shipping/sync/'))
      .reduce((sum, row) => sum + (row.bytes || 0), 0), api, routes, notificationOpen, errors };
  page.off('response', onResponse); page.off('pageerror', onError);
  await cdp.detach();
  return { result, context, page };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/soulia');
  let browser;
  try {
    const admin = await mongoose.connection.db.collection('users').findOne(
      { role: 'admin', isActive: { $ne: false } }, { projection: { _id: 1, username: 1, name: 1, role: 1 } });
    if (!admin) throw new Error('No active admin account');
    const token = jwt.sign({ sub: String(admin._id), username: admin.username },
      process.env.JWT_SECRET || 'soulia_jwt_default_secret', { expiresIn: '30m' });
    const user = { _id: String(admin._id), username: admin.username, name: admin.name, role: admin.role };
    browser = await puppeteer.launch({ headless: true,
      args: ['--no-sandbox', '--enable-precise-memory-info'] });
    const runs = [];
    for (let pair = 1; pair <= pairs; pair++) {
      const cold = await runPage(browser, token, user, pair, 'cold');
      runs.push(cold.result);
      console.log(`pair ${pair} cold: ${cold.result.startup.dataReadyMs}ms, ${cold.result.startupApiBytes}B, ${cold.result.startupCount} requests`);
      const warm = await runPage(browser, token, user, pair, 'warm', cold);
      runs.push(warm.result);
      console.log(`pair ${pair} warm: ${warm.result.startup.dataReadyMs}ms, ${warm.result.startupApiBytes}B, ${warm.result.startupCount} requests`);
      await warm.context.close();
    }
    fs.writeFileSync(path.join(out, process.env.PHASE9_OUTPUT || 'phase9-browser-runs.json'),
      JSON.stringify({ pairs, runs }, null, 2));
    console.log(`saved ${runs.length} runs`);
  } finally { if (browser) await browser.close(); await mongoose.disconnect(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
