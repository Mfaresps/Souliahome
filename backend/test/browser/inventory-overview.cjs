// Inventory overview (Nov 15, 2026): ready to sell / reserved / needs attention / incoming,
// one state per product, tabs, ready-first sort and the details popover. Runs over the shipped page.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const output = path.resolve(__dirname, '../../../artifacts/inventory-overview');
const row = (id, code, name, current, extra = {}) => ({ _id: id, code, name, sellPrice: 100, buyPrice: 50, current,
  warehouseBalances: { MAIN: current }, openingBalance: 0, purchases: current, sales: 0, returnsToStock: 0, minStock: 2, isActive: true, ...extra });
const stock = [
  row('p-ok', 'OK-1', 'Plenty', 20),                                   // ready 20
  row('p-res', 'RES-1', 'Reserved some', 6),                            // 2 reserved → on hand 8, ready 6
  row('p-issue', 'ISS-1', 'Has damage', 5),                             // 1 damaged + 1 lost + 1 inspection → ready 2 → low
  row('p-out', 'OUT-1', 'Sold out', 0),                                 // incoming 10 → out, covered
  row('p-reorder', 'RO-1', 'Needs buying', 1),                          // low, nothing incoming → reorder
  row('p-neg', 'NEG-1', 'Negative', -19, { isActive: false }),
  row('p-inact', 'IN-1', 'Old stock', 3, { isActive: false }),
];
const breakdown = {
  'p-res': { byWarehouse: { MAIN: { reserved: 2, reservedOrders: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', ref: '3150', client: 'Mona', qty: 2, stage: 'Preparing' }], damaged: 0, lost: 0, inspection: 0 } }, incoming: 0, incomingOrders: [] },
  'p-issue': { byWarehouse: { MAIN: { reserved: 0, reservedOrders: [], damaged: 1, lost: 1, inspection: 1 } }, incoming: 0, incomingOrders: [] },
  'p-out': { byWarehouse: {}, incoming: 10, incomingOrders: [{ id: 'po1', poNumber: 'PO-2026-013', supplier: 'Talla Home', qty: 10, status: 'معلق', expected: '2026-11-20' }] },
};
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  let passed = 0;
  const ok = (cond, msg) => { assert(cond, msg); passed++; };
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('token', 'inventory-overview-test');
      localStorage.setItem('user', JSON.stringify({ name: 'Owner', role: 'admin', perms: [] }));
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return request.continue();
      const respond = data => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      if (pathname === '/api/transactions/inventory') return respond(stock);
      if (pathname === '/api/transactions/inventory/breakdown') return respond(breakdown);
      if (pathname === '/api/auth/me') return respond({ name: 'Owner', role: 'admin', perms: [] });
      if (pathname === '/api/settings') return respond({ lang: 'ar' });
      if (pathname === '/api/notifications' || pathname === '/api/notifications/preferences') return respond({ preferences: { enabled: false }, subscriptions: [] });
      if (pathname === '/api/products') return respond(stock);
      if (pathname === '/api/warehouses') return respond([{ code: 'MAIN', name: 'Main', active: true, isDefault: true }]);
      if (pathname === '/api/transactions/startup-overview') return respond({ rows: [], activeCount: 0 });
      if (pathname === '/api/collections/product-links') return respond({});
      return respond([]);
    });
    await page.goto(origin + '/#inventory', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof currentPage !== 'undefined' && currentPage === 'inventory' && !document.querySelector('#splash-screen'));
    await page.waitForFunction(() => window.InvOverview?.loaded() && document.querySelectorAll('#inv-tbody .inv-row').length === 7);
    await new Promise(r => setTimeout(r, 300));

    const read = () => page.evaluate(() => [...document.querySelectorAll('#inv-tbody .inv-row')].map(tr => ({
      key: tr.dataset.key, state: [...tr.classList].find(c => c.startsWith('is-') && c !== 'is-inactive-row'),
      ready: tr.querySelector('.invo-ready strong')?.textContent.trim(),
      caption: tr.querySelector('.invo-ready small')?.textContent.trim(),
      reserved: (tr.children[6].querySelector('strong') || tr.children[6]).textContent.trim(),
      issue: (tr.children[7].querySelector('strong') || tr.children[7]).textContent.trim(),
      incoming: (tr.children[8].querySelector('strong') || tr.children[8]).textContent.trim(),
      label: tr.querySelector('.invo-state')?.textContent.trim(), stateCell: tr.children[9].textContent.replace(/\s+/g, ' '),
    })));
    let rows = await read();
    const by = Object.fromEntries(rows.map(r => [r.key, r]));
    ok(by['RES-1'].ready === '6' && by['RES-1'].reserved === '2' && /8/.test(by['RES-1'].caption), 'reserved: ready 6, reserved 2, in stock 8');
    ok(by['ISS-1'].ready === '2' && by['ISS-1'].issue === '3' && by['ISS-1'].state === 'is-low', 'needs attention 3 → ready 2, low');
    ok(by['OUT-1'].state === 'is-out' && by['OUT-1'].incoming === '10' && /وارد 10/.test(by['OUT-1'].stateCell), 'out of stock names incoming');
    ok(by['NEG-1'].state === 'is-negative' && by['NEG-1'].ready === '-19', 'negative balance shown as a problem, not «out»');
    ok(by['IN-1'].state === 'is-inactive-stock' && by['IN-1'].label === 'متوقف' && /ما زال به رصيد/.test(by['IN-1'].stateCell), 'discontinued with stock');
    ok(by['OK-1'].label.includes('متوفر'), 'plenty in stock');

    // Ready-to-sell first: active rows by ready desc, discontinued last.
    ok(JSON.stringify(rows.map(r => r.key)) === JSON.stringify(['OK-1', 'RES-1', 'ISS-1', 'RO-1', 'OUT-1', 'IN-1', 'NEG-1']), 'default sort: ready to sell first, discontinued last: ' + rows.map(r => r.key));

    // Summary cards.
    const cards = await page.$$eval('#inv-summary-cards .invo-card:not(.is-money)', els => els.map(el => el.querySelector('.invo-card-val').textContent.trim()));
    ok(JSON.stringify(cards) === JSON.stringify(['29', '2', '3', '10']), 'summary: ready 29, reserved 2, attention 3, incoming 10: ' + cards);

    // Tabs.
    const counts = await page.$$eval('#inv-toolbar .invo-tab', els => Object.fromEntries(els.map(el => [el.dataset.status, el.hidden ? 'hidden' : el.querySelector('.fx-btn-count').textContent.trim()])));
    ok(counts.all === '7' && counts.ready === '4' && counts.reorder === '2' && counts.issue === '1' && counts.negative === '1' && counts.inactive === '2', 'tab counts ' + JSON.stringify(counts));
    await page.click('#inv-toolbar [data-status="reorder"]');
    ok(JSON.stringify((await read()).map(r => r.key)) === '["ISS-1","RO-1"]', 'reorder tab: low with nothing incoming (the sold-out one is covered by a PO)');
    await page.evaluate(() => setInvFilter('low', null));
    ok(await page.$eval('#inv-toolbar [data-status="reorder"]', el => el.classList.contains('active')), 'old «low» link opens the reorder tab');
    await page.evaluate(() => window.InvOverview.setFilter('reserved'));
    ok(JSON.stringify((await read()).map(r => r.key)) === '["RES-1"]', 'reserved card filters the list');
    await page.evaluate(() => setInvFilter('all', null));

    // Popover.
    await page.click('#inv-tbody tr[data-key="RES-1"] [data-invo-open="reserved"]');
    const pop = await page.$eval('.invo-pop', el => el.textContent);
    ok(/3150/.test(pop) && /Mona/.test(pop) && /قيد التجهيز/.test(pop), 'reserved popover lists the order and its stage');
    await page.screenshot({ path: path.join(output, 'ar-1440.png') });
    await page.keyboard.press('Escape');
    ok(!(await page.$('.invo-pop')), 'Escape closes the popover');
    await page.click('#inv-tbody tr[data-key="OUT-1"] [data-invo-open="incoming"]');
    ok(/PO-2026-013/.test(await page.$eval('.invo-pop', el => el.textContent)), 'incoming popover lists the purchase order');
    await page.keyboard.press('Escape');

    // Global search states the same figures as the inventory page.
    const searchLine = await page.evaluate(() => {
      searchResults = ['p-res', 'p-out', 'p-neg', 'p-ok'].map(id => ({ type: 'product', id, title: id, meta: '' }));
      const dd = document.querySelector('#search-dropdown'); dd.classList.add('active'); renderSearchDropdown();
      const text = [...dd.querySelectorAll('.search-product-meta')].map(el => el.textContent.replace(/\s+/g, ' ').trim());
      dd.classList.remove('active'); dd.innerHTML = ''; searchResults = [];
      return text;
    });
    ok(searchLine.length === 4, 'search lists the products ' + searchLine.length);
    ok(/صالح للبيع: 6/.test(searchLine[0]) && /محجوز 2/.test(searchLine[0]) && !/متوفر/.test(searchLine[0]), 'search: ready to sell 6 · reserved 2: ' + searchLine[0]);
    ok(/لا يوجد صالح للبيع/.test(searchLine[1]) && /وارد 10/.test(searchLine[1]), 'search: nothing ready, incoming named: ' + searchLine[1]);
    ok(/رصيد سالب -19/.test(searchLine[2]), 'search: negative balance: ' + searchLine[2]);
    ok(/صالح للبيع: 20/.test(searchLine[3]), 'search: plenty');

    // Stock actions: one menu per row instead of two stacked buttons.
    await page.evaluate(() => { window.hasPerm = () => true; window.__opened = [];
      window.LegacyStockLabels.open = id => window.__opened.push('codes:' + id); window.ProductStocktake.open = id => window.__opened.push('count:' + id); renderInventory(); });
    await new Promise(r => setTimeout(r, 600)); // rows finish their entrance animation
    ok(await page.$$eval('#inv-tbody tr[data-key="OK-1"] .legacy-stock-trigger', b => b.length === 0), 'no stacked buttons in the row');
    await page.click('#inv-tbody tr[data-key="OK-1"] .invo-more');
    const items = await page.$$eval('.invo-menu [role=menuitem] b', b => b.map(x => x.textContent));
    ok(JSON.stringify(items) === JSON.stringify(['أكواد القطع', 'جرد المنتج']), 'menu lists the two commands: ' + items);
    ok(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'menuitem'), 'focus moves into the menu');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    ok(JSON.stringify(await page.evaluate(() => window.__opened)) === '["count:p-ok"]', 'keyboard: «جرد المنتج» opens the product stocktake');
    ok(!(await page.$('.invo-menu')), 'menu closes after a choice');
    await page.screenshot({ path: path.join(output, 'menu-ar.png') });
    await page.click('#inv-tbody tr[data-key="OK-1"] .invo-more');
    await page.screenshot({ path: path.join(output, 'menu-open-ar.png'), clip: { x: 0, y: 300, width: 900, height: 360 }, captureBeyondViewport: false });
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => document.activeElement?.classList.contains('invo-more')), 'Escape returns focus to the menu button');
    ok(await page.$eval('#inv-tbody tr[data-key="RES-1"] .invo-ready', el => /من 8 في المخزن/.test(el.textContent) && /محجوز 2/.test(el.title)), 'ready figure reads «of N in stock», parts in the tooltip');

        // English, dark, phone.
    await page.evaluate(() => { currentLang = 'en'; document.documentElement.dir = 'ltr'; applyLang(); document.body.classList.add('dark-mode'); });
    await new Promise(r => setTimeout(r, 300));
    rows = await read();
    ok(rows.find(r => r.key === 'NEG-1').label === 'Negative balance' && /Count needed/.test(rows.find(r => r.key === 'NEG-1').stateCell), 'English state label');
    ok(await page.$eval('#inv-table thead', el => /Ready to sell/.test(el.textContent) && /Reserved for orders/.test(el.textContent) && /Needs attention/.test(el.textContent) && /Incoming/.test(el.textContent)), 'English column headings');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll at 1440');
    await page.screenshot({ path: path.join(output, 'en-1440-dark.png') });
    // The inventory page itself never widens the page at 1024 / 1280 (the table scrolls inside its card).
    for (const width of [1024, 1280]) {
      await page.setViewport({ width, height: 900 });
      await new Promise(r => setTimeout(r, 200));
      ok(await page.evaluate(() => { const page = document.querySelector('#page-inventory').getBoundingClientRect(); const wrap = document.querySelector('#inv-panel-list .overflow-x');
        return page.left >= -1 && page.right <= innerWidth + 1 && wrap.getBoundingClientRect().right <= innerWidth + 1 && getComputedStyle(wrap).overflowX === 'auto'; }), `inventory page fits at ${width}`);
    }
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => { currentLang = 'ar'; document.documentElement.dir = 'rtl'; applyLang(); document.body.classList.remove('dark-mode'); renderInventory(); });
    await new Promise(r => setTimeout(r, 300));
    ok(await page.$$eval('#inv-mobile-list .invo-card-row', els => els.length === 7), 'phone cards');
    ok(await page.$eval('#inv-mobile-list .invo-card-row.is-low', el => /يحتاج مراجعة 3/.test(el.textContent)), 'phone card names what needs attention');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll at 390');
    ok(await page.$$eval('#inv-mobile-list .invo-card-row', cards => cards.every(card => {
      const a = card.querySelector('.invo-more')?.getBoundingClientRect(), b = card.querySelector('.invo-card-ready')?.getBoundingClientRect();
      return !a || !b || a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    })), 'phone card: the actions button never covers the ready figure');
    await page.screenshot({ path: path.join(output, 'ar-390.png'), fullPage: false });
    assert.deepEqual(errors, []);
    console.log(`PASS inventory overview: ${passed} checks`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
