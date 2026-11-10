const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/') {
        return request.respond({ status: 200, contentType: 'text/html', body: html });
      }
      const file = path.join(publicDir, url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext = path.extname(file);
        const contentType = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : ext === '.svg' ? 'image/svg+xml' : 'application/octet-stream';
        return request.respond({ status: 200, contentType, body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') {
        return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      }
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentLang = 'ar';
      document.documentElement.lang = 'ar';
      document.documentElement.dir = 'rtl';
      currentUser = { _id: 'admin-1', name: 'Manager', role: 'admin', perms: ['shopify-orders', 'shopify-deposit-upload'] };
      qs('#app').style.display = '';
      qs('#login-page').style.display = 'none';
      qs('#splash-screen')?.remove();
      qsa('.page').forEach(el => el.classList.remove('active'));
      qs('#page-shopify-orders').classList.add('active');
      currentPage = 'shopify-orders';
      _spSubnavTab = 'deposits';
      _shopifyOrders = [{
        _id: 'order-1', ref: '3021', client: 'Test customer', status: 'pending', cancelled: false,
        total: 1485, items: [], depositReceipts: [{ id: 'receipt-1', status: 'معلق', amount: 500,
          method: 'Instapay', submittedBy: 'Staff', submittedAt: new Date().toISOString(), imageDeleted: true }]
      }];
      window.approvalCalls = 0;
      window.orderFetches = 0;
      window.holdNextOrderFetch = true;
      window.releaseOrders = null;
      api = async (url, options) => {
        if (url.endsWith('/deposit-receipts/receipt-1/approve')) {
          approvalCalls++;
          return { success: true, vaultEntryId: 'vault-1', vaultTxNo: 'SAL-001' };
        }
        if (url.endsWith('/deposit-receipts/receipt-2/approve')) throw new Error('Approval failed');
        if (url === '/shopify/orders/deposit-review') {
          orderFetches++;
          const snapshot = _shopifyOrders.map(order => ({ ...order, depositReceipts: order.depositReceipts.map(receipt => ({ ...receipt })) }));
          if (holdNextOrderFetch) {
            holdNextOrderFetch = false;
            return new Promise(resolve => { releaseOrders = () => resolve(snapshot); });
          }
          return snapshot;
        }
        return [];
      };
      renderSpDepositReview();
      _spDepositReviewIds = new Set(['order-1']);
      _spDepositReviewToken = localStorage.getItem('token');
      window.oldRefresh = loadShopifyOrders();
    });
    assert.equal(await page.$$eval('.spdep-review-card', cards => cards.length), 1);
    await page.evaluate(() => _spReceiptAction('order-1', 'receipt-1', 'approve'));
    await page.click('#spdep-decide');
    await page.waitForFunction(() => !qs('#modal-overlay').classList.contains('active') && !qs('.spdep-review-card'), { timeout: 5000 }).catch(async error => {
      console.error('approval state', await page.evaluate(() => ({
        decisionOpen: qs('#modal-overlay').classList.contains('active'), card: !!qs('.spdep-review-card'),
        status: _shopifyOrders[0].depositReceipts[0].status,
        feedback: qs('#spdep-error')?.textContent,
        toast: qs('#toast-container')?.textContent,
      })), errors);
      throw error;
    });
    const approved = await page.evaluate(() => ({
      status: _shopifyOrders[0].depositReceipts[0].status,
      vault: _shopifyOrders[0].depositReceipts[0].vaultEntryId,
      empty: qs('.spdep-review').textContent.includes(t('spDepReviewEmpty')),
      countHidden: qs('#sp-subnav-deposits-n').hidden,
      toast: qs('#toast-container .toast.success')?.textContent.trim(),
      refreshPending: !!_spDepositReviewRequest,
      calls: approvalCalls,
    }));
    assert.deepEqual(approved, {
      status: 'معتمد', vault: 'vault-1', empty: true, countHidden: true,
      toast: 'تم اعتماد العربون', refreshPending: true, calls: 1,
    });
    await page.evaluate(() => releaseOrders());
    await page.waitForFunction(() => orderFetches >= 2 && !_spDepositReviewRequest);
    assert.equal(await page.$$eval('.spdep-review-card', cards => cards.length), 0);

    await page.evaluate(() => {
      _shopifyOrders[0].depositReceipts.push({ id: 'receipt-2', status: 'معلق', amount: 200,
        method: 'Instapay', submittedBy: 'Staff', imageDeleted: true });
      renderSpDepositReview();
      _spReceiptAction('order-1', 'receipt-2', 'approve');
    });
    await page.click('#spdep-decide');
    await page.waitForFunction(() => qs('#spdep-error') && !qs('#spdep-error').hidden);
    assert.equal(await page.$$eval('.spdep-review-card', cards => cards.length), 1);
    assert.equal(await page.evaluate(() => _shopifyOrders[0].depositReceipts[1].status), 'معلق');
    assert.deepEqual(errors, []);
    console.log('PASS: approval updates the queue before refresh, ignores stale GET data, and failure keeps the receipt for review');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
