/* Review the shipped order cards, proposal dialog and approvals in Chromium.
 * All network traffic is intercepted; no live order or approval is changed.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const publicDir = path.join(root, 'frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const output = path.join(root, 'artifacts/edit-review');
const settle = () => new Promise(resolve => setTimeout(resolve, 350));
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: html });
      if (['/shopify-edit-approvals.js', '/shopify-edit-approvals.css', '/shopify-responsive.css', '/approvals.css'].includes(url.pathname)) {
        const file = path.join(publicDir, url.pathname.slice(1));
        if (fs.existsSync(file)) return request.respond({ status: 200, contentType: file.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentLang = 'ar'; document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl';
      currentUser = { _id: 'staff-1', name: 'Employee', role: 'staff', perms: ['shopify-orders', 'movements'] };
      qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      onPageEnter = () => {};
      window.liveWrites = [];
      api = async (url, options = {}) => { if (options.method && options.method !== 'GET') liveWrites.push(url); return []; };
      window.originalOrder = { _id: 'order-1', ref: '2913', client: 'Lobna Abdelaziz', phone: '01000000000',
        shopifyId: 's1', status: 'pending', createdAt: '2026-10-22T09:52:00Z', assignedToName: 'Employee',
        items: [{ productId: 'p1', name: 'Oriva Dining Set (15 pieces)', qty: 1, price: 2180 }],
        total: 2180, itemsTotal: 2180, shipCost: 0, discount: 0, manualDiscount: 0, codesDiscount: 0, depositReceipts: [] };
      window.proposal = { items: [{ productId: 'p1', name: 'Oriva Dining Set (15 pieces)', qty: 2, price: 2000 },
        { productId: 'p2', name: 'Geo Basket', qty: 1, price: 500 }] };
      const patch = _spEditProposalPatch(originalOrder, proposal);
      _shopifyOrders = [{ ...originalOrder, editRequest: { id: 'r1', status: 'معلق', requestedBy: 'Employee',
        requestedById: 'staff-1', requestedAt: '2026-10-24T09:00:00Z', before: originalOrder, patch,
        changes: _spEditProposalChanges(originalOrder, proposal) } }];
      _shopifyTab = 'pending'; _shopifyStatusFilter = ''; _shopifyDateFilter = {}; _spOrdersLoaded = true;
      navigateTo('shopify-orders');
    });
    for (const width of [390, 1920]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1080 });
      await page.evaluate(() => renderShopifyOrders());
      const selector = width === 390 ? '#sp-mobile-list .sp-edit-status' : '#shopify-orders-table-body .sp-edit-status';
      await page.waitForSelector(selector, { visible: true });
      await settle();
      assert.match(await page.$eval(selector, el => el.textContent), /في انتظار الموافقة على التعديل/);
      await page.screenshot({ path: path.join(output, `staff-orders-${width}.png`) });
      await page.click(selector);
      await page.waitForSelector('#modal-overlay.shopify-edit-review.active');
      await settle();
      assert.equal(await page.$$eval('#modal-content .appr-actions button', buttons => buttons.length), 0);
      await page.evaluate(() => closeModal());
      await page.evaluate(() => { window.proposalResult = _spConfirmEditSubmission(originalOrder, proposal); });
      await page.waitForSelector('.edit-proposal-dialog');
      await settle();
      const preview = await page.$eval('.edit-proposal-dialog', el => ({
        text: el.textContent, products: el.querySelectorAll('.edit-diff-product').length,
        overflow: el.scrollWidth > el.clientWidth + 1,
      }));
      assert.equal(preview.products, 2);
      assert.equal(preview.overflow, false);
      assert.match(preview.text, /قبل التعديل/); assert.match(preview.text, /بعد التعديل/);
      assert.match(preview.text, /EGP 4,500/); assert.equal(preview.text.includes('<span'), false);
      await page.screenshot({ path: path.join(output, `staff-proposal-${width}.png`) });
      await page.click('[data-back]');
      assert.equal(await page.evaluate(() => proposalResult), false);
      await page.evaluate(() => {
        currentUser = { _id: 'admin-1', role: 'admin', perms: [] };
        renderShopifyOrders(); openShopifyEditReview('order-1');
      });
      await settle();
      const review = await page.$eval('#modal-content', el => ({ text: el.textContent,
        overflow: el.scrollWidth > el.clientWidth + 1, actions: el.querySelectorAll('.appr-actions button').length }));
      assert.match(review.text, /طلب تعديل يحتاج موافقة/);
      assert.equal(review.actions, 2); assert.equal(review.overflow, false);
      await page.screenshot({ path: path.join(output, `admin-review-${width}.png`) });
      await page.evaluate(() => {
        closeModal(); navigateTo('approvals'); _apprOpenRows.add('shopify-edit:order-1'); renderApprovals();
      });
      await settle();
      assert.equal(await page.$$eval('#appr-tbody .edit-diff-product', items => items.length), 2);
      await page.screenshot({ path: path.join(output, `admin-approvals-${width}.png`) });
      await page.evaluate(() => {
        currentUser = { _id: 'staff-1', role: 'staff', perms: ['shopify-orders', 'movements'] }; navigateTo('shopify-orders');
      });
    }
    assert.equal(await page.evaluate(() => originalOrder.total), 2180);
    assert.deepEqual(await page.evaluate(() => liveWrites), []);
    console.log('PASS: visible staff/admin statuses, real mobile cards and desktop table, proposal cancel, product/price/quantity comparisons, approval page, no markup leakage or horizontal overflow. Screenshots: artifacts/edit-review.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
