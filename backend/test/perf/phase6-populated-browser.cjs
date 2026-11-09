// Read-only browser profile with populated, deterministic API fixtures.
// BASELINE_MODE=1 serves the monolithic app script through the same runtime shell.
const puppeteer = require('puppeteer');
const fs = require('node:fs');
const path = require('node:path');

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8081';
const baseline = process.env.BASELINE_MODE === '1';
const runs = Number(process.env.RUNS || 3);
const frontend = path.resolve(__dirname, '../../../frontend');
const source = fs.readFileSync(path.join(frontend, 'public/index.html'), 'utf8');
const runtimeHtml = fs.readFileSync(path.join(frontend, 'runtime/index.html'), 'utf8');
const appStart = /<script>\r?\nconst qs =/.exec(source)?.index ?? -1;
if (appStart < 0) throw new Error('Missing application source script');
const appBody = source.slice(appStart + '<script>'.length, source.indexOf('</script>', appStart));
const baselineHtml = runtimeHtml.replace('<script>window.__SOULIA_SPLIT_SHOPIFY__=true;</script>', '')
  .replace(/(<script src="\/app-core\.js[^>]*><\/script>)/,
    '<script src="/deposit-history.js?v=20261108"></script>\n'
    + '<script src="/shopify-kpis.js?v=20261029-metric-strip"></script>\n$1\n'
    + '<script src="/invoice-image.js?v=20261029-purchase-access"></script>\n'
    + '<script src="/shopify-edit-approvals.js?v=20261103-compact-order-mark"></script>');
const now = new Date().toISOString();
const product = n => ({ _id: `p${n}`, code: `SKU-${n}`, name: `Product ${n}`, sellPrice: 100 + n, purchasePrice: 50, stock: 20 });
const tx = n => ({ _id: `tx${n}`, ref: `${3000 + n}`, type: 'مبيعات', date: now, client: `Customer ${n}`, total: 200,
  paid: 50, remaining: 150, status: 'معلق', items: [{ productId: `p${n % 120}`, name: `Product ${n % 120}`, qty: 1, price: 200 }] });
const order = n => ({ _id: `o${n}`, shopifyId: `s${n}`, ref: `${5000 + n}`, client: `Customer ${n}`,
  phone: `0100000${String(n).padStart(4, '0')}`, status: n % 3 ? 'pending' : 'approved',
  shopifyCreatedAt: now, total: 200, items: [{ productId: `p${n % 120}`, name: `Product ${n % 120}`, qty: 1, price: 200 }],
  depositReceipts: [] });
const followup = n => ({ _id: `fu${n}`, orderRef: `${5000 + n}`, clientName: `Customer ${n}`,
  clientPhone: `0100000${String(n).padStart(4, '0')}`, reason: 'Customer call', status: 'معلق', createdAt: now });
const products = Array.from({ length: 120 }, (_, i) => product(i + 1));
const transactions = Array.from({ length: 200 }, (_, i) => tx(i + 1));
const allTransactions = Array.from({ length: 1053 }, (_, i) => tx(i + 1));
const orders = Array.from({ length: 30 }, (_, i) => order(i + 1));
const followups = Array.from({ length: 90 }, (_, i) => followup(i + 1));
const ordersPage = { rows: orders, page: 1, limit: 30, total: 891, allCount: 891, pendingCount: 594, tabCount: 594,
  filterCounts: {}, baseCount: 891, starredCount: 0, filteredIds: [], selectionRows: [],
  depositSummary: { instapay: 0, vodafone: 0, paidCount: 0, unpaidCount: 891 },
  panelFacets: { status: {}, staff: {}, tags: {}, comments: 0, stock: {} },
  pendingCancelCount: 0, pendingEditCount: 0, kpiStats: null };
const movementsPage = { pageRows: transactions.slice(0, 20), total: 1053, page: 1, pageSize: 20,
  transactionCount: 1053, activeCount: 1053,
  tabCounts: { all: 1053, sales: 1053, purchase: 0, returns: 0 },
  facets: { employee: {}, method: {}, status: {}, operation: {}, bosta: {}, pickup: {}, tags: {} },
  kpi: { sales: 0, shipping: 0, shipLoss: 0, purchases: 0, returns: 0,
    remainingCollection: 0, remainingSupplier: 0, pending: 0, completed: 0,
    cancelled: 0, delivered: 0, mini: { sales: 0, purchases: 0, returns: 0 },
    series: { sales: null, purchases: null, remainingCollection: null } }, orderIds: [] };
function responseFor(url) {
  const p = url.pathname;
  if (p === '/api/auth/me') return { _id: 'profile-admin', name: 'Profile Admin', role: 'admin', perms: [] };
  if (p === '/api/settings') return {};
  if (p === '/api/transactions/startup-overview') return { rows: transactions, activeCount: 1053 };
  if (p === '/api/transactions/movements-page') return movementsPage;
  if (p === '/api/transactions/summary-page') {
    const page = Number(url.searchParams.get('page') || 1);
    return { rows: allTransactions.slice((page - 1) * 200, page * 200), total: 1053, page, pageSize: 200 };
  }
  if (p === '/api/shopify/orders/summary-page') return ordersPage;
  if (p === '/api/shopify/orders') return orders;
  if (p === '/api/shopify/orders/detail/o1') return { ...order(1), rawData: { note: 'Fixture detail' } };
  if (p === '/api/products') return products;
  if (p === '/api/transactions/inventory') return products.map(p => ({ _id: p._id, current: 20 }));
  if (p === '/api/warehouses') return [{ code: 'MAIN', name: 'Main warehouse', active: true, isDefault: true }];
  if (p === '/api/warehouse-layout') return { warehouses: [{ code: 'MAIN', name: 'Main warehouse' }], locations: [], labelSizes: [] };
  if (p === '/api/followups') return followups;
  if (p === '/api/users' || p === '/api/users/mentionable') return [{ _id: 'profile-admin', name: 'Profile Admin', role: 'admin' }];
  if (p === '/api/transactions/sales-overview') return { month: now.slice(0, 7), timeZone: 'Africa/Cairo', totalOrders: 1053,
    totalRevenue: 210600, confirmedOrders: 500, averageOrderValue: 200, today: null, days: [] };
  if (p === '/api/employee-performance/duty-board') return { active: [], upcoming: [] };
  if (p === '/api/transactions/dashboard') return {};
  return [];
}
async function one(browser) {
  const page = await browser.newPage();
  const cdp = await page.target().createCDPSession();
  await cdp.send('Performance.enable');
  await page.setViewport({ width: 1440, height: 900 });
  await page.setCacheEnabled(false);
  const errors = [], assets = [], api = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => errors.push(`FAILED ${request.url()} ${request.failure()?.errorText}`));
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('token', 'phase6-populated-fixture');
    localStorage.setItem('user', JSON.stringify({ _id: 'profile-admin', name: 'Profile Admin', role: 'admin', perms: [] }));
    window.__profile = { interactive: 0, lcp: 0, longTasks: [] };
    let libraryLoader;
    Object.defineProperty(window, 'souliaLibraryReady', { configurable: true,
      get() { return libraryLoader; },
      set(fn) { libraryLoader = name => {
        if (name === 'shopifyOrders' && !window.__profile.shopifyLoadStack)
          window.__profile.shopifyLoadStack = new Error().stack;
        return fn(name);
      }; } });
    new PerformanceObserver(list => list.getEntries().forEach(e => window.__profile.longTasks.push({ start: e.startTime, duration: e.duration })))
      .observe({ type: 'longtask', buffered: true });
    new PerformanceObserver(list => list.getEntries().forEach(e => { window.__profile.lcp = e.startTime; }))
      .observe({ type: 'largest-contentful-paint', buffered: true });
    const tick = () => {
      if (!window.__profile.interactive && window.souliaPushAppReady === true
        && document.querySelector('#app')?.style.display === 'block' && !document.querySelector('#splash-screen'))
        window.__profile.interactive = performance.now();
      if (!window.__profile.interactive) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (baseline && url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: baselineHtml });
    if (baseline && url.pathname === '/app-core.js') return request.respond({ status: 200, contentType: 'text/javascript', body: appBody });
    if (url.pathname === '/vendor/socket.io-4.7.5.min.js')
      return request.respond({ status: 200, contentType: 'text/javascript',
        body: 'window.io=()=>({on(){},emit(){},disconnect(){}});' });
    if (!url.pathname.startsWith('/api/')) return request.continue();
    api.push(url.pathname + url.search);
    return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(responseFor(url)) });
  });
  page.on('response', async response => {
    if (response.request().resourceType() !== 'script') return;
    try { assets.push({ path: new URL(response.url()).pathname, bytes: (await response.buffer()).length }); } catch (_) {}
  });
  await page.goto(origin + '/#dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForFunction(() => window.__profile.interactive > 0, { timeout: 15000 });
  } catch (error) {
    const state = await page.evaluate(() => ({ app: document.querySelector('#app')?.style.display,
      splash: !!document.querySelector('#splash-screen'), ready: window.souliaPushAppReady,
      page: typeof currentPage === 'undefined' ? null : currentPage }));
    throw new Error(`Startup: ${error.message}; ${JSON.stringify(state)}; ${errors.join(' | ')}`);
  }
  await new Promise(r => setTimeout(r, 400));
  const startup = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0;
    const { interactive, lcp, longTasks } = window.__profile;
    return { dcl: nav.domContentLoadedEventEnd, fcp, lcp, interactive,
      tbt: longTasks.filter(t => t.start >= fcp && t.start < interactive).reduce((s, t) => s + Math.max(0, t.duration - 50), 0),
      domNodes: document.getElementsByTagName('*').length };
  });
  const chromeMetrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics
    .map(metric => [metric.name, metric.value]));
  startup.scriptMs = Math.round((chromeMetrics.ScriptDuration || 0) * 1000);
  startup.taskMs = Math.round((chromeMetrics.TaskDuration || 0) * 1000);
  const startupApi = api.length;
  const startupScripts = assets.map(asset => asset.path);
  const startupScriptBytes = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const navigation = {};
  for (const route of ['settings', 'shopify-orders', 'movements', 'followups', 'reports', 'invoice-view']) {
    const from = await page.evaluate(() => performance.now());
    const apiBefore = api.length, assetBefore = assets.length;
    await page.evaluate(target => navigateTo(target), route);
    try {
      await page.waitForFunction(target => currentPage === target
        && document.querySelector(`#page-${target === 'followups' ? 'complaints' : target}`)?.classList.contains('active'),
        { timeout: 15000 }, route);
    } catch (error) {
      const state = await page.evaluate(() => ({ currentPage, active: [...document.querySelectorAll('.page.active')].map(p => p.id),
        transactionComplete: _transactionSummariesComplete, pendingTransaction: _pendingTransactionRoute,
        pendingStartup: _pendingStartupRoute, pendingShopify: _pendingShopifyRoute }));
      throw new Error(`${route}: ${error.message}; ${JSON.stringify(state)}; ${api.slice(-12).join(' | ')}; ${errors.join(' | ')}`);
    }
    const visibleMs = Math.round((await page.evaluate(() => performance.now())) - from);
    if (route === 'shopify-orders')
      await page.waitForFunction(() => _spOrdersLoaded && _spServerResponse?.rows?.length === 30, { timeout: 15000 });
    if (route === 'movements')
      await page.waitForFunction(() => _movServerResponse?.pageRows?.length === 20, { timeout: 15000 });
    const dataReadyMs = Math.round((await page.evaluate(() => performance.now())) - from);
    await new Promise(r => setTimeout(r, 250));
    navigation[route] = { visibleMs, dataReadyMs, settledMs: Math.round((await page.evaluate(() => performance.now())) - from),
      api: api.slice(apiBefore), scripts: assets.slice(assetBefore).map(a => a.path) };
    if (route === 'shopify-orders') {
      navigation[route].subnav = await page.evaluate(() => ({ role: currentUser?.role, admin: isAdmin(),
        loaded: !!window.__SOULIA_SHOPIFY_LOADED__, tabs: [...document.querySelectorAll('#sp-subnav [role="tab"]')]
          .map(el => ({ id: el.id, hidden: el.hidden, display: getComputedStyle(el).display })) }));
      const detailStart = Date.now(), detailApiBefore = api.length;
      await page.evaluate(() => openSpOrderPeek('o1'));
      await page.waitForSelector('#sp-peek [role="dialog"]');
      navigation[route].detail = { ms: Date.now() - detailStart, api: api.slice(detailApiBefore) };
      await page.evaluate(() => closeSpOrderPeek());
    }
  }
  const invoiceBefore = assets.filter(a => a.path === '/invoice-image.js').length;
  const invoiceStart = Date.now();
  await page.evaluate(() => exportInvoiceImage('transaction', 'tx1', 'download'));
  await new Promise(r => setTimeout(r, 100));
  const invoiceImage = { elapsedMs: Date.now() - invoiceStart,
    loadedOnDemand: assets.filter(a => a.path === '/invoice-image.js').length > invoiceBefore };
  const shopifyLoadStack = await page.evaluate(() => window.__profile.shopifyLoadStack || null);
  const result = { startup, startupApi, startupScripts, startupScriptBytes, totalApi: api.length,
    api, assets, navigation, invoiceImage, errors, shopifyLoadStack };
  await page.close();
  return result;
}
(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--disable-background-networking'] });
  try {
    const results = [];
    for (let i = 0; i < runs; i++) results.push(await one(browser));
    const median = key => [...results.map(r => r.startup[key])].sort((a, b) => a - b)[Math.floor(results.length / 2)];
    console.log(JSON.stringify({ mode: baseline ? 'monolith-with-current-data-flow' : 'split',
      fixture: { orders: 891, transactions: 1053, products: products.length, followups: followups.length },
      median: Object.fromEntries(['dcl', 'fcp', 'lcp', 'interactive', 'tbt', 'domNodes', 'scriptMs', 'taskMs'].map(k => [k, median(k)])),
      runs: results }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
