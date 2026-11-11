const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { buildClientProfiles } = require('../../dist/clients/client-profile.util');
const root = path.resolve(__dirname, '../../..');
const out = path.join(root, 'artifacts/clients-profile');
fs.mkdirSync(out, { recursive: true });
const sale = (id, extra = {}) => ({ _id: id, type: 'مبيعات', client: 'منة الديب', phone: '01012345678',
  date: '2026-10-01', pickupStatus: 'Pending', ref: '260' + id, total: 1475, deposit: 1000, remaining: 475,
  shippingAddress: '١٢ شارع النخيل، الدور الثالث، شقة ٨', shippingCity: 'مدينة نصر', shippingGov: 'القاهرة', ...extra });
const txs = [sale('1', { deliveredAt: '2026-10-04', date: '2026-10-04', remaining: 0, deposit: 1475 }),
  sale('2', { bostaShippingStatus: 'Delivered', date: '2026-09-22' }),
  sale('3', { bostaOrderId: 'b3', bostaStatus: 'RETURNED', failedDelivery: { outcome: 'refused', note: 'رفض الاستلام عند وصول المندوب' } }),
  sale('4', { cancelled: true, cancelReasonCode: 'customer-changed-mind', cancelReason: 'العميل غيّر رأيه' }),
  sale('5', { date: '2026-08-01', bostaOrderId: 'b5', bostaStatus: 'OUT_FOR_DELIVERY', shippingAddress: '٥ شارع التحرير', shippingCity: 'الدقي', shippingGov: 'الجيزة' }),
  sale('6', { client: 'منة الديب', phone: '01112345678' }),
  sale('7', { client: '<script>alert(1)</script>', phone: '01212345678' })];
const orders = [{ _id: 's1', shopifyId: '101', ref: '3101', client: 'منة الديب', phone: '+201012345678',
  customerEmail: 'menna@example.com', total: 1700, cancelled: true, cancelReasonCode: 'out-of-stock', shopifyCreatedAt: '2026-10-06' }];
const profiles = buildClientProfiles(txs, orders, [{ originalTransactionId: '1', status: 'معتمد', returnTxId: 'ret1', returnTxRef: '2601-RET',
  approvedAt: '2026-10-06', total: 200, reason: 'عيب صناعة' },
  { _id: 'pending-return', originalTransactionId: '1', originalRef: '2601', status: 'معلق', total: 300, requestKind: 'return',
    createdAt: '2026-11-10', reason: 'customer-choice', workflow: { version: 2, ref: 'AS-RETURN', stage: 'approved', quote: { refundDue: 250 } } },
  { _id: 'exchange-case', originalTransactionId: '1', originalRef: '2601', status: 'معتمد', total: 400, requestKind: 'exchange',
    returnTxId: 'ret-exchange', returnTxRef: 'RT-EXCHANGE', createdAt: '2026-11-09', reason: 'defect',
    workflow: { version: 2, ref: 'AS-EXCHANGE', stage: 'settlement', receivedAt: '2026-11-10', replacementTxId: 'replacement',
      replacementRef: 'SALE-REPLACEMENT', quote: { collectDue: 50 }, collection: { amount: 50 } } }]);
