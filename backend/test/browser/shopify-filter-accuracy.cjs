const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/')
        return request.respond({ status: 200, contentType: 'text/html', body: html });
      const local = path.join(publicDir, url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && fs.existsSync(local) && (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')))
        return request.respond({ status: 200, contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(local) });
      if (request.resourceType() === 'script')
        return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentLang = 'en'; document.documentElement.dir = 'ltr';
      currentUser = { _id: 'admin', role: 'admin', perms: [] };
      qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      const today = new Date().toISOString();
      const yesterday = new Date(Date.now() - 86400000).toISOString();
      const item = productId => [{ productId, name: productId, qty: 1, price: 100 }];
      _shopifyOrders = [
        { _id: 'o1', shopifyId: 's1', ref: '3024', status: 'pending', starred: true, shopifyCreatedAt: today, items: item('p1'), total: 100,
          depositReceipts: [{ status: 'معتمد', amount: 30, method: 'Cash' }] },
        { _id: 'o2', shopifyId: 's2', ref: '3023', status: 'pending', shopifyCreatedAt: today, items: item('p2'), total: 100 },
        { _id: 'o3', shopifyId: 's3', ref: '3022', status: 'approved', shopifyCreatedAt: today, items: item('p2'), total: 100,
          depositAmount: 30, depositMethod: 'Cash', depositReceipts: [] },
        { _id: 'o4', shopifyId: 's4', ref: '3021', status: 'approved', starred: true, shopifyCreatedAt: today, items: item('p2'), total: 100 },
        { _id: 'o5', shopifyId: 's5', ref: '3020', status: 'pending', cancelled: true, shopifyCreatedAt: yesterday, items: item('p2'), total: 100 },
      ];
      transactions = [{ _id: 'tx4', shopifyOrderId: 's4', pickupStatus: 'Ready', bostaOrderId: 'b4', bostaStatus: 'IN_TRANSIT' }];
      inventoryCache = [{ _id: 'p1', current: 5 }, { _id: 'p2', current: 0 }]; _inventoryHasLoaded = true;
      followUps = []; _shopifyTab = 'all'; _shopifyStatusFilter = ''; _spStarOnly = false;
      _spPanel = _spPanelEmpty(); _shopifyDateFilter = { from: null, to: null }; _spOrdersLoaded = true;
      currentPage = 'shopify-orders'; _spSubnavTab = 'orders'; document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
      qs('#page-shopify-orders').classList.add('active');
      renderShopifyOrders();
    });
    const snapshot = () => page.evaluate(() => ({
      counts: [...document.querySelectorAll('#sp-filter-dropdown .sp-fdd-opt')].map(el => Number(el.querySelector('.sp-fdd-count')?.textContent || 0)),
      shown: Number(qs('#sp-result-count')?.querySelector('b')?.textContent || 0),
      stage: _orderStateMeta(_shopifyOrders[3], 'shopify').key,
    }));
    assert.deepEqual(await snapshot(), { counts: [5, 0, 2, 2, 1, 1, 2], shown: 5, stage: 'IN_TRANSIT' });
    assert.equal(await page.evaluate(() => _spOrderStatusKey(_shopifyOrders[3])), 'confirmed');
    await page.evaluate(() => { transactions[0].bostaStatus = 'DELIVERED'; _rtRefreshUI({ movements: true }); });
    await page.waitForFunction(() => !!document.querySelector('#shopify-orders-table-body [data-order-state="DELIVERED"]'));
    assert.equal((await snapshot()).stage, 'DELIVERED');
    await page.evaluate(() => { _spStarOnly = true; renderShopifyOrders(); });
    assert.deepEqual((await snapshot()).counts, [2, 0, 1, 1, 1, 0, 2]);
    await page.evaluate(() => { _shopifyStatusFilter = 'deposit-paid'; renderShopifyOrders(); });
    assert.equal((await snapshot()).shown, 1);
    assert.equal((await snapshot()).counts[6], 1);
    await page.evaluate(() => { _shopifyStatusFilter = ''; _spStarOnly = false; _spkPeriod = 'today'; _spkFilter = 'received'; renderShopifyOrders(); });
    assert.equal((await snapshot()).counts[0], 4);
    assert.equal((await snapshot()).shown, 4);
    const stockCases = await page.evaluate(() => {
      inventoryCache = [{ _id: 'p3', current: 1 }];
      const index = _spBuildInvIndex();
      const repeated = _spStockBlock({ items: [{ productId: 'p3', qty: 1 }, { productId: 'p3', qty: 1 }] }, index);
      const unlinked = _spStockBlock({ items: [{ code: 'p3', qty: 1 }] }, index);
      inventoryCache = [];
      const emptyInventory = _spStockBlock({ items: [{ productId: 'p3', qty: 1 }] }, _spBuildInvIndex());
      return { repeated, unlinked, emptyInventory };
    });
    assert.equal(stockCases.repeated.shortQty, 1);
    assert.equal(stockCases.unlinked.missing, 1);
    assert.equal(stockCases.emptyInventory.missing, 1);
    await page.evaluate(async () => {
      api = async url => url === '/shopify/orders' ? _shopifyOrders
        : url === '/transactions' ? [{ _id: 'tx4', shopifyOrderId: 's4', bostaOrderId: 'b4', bostaStatus: 'OUT_FOR_DELIVERY' }]
        : url === '/transactions/inventory' ? [{ _id: 'p1', current: 5 }, { _id: 'p2', current: 3 }]
        : [];
      await refreshShopifyOrders();
    });
    assert.equal((await snapshot()).stage, 'OUT_FOR_DELIVERY');
    assert.equal((await snapshot()).counts[5], 0);
    const unloadedStock = await page.evaluate(() => {
      inventoryCache = []; _inventoryHasLoaded = false; renderShopifyOrders();
      const option = [...document.querySelectorAll('#sp-filter-dropdown .sp-fdd-opt')][5];
      return { count: option.querySelector('.sp-fdd-count').textContent, disabled: option.disabled };
    });
    assert.deepEqual(unloadedStock, { count: '—', disabled: true });
    console.log('PASS Shopify filters: counts match active scope, historical stock is excluded, legacy deposit is counted, and recorded stage follows its invoice.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
