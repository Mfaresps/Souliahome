const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

// Run against the local frontend on :8080. API replies are controlled so a slow
// secondary collection cannot accidentally become a first-paint dependency.
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('token', 'startup-fast-path-test');
      localStorage.setItem('user', JSON.stringify({ name: 'Test', role: 'admin', perms: [] }));
    });
    await page.setRequestInterception(true);
    let suppliersFinished = false;
    let productsRequested = false;
    let supplierRequest = null;
    let dashboardRequests = 0;
    let inventoryRequests = 0;
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return request.continue();
      if (pathname === '/api/transactions/dashboard') dashboardRequests++;
      if (pathname === '/api/transactions/inventory') inventoryRequests++;
      if (pathname === '/api/products') {
        productsRequested = true;
        return; // Keep an unrelated collection pending for the whole assertion window.
      }
      if (pathname === '/api/suppliers') {
        supplierRequest = request;
        return;
      }
      let body = '[]';
      if (pathname === '/api/auth/me') body = JSON.stringify({ name: 'Test', role: 'admin', perms: [] });
      if (pathname === '/api/settings' || pathname === '/api/transactions/dashboard') body = '{}';
      const respond = () => request.respond({ status: 200, contentType: 'application/json', body });
      respond();
    });

    await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.querySelector('#app')?.style.display === 'block'
      && !document.querySelector('#splash-screen'), { timeout: 10000 });
    assert.equal(suppliersFinished, false, 'first paint must not await suppliers');
    assert.equal(productsRequested, true, 'the unrelated collection request is in flight');
    await page.evaluate(() => navigateTo('suppliers'));
    assert.equal(await page.evaluate(() => currentPage), 'dashboard', 'secondary route waits for its data');
    await page.waitForSelector('#header-loadbar.active', { timeout: 1000 });
    assert.ok(supplierRequest, 'supplier request is in flight');
    await supplierRequest.respond({ status: 200, contentType: 'application/json', body: '[]' });
    suppliersFinished = true;
    await page.waitForFunction(() => currentPage === 'suppliers', { timeout: 10000 });
    assert.equal(suppliersFinished, true);
    assert.equal(await page.evaluate(() => !!window._startupBackgroundReady), true,
      'suppliers route must not wait for unrelated products');
    await page.evaluate(() => navigateTo('categories'));
    assert.equal(await page.evaluate(() => currentPage), 'categories', 'self-loading pages open immediately');
    await page.evaluate(() => navigateTo('inventory'));
    await page.waitForFunction(() => currentPage === 'inventory' && _inventoryHasLoaded, { timeout: 3000 });
    assert.equal(inventoryRequests, 1, 'inventory page reuses the startup request');
    assert.equal(dashboardRequests, 1, 'dashboard boot reuses its prefetched request');
    assert.deepEqual(errors, []);
    console.log('PASS: dashboard paints early and navigation waits only for its own data.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
