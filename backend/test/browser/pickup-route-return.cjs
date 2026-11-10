const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const out = path.resolve(__dirname, '../../../artifacts/pickup-route-return');
fs.mkdirSync(out, { recursive: true });
const orders = [
  ...Array.from({ length: 6 }, (_, i) => ({ _id: 'pending-' + i, ref: String(4100 + i), client: 'Customer pending ' + i, pickupStatus: 'Pending' })),
  { _id: 'prep', ref: '4200', client: 'Customer prep', pickupStatus: 'Preparing', pickupRef: 'PREP-1', prepNote: 'Group note' },
  { _id: 'ready', ref: '4300', client: 'Customer ready', pickupStatus: 'Ready', pickupRef: 'READY-1', pickupDate: '2026-11-10' },
  ...Array.from({ length: 8 }, (_, i) => ({ _id: 'shipped-' + i, ref: String(4400 + i), client: 'Customer shipped ' + i,
    pickupStatus: 'Shipped', pickupRef: 'SHIP-' + i, pickupDate: `2026-11-${String(i + 1).padStart(2, '0')}` })),
].map(row => ({ type: 'مبيعات', total: 100, phone: '01000000000', date: '2026-11-10', createdAt: '2026-11-10T09:00:00Z',
  shipCo: 'Manual', items: [{ lineId: 'L1', name: 'Product', qty: 1, price: 100 }], ...row }));
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    for (const [width, lang] of [[1440, 'en'], [390, 'ar']]) {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
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
        currentUser = { _id: 'pickup-route-test', role: 'admin', perms: [] };
        localStorage.setItem('token', 'pickup-route-test');
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
        window._startupRouteData = null;
        const enter = onPageEnter;
        onPageEnter = page => { if (page === 'pickup-orders') return enter(page); };
        window.reads = []; window.held = [];
        api = (url, options = {}) => {
          if (url !== '/transactions/pickup-orders/workspace') return Promise.resolve([]);
          reads.push({ url, background: !!options.background });
          return new Promise((resolve, reject) => held.push({ resolve, reject }));
        };
        window.timeOffset = 0; const now = Date.now;
        Date.now = () => now() + timeOffset;
        _puSecondaryAt = Date.now() + 600000;
        navigateTo('pickup-orders');
      }, lang);
      assert.equal(await page.evaluate(() => reads.length), 1);
      assert.equal(await page.$$eval('#page-pickup-orders .pu-loading-card', cards => cards.length), 8);
      assert.equal(await page.$eval('#page-pickup-orders .ss-skeleton', el =>
        getComputedStyle(el, '::after').animationName), 'data-sheen');
      await page.evaluate(() => puSwitchView('ready'));
      assert.equal(await page.$$eval('#pu-ready-tbl .ss-placeholder-row', rows => rows.length), 6,
        'switching views during first load keeps shimmer in the real table');
      await page.evaluate(() => puSwitchView('board'));
      await page.screenshot({ path: path.join(out, `shimmer-${lang}-${width}.png`) });
      await page.evaluate(rows => held[0].resolve(rows), orders);
      await page.waitForFunction(() => _puOrdersLoaded && !_puOrdersRequest);
      assert.equal(await page.evaluate(() => !qs('#pu-board-view .ss-skeleton,.pu-stagger-in')
        && getComputedStyle(qs('#page-pickup-orders')).animationName === 'none'
        && [...document.querySelectorAll('#pu-board-view .pu-group')]
          .every(card => getComputedStyle(card).animationName === 'none' && Number(getComputedStyle(card).opacity) === 1)), true,
        'cards appear together without a page fade or stagger');
      await page.evaluate(() => {
        qs('#pu-board-search').value = 'Customer'; renderPickupBoard();
        _puPendingSelected.add('pending-0');
        window.savedCard = qs('#pu-prep-col .pu-group');
        const col = qs('#pu-shipped-col'); col.scrollTop = 100;
        window.scrollTo(0, 150); window.savedScroll = { col: col.scrollTop, y: scrollY };
        timeOffset += 5000;
        navigateTo('movements'); window.scrollTo(0, 0); navigateTo('pickup-orders');
      });
      assert.equal(await page.evaluate(() => reads.length), 1, 'recent pickup data is reused without another read');
      assert.equal(await page.evaluate(() => savedCard === qs('#pu-prep-col .pu-group')), true);
      assert.equal(await page.$eval('#pu-load-state', el => el.hidden), true);
      assert.equal(await page.evaluate(() => _puPendingSelected.has('pending-0') && qs('#pu-board-search').value === 'Customer'), true);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.deepEqual(await page.evaluate(() => ({ col: qs('#pu-shipped-col').scrollTop, y: scrollY })),
        await page.evaluate(() => savedScroll));
      for (const [mode, selector] of [['ready', '#pu-ready-tbl-body tr'], ['table', '#pu-runs-body tr']]) {
        const same = await page.evaluate(({ mode, selector }) => {
          puSwitchView(mode); const row = qs(selector);
          navigateTo('movements'); navigateTo('pickup-orders');
          return !!row && row === qs(selector) && _puBoardView === mode;
        }, { mode, selector });
        assert.equal(same, true, `${width}/${mode}: view and rows survive return`);
      }
      await page.evaluate(() => { puSwitchView('board'); savedCard = qs('#pu-prep-col .pu-group'); timeOffset += 31000;
        navigateTo('movements'); navigateTo('pickup-orders'); });
      assert.equal(await page.evaluate(() => reads.length), 2);
      assert.equal(await page.evaluate(() => reads[1].background), true);
      assert.equal(await page.evaluate(() => savedCard === qs('#pu-prep-col .pu-group') && qs('#pu-load-state').hidden), true);
      await page.evaluate(() => { navigateTo('movements'); navigateTo('pickup-orders'); });
      assert.equal(await page.evaluate(() => reads.length), 2, 'rapid returns share the in-flight request');
      await page.evaluate(rows => held[1].resolve(rows), orders);
      await page.waitForFunction(() => !_puOrdersRequest);
      assert.equal(await page.evaluate(() => savedCard === qs('#pu-prep-col .pu-group')), true,
        'an unchanged background response must not rebuild the board');
      await page.screenshot({ path: path.join(out, `returned-${lang}-${width}.png`) });
      await page.evaluate(() => {
        const row = _pickupOrders.find(row => row._id === 'prep'); _puRememberDraft(row);
        row.items[0].qty = 3; row.total = 300; _puDirtyCards.add('prep');
        timeOffset += 31000; navigateTo('movements'); navigateTo('pickup-orders'); navigateTo('movements');
      });
      const changed = structuredClone(orders); changed.find(row => row._id === 'pending-0').total = 150;
      changed.find(row => row._id === 'pending-0').shipCo = 'New carrier';
      await page.evaluate(rows => held[2].resolve(rows), changed);
      await page.waitForFunction(() => !_puOrdersRequest);
      assert.equal(await page.evaluate(() => currentPage), 'movements');
      await page.evaluate(() => navigateTo('pickup-orders'));
      assert.equal(await page.evaluate(() => reads.length), 3);
      assert.equal(await page.evaluate(() => _pickupOrders.find(row => row._id === 'prep').items[0].qty), 3, 'unsaved quantities survive refresh');
      assert.equal(await page.evaluate(() => _pickupOrders.find(row => row._id === 'pending-0').total), 150);
      assert.equal(await page.$eval('#pu-board-shipco', el => [...el.options].some(option => option.value === 'New carrier')), true,
        'off-page updates also refresh the carrier filter on return');
      await page.evaluate(() => { timeOffset += 31000; navigateTo('movements'); navigateTo('pickup-orders');
        held[3].reject(new Error('Fixture refresh failure')); });
      await page.waitForFunction(() => !_puOrdersRequest);
      assert.equal(await page.evaluate(() => !!qs('#pu-prep-col .pu-group') && qs('#pu-load-state').hidden), true);
      await page.evaluate(() => { loadPickupOrders({ force: true }); });
      assert.equal(await page.evaluate(() => reads.length), 5, 'manual refresh still fetches current data');
      await page.evaluate(rows => held[4].resolve(rows), changed);
      await page.waitForFunction(() => !_puOrdersRequest);
      await page.evaluate(() => { navigateTo('movements'); _puLiveRevision++; navigateTo('pickup-orders'); });
      assert.equal(await page.evaluate(() => reads.length), 6, 'live changes invalidate reuse immediately');
      await page.evaluate(rows => held[5].resolve(rows), changed);
      await page.waitForFunction(() => !_puOrdersRequest);
      await page.evaluate(() => { navigateTo('movements'); _apiWriteRevision++; navigateTo('pickup-orders'); });
      assert.equal(await page.evaluate(() => reads.length), 7, 'writes invalidate reuse immediately');
      // Start a second account's read while the old request is still pending.
      await page.evaluate(() => { navigateTo('movements'); localStorage.setItem('token', 'new-pickup-account');
        currentUser._id = 'new-pickup-account'; navigateTo('pickup-orders'); });
      assert.equal(await page.evaluate(() => reads.length), 8);
      await page.evaluate(rows => held[6].resolve(rows), changed);
      assert.equal(await page.evaluate(() => _pickupOrders.length), 0, 'late old-account rows are ignored');
      await page.evaluate(rows => held[7].resolve(rows), orders.slice(0, 1));
      await page.waitForFunction(() => !_puOrdersRequest);
      assert.equal(await page.evaluate(() => _pickupOrders.length), 1);
      assert.equal(await page.evaluate(() => _puPendingSelected.size), 0);
      assert.deepEqual(errors, [], `${width}: browser errors`);
      await page.close();
    }
    console.log('PASS: Pickup returns immediately, preserves board/ready/table state, selection, filters, scroll and local edits, shares background reads, keeps unchanged cards, and isolates accounts.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
