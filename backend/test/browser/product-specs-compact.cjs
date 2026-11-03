const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('token', 'product-specs-test');
      localStorage.setItem('user', JSON.stringify({ name: 'Test', role: 'admin', perms: [] }));
    });
    await page.setRequestInterception(true);
    const skuRequests = [];
    page.on('request', request => {
      const requestUrl = new URL(request.url());
      const pathname = requestUrl.pathname;
      if (!pathname.startsWith('/api/')) return request.continue();
      const product = {
        _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', code: 'SOULIA-001', name: 'SOULIA sample',
        colors: ['Dark Green'], features: ['Waterproof', 'Machine Washable'],
        isPattern: true, pattern: 'Striped', material: 'Cotton', sizeType: 'standard', size: 'Medium',
        sellPrice: 100, buyPrice: 50, openingBalance: 0,
      };
      let body = '[]';
      if (pathname === '/api/auth/me') body = JSON.stringify({ name: 'Test', role: 'admin', perms: [] });
      if (pathname === '/api/products') body = JSON.stringify([product]);
      if (pathname === '/api/products/suggest-sku') {
        skuRequests.push(requestUrl.searchParams.get('exclude'));
        body = JSON.stringify({ code: `BLA-DAR-KNI-${skuRequests.length === 1 ? '482731' : '916405'}` });
      }
      if (pathname === '/api/settings' || pathname === '/api/transactions/dashboard') body = '{}';
      if (pathname === '/api/warehouse-layout') body = JSON.stringify({ warehouses: [{ code: 'MAIN', name: 'Main warehouse' }], locations: [], labelSizes: [] });
      return request.respond({ status: 200, contentType: 'application/json', body });
    });
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto('http://127.0.0.1:8080/#products', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => currentPage === 'products' && Array.isArray(products) && products.length === 1);
    await page.evaluate(() => openProductModal(products[0]._id));
    await page.waitForSelector('#pm-color-picker');
    assert.equal(await page.$eval('#pm-color-picker', node => node.open), false);
    assert.equal(await page.$eval('#pm-feature-picker', node => node.open), false);
    assert.equal(await page.$eval('#pm-material-picker', node => node.open), false);
    assert.equal(await page.$eval('#pm-size-picker', node => node.open), false);
    assert.match(await page.$eval('#pm-color-picker > summary', node => node.textContent), /أخضر داكن/);
    assert.match(await page.$eval('#pm-feature-picker > summary', node => node.textContent), /مقاوم للماء/);
    const section = await (await page.$('#pm-color-picker')).evaluateHandle(node => node.closest('.pm-section'));
    await section.screenshot({ path: path.join(os.tmpdir(), 'soulia-product-specs-compact-desktop.png') });
    await page.click('#pm-color-picker > summary');
    assert.equal(await page.$eval('#pm-color-picker', node => node.open), true);
    assert.equal(await page.$eval('#pm-color-dark-green', node => node.checked), true);
    await page.click('#pm-color-blue');
    assert.equal(await page.$eval('#pm-color-picker .pm-spec-picker-count', node => node.textContent), '2/3');
    assert.match(await page.$eval('#pm-color-picker > summary', node => node.textContent), /أزرق/);
    await page.click('#pm-feature-picker > summary');
    await page.click('#pm-feat-water-repellent');
    assert.equal(await page.$eval('#pm-feature-picker .pm-spec-picker-count', node => node.textContent), '3');
    await page.click('#pm-material-picker > summary');
    await page.select('#pm-material-select', 'Linen');
    assert.match(await page.$eval('#pm-material-preview', node => node.textContent), /Linen/);
    await page.click('#pm-size-picker > summary');
    await page.select('#pm-size-standard', 'Large');
    assert.equal(await page.$eval('#pm-size-preview', node => node.textContent), 'Large');
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => document.querySelectorAll('#pm-color-picker, #pm-feature-picker, #pm-material-picker, #pm-size-picker').forEach(node => { node.open = false; }));
    await page.$eval('#pm-color-picker', node => node.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: path.join(os.tmpdir(), 'soulia-product-specs-compact-mobile.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile layout must not overflow');
    await page.evaluate(() => { currentLang = 'en'; openProductModal(products[0]._id); });
    assert.match(await page.$eval('#pm-color-picker > summary', node => node.textContent), /Colors|Dark Green/);
    assert.match(await page.$eval('#pm-feature-picker > summary', node => node.textContent), /Waterproof/);
    await page.evaluate(() => openProductModal());
    await page.$eval('#pm-name', node => { node.value = 'Blanket darkgreen Knitted'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#pm-code-gen-btn');
    await page.waitForFunction(() => document.querySelector('#pm-code')?.value === 'BLA-DAR-KNI-482731');
    await page.click('#pm-code-gen-btn');
    await page.waitForFunction(() => document.querySelector('#pm-code')?.value === 'BLA-DAR-KNI-916405');
    assert.deepEqual(skuRequests, ['', 'BLA-DAR-KNI-482731']);
    await page.$eval('#pm-name', node => { node.value = 'Blanket Linen Knitted'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await page.$eval('#pm-code', node => node.value), '', 'changing the name invalidates the earlier suggestion');
    assert.deepEqual(errors, []);
    console.log('Compact product specifications browser check passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
