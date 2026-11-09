const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep)
        && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const extension = path.extname(file);
        return request.respond({ status: 200,
          contentType: extension === '.html' ? 'text/html' : extension === '.css' ? 'text/css' : 'text/javascript',
          body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: '' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentUser = { _id: 'admin', role: 'admin', perms: ['shopify-orders'] };
      currentLang = 'en';
      document.documentElement.lang = 'en';
      document.documentElement.dir = 'ltr';
      qs('#login-page').style.display = 'none';
      qs('#app').style.display = '';
      qs('#splash-screen')?.remove();
      document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
      qs('#page-shopify-orders').classList.add('active');
      currentPage = 'shopify-orders';
      _shopifyOrders = [
        { _id: 'order-1', ref: '3082', type: 'shopify', status: 'pending', client: 'Mohamed Soliman',
          total: 3000, createdAt: '2026-11-07T19:03:00+02:00', items: [{ name: 'Product', qty: 1, price: 3000, total: 3000 }],
          depositReceipts: [], shipWithoutDeposit: false },
        { _id: 'order-2', ref: '3083', type: 'shopify', status: 'pending', client: 'Rania El Khodary',
          total: 2500, createdAt: '2026-11-07T18:03:00+02:00', items: [{ name: 'Product', qty: 1, price: 2500, total: 2500 }],
          depositReceipts: [], shipWithoutDeposit: false },
      ];
      renderShopifyOrders();
    });
    await page.waitForSelector('#shopify-orders-table-body tr.sp-order-row');
    const row = await page.$('#shopify-orders-table-body tr.sp-order-row');
    const box = await row.boundingBox();
    await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5);
    const sample = await page.evaluate(async () => {
      const selector = '#shopify-orders-table-body tr.sp-order-row';
      const row = document.querySelector(selector);
      const first = row.querySelector('td');
      const transitions = { row: getComputedStyle(row).transitionDuration, cell: getComputedStyle(first).transitionDuration };
      let replacements = 0;
      const host = document.querySelector('#shopify-orders-table-body');
      const observer = new MutationObserver(() => { replacements++; });
      observer.observe(host, { childList: true, subtree: true });
      const positions = [];
      for (let i = 0; i < 8; i++) {
        positions.push({ row: row.getBoundingClientRect().y, cell: first.getBoundingClientRect().y,
          connected: row.isConnected, hover: row.matches(':hover'),
          shadow: getComputedStyle(first).boxShadow });
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      observer.disconnect();
      return { transitions, replacements, positions };
    });
    assert.equal(sample.transitions.row, '0s');
    assert.equal(sample.transitions.cell, '0s');
    assert.equal(sample.replacements, 0);
    assert.ok(sample.positions.every(position => position.connected && position.hover
      && position.row === sample.positions[0].row && position.cell === sample.positions[0].cell));
    const refresh = await page.evaluate(async () => {
      const rows = _shopifyOrders;
      const originalApi = api;
      const host = document.querySelector('#shopify-orders-table-body');
      const originalAnimate = host.animate;
      let reveals = 0;
      host.animate = function (...args) { reveals++; return originalAnimate.apply(this, args); };
      api = async (url, options) => url.startsWith('/shopify/orders/summary-page?')
        ? { rows, page: 1, total: rows.length, tabCount: rows.length, pendingCount: rows.length, filteredIds: rows.map(row => row._id) }
        : originalApi(url, options);
      _spServerEnabled = true;
      _spOrdersLoaded = true;
      _spSubnavTab = 'orders';
      try {
        await _spLoadServerPage(true);
        await _spLoadServerPage(true);
        return { reveals, rows: host.querySelectorAll('tr.sp-order-row').length };
      } finally { api = originalApi; host.animate = originalAnimate; }
    });
    assert.equal(refresh.rows, 2);
    assert.equal(refresh.reveals, 0, 'Live refresh does not replay the table reveal');
    console.log('Shopify row hover stays still and live refresh does not pulse the table.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
