const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = html.indexOf('<div class="sp-subnav-shell"');
const end = html.indexOf('<!-- Search + Filters', start);
const functions = html.slice(html.indexOf('function _spVisibleSubnavTabs()'), html.indexOf('function _perfAvatarHtml('));
const css = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1];
(async () => {
  const browser = await puppeteer.launch({headless: true});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => request.respond({status: 200, contentType: 'text/html', body: '<html><head></head><body></body></html>'}));
    await page.goto('http://shopify-tabs.test/');
    await page.setContent('<style>:root{--accent:#2c7a50;--border:#d5e3dc;--surface:#f7faf8;--text:#12352b;--text-muted:#68877b}body{margin:10px}</style><div id="page-shopify-orders">' + html.slice(start, end) + ['sp-orders-tab-content', 'sp-deposits-tab-content', 'sp-deposit-log-content', 'sp-perf-dashboard-content', 'shopify-filters-bar'].map(id => '<div id="' + id + '"></div>').join('') + '</div>');
    await page.addStyleTag({content: css});
    await page.addStyleTag({path: path.join(root, 'shopify-tabs.css')});
    await page.addScriptTag({content: 'window.qs=s=>document.querySelector(s); window.admin=true;window.isAdmin=()=>admin;window.renderPerformanceDashboard=()=>{};window.renderSpDepositReview=()=>{};window.renderSpDepositHistory=()=>{};window._depLogUrl=()=>"#shopify-orders/deposit-log";' + functions + ';_initShopifySubnav();'});
    for (const dir of ['ltr', 'rtl']) {
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewport({width, height: 800});
        await page.evaluate(dir => {document.documentElement.dir = dir; _initShopifySubnav(); switchShopifySubnav('orders', true);}, dir);
        await page.click('#sp-subnav-orders');
        await page.keyboard.press(dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'sp-subnav-deposits');
        assert.equal(await page.$eval('#sp-subnav-orders', el => el.getAttribute('aria-selected')), 'true', 'arrows move focus without loading another tab');
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => location.hash), '#shopify-orders/deposits');
        assert.equal(await page.$eval('#sp-subnav-deposits', el => el.getAttribute('aria-selected')), 'true');
        await page.evaluate(() => _spStepSubnav(1));
        assert.equal(await page.evaluate(() => location.hash), '#shopify-orders/deposit-log');
        await page.keyboard.press('End');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'sp-subnav-perf');
        await page.keyboard.press('Enter');
        await new Promise(resolve => setTimeout(resolve, 400));
        assert.equal(await page.$eval('#sp-tab-next', el => el.disabled), true);
        assert.ok(await page.$eval('#sp-subnav-perf', el => {const a=el.getBoundingClientRect(), b=el.parentElement.getBoundingClientRect();return a.left >= b.left - 1 && a.right <= b.right + 1;}), 'selected tab visible at ' + width + ' ' + dir);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no page overflow');
        if (width === 390 && dir === 'rtl') await page.screenshot({path: 'artifacts/shopify-tabs-mobile.png'});
      }
    }
    await page.evaluate(() => {admin = false; switchShopifySubnav('orders', true); _initShopifySubnav(); switchShopifySubnav('perf');});
    assert.equal(await page.$eval('#sp-subnav-orders', el => el.getAttribute('aria-selected')), 'true');
    assert.equal(await page.evaluate(() => _spVisibleSubnavTabs().length), 1);
    assert.equal(await page.$eval('#sp-tab-next', el => el.disabled), true);
    assert.deepEqual(errors, []);
    console.log('PASS Shopify tabs: keyboard, selection, routes, arrow boundaries, admin permissions, RTL/LTR and four viewport widths.');
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode = 1;});
