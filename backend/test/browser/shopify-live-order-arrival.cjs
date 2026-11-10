const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

function order(id, ref) {
  return { _id: id, shopifyId: id, ref, client: 'Customer ' + ref,
    status: 'pending', shopifyCreatedAt: new Date().toISOString(),
    items: [], total: 100, comments: [], depositReceipts: [] };
}
function summary(rows, received = rows.length) {
  return { rows, page: 1, limit: 30, total: rows.length, allCount: received,
    pendingCount: received, tabCount: received, filterCounts: {}, baseCount: rows.length,
    starredCount: 0, filteredIds: rows.map(row => row._id), selectionRows: [],
    depositSummary: { instapay: 0, vodafone: 0, paidCount: 0, unpaidCount: rows.length },
    panelFacets: { status: {}, staff: {}, tags: {}, comments: 0, stock: {} },
    pendingCancelCount: 0, pendingEditCount: 0,
    kpiStats: { received, deposit: 0, nodep: 0, confirmed: 0, followup: 0,
      cancelled: 0, open: received, rate: 0, prevReceived: 0 } };
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewport({ width, height: 900 });
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === 'http://soulia.test' && url.pathname === '/')
          return request.respond({ status: 200, contentType: 'text/html', body: html });
        const local = path.join(publicDir, url.pathname.slice(1));
        if (url.origin === 'http://soulia.test' && fs.existsSync(local) && /\.(js|css)$/.test(url.pathname))
          return request.respond({ status: 200, contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(local) });
        if (request.resourceType() === 'script')
          return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
        return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
      });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      const first = order('aaaaaaaaaaaaaaaaaaaaaaaa', '3100');
      const second = order('bbbbbbbbbbbbbbbbbbbbbbbb', '3099');
      const incoming = order('cccccccccccccccccccccccc', '3101');
      await page.evaluate(async (initial, viewportWidth) => {
        currentLang = viewportWidth > 768 ? 'ar' : 'en';
        document.documentElement.dir = currentLang === 'ar' ? 'rtl' : 'ltr';
        currentUser = { _id: 'admin', role: 'admin', perms: [] };
        localStorage.setItem(_colsPrefKey(SPK_HIDDEN_KEY), '0');
        qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
        currentPage = 'shopify-orders'; _spSubnavTab = 'orders'; _shopifyTab = 'all';
        document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
        qs('#page-shopify-orders').classList.add('active');
        _spServerEnabled = true; _spOrdersLoaded = true; _spPanel = _spPanelEmpty();
        _shopifyDateFilter = { from: null, to: null }; inventoryCache = []; transactions = []; followUps = [];
        window.__socketEvents = {};
        window.io = () => ({ on(name, handler) { window.__socketEvents[name] = handler; }, emit() {}, disconnect() {} });
        localStorage.setItem('token', 'live-order-browser-test');
        connectSocket();
        window.__liveSummary = initial; window.__liveCalls = 0;
        api = async url => {
          if (url.startsWith('/shopify/orders/summary-page')) {
            window.__liveCalls++;
            return structuredClone(window.__liveSummary);
          }
          return [];
        };
        await _spLoadServerPage(true);
        const selector = innerWidth < 600 ? '#sp-mobile-list [data-sp-order-id]' : '#shopify-orders-table-body tr[data-sp-order-id]';
        window.__keptRow = document.querySelector(selector);
      }, summary([first, second]), width);
      assert.equal(await page.evaluate(() => !!window.__keptRow), true, `${width}: initial row`);
      // Let the initial layout/header observers settle before measuring the live patch.
      await new Promise(resolve => setTimeout(resolve, 350));
      await page.evaluate(() => {
        const selector = innerWidth < 600 ? '#sp-mobile-list [data-sp-order-id]' : '#shopify-orders-table-body tr[data-sp-order-id]';
        window.__keptRow = document.querySelector(selector);
      });
      await page.evaluate(next => {
        window.__liveSummary = next;
        window.__socketEvents['shopify:order-created']({ id: 'cccccccccccccccccccccccc' });
        window.__socketEvents['shopify:order-created']({ id: 'cccccccccccccccccccccccc' });
      }, summary([incoming, first, second]));
      await page.waitForFunction(() => document.querySelector('.spk-tile.is-received .spk-val bdi')?.textContent.trim() === '3', { timeout: 5000 }).catch(async error => {
        const state = await page.evaluate(() => ({ calls: window.__liveCalls, page: currentPage,
          serverKey: _spServerKey, livePaint: _spLivePaint, rows: _shopifyOrders.map(o => o._id),
          kpi: document.querySelector('.spk-tile.is-received .spk-val bdi')?.outerHTML,
          kpiHost: document.querySelector('#sp-kpi')?.outerHTML.slice(0, 300),
          kpiFunction: typeof _spkRender,
          receiptError: _spReceiptLoadError }));
        throw new Error(error.message + ' ' + JSON.stringify(state));
      });
      const result = await page.evaluate(() => {
        const selector = innerWidth < 600 ? '#sp-mobile-list [data-sp-order-id]' : '#shopify-orders-table-body tr[data-sp-order-id]';
        return { ids: [...document.querySelectorAll(selector)].map(row => row.dataset.spOrderId),
          preserved: document.querySelector(selector + '[data-sp-order-id="aaaaaaaaaaaaaaaaaaaaaaaa"]') === window.__keptRow,
          calls: window.__liveCalls, animated: !!document.querySelector(selector + '[data-sp-order-id="cccccccccccccccccccccccc"].sp-live-arrival') };
      });
      assert.deepEqual(result.ids, [incoming._id, first._id, second._id], `${width}: ordered rows`);
      assert.equal(result.preserved, true, `${width}: unchanged row retained`);
      assert.equal(result.calls, 2, `${width}: one initial request and one deduplicated live request`);
      assert.equal(result.animated, false, `${width}: new row appears directly without arrival motion`);
      assert.deepEqual(errors, [], `${width}: browser errors`);
      await page.close();
    }
    console.log('PASS: new Shopify order and final count appear directly, existing DOM is preserved, and live requests coalesce on desktop and mobile.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
