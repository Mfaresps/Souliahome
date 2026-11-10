/* Only Shipped scrolls after four cards; other pickup lanes keep their natural height. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const output = path.resolve(__dirname, '../../../artifacts/pickup-board-viewport');

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'image/webp';
        return request.respond({ status: 200, contentType: type, body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.setViewport({ width: 1920, height: 1080 });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(() => {
      currentUser = { _id: 'layout-user', name: 'Layout review', role: 'admin', perms: [] };
      qs('#app').style.display = '';
      qs('#login-page').style.display = 'none';
      qs('#splash-screen')?.remove();
      onPageEnter = () => {};
      const base = { client: 'Mona Hassan', phone: '01000000000', date: '2026-11-08', total: 450, shipCo: 'Bosta', items: [] };
      _pickupOrders = [
        { ...base, _id: 'prep-order', ref: '4101', pickupStatus: 'Preparing', pickupRef: 'PREP-4101', prepCreatedAt: '2026-11-08T08:00:00Z' },
        ...Array.from({ length: 24 }, (_, i) => ({ ...base, _id: 'shipped-' + i, ref: String(4200 + i), pickupStatus: 'Shipped', pickupDate: `2026-10-${String(i + 1).padStart(2, '0')}`, pickupRef: 'SH-' + i })),
      ];
      transactions = _pickupOrders;
      _puOrdersLoaded = true;
      _puLoadPrepGroups(_pickupOrders);
      api = async () => [];
      navigateTo('pickup-orders');
      qs('#fx-drawer').style.display = 'none';
      qs('#drafts-drawer').style.display = 'none';
      renderPickupBoard();
    });
    const measurements = [];
    for (const [width, height, lang] of [[1920, 1080, 'en'], [2308, 1256, 'en'], [1440, 900, 'ar'], [1440, 600, 'en'], [1024, 768, 'en'], [768, 1024, 'ar'], [390, 844, 'ar'], [375, 667, 'en'], [844, 390, 'en']]) {
      await page.setViewport({ width, height });
      await page.evaluate(language => {
        currentLang = language;
        document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
        applyLang();
        window.scrollTo(0, 0);
      }, lang);
      await new Promise(resolve => setTimeout(resolve, 450));
      const result = await page.evaluate(() => {
        const board = qs('.pu-board-3col'), main = qs('#main'), page = qs('#page-pickup-orders');
        const bottom = board.getBoundingClientRect().bottom;
        return {
          width: innerWidth, height: innerHeight,
          boardBottom: bottom,
          pageBottom: page.getBoundingClientRect().bottom,
          gutter: parseFloat(getComputedStyle(main).paddingBottom),
          pagePadding: parseFloat(getComputedStyle(page).paddingBottom) + parseFloat(getComputedStyle(page).borderBottomWidth),
          columns: getComputedStyle(board).gridTemplateColumns.split(' ').length,
          overflowX: document.documentElement.scrollWidth > innerWidth,
          scrollHeight: document.documentElement.scrollHeight,
          locked: document.documentElement.classList.contains('pu-page-locked'),
          pageOverflow: getComputedStyle(document.documentElement).overflowY,
          boardViewBottom: qs('#pu-board-view').getBoundingClientRect().bottom,
          lanes: [...board.querySelectorAll('.pu-board-col-body')].map(el => ({ height: el.clientHeight, scrollHeight: el.scrollHeight, overflow: getComputedStyle(el).overflowY })),
        };
      });
      measurements.push(result);
      if ([1920, 1024, 390].includes(width)) await page.screenshot({ path: path.join(output, `natural-${lang}-${width}.png`) });
      assert.equal(result.overflowX, false, `no horizontal overflow at ${width}x${height}`);
      assert(result.locked && result.pageOverflow === 'hidden', `page scrolling is locked at ${width}x${height}`);
      assert(result.pageBottom <= height && result.boardViewBottom <= height, `board stays inside the viewport at ${width}x${height}: ${JSON.stringify(result)}`);
      await page.evaluate(() => window.scrollTo(0, 200));
      assert.equal(await page.evaluate(() => scrollY), 0, `page cannot scroll at ${width}x${height}`);
      assert(result.lanes.every(lane => lane.height > 0), `usable lane bodies at ${width}x${height}: ${JSON.stringify(result)}`);
      assert(result.lanes[3].scrollHeight > result.lanes[3].height && result.lanes[3].overflow === 'auto', `Shipped scrolls at ${width}x${height}`);
      assert(await page.$eval('#pu-shipped-col', el => {
        el.scrollTop = 0;
        const cards = [...el.querySelectorAll(':scope > .pu-daily-group, :scope > .pu-group')], bottom = el.getBoundingClientRect().bottom;
        return cards[4].getBoundingClientRect().top >= bottom - 9;
      }), `Shipped shows at most four cards within the available height at ${width}x${height}`);
      await page.$eval('#pu-shipped-col', el => { el.scrollTop = el.scrollHeight; });
      assert(await page.$eval('#pu-shipped-col', el => {
        const last = el.lastElementChild;
        return !last || last.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom + 1;
      }), `last shipped card fits inside its lane at ${width}x${height}`);
    }
    await page.setViewport({ width: 1920, height: 1256 });
    for (const count of [4, 5, 1, 0]) {
      await page.evaluate(count => {
        window.shippedLayoutOrders ||= _pickupOrders;
        const prep = shippedLayoutOrders.filter(order => order.pickupStatus === 'Preparing');
        _pickupOrders = [...prep, ...shippedLayoutOrders.filter(order => order.pickupStatus === 'Shipped').slice(0, count)];
        transactions = _pickupOrders;
        renderPickupBoard();
      }, count);
      await new Promise(resolve => setTimeout(resolve, 100));
      const state = await page.$eval('#pu-shipped-col', el => ({ scroll: el.classList.contains('pu-shipped-scroll'), overflow: el.scrollHeight > el.clientHeight + 1, tab: el.tabIndex }));
      assert.equal(state.scroll, count > 4, `scroll activates only after four cards (${count})`);
      assert.equal(state.overflow, count > 4, `no clipping for ${count} cards`);
      if (count > 4) assert.equal(state.tab, 0, 'scrollable shipped list is keyboard focusable');
    }
    await page.setViewport({ width: 1920, height: 1080 });
    await page.evaluate(() => {
      _pickupOrders = _pickupOrders.filter(order => order.pickupStatus === 'Preparing');
      transactions = _pickupOrders;
      renderPickupBoard();
      window.scrollTo(0, 0);
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 2), 'short board has no unnecessary page scrollbar');
    await page.screenshot({ path: path.join(output, 'natural-short-en-1920.png') });
    for (const mode of ['table', 'ready', 'board']) {
      await page.evaluate(mode => puSwitchView(mode), mode);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await page.$eval('#pu-board-view', el => !!el.getClientRects().length), mode === 'board', `${mode} view switches correctly`);
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('pu-page-locked')), mode === 'board', `page lock follows ${mode} view`);
    }
    await page.evaluate(() => navigateTo('dashboard'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('pu-page-locked')), false, 'page scroll lock is released on navigation');
    fs.writeFileSync(path.join(output, 'natural.json'), JSON.stringify(measurements, null, 2));
    assert.deepEqual(errors, []);
    console.log(`PASS pickup board: no page scrolling, content stays within viewport, Shipped scrolls internally with at most four cards, 0/1/4/5 thresholds, last card reachable, view switching and navigation cleanup (${measurements.length} sizes)`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
