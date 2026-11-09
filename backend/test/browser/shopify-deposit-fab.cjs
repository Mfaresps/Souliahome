/* One Shopify deposit trigger routes to the existing deposit or shipping action. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
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
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'image/webp';
        return request.respond({ status: 200, contentType: type, body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: '' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentUser = { _id: 'staff-1', role: 'staff', perms: ['shopify-orders', 'shopify-deposit-upload'] };
      currentLang = 'ar';
      qs('#login-page').style.display = 'none';
      qs('#app').style.display = '';
      qs('#splash-screen')?.remove();
      window.fabActions = [];
      openSpReceiptForm = id => fabActions.push(['deposit', id]);
      _spToggleShipWithoutDeposit = id => fabActions.push(['shipping', id]);
      const order = { _id: 'order-1', status: 'pending', cancelled: false, depositReceipts: [], shipWithoutDeposit: false };
      document.body.insertAdjacentHTML('beforeend', `<div id="fab-fixture" style="position:fixed;z-index:2000;inset:24px auto auto 24px;width:240px;padding:18px;background:var(--surface)">${_spDepositCellHtml(order)}</div>`);
    });
    const trigger = '#fab-fixture .spdep-fab-trigger';
    assert.equal(await page.$eval(trigger, el => el.textContent.trim()), '', 'trigger is plus only');
    assert.equal(await page.$eval(trigger, el => el.querySelectorAll('svg').length), 1);
    assert.equal(await page.$eval(trigger, el => el.getAttribute('aria-expanded')), 'false');
    const normalStyle = await page.$eval(trigger, el => ({
      fill: getComputedStyle(el, '::before').backgroundColor,
      color: getComputedStyle(el).color,
    }));
    assert.equal(normalStyle.fill, 'rgb(255, 255, 255)', 'plus button has a plain white face');
    const channels = normalStyle.color.match(/\d+/g)?.map(Number) || [];
    assert.ok(channels.length === 3 && channels[1] > channels[0] && channels[1] > channels[2], 'plus icon is green');
    await page.hover(trigger);
    await new Promise(resolve => setTimeout(resolve, 280));
    const hoverFill = await page.$eval(trigger, el => getComputedStyle(el, '::before').backgroundColor);
    assert.notEqual(hoverFill, normalStyle.fill, 'hover adds a soft tint');
    await page.click(trigger);
    assert.equal(await page.$eval(trigger, el => el.getAttribute('aria-expanded')), 'true');
    assert.equal(await page.$$eval('#spdep-fab-menu [role="menuitem"]', els => els.length), 2);
    assert.equal(await page.$$eval('#spdep-fab-menu svg', els => els.length), 2, 'both options have icons');
    assert.deepEqual(await page.$$eval('#spdep-fab-menu [role="menuitem"]', els => els.map(el => el.textContent.trim())), ['إضافة عربون', 'شحن بدون عربون']);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.$eval('#spdep-fab-menu [data-action="shipping"]', el => document.activeElement === el), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.$('#spdep-fab-menu'), null);
    assert.equal(await page.$eval(trigger, el => document.activeElement === el && el.getAttribute('aria-expanded') === 'false'), true);

    await page.click(trigger);
    await page.click('#spdep-fab-menu [data-action="deposit"]');
    assert.deepEqual(await page.evaluate(() => fabActions), [['deposit', 'order-1']]);
    assert.equal(await page.$('#spdep-fab-menu'), null);
    await page.setViewport({ width: 390, height: 844 });
    await page.click(trigger);
    await page.click('#spdep-fab-menu [data-action="shipping"]');
    assert.deepEqual(await page.evaluate(() => fabActions), [['deposit', 'order-1'], ['shipping', 'order-1']]);
    await page.click(trigger);
    await page.click('body');
    assert.equal(await page.$('#spdep-fab-menu'), null, 'outside click closes menu');
    // A live update (another employee's action, a Shopify webhook, a socket event) redraws the
    // table and replaces the plus button. The open menu must follow the new button, not vanish.
    await page.click(trigger);
    await page.evaluate(() => {
      const order = { _id: 'order-1', status: 'pending', cancelled: false, depositReceipts: [], shipWithoutDeposit: false };
      qs('#fab-fixture').innerHTML = _spDepositCellHtml(order);
    });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.ok(await page.$('#spdep-fab-menu'), 'menu survives a table redraw');
    assert.equal(await page.$eval(trigger, el => el.getAttribute('aria-expanded')), 'true', 'the redrawn button is marked open');
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    assert.ok(await page.$('#spdep-fab-menu'), 'a resize (mobile address bar) repositions instead of closing');
    await page.click('#spdep-fab-menu [data-action="deposit"]');
    assert.deepEqual((await page.evaluate(() => fabActions)).at(-1), ['deposit', 'order-1'], 'the option still reaches its order');
    await page.click(trigger);
    await page.evaluate(() => { qs('#fab-fixture').innerHTML = ''; });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(await page.$('#spdep-fab-menu'), null, 'closes when the order leaves the table');
    await page.evaluate(() => {
      const order = { _id: 'order-1', status: 'pending', cancelled: false, depositReceipts: [], shipWithoutDeposit: false };
      qs('#fab-fixture').innerHTML = _spDepositCellHtml(order);
    });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.click(trigger);
    assert.equal(await page.$eval('#spdep-fab-menu .spdep-fab-item', el => parseFloat(getComputedStyle(el).transitionDuration) < .001), true);
    assert.deepEqual(errors, []);
    console.log('shopify deposit FAB: passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
