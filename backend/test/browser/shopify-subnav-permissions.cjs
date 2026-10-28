/* Exercise the shipped menu and its mobile portal with real styles and handlers.
 * All data/render operations are stubbed; no account or order is modified.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = html.indexOf('<details id="sp-subnav-shell"');
const menu = html.slice(start, html.indexOf('</details>', start) + '</details>'.length);
const functions = html.slice(html.indexOf('function _spVisibleSubnavTabs()'), html.indexOf('function _perfAvatarHtml('));
const restricted = ['deposits', 'deposit-log', 'perf'];

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => request.respond({ status: 200, contentType: 'text/html', body: '<html><body></body></html>' }));
    await page.goto('http://shopify-menu.test/');
    await page.setContent(`<div id="page-shopify-orders"><div id="shopify-page-header">${menu}</div>${['sp-orders-tab-content', 'sp-deposits-tab-content', 'sp-deposit-log-content', 'sp-perf-dashboard-content', 'shopify-filters-bar'].map(id => `<div id="${id}"></div>`).join('')}</div>`);
    await page.addStyleTag({ content: html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1] });
    for (const file of ['shopify-tabs.css', 'shopify-responsive.css', 'shopify-compact-header.css', 'interface-motion.css']) {
      await page.addStyleTag({ path: path.join(root, file) });
    }
    await page.addScriptTag({ content: `
      window.qs=s=>document.querySelector(s); window.currentUser={role:'staff',perms:[]};
      window.isAdmin=()=>currentUser?.role==='admin'; window.t=key=>key;
      window.calls=[]; window.renderPerformanceDashboard=()=>calls.push('perf');
      window.renderSpDepositReview=()=>calls.push('deposits');
      window.renderSpDepositHistory=()=>calls.push('deposit-log');
      window._depLogUrl=()=>'#shopify-orders/deposits/log';
      ${functions}
      _initShopifySubnav();
    ` });
    await page.addScriptTag({ path: path.join(root, 'shopify-compact-header.js') });
    for (const width of [1440, 390]) {
      await page.setViewport({ width, height: 844 });
      for (const dir of ['ltr', 'rtl']) {
        for (const role of ['staff', 'admin', 'viewer', 'admin', 'staff']) {
          await page.evaluate(({ role, dir }) => {
            currentUser = { role, perms: [] };
            document.documentElement.dir = dir;
            switchShopifySubnav('orders', true);
            _initShopifySubnav();
            calls.length = 0;
          }, { role, dir });
          await page.click('#sp-subnav-shell > summary');
          await page.waitForFunction(mobile => qs('#sp-subnav-shell').open && qs('#sp-subnav').classList.contains('sp-subnav-portal') === mobile, {}, width < 768);
          const visible = await page.$$eval('#sp-subnav [role="tab"]', tabs => tabs.filter(tab => getComputedStyle(tab).display !== 'none').map(tab => tab.id));
          assert.deepEqual(visible, ['sp-subnav-orders', ...(role === 'admin' ? restricted.map(tab => 'sp-subnav-' + tab) : [])], `${role} ${width} ${dir}: visible menu sections`);
          await page.focus('#sp-subnav-orders');
          await page.keyboard.press('End');
          assert.equal(await page.evaluate(() => document.activeElement.id), role === 'admin' ? 'sp-subnav-perf' : 'sp-subnav-orders');
          const result = await page.evaluate(tabs => {
            for (const tab of tabs) switchShopifySubnav(tab, true);
            return { calls: [...calls], tab: _spSubnavTab };
          }, restricted);
          assert.deepEqual(result.calls, role === 'admin' ? restricted : [], 'Restricted handlers do not load data');
          assert.equal(result.tab, role === 'admin' ? 'perf' : 'orders');
          await page.evaluate(() => { qs('#sp-subnav-shell').open = false; });
          await page.waitForFunction(() => !qs('#sp-subnav').classList.contains('sp-subnav-portal'));
        }
      }
    }
    assert.deepEqual(errors, []);
    console.log('PASS: admin/staff/viewer menu permissions, direct handlers, role changes, keyboard, desktop/mobile portal and RTL/LTR.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
