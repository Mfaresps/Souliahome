const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const { buildMovementsPage } = require('../../dist/transactions/movements-page.util');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const out = path.resolve(__dirname, '../../../artifacts/movements-route-return');
fs.mkdirSync(out, { recursive: true });
function result(state, total = 100) {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    _id: String(i + 1).padStart(24, '0'), ref: String(6000 - i), type: 'مبيعات',
    client: 'Customer ' + i, total, deposit: 25, remaining: total - 25,
    payStatus: 'معلق', pickupStatus: 'Pending', employee: 'Test',
    items: [], comments: [], date: '2026-11-10', transactionDate: '2026-11-10',
    createdAt: '2026-11-10T09:00:00Z',
  }));
  return buildMovementsPage(rows, [], [], state);
}
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    for (const [width, lang, mode] of [[1440, 'en', 'list'], [390, 'ar', 'grid'], [390, 'en', 'list']]) {
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.setViewport({ width, height: 900 });
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
      await page.evaluate(({ lang, mode }) => {
        currentUser = { _id: 'mov-route-test', role: 'admin', perms: [] };
        localStorage.setItem('token', 'mov-route-test');
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
        window._startupResourceReady = null;
        const enter = onPageEnter;
        onPageEnter = page => { if (page === 'movements') return enter(page); };
        window.reads = []; window.held = [];
        _apiRequest = (url, options = {}) => {
          if (url !== '/transactions/movements-page') return Promise.resolve([]);
          reads.push(JSON.parse(options.body));
          return new Promise((resolve, reject) => held.push({ resolve, reject }));
        };
        window.timeOffset = 0; const now = Date.now;
        Date.now = () => now() + timeOffset;
        qs('#mov-search').value = 'Customer'; movPage = 2; movPerPage = 10;
        movViewMode = mode;
        navigateTo('movements');
      }, { lang, mode });
      assert.equal(await page.evaluate(() => reads.length), 1);
      assert.equal(await page.$eval('#page-movements', el => el.classList.contains('mov-nav-pending')), true);
      assert.equal(await page.$$eval('#mov-table .ss-placeholder-row', rows => rows.length), 6,
        'loading uses six shimmer rows in the existing table');
      assert.equal(await page.$eval('#mov-table', table => [...table.querySelectorAll('.ss-placeholder-row')]
        .every(row => row.children.length === table.querySelectorAll('thead tr:first-child > th').length)), true,
        'placeholders follow the actual table columns');
      if (width > 768) assert.equal(await page.$eval('#mov-table .ss-skeleton', el =>
        getComputedStyle(el).visibility === 'visible' && getComputedStyle(el, '::after').animationName === 'data-sheen'), true);
      assert.equal(await page.$$eval('#mov-table .ss-placeholder-row td', cells =>
        cells.every(cell => getComputedStyle(cell, '::after').content === 'none')), true,
        'shimmer cells do not duplicate the legacy loading bars');
      if (width > 768) await page.screenshot({ path: path.join(out, `shimmer-${lang}-${width}.png`) });
      const firstState = await page.evaluate(() => reads[0]);
      await page.evaluate(value => held[0].resolve(value), result(firstState));
      await page.waitForFunction(() => !!_movServerResponse && !_movServerRequest);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => {
        const selector = movViewMode === 'grid' ? '#mov-grid-list > *'
          : innerWidth > 768 ? '#mov-table tbody tr' : '#mov-mobile-list > *';
        return getComputedStyle(qs('#mov-panel-list')).animationName === 'none'
          && [...document.querySelectorAll(selector)].every(row => !row.classList.contains('ss-cascade-item')
            && getComputedStyle(row).animationName === 'none' && Number(getComputedStyle(row).opacity) === 1);
      }), true, 'loaded rows/cards appear together without fade, stagger or cascade');
      await page.evaluate(() => {
        window.rowSelector = movViewMode === 'grid' ? '#mov-grid-list > *'
          : innerWidth > 768 ? '#mov-table tbody tr' : '#mov-mobile-list > *';
        window.firstRow = qs(rowSelector);
        selectedMovIds.add(_movServerResponse.pageRows[0].tx._id);
        const box = qs('#mov-table-wrap .ent-table-scroll'); box.scrollTop = 80;
        if (innerWidth <= 768) window.scrollTo(0, 250);
        window.savedScroll = { top: box.scrollTop, y: scrollY };
        navigateTo('shopify-orders'); window.scrollTo(0, 0); navigateTo('movements');
      });
      assert.equal(await page.$eval('#page-movements', el => el.classList.contains('mov-nav-pending')), false,
        `${width}: returning must not mask cached transactions`);
      assert.equal(await page.evaluate(() => reads.length), 1, 'recent data is reused without a new request');
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => firstRow === qs(rowSelector)), true, 'existing rows are retained');
      assert.equal(await page.evaluate(() => !!firstRow), true, 'the cached view contains actual transaction rows');
      assert.deepEqual(await page.evaluate(() => ({ page: movPage, filter: qs('#mov-search').value, selected: selectedMovIds.size })),
        { page: 2, filter: 'Customer', selected: 1 });
      assert.equal(await page.evaluate(() => qs('#mov-table-wrap .ent-table-scroll').scrollTop),
        await page.evaluate(() => savedScroll.top), 'table scroll is restored');
      assert.equal(await page.evaluate(() => scrollY), await page.evaluate(() => savedScroll.y), 'window scroll is restored');
      await page.evaluate(() => { timeOffset += 31000; navigateTo('shopify-orders'); navigateTo('movements'); });
      assert.equal(await page.evaluate(() => reads.length), 2, 'stale data starts one background refresh');
      assert.equal(await page.evaluate(() => firstRow === qs(rowSelector)
        && !qs('#page-movements').classList.contains('mov-nav-pending')), true);
      await page.screenshot({ path: path.join(out, `background-refresh-${mode}-${lang}-${width}.png`) });
      await page.evaluate(() => { navigateTo('shopify-orders'); navigateTo('movements'); });
      assert.equal(await page.evaluate(() => reads.length), 2, 'rapid returns share the pending read');
      const staleState = await page.evaluate(() => reads[1]);
      await page.evaluate(value => { navigateTo('shopify-orders'); held[1].resolve(value); }, result(staleState, 200));
      await page.waitForFunction(() => !_movServerRequest);
      assert.equal(await page.evaluate(() => currentPage), 'shopify-orders');
      await page.evaluate(() => navigateTo('movements'));
      assert.equal(await page.evaluate(() => reads.length), 2, 'off-page response is reused');
      assert.equal(await page.evaluate(() => _movServerResponse.pageRows[0].tx.total), 200);
      await page.evaluate(() => { navigateTo('shopify-orders'); _transactionLiveRevision++; navigateTo('movements'); });
      assert.equal(await page.evaluate(() => reads.length), 3, 'live changes invalidate the read immediately');
      await page.evaluate(() => held[2].reject(new Error('Fixture background refresh failed')));
      await page.waitForFunction(() => !_movServerRequest);
      assert.equal(await page.evaluate(() => !!qs(rowSelector)
        && !qs('#page-movements').classList.contains('mov-nav-error')
        && !qs('#page-movements').classList.contains('mov-nav-pending')), true,
        'failed background refresh retains visible rows');
      await page.evaluate(() => { loadTransactionSummaries(); });
      assert.equal(await page.evaluate(() => reads.length), 4, 'explicit refresh still reads current data');
      await page.evaluate(value => held[3].resolve(value), result(await page.evaluate(() => reads[3]), 300));
      await page.waitForFunction(() => !_movServerRequest);
      await page.evaluate(() => { navigateTo('shopify-orders'); _apiWriteRevision++; navigateTo('movements'); });
      assert.equal(await page.evaluate(() => reads.length), 5, 'writes invalidate the read immediately');
      await page.evaluate(value => held[4].resolve(value), result(await page.evaluate(() => reads[4]), 400));
      await page.waitForFunction(() => !_movServerRequest);
      await page.evaluate(() => { navigateTo('shopify-orders'); qs('#mov-search').value = 'different'; navigateTo('movements'); });
      assert.equal(await page.evaluate(() => reads.length), 6);
      assert.equal(await page.$eval('#page-movements', el => el.classList.contains('mov-nav-pending')), true,
        'unrelated filters cannot reuse the cached view');
      await page.evaluate(() => held[5].reject(new Error('Fixture filter read failed')));
      await page.waitForFunction(() => !_movServerRequest);
      await page.evaluate(() => { navigateTo('shopify-orders'); qs('#mov-search').value = 'Customer'; navigateTo('movements'); });
      assert.equal(await page.evaluate(() => reads.length), 7);
      assert.equal(await page.evaluate(() => !!qs(rowSelector)
        && !qs('#page-movements').classList.contains('mov-nav-pending')
        && !qs('#page-movements').classList.contains('mov-nav-error')), true,
        'returning to the cached filter restores actual rows after another filter fails');
      await page.evaluate(value => held[6].resolve(value), result(await page.evaluate(() => reads[6]), 400));
      await page.waitForFunction(() => !_movServerRequest);
      await page.evaluate(() => { navigateTo('shopify-orders'); qs('#mov-search').value = 'different'; navigateTo('movements'); });
      await page.evaluate(value => held[7].resolve(value), result(await page.evaluate(() => reads[7])));
      await page.waitForFunction(() => !_movServerRequest);
      await page.evaluate(() => { navigateTo('shopify-orders'); localStorage.setItem('token', 'another-account'); navigateTo('movements'); });
      assert.equal(await page.evaluate(() => reads.length), 9);
      assert.equal(await page.$eval('#page-movements', el => el.classList.contains('mov-nav-pending')), true,
        'another account cannot see the old account snapshot');
      await page.evaluate(value => held[8].resolve(value), result(await page.evaluate(() => reads[8])));
      await page.waitForFunction(() => !_movServerRequest);
      await page.evaluate(() => {
        navigateTo('shopify-orders'); currentUser.role = 'staff'; currentUser.perms = ['movements']; navigateTo('movements');
      });
      assert.equal(await page.evaluate(() => reads.length), 10);
      assert.equal(await page.$eval('#page-movements', el => el.classList.contains('mov-nav-pending')), true,
        'changed permissions cannot reuse the admin snapshot with the same token');
      await page.evaluate(value => held[9].resolve(value), result(await page.evaluate(() => reads[9])));
      await page.waitForFunction(() => !_movServerRequest);
      assert.deepEqual(errors, [], `${width}: browser errors`);
      await page.close();
    }
    console.log('PASS: Movements route return reuses data, restores scroll/filter/selection/page, refreshes stale/live/write changes in the background, retains off-page responses, handles errors and isolates accounts.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
