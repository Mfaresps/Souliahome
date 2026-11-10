const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

// Every API is intercepted; no order or financial data is written.
const user = { _id: 'receipt-stability', name: 'Review', role: 'admin', perms: [] };
const approved = { _id: 'stable-order', ref: '3080', client: 'Receipt Customer', phone: '01000812575',
  status: 'pending', total: 770, shopifyCreatedAt: '2026-11-07', items: [], comments: [],
  depositReceipts: [{ id: 'stable-receipt', status: 'معتمد', amount: 323, method: 'Instapay',
    vaultEntryId: 'entry-1', vaultTxNo: 'SAL-1221', noImage: true, noImageAuth: 'otp',
    submittedBy: 'Review', submittedAt: '2026-11-07T09:08:00Z' }] };
const summary = { ...approved, depositReceipts: undefined };

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage(), errors = [], held = [];
    const waitForHeld = async count => {
      const deadline = Date.now() + 10000;
      while (held.length < count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(held.length, count, 'expected held detail requests');
    };
    let holdDetails = false, serverOrder = structuredClone(approved), detailReads = 0;
    page.on('pageerror', error => errors.push(error.message));
    await page.evaluateOnNewDocument(user => {
      localStorage.setItem('token', 'receipt-stability-fixture');
      localStorage.setItem('user', JSON.stringify(user));
      localStorage.setItem('soulia_lang_pref', 'en');
      localStorage.setItem('soulia-push-prompt:' + user._id, 'dismissed');
    }, user);
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      let body = [];
      if (url.pathname === '/api/auth/me') body = user;
      if (url.pathname === '/api/settings') body = {};
      if (url.pathname === '/api/notifications' || url.pathname === '/api/notifications/preferences')
        body = { preferences: { enabled: false }, language: 'en', subscriptions: [] };
      if (url.pathname === '/api/transactions/startup-overview') body = { rows: [], activeCount: 0 };
      if (url.pathname === '/api/clients/order-profile') body = null;
      if (url.pathname === '/api/shopify/orders/summary-page') body = {
        rows: [summary], page: 1, limit: 30, total: 1, allCount: 1, pendingCount: 1,
        tabCount: 1, filterCounts: {}, baseCount: 1, starredCount: 0, filteredIds: [approved._id],
        selectionRows: [], depositSummary: {}, panelFacets: { status: {}, staff: {}, tags: {}, comments: 0, stock: {} },
      };
      if (url.pathname === '/api/shopify/orders/detail/' + approved._id) {
        detailReads++;
        body = structuredClone(serverOrder);
        if (holdDetails) {
          held.push(() => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
          return;
        }
      }
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto('http://127.0.0.1:8080/#shopify-orders', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#splash-screen') && typeof openSpOrderPeek === 'function');
    await page.evaluate(async approved => {
      _shopifyOrders = [approved]; _spFullOrderCache.set(approved._id, approved);
      await openSpOrderPeek(approved._id); await document.fonts.ready;
    }, approved);
    await page.waitForSelector('#sp-peek.is-open .spdep-status-approved');
    await page.click('#sp-peek .spdep-peek-details>summary');
    await page.evaluate(() => {
      window.__receipt = document.querySelector('#sp-peek .spdep-peek-row');
      window.__refund = __receipt.querySelector('[onclick*="refund"]');
      __refund.focus();
      for (let i = 0; i < 8; i++) _spPeekRender();
      _spOrderById('stable-order').comments.push({ text: 'An unrelated comment', createdAt: new Date().toISOString() });
      _spPeekRender();
    });
    assert.deepEqual(await page.evaluate(() => ({
      sameReceipt: __receipt === document.querySelector('#sp-peek .spdep-peek-row'),
      sameRefund: __refund === document.querySelector('#sp-peek [onclick*="refund"]'),
      focus: document.activeElement === __refund,
      details: __receipt.querySelector('details').open,
      status: __receipt.querySelector('.spdep-status').textContent,
      refund: __refund.textContent.trim(),
    })), { sameReceipt: true, sameRefund: true, focus: true, details: true, status: 'Approved', refund: 'Refund deposit' });

    // A live summary arrives before its full detail: the approved receipt stays visible.
    holdDetails = true;
    await page.evaluate(() => { window.__refresh = loadShopifyOrders(); });
    await page.waitForFunction(() => _spDetailRequests.has('stable-order'));
    await waitForHeld(1);
    await page.evaluate(() => { _spPeekRender(); _spRefreshReceiptViews(); });
    assert.equal(await page.$eval('#sp-peek .spdep-status', el => el.textContent), 'Approved');
    assert.equal(await page.$eval('#sp-peek [onclick*="refund"]', el => el.textContent.trim()), 'Refund deposit');
    assert.equal(await page.evaluate(() => __refund === document.querySelector('#sp-peek [onclick*="refund"]')), true);
    await held.shift()();
    await page.waitForFunction(() => !_spDetailRequests.has('stable-order'));
    assert.equal(await page.$eval('#sp-peek .spdep-peek-details', el => el.open), true);

    // Reproduce a pending detail GET arriving after a successful approval.
    serverOrder = structuredClone(approved);
    Object.assign(serverOrder.depositReceipts[0], { status: 'معلق', vaultEntryId: '', vaultTxNo: '' });
    await page.evaluate(order => {
      _spFullOrderCache.set(order._id, order); _spPeekRender();
      _spInvalidateOrderDetails(); window.__read = _spEnsureFullOrder(order._id);
    }, serverOrder);
    await page.waitForFunction(() => _spDetailRequests.has('stable-order'));
    await waitForHeld(1);
    await page.evaluate(() => _spApplyApprovedReceipt('stable-order', 'stable-receipt', { vaultEntryId: 'entry-1', vaultTxNo: 'SAL-1221' }));
    assert.equal(await page.$eval('#sp-peek .spdep-status', el => el.textContent), 'Approved');
    await held.shift()();
    await page.evaluate(async () => { await __read; _spPeekRender(); });
    assert.equal(await page.$eval('#sp-peek .spdep-status', el => el.textContent), 'Approved', 'older pending data cannot undo approval');
    assert.ok(await page.$('#sp-peek [onclick*="refund"]'));

    // A superseded request must not remove the newer request's deduplication entry.
    await page.evaluate(() => { _spInvalidateOrderDetails(); window.__oldRead = _spEnsureFullOrder('stable-order'); });
    await page.waitForFunction(() => _spDetailRequests.has('stable-order'));
    await waitForHeld(1);
    await page.evaluate(() => { _spInvalidateOrderDetails(); window.__newRead = _spEnsureFullOrder('stable-order'); });
    await waitForHeld(2);
    await held.shift()();
    await page.evaluate(async () => { await __oldRead; });
    const beforeReads = detailReads;
    assert.equal(await page.evaluate(() => _spEnsureFullOrder('stable-order') === __newRead), true);
    assert.equal(detailReads, beforeReads, 'one detail request per active generation');
    await held.shift()();
    await page.evaluate(async () => { await __newRead; });

    // A genuine newer refund must still replace the approval and remove its action.
    holdDetails = false;
    serverOrder = structuredClone(approved);
    Object.assign(serverOrder.depositReceipts[0], { status: 'مُسترد', refundVaultEntryId: 'refund-entry', refundReason: 'Customer request' });
    await page.evaluate(async () => {
      _spInvalidateOrderDetails(); await _spEnsureFullOrder('stable-order'); _spPeekRender();
    });
    assert.equal(await page.$eval('#sp-peek .spdep-status', el => el.textContent), 'Refunded');
    assert.equal(await page.$('#sp-peek [onclick*="refund"]'), null);
    assert.equal(await page.$eval('#sp-peek .spdep-peek-row', el => el.textContent.includes('Customer request')), true);

    // Language changes remain intentional; the compact SVG fits both directions.
    for (const [lang, width] of [['en', 1440], ['ar', 390]]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(({ order, lang }) => {
        _spFullOrderCache.set(order._id, order); currentLang = lang;
        document.documentElement.dir = document.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.querySelector('#sp-peek').dir = document.dir; _spPeekRender();
      }, { order: approved, lang });
      const view = await page.$eval('#sp-peek .spdep-peek-row', row => {
        const button = row.querySelector('[onclick*="refund"]'), icon = button.querySelector('svg');
        return { status: row.querySelector('.spdep-status').textContent, label: button.textContent.trim(),
          iconWidth: icon.getBoundingClientRect().width, iconHidden: icon.getAttribute('aria-hidden'),
          overflow: row.scrollWidth > row.clientWidth + 1 };
      });
      assert.equal(view.status, lang === 'en' ? 'Approved' : 'معتمد');
      assert.equal(view.label, lang === 'en' ? 'Refund deposit' : 'رد العربون');
      assert.equal(view.iconHidden, 'true'); assert.equal(view.iconWidth, 15); assert.equal(view.overflow, false);
      const out = path.resolve(__dirname, '../../../artifacts/clients-profile');
      fs.mkdirSync(out, { recursive: true });
      await page.screenshot({ path: path.join(out, `stable-receipt-${lang}-${width}.png`) });
    }
    assert.deepEqual(errors, []);
    console.log('Shopify receipt stability: passed (live refresh, stale approval response, request races, real refund, Arabic/English).');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
