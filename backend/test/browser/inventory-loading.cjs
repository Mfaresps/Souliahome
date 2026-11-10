const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const output = path.resolve(__dirname, '../../../artifacts/inventory-loading');
const stock = Array.from({ length: 24 }, (_, i) => ({
  _id: `inventory-${i}`, code: `SKU-${i}`, name: `Product ${i}`, sellPrice: 120, buyPrice: 70,
  current: 10, warehouseBalances: { MAIN: 10 }, openingBalance: 10, purchases: 0, sales: 0,
  returned: 0, minStock: 2, status: 'ok', isActive: true,
}));
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    let inventoryReads = 0, releaseStock, responseStock = stock, failStock = false;
    page.on('pageerror', error => errors.push(error.stack));
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('token', 'inventory-loading-test');
      localStorage.setItem('user', JSON.stringify({ name: 'Inventory review', role: 'admin', perms: [] }));
      const watch = new MutationObserver(() => {
        const body = document.querySelector('#inv-tbody');
        if (!body || window.inventoryPaintObserver) return;
        window.inventoryPaints = 0;
        window.inventoryPaintObserver = new MutationObserver(records => { window.inventoryPaints += records.filter(r => r.type === 'childList' && r.target === body).length; });
        window.inventoryPaintObserver.observe(body, { childList: true });
      });
      watch.observe(document, { childList: true, subtree: true });
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return request.continue();
      const respond = (data, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (pathname === '/api/transactions/inventory') {
        inventoryReads++;
        if (inventoryReads === 1) { releaseStock = () => respond(responseStock); return; }
        return new Promise(resolve => setTimeout(resolve, 100)).then(() => respond(failStock ? { message: 'Inventory unavailable' } : responseStock, failStock ? 503 : 200));
      }
      if (pathname === '/api/auth/me') return respond({ name: 'Inventory review', role: 'admin', perms: [] });
      if (pathname === '/api/settings') return respond({ lang: 'en' });
      if (pathname === '/api/notifications' || pathname === '/api/notifications/preferences') return respond({ preferences: { enabled: false }, subscriptions: [] });
      if (pathname === '/api/products') return respond(stock);
      if (pathname === '/api/warehouses') return respond([{ code: 'MAIN', name: 'Main warehouse', active: true, isDefault: true }]);
      if (pathname === '/api/transactions/startup-overview') return respond({ rows: [], activeCount: 0 });
      if (pathname === '/api/collections/product-links') return respond({});
      return respond([]);
    });
    await page.goto(origin + '/#dashboard', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => currentPage === 'dashboard' && !document.querySelector('#splash-screen'));
    await new Promise(resolve => setTimeout(resolve, 450));
    await page.evaluate(() => navigateTo('inventory'));
    await page.waitForFunction(() => currentPage === 'inventory' && !document.querySelector('#splash-screen'));
    await new Promise(resolve => setTimeout(resolve, 200));
    const measure = () => page.evaluate(() => ({
      top: document.querySelector('#inv-panel-list').getBoundingClientRect().top,
      width: document.querySelector('#page-inventory').getBoundingClientRect().width,
      height: document.querySelector('#page-inventory').getBoundingClientRect().height,
      kpis: document.querySelectorAll('#inv-summary-cards .kpi').length,
      paints: window.inventoryPaints,
    }));
    const pending = await measure();
    await page.screenshot({ path: path.join(output, 'pending.png') });
    assert(releaseStock, 'startup stock request was started');
    await releaseStock();
    await page.waitForFunction(() => _inventoryHasLoaded && document.querySelectorAll('#inv-tbody .inv-row').length === 24);
    await new Promise(resolve => setTimeout(resolve, 250));
    const ready = await measure();
    await page.screenshot({ path: path.join(output, 'ready.png') });
    const beforeReads = inventoryReads, beforePaints = ready.paints;
    await page.evaluate(() => Promise.all([loadInventory(), loadInventory(), loadInventory()]));
    await new Promise(resolve => setTimeout(resolve, 100));
    const refreshed = await measure();
    console.log(JSON.stringify({ pending, ready, refreshed, beforeReads, inventoryReads }));
    if (!process.env.RECORD_ONLY) {
      assert.equal(pending.kpis, ready.kpis, 'summary reserves its final geometry during loading');
      assert(Math.abs(pending.top - ready.top) <= 2, 'table does not jump when summary loads');
      assert(Math.abs(pending.width - ready.width) <= 1, 'page width stays stable when scrollbars appear');
      assert(Math.abs(pending.height - ready.height) <= 2, 'desktop page height stays stable when stock rows arrive');
      assert.equal(inventoryReads, beforeReads + 1, 'concurrent refreshes share one stock request');
      assert.equal(refreshed.paints, beforePaints, 'unchanged stock does not replace existing rows');
      responseStock = stock.map((row, i) => i ? row : { ...row, current: 15, warehouseBalances: { MAIN: 15 } });
      await page.evaluate(() => loadInventory());
      assert.equal((await measure()).paints, beforePaints + 1, 'changed stock repaints once');
      failStock = true;
      await page.evaluate(() => loadInventory());
      assert.equal((await measure()).paints, beforePaints + 1, 'a failed refresh preserves the visible stock');
      failStock = false;
      for (const [width, height, lang, role] of [[1920, 1080, 'en', 'admin'], [1024, 768, 'ar', 'admin'], [390, 844, 'ar', 'admin'], [320, 900, 'en', 'admin'], [1440, 900, 'en', 'staff']]) {
        await page.setViewport({ width, height });
        await page.evaluate(({lang,role}) => {
          currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
          currentUser.role = role; currentUser.perms = ['inventory', 'inventory-units-view'];
          applyLang();
        }, {lang,role});
        await new Promise(resolve => setTimeout(resolve, 400));
        await page.evaluate(() => {
          _inventoryPageRendered = false; _inventoryHasLoaded = false; inventoryCache = [];
          window.inventoryReload = loadInventory();
        });
        const loadingLayout = await measure();
        await page.evaluate(() => inventoryReload);
        await new Promise(resolve => setTimeout(resolve, 150));
        const loadedLayout = await measure();
        assert.equal(loadingLayout.kpis, loadedLayout.kpis, `summary slots stay stable ${lang}/${width}/${role}`);
        assert(Math.abs(loadingLayout.top - loadedLayout.top) <= 2, `table position stays stable ${lang}/${width}/${role}: ${JSON.stringify({loadingLayout,loadedLayout})}`);
        assert(Math.abs(loadingLayout.width - loadedLayout.width) <= 1, `page width stays stable ${lang}/${width}/${role}`);
        if (width > 768) assert(Math.abs(loadingLayout.height - loadedLayout.height) <= 2, `page height stays stable ${width}`);
        if (width <= 768) assert(await page.$eval('#inv-mobile-list .inv-product-card', el => !!el.getClientRects().length), 'mobile cards replace their placeholders');
        await page.screenshot({ path: path.join(output, `${lang}-${width}-${role}.png`) });
      }
      failStock = true;
      await page.evaluate(async () => {
        currentUser.role = 'admin'; inventoryCache = []; _inventoryHasLoaded = false; _inventoryPageRendered = false;
        await loadInventory();
      });
      assert(await page.$eval('#page-inventory', el => el.classList.contains('inv-load-error') && el.getAttribute('aria-busy') === 'false'), 'initial failure ends loading and offers a retry');
      assert(await page.$$eval('#inv-summary-cards .kpi-val', values => values.every(el => el.textContent === '—')), 'unknown stock is not shown as zero after failure');
      failStock = false;
      await page.evaluate(() => loadInventory());
      assert(await page.$eval('#page-inventory', el => !el.classList.contains('inv-load-error') && !el.classList.contains('inv-loading')), 'retry restores stock and summary');
      assert.deepEqual(errors, []);
      console.log('PASS inventory: stable loading geometry, shared refresh request, unchanged rows preserved, changed stock, refresh failure, Arabic/English, mobile and staff view.');
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
