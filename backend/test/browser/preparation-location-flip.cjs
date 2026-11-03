const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');
const artifactDir = path.resolve(__dirname, '../../../artifacts/preparation-workspace');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport({ width: 1440, height: 900 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test') {
        const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.resolve(publicDir, relative);
        if (file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const contentType = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'image/webp';
          return request.respond({ status: 200, contentType, body: fs.readFileSync(file) });
        }
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentLang = 'en'; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; applyLang();
      currentUser = { _id: 'preview', name: 'Preview', role: 'admin', perms: ['movements', 'pickup-orders', 'inventory-units-view', 'inventory-units-allocate'] };
      qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      onPageEnter = () => {};
      const items = [
        { lineId: 'line-1', productId: 'product-1', name: 'Riva dining bowl', code: 'SKU-1', qty: 2, price: 150, imageUrl: 'http://soulia.test/empty-shipping.webp' },
        { lineId: 'line-2', productId: 'product-2', name: 'Cotton basket', code: 'SKU-2', qty: 1, price: 100, imageUrl: 'http://soulia.test/empty-shipping.webp' },
      ];
      products = [
        { _id: 'product-1', name: items[0].name, code: items[0].code, storageLocationId: 'level-1' },
        { _id: 'product-2', name: items[1].name, code: items[1].code },
      ];
      _pickupOrders = [{ _id: 'order-1', ref: '2995', client: 'Test customer', phone: '01000000000', type: 'مبيعات', date: '2026-11-03', total: 400, remaining: 400, pickupStatus: 'Preparing', pickupRef: '925-02NOV', items }];
      transactions = _pickupOrders; _puOrdersLoaded = true; _puLoadPrepGroups(_pickupOrders);
      window.layoutReads = 0;
      api = async url => {
        if (url === '/warehouse-layout') {
          layoutReads++;
          return { warehouses: [{ code: 'MAIN', name: 'Main warehouse' }], locations: [
            { _id: 'zone-1', warehouseCode: 'MAIN', parentId: null, kind: 'zone', code: 'A' },
            { _id: 'rack-1', warehouseCode: 'MAIN', parentId: 'zone-1', kind: 'rack', code: 'R1' },
            { _id: 'level-1', warehouseCode: 'MAIN', parentId: 'rack-1', kind: 'level', code: 'S02' },
          ], labelSizes: [] };
        }
        if (url.endsWith('/picking')) return { lines: items.map(item => ({ lineId: item.lineId, productId: item.productId, qty: item.qty, units: [], skippedCount: 0 })) };
        if (url === '/transactions/pickup-orders') return structuredClone(_pickupOrders);
        return [];
      };
      navigateTo('pickup-orders'); openPuCardOrdersModal('925-02NOV', 'prep');
    });
    await page.waitForSelector('#pw-work .pw-item[data-pw-line="line-1"] .pw-location-toggle');
    assert.equal(await page.$$eval('#pw-work .pw-item', cards => cards.length), 2);
    const first = '#pw-work .pw-item[data-pw-line="line-1"]';
    const second = '#pw-work .pw-item[data-pw-line="line-2"]';
    assert.ok(await page.$eval(first + ' .product-thumb', el => el.getBoundingClientRect().width >= 140), 'Product photo keeps its size');
    await page.click(first + ' .pw-item-front .pw-location-toggle');
    await page.waitForFunction(() => document.querySelector('#pw-work .pw-item[data-pw-line="line-1"] .pw-location-grid')?.textContent.includes('S02'));
    const location = await page.$eval(first, card => ({ text: card.querySelector('.pw-item-back').textContent, open: card.classList.contains('is-location-open'), frontInert: card.querySelector('.pw-item-front').inert }));
    assert.equal(location.open && location.frontInert, true);
    for (const value of ['Main warehouse', 'ZONE A', 'R1', 'S02']) assert.ok(location.text.includes(value), value);
    await page.evaluate(() => _pwRenderWork());
    assert.equal(await page.$eval(first, card => card.classList.contains('is-location-open')), true, 'Flip survives order updates');
    await page.$eval(first + ' .pw-item-flipper', el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    fs.mkdirSync(artifactDir, { recursive: true });
    await page.screenshot({ path: path.join(artifactDir, 'location-flip-desktop.png') });
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => pwSelectOrder(_pwSelId));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Mobile layout fits');
    await page.click(first + ' .pw-item-back .pw-location-toggle');
    assert.equal(await page.$eval(first, card => card.querySelector('.pw-item-front').inert), false);
    await page.click(second + ' .pw-item-front .pw-location-toggle');
    assert.match(await page.$eval(second + ' .pw-item-back', el => el.textContent), /No warehouse location assigned/);
    assert.equal(await page.evaluate(() => layoutReads), 1, 'Unassigned products need no extra layout request');
    await page.evaluate(() => {
      currentLang = 'ar'; document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl'; document.body.classList.add('dark-mode');
      applyLang(); _pwRenderWork();
    });
    await page.$eval(first, el => el.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
    await page.click(first + ' .pw-item-front .pw-location-toggle');
    assert.equal(await page.$eval(first, card => card.classList.contains('is-location-open')), true);
    assert.match(await page.$eval(first + ' .pw-item-back', el => el.textContent), /المخزن/);
    assert.match(await page.$eval(first + ' .pw-item-back', el => el.textContent), /المستوى/);
    await page.$eval(first, el => el.scrollIntoView({ block: 'center' }));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 550)));
    await page.$eval(first + ' .pw-item-flipper', el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    await page.screenshot({ path: path.join(artifactDir, 'location-flip-ar-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Arabic mobile layout fits');
    assert.deepEqual(errors, []);
    console.log('PASS: preparation product cards flip to assigned warehouse locations');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
