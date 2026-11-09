const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
        return request.respond({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: '' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    for (const width of [390, 320]) {
      await page.setViewport({ width, height: 850 });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        currentUser = { _id: 'staff-1', role: 'admin', perms: ['shopify-orders', 'shopify-deposit-upload', 'shopify-prepare-ship'] };
        currentLang = 'en';
        document.documentElement.lang = 'en';
        document.documentElement.dir = 'ltr';
        qs('#login-page').style.display = 'none';
        qs('#app').style.display = '';
        qs('#splash-screen')?.remove();
        document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
        qs('#page-shopify-orders').classList.add('active');
        currentPage = 'shopify-orders';
        window.previewCalls = [];
        openSpOrderPeek = id => previewCalls.push(id);
        _shopifyOrders = [{ _id: 'order-3082', ref: '3082', type: 'shopify', status: 'pending',
          client: 'Mohamed Soliman', total: 3000, createdAt: '2026-11-07T19:03:00+02:00',
          items: [{ name: 'Product', qty: 1, price: 3000, total: 3000 }], depositReceipts: [], shipWithoutDeposit: false }];
        renderShopifyOrders();
      });
      await page.waitForSelector('#sp-mobile-list .sp-card-preview-btn');
      await page.evaluate(() => {
        closeSidebar();
        window.previewCalls = [];
        openSpOrderPeek = id => previewCalls.push(id);
      });
      const geometry = await page.evaluate(() => {
        const card = document.querySelector('#sp-mobile-list .sp-card');
        const products = card.querySelector('.sp-card-products-toggle').getBoundingClientRect();
        const preview = card.querySelector('.sp-card-preview-btn').getBoundingClientRect();
        const add = card.querySelector('.spdep-fab-trigger').getBoundingClientRect();
        const actions = card.querySelector('.sp-card-actions-row').getBoundingClientRect();
        const optionInfo = card.querySelector('.sp-card-options-info').getBoundingClientRect();
        const optionActions = card.querySelector('.sp-card-option-actions').getBoundingClientRect();
        const options = card.querySelector('.sp-card-options').getBoundingClientRect();
        return { cardHeight: card.getBoundingClientRect().height, productTop: products.top,
          previewTop: preview.top, addTop: add.top, actionsTop: actions.top,
          previewSize: [preview.width, preview.height], widths: [options.width, optionInfo.width, optionActions.width], overflow: card.scrollWidth > card.clientWidth + 1 };
      });
      assert.equal(geometry.overflow, false, `${width}px: card fits viewport`);
      assert.ok(Math.abs(geometry.productTop - geometry.addTop) < 8, `${width}px: product count and add action share one row: ${JSON.stringify(geometry)}`);
      assert.ok(Math.abs(geometry.previewTop - geometry.addTop) < 8, `${width}px: preview stays beside add action`);
      assert.ok(geometry.cardHeight < 220, `${width}px: card no longer reserves a blank row: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.previewSize[0] >= 44 && geometry.previewSize[1] >= 40, `${width}px: preview has a touch target`);
      await page.screenshot({ path: path.join(os.tmpdir(), `soulia-shopify-card-preview-${width}.png`), fullPage: true });
      await page.click('#sp-mobile-list .sp-card-preview-btn');
      assert.deepEqual(await page.evaluate(() => previewCalls), ['order-3082'], `${width}px: preview button click; page errors: ${errors.join(' | ')}`);
      await page.click('#sp-mobile-list .sp-card-client');
      assert.deepEqual(await page.evaluate(() => previewCalls), ['order-3082', 'order-3082'], 'tapping card content opens preview');
      await page.click('#sp-mobile-list .sp-card-products-toggle');
      assert.equal(await page.evaluate(() => previewCalls.length), 2, 'product toggle does not open preview');
      await page.click('#sp-mobile-list .spdep-fab-trigger');
      assert.equal(await page.evaluate(() => previewCalls.length), 2, 'deposit action does not open preview');
      assert.ok(await page.$('#spdep-fab-menu'));
      const arabic = await page.evaluate(() => {
        ShopifyDepositFab.close();
        currentLang = 'ar';
        document.documentElement.lang = 'ar';
        document.documentElement.dir = 'rtl';
        renderShopifyOrders();
        const card = document.querySelector('#sp-mobile-list .sp-card');
        return { height: card.getBoundingClientRect().height, overflow: card.scrollWidth > card.clientWidth + 1,
          preview: card.querySelector('.sp-card-preview-btn')?.getAttribute('aria-label') };
      });
      assert.equal(arabic.overflow, false, `${width}px Arabic: card fits viewport`);
      assert.ok(arabic.height < 220, `${width}px Arabic: compact card height`);
      assert.ok(arabic.preview?.includes('عرض ملخص الطلب'), 'Arabic preview remains labelled');
      assert.deepEqual(errors, []);
    }
    console.log('shopify card preview: passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
