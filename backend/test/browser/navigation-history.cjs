const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { buildClientProfiles } = require('../../dist/clients/client-profile.util');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const txs = ['1', '2'].map((id, i) => ({ _id: id, type: 'مبيعات', ref: '700' + id, client: 'Client ' + id,
  phone: i ? '01112345678' : '01012345678', total: 1000, deposit: 200, remaining: 800,
  date: '2026-10-01', items: [], pickupStatus: 'Pending' }));
const profiles = buildClientProfiles(txs, []);

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const errors = [];
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks++; };
  try {
    async function setup(hash = '') {
      const page = await browser.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      page.on('pageerror', error => errors.push(error.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/')) return request.continue();
        let body = [];
        if (url.pathname === '/api/settings') body = {};
        if (url.pathname === '/api/clients') body = profiles.map(({ history, addresses, returns, emails, ...p }) => p);
        if (url.pathname === '/api/clients/profile') {
          const key = url.searchParams.get('key') || '';
          body = profiles.find(p => p.key === key || key.endsWith('~' + p.code));
        }
        if (url.pathname === '/api/clients/order-profile') body = profiles.find(p => p.history.some(r => r.id === url.searchParams.get('id'))) || profiles[0];
        if (url.pathname.startsWith('/api/transactions/')) body = txs.find(tx => tx._id === url.pathname.split('/').pop()) || [];
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.goto(origin + '/' + hash, { waitUntil: 'networkidle2' });
      await page.evaluate(txs => {
        currentUser = { _id: 'nav-admin', name: 'Navigation review', role: 'admin', perms: [] };
        currentLang = 'en'; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr';
        qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
        transactions = txs; _transactionSummariesComplete = true; settings = {};
        window.__routeEnters = [];
        const enter = onPageEnter;
        onPageEnter = page => {
          window.__routeEnters.push({ page, hash: location.hash });
          // Exercise real customer/invoice renders; unrelated datasets are outside this test.
          if (['clients', 'invoice-view', 'transaction'].includes(page)) return enter(page);
        };
        buildSidebar(); updateHeader();
      }, txs);
      return page;
    }
    const page = await setup();
    async function reset(hash, route) {
      await page.evaluate(({ hash, route }) => {
        currentUser = { _id: 'nav-admin', name: 'Navigation review', role: 'admin', perms: [] };
        txDirty = false; _pendingNavPage = null;
        const url = new URL(location.href); url.search = ''; url.hash = hash;
        history.replaceState(null, '', url); SouliaNavigation.reset(); navigateTo(route, false);
      }, { hash, route });
      await page.waitForFunction(route => currentPage === route, {}, route);
    }
    await reset('#shopify-orders/deposit-log', 'shopify-orders');
    await page.evaluate(() => {
      shopifyPage = 3; _shopifyTab = 'approved'; _spStarOnly = true;
      qs('#shopify-search').value = 'Hagar';
    });
    await page.evaluate(key => SouliaClients.open(key), profiles[0].key);
    await page.waitForSelector('.cp-profile');
    check((await page.$eval('.cp-back', el => el.textContent)).includes('Shopify'), 'Customer Back names its actual Shopify source');
    const length = await page.evaluate(() => history.length);
    await page.evaluate(() => { shopifyPage = 1; qs('#shopify-search').value = ''; _spStarOnly = false; });
    await page.click('.cp-back');
    await page.waitForFunction(() => currentPage === 'shopify-orders' && location.hash === '#shopify-orders/deposit-log');
    check(await page.evaluate(() => shopifyPage === 3 && qs('#shopify-search').value === 'Hagar' && _spStarOnly), 'Back restores exact Shopify URL, filters and page');
    check(await page.evaluate(() => history.length) === length, 'App Back consumes browser history instead of pushing another route');
    await page.goForward();
    await page.waitForFunction(code => currentPage === 'clients' && location.hash.endsWith(code), {}, profiles[0].code);
    check(await page.evaluate(() => history.length) === length, 'Browser Forward preserves history length');

    // Same logical page, different objects: both need independent return destinations.
    await page.evaluate(key => SouliaClients.open(key), profiles[1].key);
    await page.waitForFunction(code => location.hash.endsWith(code), {}, profiles[1].code);
    await page.click('.cp-back');
    await page.waitForFunction(code => location.hash.endsWith(code) && !!document.querySelector('.cp-profile'), {}, profiles[0].code);
    check(await page.evaluate(() => SouliaClients.currentProfile().key) === profiles[0].key, 'Back distinguishes two customer profiles');
    await page.evaluate(() => openOrderView('1'));
    await page.waitForFunction(() => currentPage === 'invoice-view');
    await page.evaluate(() => openOrderView('2'));
    await page.waitForFunction(() => location.hash.endsWith('sales-7002'));
    await page.evaluate(() => navBack());
    await page.waitForFunction(() => currentPage === 'invoice-view' && location.hash.endsWith('sales-7001'));
    check(await page.evaluate(() => window._invoiceViewRef) === '7001', 'Back distinguishes two invoices even after current invoice globals change');
    await page.evaluate(() => navBack());
    await page.waitForFunction(code => currentPage === 'clients' && location.hash.endsWith(code), {}, profiles[0].code);

    // Replace-based ticket routes retain the real source, not an intermediate parent screen.
    await page.evaluate(() => { navigateTo('complaints'); history.replaceState(null, '', '#complaints/fu/view/FU-7001'); });
    const ticketLength = await page.evaluate(() => history.length);
    await page.evaluate(() => navBack());
    await page.waitForFunction(code => currentPage === 'clients' && location.hash.endsWith(code), {}, profiles[0].code);
    check(await page.evaluate(() => history.length) === ticketLength, 'Ticket Back does not push a replacement navigation');
    await reset('#complaints', 'complaints');
    await page.evaluate(() => { navigateTo('complaints'); history.replaceState(null, '', '#complaints/fu/view/FU-7001'); });
    await page.evaluate(() => navBack());
    await page.waitForFunction(() => currentPage === 'complaints' && location.hash === '#complaints');
    check(true, 'A ticket opened from its own list returns to that list');

    // Hash-only anchors use the same route dispatcher as application navigation.
    await reset('#products', 'products');
    await page.evaluate(path => { location.hash = path; }, profiles[0].profilePath);
    await page.waitForFunction(code => currentPage === 'clients' && location.hash.endsWith(code), {}, profiles[0].code);
    await page.click('.cp-back');
    await page.waitForFunction(() => currentPage === 'products' && location.hash === '#products');
    check(true, 'Native hash links have a correct return destination');

    await reset('#products', 'products');
    await page.evaluate(() => { qs('#page-products').style.minHeight = '2400px'; window.scrollTo({ top: 650, behavior: 'instant' }); prodPage = 4; });
    await page.waitForFunction(() => window.scrollY > 600, { timeout: 3000 });
    await page.evaluate(key => SouliaClients.open(key), profiles[0].key);
    await page.waitForSelector('.cp-profile');
    await page.evaluate(() => { window.__scrollSnapshot = navBackTarget()?.scroll; prodPage = 1; navBack(); });
    await page.waitForFunction(() => currentPage === 'products' && window.scrollY > 600, { timeout: 8000 }).catch(async error => {
      console.error(await page.evaluate(() => ({ saved: window.__scrollSnapshot, y: window.scrollY, page: currentPage,
        hash: location.hash, htmlClass: document.documentElement.className, height: document.documentElement.scrollHeight })));
      throw error;
    });
    check(await page.evaluate(() => prodPage) === 4, 'List pagination and scroll position survive a detail visit');
    await page.mouse.move(300, 300); await page.mouse.wheel({ deltaY: -250 });
    await page.evaluate(() => navigateTo('products', false));
    check(await page.evaluate(() => window.scrollY) < 600, 'Normal re-render does not reapply an old Back snapshot');

    await page.evaluate(() => {
      history.replaceState(null, '', '?sale=7001'); SouliaNavigation.reset(); navigateTo('movements', false);
    });
    await page.evaluate(key => SouliaClients.open(key), profiles[0].key);
    await page.waitForSelector('.cp-profile'); await page.click('.cp-back');
    await page.waitForFunction(() => currentPage === 'movements' && location.search === '?sale=7001' && !location.hash);
    check(true, 'Query-style invoice permalinks retain their complete source route');
    await reset('#clients', 'clients');
    await page.evaluate(key => SouliaClients.open(key), profiles[0].key);
    await page.waitForSelector('.cp-profile');
    await page.evaluate(() => showInvoiceDetail('1'));
    await page.waitForSelector('#inv-detail-overlay.active .cp-invoice-customer');
    await page.click('#inv-detail-overlay.active .cp-invoice-customer');
    await page.waitForFunction(() => !qs('#inv-detail-overlay').classList.contains('active'));
    check(await page.evaluate(() => !location.search), 'Customer URLs do not retain invoice permalink parameters');
    await page.click('.cp-back');
    await page.waitForSelector('#inv-detail-overlay.active .cp-invoice-customer');
    check(true, 'Back restores the invoice window that opened the customer');
    await page.evaluate(() => closeInvoiceDetail());

    // Shared detail links have a safe parent rather than a previous site in the browser.
    const direct = await setup(profiles[1].profilePath);
    await direct.evaluate(() => navigateTo('clients', false));
    await direct.waitForSelector('.cp-profile');
    await direct.click('.cp-back');
    await direct.waitForFunction(() => currentPage === 'clients' && location.hash === '#clients');
    check(new URL(direct.url()).origin === origin, 'Direct-link Back remains inside the app');
    check(await direct.$eval('#shell-back-btn', el => el.hidden), 'Direct-link fallback does not create a parent/detail loop');
    await direct.close();

    // App Back and native Back both honour the existing unsaved-transaction dialog.
    await reset('#products', 'products');
    await page.evaluate(() => navigateTo('transaction'));
    await page.waitForFunction(() => currentPage === 'transaction');
    await page.evaluate(() => { txDirty = true; qs('#tx-client').value = 'Unsaved customer'; navBack(); });
    await page.waitForFunction(() => qs('#tx-dirty-overlay').style.display === 'flex');
    check(await page.evaluate(() => currentPage === 'transaction' && location.hash === '#new-transaction'), 'App Back waits for the unsaved-work decision');
    await page.evaluate(() => txDirtyCancel());
    await page.goBack();
    await page.waitForFunction(() => qs('#tx-dirty-overlay').style.display === 'flex' && location.hash === '#new-transaction');
    check(await page.$eval('#tx-client', el => el.value) === 'Unsaved customer', 'Native Back preserves the unsaved form while requesting a decision');
    await page.evaluate(() => txDirtyConfirmLeave());
    await page.waitForFunction(() => currentPage === 'products' && location.hash === '#products');
    await page.evaluate(() => navigateTo('transaction'));
    await page.waitForSelector('#tx-client');
    await page.evaluate(() => { txDirty = true; qs('#tx-client').value = 'Still unsaved'; location.hash = '#products'; });
    await page.waitForFunction(() => qs('#tx-dirty-overlay').style.display === 'flex' && location.hash === '#new-transaction');
    check(await page.$eval('#tx-client', el => el.value) === 'Still unsaved', 'A native hash link also protects unsaved input');
    await page.evaluate(() => txDirtyConfirmLeave());
    await page.waitForFunction(() => currentPage === 'products' && location.hash === '#products');

    // A route whose permission was revoked must not be reopened by Back.
    await reset('#products', 'products');
    await page.evaluate(() => navigateTo('shopify-orders'));
    await page.waitForFunction(() => currentPage === 'shopify-orders');
    await page.evaluate(key => SouliaClients.open(key), profiles[0].key);
    await page.waitForSelector('.cp-profile');
    await page.evaluate(() => { currentUser.role = 'staff'; currentUser.perms = ['products', 'clients']; navBack(); });
    await page.waitForFunction(() => currentPage === 'products' && location.hash === '#products');
    check(await page.evaluate(() => currentPage !== 'shopify-orders'), 'Back skips a route without permission');

    // Existing history.state consumers (notification overlays) retain their fields.
    await page.evaluate(() => { history.pushState({ customOverlay: true }, '', location.href); });
    check(await page.evaluate(() => history.state.customOverlay === true), 'Route tracking preserves caller history.state');
    const before = await page.evaluate(() => window.__routeEnters.length);
    await page.goBack();
    await page.waitForFunction(() => !history.state?.customOverlay);
    check(await page.evaluate(() => window.__routeEnters.length) === before, 'Same-URL overlay history does not reload the route');

    // A slow request from a superseded route cannot navigate over the user's latest choice.
    await reset('#products', 'products');
    await page.evaluate(() => {
      localStorage.setItem('token', 'navigation-race-test');
      window.__originalSummaryRead = loadTransactionSummaries;
      loadTransactionSummaries = () => new Promise(resolve => { window.__finishOldRoute = resolve; });
      _transactionSummariesComplete = false;
      navigateTo('reports'); navigateTo('clients');
    });
    await page.waitForFunction(() => currentPage === 'clients' && location.hash === '#clients');
    await page.evaluate(txs => { window.__finishOldRoute(txs); loadTransactionSummaries = window.__originalSummaryRead; _transactionSummariesComplete = true; }, txs);
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
    check(await page.evaluate(() => currentPage === 'clients' && location.hash === '#clients'), 'An obsolete route request cannot overwrite a newer destination');

    await reset('#shopify-orders', 'shopify-orders');
    await page.evaluate(key => SouliaClients.open(key), profiles[0].key);
    await page.waitForSelector('.cp-profile');
    for (const dir of ['ltr', 'rtl']) for (const width of [320, 390, 768, 1440]) {
      await page.setViewport({ width, height: 900 });
      await page.evaluate(dir => { document.documentElement.dir = dir; currentLang = dir === 'rtl' ? 'ar' : 'en'; syncNavigationShell(); }, dir);
      const fits = await page.$eval('#shell-back-btn', el => { const r = el.getBoundingClientRect(); return !el.hidden && r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1; });
      check(fits, `Global Back remains reachable ${dir}/${width}`);
    }
    check(errors.length === 0, 'No browser errors: ' + errors.join(' | '));
    console.log(JSON.stringify({ ok: true, checks, scenarios: ['source state', 'Back/Forward', 'same-page details', 'direct links', 'unsaved work', 'permissions', 'overlays', 'responsive Back'] }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