const profile = profiles.find(p => p.key === 'p:201012345678');
profile.emailSource = 'shopify';
const list = () => profiles.map(({ history, addresses, returns, emails, ...p }) => p);
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const errors = [], requests = [], writes = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', error => { errors.push(error.message); console.error(error.stack); });
    await page.setRequestInterception(true);
    let failProfile = false;
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      requests.push(url.pathname);
      let body = [];
      if (url.pathname === '/api/auth/me') body = { _id: 'client-test', name: 'Profile review', username: 'review', role: 'admin', perms: [] };
      if (url.pathname === '/api/settings') body = {};
      if (url.pathname === '/api/notifications') body = { preferences: { enabled: false }, categories: [], devices: 0, language: 'ar' };
      if (url.pathname === '/api/transactions/startup-overview') body = { rows: [], activeCount: 0 };
      if (url.pathname === '/api/clients') body = list();
      if (url.pathname === '/api/clients/profile') {
        if (failProfile) return request.respond({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Temporary failure' }) });
        const ref = url.searchParams.get('key');
        body = profiles.find(p => p.key === ref || p.code === ref || ref.endsWith('~' + p.code));
      }
      if (url.pathname === '/api/clients/order-profile') {
        const id = url.searchParams.get('id'), source = url.searchParams.get('source') || 'shopify';
        body = profiles.find(p => p.history.some(r => source === 'transaction' ? r.id === id && r.source === source : r.orderId === id || r.id === id && r.source === source));
      }
      if (url.pathname === '/api/clients/tickets') body = { rows: [
        { id: 'fu1', kind: 'followup', number: 'FU-2601', ref: '2601', status: 'قيد المتابعة', subject: 'تأكيد بيانات العميل', date: '2026-10-06' },
        { id: 'cmp1', kind: 'complaint', number: 'CMP-2601', ref: '2601', status: 'معلق', subject: 'شكوى العميل', date: '2026-10-05' },
      ], hasMore: false };
      if (url.pathname === '/api/shopify/orders/detail/s1') body = { ...orders[0], status: 'pending', items: [], depositReceipts: [], comments: [] };
      if (url.pathname === '/api/clients/email') {
        writes.push(JSON.parse(request.postData())); profile.email = writes.at(-1).email; profile.emailSource = 'manual'; body = { email: profile.email };
      }
      if (url.pathname.startsWith('/api/transactions/') && request.method() === 'GET') body = txs.find(t => t._id === url.pathname.split('/').at(-1)) || sale('ret1');
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(origin, { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      currentUser = { _id: 'client-test', name: 'Profile review', username: 'review', role: 'admin', perms: [] };
      currentLang = 'ar'; document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl';
      qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      _transactionSummariesComplete = true;
      buildSidebar(); updateHeader(); applyLang();
      navigateTo('clients');
    });
    await page.waitForSelector('.cp-client-card', { timeout: 10000 }).catch(async error => {
      console.error(JSON.stringify({ errors, requests: requests.slice(-15), state: await page.evaluate(() => ({
        page: currentPage, hash: location.hash, pending: _pendingStartupRoute, content: document.querySelector('#page-clients').innerHTML.slice(-1800),
        module: !!window.SouliaClients, user: !!currentUser, active: [...document.querySelectorAll('.page.active')].map(el => el.id),
      })) }));
      throw error;
    });
    assert.equal(await page.$$eval('.cp-client-card', nodes => nodes.length), 3, 'same names stay separate');
    assert.equal(await page.$('#clients-stats'), null, 'customer KPIs are removed from the DOM');
    assert.equal(await page.$('.cp-card-numbers'), null, 'customer cards do not contain KPI tiles');
    assert.equal(await page.evaluate(() => document.querySelector('.cp-client-card script') !== null), false, 'names are escaped');
    await page.screenshot({ path: path.join(out, 'list-ar-1440.png'), fullPage: true });
    await page.click(`[data-cp-open="${profile.key}"]`);
    await page.waitForSelector('.cp-profile');
    assert.match(await page.evaluate(() => decodeURIComponent(location.hash)), new RegExp('منة-الديب~' + profile.code));
    assert.equal(await page.$eval('#shell-breadcrumb [aria-current="page"]', el => el.textContent), profile.name);
    assert.match(await page.$eval('.cp-header-meta .cp-name-orders', el => el.textContent), /6|٦/);
    assert.equal(await page.$eval('.cp-success strong', el => el.textContent.trim().replace(/٦/g, '6').replace(/٧/g, '7')), '67%');
    assert.equal(await page.$eval('#cp-email', el => el.value), 'menna@example.com');
    assert.equal(await page.$$eval('.cp-address', nodes => nodes.length), 2);
    assert.equal(await page.$eval('.cp-address', el => el.querySelector('h3').compareDocumentPosition(el.querySelector('p')) & Node.DOCUMENT_POSITION_FOLLOWING), 4);
    assert.equal(requests.filter(url => url === '/api/clients/tickets').length, 0, 'tickets are not requested on initial profile load');
    await page.click('#cp-ticket-panel summary');
    await page.waitForSelector('.cp-ticket');
    assert.equal(await page.$$eval('.cp-ticket', nodes => nodes.length), 2);
    await page.click('#cp-ticket-panel summary');
    await page.click('#cp-ticket-panel summary');
    assert.equal(requests.filter(url => url === '/api/clients/tickets').length, 1, 'reopening tickets reuses the same response');
    assert.equal(await page.$$eval('#cp-order-results tbody tr', nodes => nodes.length), 6);
    assert.equal(await page.$$eval('#cp-order-results .order-state', nodes => nodes.length), 6, 'profile rows use shared status badges');
    assert.equal(await page.$eval('#cp-order-results [data-order-state="OUT_FOR_DELIVERY"] .order-state-label', el => el.textContent), 'خارج للتسليم');
    assert.equal(await page.$('.cp-deposit-paid'), null, 'orders without retained deposits have no paid-deposit label');
    await page.click('[data-cp-filter="failed"]');
    assert.equal(await page.$$eval('#cp-order-results tbody tr', nodes => nodes.length), 1);
    assert.match(await page.$eval('#cp-order-results', el => el.textContent), /رفض الاستلام/);
    await page.click('[data-cp-filter="returns"]');
    assert.match(await page.$eval('#cp-order-results', el => el.textContent), /2601-RET/);
    assert.equal(await page.$$eval('#cp-order-results tbody tr', nodes => nodes.length), 2, 'pending and legacy returns are both visible');
    assert.match(await page.$eval('#cp-order-results', el => el.textContent), /250/);
    assert.match(await page.$eval('#cp-order-results', el => el.textContent), /بانتظار سحب المرتجع/);
    await page.evaluate(() => { window.__cpOpenedCases = []; window.AfterSales.open = id => window.__cpOpenedCases.push(id); });
    await page.click('[data-cp-case="pending-return"]');
    assert.deepEqual(await page.evaluate(() => window.__cpOpenedCases), ['pending-return']);
    await page.click('[data-cp-filter="exchanges"]');
    assert.equal(await page.$$eval('#cp-order-results tbody tr', nodes => nodes.length), 1);
    assert.match(await page.$eval('#cp-order-results', el => el.textContent), /SALE-REPLACEMENT/);
    assert.match(await page.$eval('#cp-order-results', el => el.textContent), /بانتظار التسوية/);
    assert.equal(await page.$eval('#cp-order-results [data-cp-invoice="replacement"]', el => el.textContent), '#SALE-REPLACEMENT');
    await page.click('[data-cp-filter="all"]');
    await page.type('#cp-order-search', '2601');
    assert.equal(await page.$$eval('#cp-order-results tbody tr', nodes => nodes.length), 1);
    await page.$eval('#cp-email', el => { el.value = 'updated@example.com'; });
    await page.click('#cp-email-form button');
    await page.waitForFunction(() => document.querySelector('#cp-email-status').textContent.includes('تم حفظ'));
    assert.deepEqual(writes, [{ email: 'updated@example.com' }]);
    await page.click('[data-cp-invoice="1"]');
    await page.waitForFunction(() => currentPage === 'invoice-view');
    await page.waitForSelector('#inv-view-content .cp-invoice-customer');
    const profileReads = requests.filter(url => url === '/api/clients/profile').length;
    const orderProfileReads = requests.filter(url => url === '/api/clients/order-profile').length;
    await page.click('#inv-view-content .cp-invoice-customer');
    await page.waitForSelector('.cp-profile');
    assert.equal(await page.evaluate(() => currentPage), 'clients', 'invoice customer name opens the customer profile');
    assert.equal(requests.filter(url => url === '/api/clients/profile').length, profileReads, 'invoice navigation reuses the loaded profile');
    assert.equal(requests.filter(url => url === '/api/clients/order-profile').length, orderProfileReads, 'known invoice identity needs no lookup');
    await page.goBack();
    await page.waitForFunction(() => currentPage === 'invoice-view');
    await page.goBack();
    await page.waitForSelector('.cp-profile');
    assert.equal(await page.$eval('#cp-email', el => el.value), 'updated@example.com');
    await page.$eval('#cp-order-search', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('[data-cp-invoice="s1"]');
    await page.waitForSelector('#sp-peek .cp-order-evidence .cp-badge');
    assert.match(await page.$eval('#sp-peek .cp-order-evidence', el => el.textContent), /عربون/);
    await page.evaluate(() => closeSpOrderPeek());
    await page.waitForSelector('#sp-peek', { hidden: true });
    // Screenshot and overflow checks at phone/tablet/desktop widths, in both languages.
    const measurements = [];
    for (const lang of ['ar', 'en']) for (const width of [390, 768, 1440]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(async lang => {
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; document.documentElement.lang = lang;
        closeSidebar(); applyLang(); await SouliaClients.renderList();
      }, lang);
      await page.waitForSelector('.cp-profile');
      assert.equal(await page.$eval('#cp-order-results [data-order-state="OUT_FOR_DELIVERY"] .order-state-label', el => el.textContent), lang === 'ar' ? 'خارج للتسليم' : 'Out for Delivery');
      // The existing shell animates its desktop sidebar margins for 300ms on resize.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
      const result = await page.evaluate(() => ({ width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        profileWidth: document.querySelector('.cp-profile').getBoundingClientRect().width,
        title: document.querySelector('.cp-header h1').textContent }));
      assert.equal(result.overflow, false, `${lang}/${width}: page overflow`);
      if (width < 760) assert.ok(result.profileWidth > width - 100, `${lang}/${width}: content must fill the mobile canvas`);
      measurements.push({ lang, ...result });
      await page.screenshot({ path: path.join(out, `profile-${lang}-${width}.png`), fullPage: true });
      if (width === 390) await page.screenshot({ path: path.join(out, `profile-${lang}-${width}-top.png`) });
      if (width !== 768) for (const kind of ['returns', 'exchanges']) {
        await page.click(`[data-cp-filter="${kind}"]`);
        assert.equal(await page.$$eval('#cp-order-results tbody tr', nodes => nodes.length), kind === 'returns' ? 2 : 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${lang}/${width}/${kind}: no page overflow`);
        if (width === 1440) assert.equal(await page.$eval('#cp-order-results .cp-table-scroll', el => el.scrollWidth > el.clientWidth + 1), false, `${lang}/${kind}: all case columns fit`);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.screenshot({ path: path.join(out, `${kind}-${lang}-${width}.png`), fullPage: true });
      }
      await page.click('[data-cp-filter="all"]');
    }
    await page.evaluate(() => { currentLang = 'ar'; history.pushState(null, '', '#clients'); return SouliaClients.renderList(); });
    await page.waitForSelector('.cp-client-card');
    await page.$eval('#clients-search', el => { el.value = '01112345678'; });
    await page.evaluate(() => SouliaClients.renderList());
    assert.equal(await page.$$eval('.cp-client-card', nodes => nodes.length), 1);
    await page.click('[data-cp-select]');
    assert.equal(await page.evaluate(() => selectedClientNames.size), 1);
    assert.equal(await page.evaluate(() => getClientsData().filter(c => selectedClientNames.has(c.key)).length), 1);
    // An already open Clients page must include arrivals immediately, without a reload or invoice.
    await page.evaluate(async () => {
      localStorage.setItem('token', 'client-live-test');
      window.__clientSocketHandlers = {};
      window.io = () => ({
        on(event, handler) { (window.__clientSocketHandlers[event] ||= []).push(handler); return this; },
        emit() {}, disconnect() {},
      });
      connectSocket();
      qs('#clients-search').value = '';
      await SouliaClients.renderList();
    });
    const websiteOrder = { _id: 'live-site-order', shopifyId: 'live-site', ref: '4101', client: 'عميل موقع جديد',
      phone: '01512345678', shopifyCustomerId: 'live-customer', status: 'pending', total: 800, shopifyCreatedAt: '2026-11-10',
      depositAmount: 700, depositReceipts: [{ status: 'معتمد', amount: 500.25 }, { status: 'معلق', amount: 100 }] };
    const websiteProfile = buildClientProfiles([], [websiteOrder])[0];
    profiles.push(websiteProfile);
    await page.evaluate(() => window.__clientSocketHandlers['shopify:order-created'].forEach(handler => handler({ id: 'live-site-order' })));
    await page.waitForSelector(`[data-cp-open="${websiteProfile.key}"]`);
    assert.equal(await page.$$eval('.cp-client-card', nodes => nodes.length), 4);
    await page.select('#clients-has-remaining', 'no-invoice');
    await page.waitForFunction(() => document.querySelectorAll('.cp-client-card').length === 1);
    assert.match(await page.$eval('.cp-client-card', el => el.textContent), /بدون فاتورة/);
    await page.click(`[data-cp-open="${websiteProfile.key}"]`);
    await page.waitForSelector('.cp-deposit-paid');
    assert.equal(await page.$eval('#cp-order-results .order-state', el => el.dataset.orderState), 'confirmed', 'unregistered paid orders use the shared confirmation label');
    websiteOrder.depositReceipts[0].status = 'مُسترد';
    Object.assign(websiteProfile, buildClientProfiles([], [websiteOrder])[0]);
    await page.evaluate(async () => {
      window.__clientSocketHandlers['shopify:deposit-changed'].forEach(handler => handler({ orderId: 'live-site-order' }));
      await SouliaClients.renderList();
    });
    assert.equal(await page.$('.cp-deposit-paid'), null, 'a refund invalidates cached deposit data');
    websiteOrder.depositReceipts[0].status = 'معتمد';
    Object.assign(websiteProfile, buildClientProfiles([], [websiteOrder])[0]);
    await page.evaluate(async () => {
      window.__clientSocketHandlers['shopify:deposit-changed'].forEach(handler => handler({ orderId: 'live-site-order' }));
      await SouliaClients.renderList();
    });
    await page.waitForSelector('.cp-deposit-paid');
    for (const lang of ['ar', 'en']) for (const width of [320, 390, 1440]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(async lang => {
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; document.documentElement.lang = lang;
        closeSidebar(); applyLang(); await SouliaClients.renderList();
        await new Promise(resolve => setTimeout(resolve, 400));
      }, lang);
      assert.equal(await page.$eval('.cp-deposit-paid', el => el.textContent), lang === 'ar' ? 'عربون مدفوع' : 'Deposit paid');
      assert.match(await page.$eval('#cp-order-results tbody tr td:nth-child(4)', el => el.textContent), /500\.25/);
      assert.equal(await page.evaluate(() => SouliaClients.currentProfile().money.paid), 500.25);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${lang}/${width}: deposit row overflow`);
      await page.screenshot({ path: path.join(out, `unregistered-deposit-${lang}-${width}.png`), fullPage: true });
    }
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluate(() => {
      currentLang = 'ar'; document.documentElement.dir = 'rtl'; document.documentElement.lang = 'ar'; applyLang();
    });
    await page.goBack();
    await page.waitForSelector('#clients-has-remaining');
    const sameCustomerSale = sale('live-manual-sale', { client: 'عميل موقع جديد', phone: '01512345678' });
    profiles.splice(profiles.indexOf(websiteProfile), 1, buildClientProfiles([sameCustomerSale], [websiteOrder])[0]);
    const manualProfile = buildClientProfiles([sale('manual-only', { client: 'أول تعامل يدوي', phone: '01099990001' })], [])[0];
    profiles.push(manualProfile);
    await page.evaluate(() => window.__clientSocketHandlers['tx:created'].forEach(handler => handler({})));
    await page.waitForFunction(() => document.querySelectorAll('.cp-client-card').length === 0);
    await page.select('#clients-has-remaining', '');
    await page.waitForSelector(`[data-cp-open="${manualProfile.key}"]`);
    assert.equal(await page.$$eval('.cp-client-card', nodes => nodes.length), 5, 'manual/site history joins one profile and a first manual customer is included');
    // A failed lookup must show a retry state rather than a blank profile or invented history.
    failProfile = true;
    await page.evaluate(() => window.__clientSocketHandlers['followup:changed'].forEach(handler => handler({})));
    await page.evaluate(key => SouliaClients.open(key), profile.key);
    await page.waitForSelector('[data-cp="retry-profile"]');
    failProfile = false;
    await page.click('[data-cp="retry-profile"]');
    await page.waitForSelector('.cp-profile');
    await page.evaluate(() => {
      localStorage.setItem('token', 'client-profile-test');
      localStorage.setItem('user', JSON.stringify({ _id: 'client-test', name: 'Profile review', username: 'review', role: 'admin', perms: [] }));
      localStorage.setItem('soulia_lang_pref', 'ar');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.cp-profile', { timeout: 15000 });
    assert.equal(await page.evaluate(() => currentPage), 'clients', 'profile deep link survives reload');
    // A different customer's invoice must resolve by order ID, never by a shared display name.
    const second = profiles.find(p => p.key === 'p:201112345678');
    await page.evaluate(tx => { transactions.push(tx); openOrderView(tx._id); }, txs.find(t => t._id === '6'));
    await page.waitForSelector('#inv-view-content .cp-invoice-customer');
    await page.click('#inv-view-content .cp-invoice-customer');
    await page.waitForFunction(code => location.hash.endsWith(code) && !!document.querySelector('.cp-profile'), {}, second.code);
    assert.equal(await page.evaluate(() => SouliaClients.currentProfile().key), second.key);
    await page.evaluate(() => showInvoiceDetail('6'));
    await page.waitForSelector('#inv-detail-overlay.active .cp-invoice-customer');
    await page.click('#inv-detail-overlay.active .cp-invoice-customer');
    await page.waitForFunction(() => !document.querySelector('#inv-detail-overlay').classList.contains('active'));
    assert.equal(await page.evaluate(() => currentPage), 'clients', 'legacy invoice modal customer link also opens the profile');
    for (const siblings of [false, true]) {
      await page.evaluate(async ({ order, siblings }) => {
        await window.souliaLibraryReady('shopifyOrders');
        currentLang = 'en';
        window.__orderCountRowClicks = 0;
        const key = _spPhoneKey(_spPhone(order));
        const counts = new Map([[key, 2]]);
        const pending = new Map(siblings ? [[key, [{ id: 'other-order', ref: '3102', kind: 'shopify', total: 100, stage: 'pending' }]]] : []);
        const row = document.createElement('div'); row.id = 'client-order-count-test';
        row.style.cssText = 'position:fixed;top:90px;left:20px;z-index:10000;background:white;padding:12px;display:flex;gap:6px';
        row.onclick = () => { window.__orderCountRowClicks++; };
        row.innerHTML = _spCustOrdersChipHtml(order, counts, pending);
        document.body.appendChild(row);
      }, { order: orders[0], siblings });
      assert.equal(await page.$eval('#client-order-count-test .sp-repeat-link', el => el.textContent), '2 orders');
      if (siblings) {
        assert.equal(await page.$$eval('#client-order-count-test .sp-cust-chip', nodes => nodes.length), 1, 'shipping action is available separately');
        await page.focus('#client-order-count-test .sp-repeat-link'); await page.keyboard.press('Enter');
      } else await page.click('#client-order-count-test .sp-repeat-link');
      await page.waitForFunction(code => location.hash.endsWith(code) && currentPage === 'clients', { timeout: 8000 }, profile.code).catch(async error => {
        console.error(JSON.stringify({ siblings, errors, state: await page.evaluate(() => ({ hash: location.hash, page: currentPage,
          focus: document.activeElement?.outerHTML, clicks: window.__orderCountRowClicks, text: document.querySelector('#clients-profile-view')?.textContent.slice(0, 250) })) }));
        throw error;
      });
      assert.equal(await page.evaluate(() => window.__orderCountRowClicks), 0, 'customer count does not trigger the order row');
      assert.equal(await page.evaluate(() => SouliaClients.currentProfile().key), profile.key);
      await page.$eval('#client-order-count-test', el => el.remove());
    }
    assert.equal(requests.filter(url => url === '/api/clients/email').length, 1, 'only explicit save writes data');
    assert.deepEqual(errors, [], 'no browser errors');
    fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(measurements, null, 2));
    console.log(JSON.stringify({ ok: true, profiles: profiles.length, measurements, writes: writes.length }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
