const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';

async function open(browser, route, role = 'admin') {
  const page = await browser.newPage();
  const errors = [];
  let fragmentReads = 0;
  let integrationScriptReads = 0;
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.evaluateOnNewDocument(userRole => {
    localStorage.setItem('token', 'lazy-settings-test');
    localStorage.setItem('user', JSON.stringify({ name: 'Test', role: userRole,
      perms: userRole === 'admin' ? [] : ['dashboard'] }));
  }, role);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/fragments/settings.html') { fragmentReads++; return request.continue(); }
    if (pathname === '/shopify-settings.js') { integrationScriptReads++; return request.continue(); }
    if (!pathname.startsWith('/api/')) return request.continue();
    let body = '[]';
    if (pathname === '/api/auth/me') body = JSON.stringify({ name: 'Test', role,
      perms: role === 'admin' ? [] : ['dashboard'] });
    if (pathname === '/api/settings' || pathname === '/api/transactions/dashboard') body = '{}';
    if (pathname === '/api/transactions/startup-overview') body = JSON.stringify({ rows: [], activeCount: 0 });
    if (pathname === '/api/warehouse-layout') body = JSON.stringify({ warehouses: [], locations: [], labelSizes: [] });
    if (pathname === '/api/notifications') body = JSON.stringify({ language: 'ar',
      preferences: { enabled: false }, devices: 0, allowedTypes: [], configured: false });
    return request.respond({ status: 200, contentType: 'application/json', body });
  });
  await page.goto(origin + route, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return { page, errors, fragmentReads: () => fragmentReads,
    integrationScriptReads: () => integrationScriptReads };
}

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const first = await open(browser, '/');
    await first.page.waitForFunction(() => currentPage === 'dashboard' && window.souliaPushAppReady);
    assert.equal(first.fragmentReads(), 0, 'Dashboard must not download Settings markup');
    assert.equal(first.integrationScriptReads(), 0, 'Dashboard must not download Settings integration code');
    assert.equal(await first.page.$('#page-settings .settings-page-inner'), null,
      'Settings content must not be mounted on Dashboard');
    assert.equal(await first.page.$$eval('#notification-settings', elements => elements.length), 1,
      'push settings remain available from the header');
    await first.page.evaluate(() => navigateTo('settings'));
    await first.page.waitForFunction(() => currentPage === 'settings'
      && !!document.querySelector('#page-settings .settings-page-inner'));
    assert.equal(first.fragmentReads(), 1, 'Settings markup loads once on first visit');
    assert.equal(first.integrationScriptReads(), 1, 'Settings integration code loads once on first visit');
    assert.equal(await first.page.evaluate(() => typeof renderShopifySettings), 'function');
    await first.page.evaluate(() => { currentLang = 'en'; applyLang(); });
    assert.match(await first.page.$eval('#page-settings .page-title', el => el.textContent), /Settings/i);
    await first.page.evaluate(() => stgOpenInnerPage('notifications', document.querySelector('[data-inner-tab="notifications"]')));
    await first.page.waitForFunction(() => !!document.querySelector('#notification-settings .push-heading'));
    assert.equal(await first.page.$eval('#notification-settings', el => el.getClientRects().length > 0), true,
      'Notification preferences must be visible inside lazy Settings');
    await first.page.evaluate(() => window.souliaOpenPushSettings());
    await first.page.waitForFunction(() => document.querySelector('.push-settings-dialog[open]'));
    await first.page.evaluate(() => document.querySelector('.push-settings-dialog[open]').close());
    await first.page.waitForFunction(() => document.querySelector('#notification-settings-slot #notification-settings'));
    await first.page.evaluate(() => { navigateTo('dashboard'); navigateTo('settings'); });
    await first.page.waitForFunction(() => currentPage === 'settings');
    assert.equal(first.fragmentReads(), 1, 'return visit reuses mounted Settings markup');
    assert.equal(first.integrationScriptReads(), 1, 'return visit reuses Settings integration code');
    assert.deepEqual(first.errors, [], 'Settings navigation must not throw');
    await first.page.close();

    const direct = await open(browser, '/#settings');
    await direct.page.waitForFunction(() => currentPage === 'settings'
      && !!document.querySelector('#page-settings .settings-page-inner'));
    assert.equal(direct.fragmentReads(), 1, 'direct Settings route loads its markup');
    assert.equal(direct.integrationScriptReads(), 1, 'direct Settings route loads its integration code');
    assert.deepEqual(direct.errors, [], 'direct Settings route must not throw');
    await direct.page.close();

    const denied = await open(browser, '/#settings', 'staff');
    await denied.page.waitForFunction(() => currentPage === 'dashboard' && window.souliaPushAppReady);
    await denied.page.evaluate(() => navigateTo('settings'));
    assert.equal(denied.fragmentReads(), 0, 'denied navigation must not download Settings markup');
    assert.equal(denied.integrationScriptReads(), 0, 'denied navigation must not download integration code');
    assert.equal(await denied.page.evaluate(() => currentPage), 'dashboard');
    await denied.page.close();
    console.log('PASS: lazy Settings, direct route, translation, push dialog, return visit, and permissions.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
