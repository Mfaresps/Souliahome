const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const out = path.resolve(__dirname, '../../../artifacts/transaction-route-return');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    for (const [width, lang] of [[1440, 'en'], [390, 'ar']]) {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setViewport({ width, height: 950 });
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep)
            && fs.existsSync(file) && fs.statSync(file).isFile())
          return request.respond({ status: 200, contentType: file.endsWith('.html') ? 'text/html'
            : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
        return request.respond({ status: 200, contentType: request.resourceType() === 'script'
          ? 'text/javascript' : 'application/json', body: request.resourceType() === 'script' ? '' : '[]' });
      });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      await page.evaluate(lang => {
        currentUser = { _id: 'tx-route-test', role: 'admin', perms: [] };
        localStorage.setItem('token', 'tx-route-test'); sessionStorage.removeItem('_txPageSnap');
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
        window._startupResourceReady = null; _transactionSummariesComplete = true;
        products = [{ _id: 'p1', code: 'P1', name: 'Test product', price: 100 }];
        inventoryCache = [{ _id: 'p1', code: 'P1', name: 'Test product', current: 10 }];
        suppliers = []; settings = {}; window.notices = []; toast = message => notices.push(message);
        const enter = onPageEnter;
        onPageEnter = page => {
          if (page === 'transaction') return enter(page);
          if (page === 'movements') _transactionSummariesComplete = false;
        };
        window.reads = []; window.held = {};
        api = (url, options = {}) => {
          reads.push(url);
          if (url.startsWith('/transactions/summary-page') || ['/products', '/suppliers', '/transactions/inventory'].includes(url))
            return new Promise((resolve, reject) => held[url] = { resolve, reject });
          return Promise.resolve([]);
        };
        window.timeOffset = 0; const now = Date.now;
        Date.now = () => now() + timeOffset;
        navigateTo('transaction');
      }, lang);
      await page.waitForSelector('#tx-client');
      await page.evaluate(() => {
        qs('#tx-client').value = 'Retained customer'; qs('#tx-ref').value = '7000';
        qs('#tx-phone').value = '01000000000';
        qs('#tx-inv-note').value = 'Retained invoice note';
        txItems = [{ productId: 'p1', code: 'P1', name: 'Test product', qty: 2, price: 100, total: 200 }];
        txComments = [{ id: 1, text: 'Retained comment', employee: 'Test', type: 'comment', timestamp: new Date().toISOString() }];
        renderTxComments();
        renderTxItems(); calcTxSummary();
        // Model an already saved draft: leaving requires no unsaved-work decision.
        activeDraftId = 'saved-draft'; txDirty = false;
        window.clientInput = qs('#tx-client'); window.itemsHost = qs('#tx-items').firstElementChild;
        window.savedType = txType;
        window.scrollTo(0, 250); window.savedScroll = scrollY;
        navigateTo('movements'); window.scrollTo(0, 0); navigateTo('transaction');
      });
      assert.equal(await page.evaluate(() => currentPage), 'transaction', 'return does not wait for all transaction history');
      assert.equal(await page.evaluate(() => reads.some(url => url.startsWith('/transactions/summary-page'))), false);
      assert.equal(await page.$eval('#tx-inv-note', el => el.value), 'Retained invoice note');
      assert.equal(await page.evaluate(() => txComments[0]?.text), 'Retained comment');
      assert.equal(await page.evaluate(() => clientInput === qs('#tx-client') && itemsHost === qs('#tx-items').firstElementChild), true,
        'return keeps the form and item nodes');
      assert.deepEqual(await page.evaluate(() => ({ client: qs('#tx-client').value, ref: qs('#tx-ref').value,
        phone: qs('#tx-phone').value, items: txItems.length, qty: txItems[0].qty, draft: activeDraftId, type: txType })),
        { client: 'Retained customer', ref: '7000', phone: '01000000000', items: 1, qty: 2, draft: 'saved-draft', type: 'مبيعات' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => scrollY), await page.evaluate(() => savedScroll));
      assert.equal(await page.evaluate(() => reads.filter(url => ['/products', '/suppliers', '/transactions/inventory'].includes(url)).length), 0,
        'a recent form does not refetch its reference data');
      await page.evaluate(() => { timeOffset += 31000; navigateTo('movements'); navigateTo('transaction'); });
      for (const url of ['/products', '/suppliers', '/transactions/inventory'])
        assert.equal(await page.evaluate(url => reads.filter(read => read === url).length, url), 1);
      assert.equal(await page.evaluate(() => clientInput === qs('#tx-client') && !qs('#main').dataset.pendingRoute), true);
      await page.screenshot({ path: path.join(out, `background-refresh-${lang}-${width}.png`) });
      await page.evaluate(() => { navigateTo('movements'); navigateTo('transaction'); });
      assert.equal(await page.evaluate(() => reads.filter(url => url === '/transactions/inventory').length), 1,
        'rapid returns share the background reads');
      await page.evaluate(() => {
        qs('#tx-client').value = 'Edited while refreshing'; markTxDirty();
        held['/products'].resolve([{ _id: 'p1', code: 'P1', name: 'Updated product', price: 120 }]);
        held['/suppliers'].resolve([]);
        held['/transactions/inventory'].resolve([{ _id: 'p1', code: 'P1', name: 'Updated product', current: 7 }]);
      });
      await page.waitForFunction(() => inventoryCache[0]?.current === 7);
      assert.equal(await page.evaluate(() => qs('#tx-client').value), 'Edited while refreshing');
      assert.equal(await page.evaluate(() => txItems[0].price), 100, 'catalog refresh does not alter the entered sale price');
      assert.equal(await page.evaluate(() => txDirty), true);
      await page.evaluate(() => navigateTo('movements'));
      assert.equal(await page.$eval('#tx-dirty-overlay', el => el.style.display), 'flex', 'unsaved-work protection remains active');
      await page.evaluate(() => txDirtyCancel());
      assert.equal(await page.evaluate(() => clientInput === qs('#tx-client')), true);
      await page.evaluate(() => { navigateTo('movements'); txDirtyConfirmLeave(); navigateTo('transaction'); });
      assert.equal(await page.evaluate(() => currentPage), 'transaction');
      assert.equal(await page.$eval('#tx-client', el => el.value), '', 'explicit discard must clear the retained form');
      assert.equal(await page.evaluate(() => txItems.length), 0);
      assert.equal(await page.evaluate(() => activeDraftId), null);
      assert.equal(await page.evaluate(() => txComments.length), 0);
      assert.equal(await page.$eval('#tx-inv-note', el => el.value), '');
      await page.evaluate(() => { qs('#tx-client').value = 'Reset me'; resetTx(); navigateTo('movements'); navigateTo('transaction'); });
      assert.equal(await page.$eval('#tx-client', el => el.value), '', 'Reset must not restore old input on return');
      await page.evaluate(() => {
        timeOffset += 31000; navigateTo('movements'); navigateTo('transaction');
        held['/products'].reject(new Error('Fixture catalog unavailable'));
        held['/suppliers'].resolve([]); held['/transactions/inventory'].resolve([{ _id: 'p1', current: 6 }]);
      });
      await page.waitForFunction(() => inventoryCache[0]?.current === 6);
      assert.equal(await page.evaluate(() => !!qs('#tx-client') && !qs('#main').dataset.pendingRoute), true);
      assert.equal(await page.evaluate(() => products[0].name), 'Updated product', 'failure retains the previous reference collection');
      assert.equal(await page.evaluate(() => notices.length > 0), true, 'reference refresh failure is reported');
      await page.evaluate(() => {
        navigateTo('movements'); navigateTo('transaction');
        _apiWriteRevision++;
        held['/products'].resolve([{ _id: 'p1', name: 'Stale after save' }]);
        held['/suppliers'].resolve([]); held['/transactions/inventory'].resolve([{ _id: 'p1', current: 999 }]);
      });
      await page.waitForFunction(() => !_txReferenceRequest);
      assert.equal(await page.evaluate(() => inventoryCache[0].current), 6,
        'a reference read that overlaps a save must not overwrite newer inventory state');
      // A new identity must initialize a clean form, not restore a previous draft.
      await page.evaluate(() => {
        qs('#tx-client').value = 'Old account customer'; txDirty = false;
        navigateTo('movements'); navigateTo('transaction');
        navigateTo('movements'); localStorage.setItem('token', 'new-account'); currentUser._id = 'new-account';
        products = [{ _id: 'p2', name: 'New account product' }];
        _transactionSummariesComplete = true;
        navigateTo('transaction');
        held['/products'].resolve([{ _id: 'p1', name: 'Old account late product' }]);
        held['/suppliers'].resolve([]); held['/transactions/inventory'].resolve([{ _id: 'p1', current: 99 }]);
      });
      await page.waitForFunction(() => !_txReferenceRequest);
      assert.equal(await page.$eval('#tx-client', el => el.value), '');
      assert.equal(await page.evaluate(() => activeDraftId), null);
      assert.equal(await page.evaluate(() => products[0].name), 'New account product', 'late old-account reference data is ignored');
      await page.evaluate(() => {
        qs('#tx-client').value = 'Previous form'; _transactionSummariesComplete = true;
        goCreateTransaction('مبيعات');
      });
      await page.waitForFunction(() => qs('#tx-client')?.value === '');
      assert.equal(await page.evaluate(() => txItems.length), 0, 'an explicit create action still starts a fresh form');
      await page.evaluate(() => {
        window.returnPrefill = null;
        applyReturnRequestPrefill = (id, exchange) => { returnPrefill = { id, exchange }; };
        pendingMovementReturn = { txId: 'return-source', asExchange: true };
        _transactionSummariesComplete = true; navigateTo('transaction');
      });
      assert.deepEqual(await page.evaluate(() => returnPrefill), { id: 'return-source', exchange: true });
      assert.deepEqual(errors, [], `${width}: browser errors`);
      await page.close();
    }
    console.log('PASS: New Transaction returns immediately, preserves draft inputs/items/scroll, refreshes reference data without editing the form, keeps unsaved/reset/discard behavior, and isolates accounts.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
