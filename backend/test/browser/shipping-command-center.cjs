/* Real shipped UI with intercepted APIs. No customer or carrier mutations. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../../..');
const publicDir = path.join(root, 'frontend/public');
const runtimeDir = process.env.TEST_RUNTIME ? path.join(root, 'frontend/runtime') : publicDir;
const artifacts = path.join(root, 'artifacts/shipping-command-center');
fs.mkdirSync(artifacts, { recursive: true });

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test') {
        const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
        const built = path.join(runtimeDir, relative);
        const file = fs.existsSync(built) ? built : path.join(publicDir, relative);
        if ((file.startsWith(publicDir + path.sep) || file.startsWith(runtimeDir + path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
          return request.respond({ status: 200, contentType: type, body: fs.readFileSync(file) });
        }
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'load' });
    // The fixture calls legacy globals directly and replaces onPageEnter below,
    // bypassing navigateTo's normal route-dependency gate.
    if (process.env.TEST_RUNTIME) await page.evaluate(() => window.souliaLibraryReady('shopifyOrders'));
    await page.evaluate(() => {
      currentUser = { _id: 'shipping-admin', name: 'Operations', role: 'admin', perms: [] }; currentLang = 'en';
      document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr';
      qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      onPageEnter = () => {}; api = async () => ({});
      _ensureDashFollowUps = async () => false; loadDutyBoard = async () => {}; _dutyTimerSync = () => {};
      const states = ['Preparing', 'Ready', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_ATTEMPT'];
      const clients = ['Mariam Hassan', 'Nour El Din', 'Salma Mostafa', 'Omar Adel', 'Lobna Abdelaziz', 'Dina Khaled'];
      window.shippingFixture = Array.from({ length: 67 }, (_, index) => {
        const key = states[index % states.length], carrier = index % 3 ? 'Bosta' : 'Aramex';
        return { _id: 'ship-' + index, ref: String(38210 + index), type: 'مبيعات', client: clients[index % clients.length],
          date: new Date(Date.UTC(2026, 10, 1 + index % 8)).toISOString(), shipCo: carrier,
          pickupStatus: key === 'Preparing' || key === 'Ready' ? key : 'Shipped',
          ...(key === 'Preparing' ? {} : { bostaOrderId: 'b-' + index, bostaStatus: key === 'Ready' ? 'CREATED' : key, bostaTrackingNumber: 'SOU' + (902100 + index) }),
          ...(key === 'Preparing' || key === 'Ready' ? {} : { shippedAt: '2026-11-02T08:00:00Z' }),
          bostaIsDelayed: key === 'IN_TRANSIT' && index % 2 === 0,
          ...(key === 'FAILED_ATTEMPT' ? { shipIssueState: 'open', phone: '01000000000' } : {}),
          ...(key === 'DELIVERED' ? { deliveredAt: '2026-11-06T10:00:00Z' } : {}),
        };
      });
      shippingFixture.push({ ...shippingFixture[6], _id: 'settled', shipIssueState: 'closed' });
      shippingFixture.push({ ...shippingFixture[0], _id: 'waiting', pickupStatus: 'Pending' });
      shippingFixture.push({ ...shippingFixture[3], _id: 'cancelled', cancelled: true });
      transactions = structuredClone(shippingFixture); followUps = [];
      inventoryCache = [{ status: 'low', isActive: true }, { status: 'low', isActive: false }, { status: 'ok' }];
      _dutyBoard = { onDuty: [{ userId: 'mariam', name: 'Mariam Hassan', shiftStart: '09:00', shiftEnd: '17:00', remainingMinutes: 125, receivesOrders: true }, { userId: 'omar', name: 'Omar Adel', shiftStart: '10:00', shiftEnd: '18:00', remainingMinutes: 185 }], nextUp: [], onLeave: [] };
      buildSidebar(); navigateTo('dashboard'); _renderStaffDashboard(true);
      const style = document.createElement('style');
      style.textContent = '#page-dashboard > :not(#shipping-command-center){display:none!important}';
      document.head.append(style);
    });
    await page.setViewport({ width: 1440, height: 1000 });
    assert.equal(await page.$$eval('#scc-body tr', rows => rows.length), 20);
    assert.equal(await page.$$eval('.scc-kpi', rows => rows.length), 4);
    assert.equal(await page.$$eval('#scc-head th', rows => rows.length), 7);
    assert.equal(await page.$$eval('.scc-filters .fsel-btn', els => els.length), 3);
    assert.ok(await page.$$eval('.scc-filters select', els => els.every(el => el.tabIndex === -1 && el.getBoundingClientRect().width <= 1)));
    const total = await page.$eval('#scc-pipeline-total', el => el.textContent);
    assert.match(total, /69/);
    await page.click('.scc-kpi[data-ship-stage="Ready"]');
    assert.ok(await page.$$eval('#scc-body [data-order-state]', els => els.every(el => el.dataset.orderState === 'Ready')));
    assert.match(page.url(), /shipStage=Ready/);
    await page.click('#scc-stages [data-ship-stage="Preparing"]');
    assert.equal(await page.$$eval('#scc-body tr', rows => rows.length), 10);
    await page.click('#scc-reset');
    await page.type('#scc-search', 'SOU902103');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await page.$$eval('#scc-body tr', rows => rows.length), 1);
    assert.match(await page.$eval('#scc-body', el => el.textContent), /38213/);
    await page.click('#scc-reset');
    await page.click('#scc-carrier-trigger');
    await page.click('#scc-carrier-listbox [data-val="Aramex"]');
    assert.equal(await page.$eval('#scc-carrier-trigger .fsel-lbl', el => el.textContent), 'Aramex');
    assert.ok(await page.$$eval('#scc-body tr td:nth-child(3)', els => els.every(el => el.textContent.includes('Aramex'))));
    await page.click('#dash-attn [data-ship-attention="delayed"]');
    assert.equal(await page.$eval('#scc-carrier', el => el.value), '');
    assert.ok(await page.$$eval('#scc-body .order-delay-badge', els => els.length > 0));
    await page.click('#dash-attn [data-ship-attention="failed"]');
    assert.equal(await page.$('#scc-body tr[data-order-id="settled"]'), null);
    assert.ok(await page.$('#scc-body .ds-ship-action'));
    await page.click('#scc-reset');
    await page.click('#scc-next');
    assert.match(page.url(), /shipPage=2/);
    await page.select('#scc-sort', 'date-asc');
    assert.equal(await page.$eval('#scc-head th[aria-sort="ascending"]', el => el.textContent.trim().replace(/\s+/g, ' ')), 'Order date ↑');
    assert.ok(!page.url().includes('shipPage='));
    const stability = await page.evaluate(() => {
      const row = qs('#scc-body tr'), button = row.querySelector('button'); button.focus();
      const observer = new MutationObserver(() => {}); observer.observe(qs('#scc-body'), { subtree: true, childList: true, attributes: true });
      SouliaShipping.render(transactions);
      const result = { same: row.isConnected, focused: document.activeElement === button, changes: observer.takeRecords().length };
      observer.disconnect(); return result;
    });
    assert.deepEqual(stability, { same: true, focused: true, changes: 0 });
    const ages = await page.evaluate(() => [
      SouliaShipping.shipmentAge({ date: '2020-01-01', bostaLastSync: new Date().toISOString() }, { key: 'IN_TRANSIT' }),
      SouliaShipping.shipmentAge({ shippedAt: '2020-01-01' }, { key: 'Ready' }),
      SouliaShipping.shipmentAge({ shippedAt: new Date(Date.now() - 86400000 * 5).toISOString(), bostaLastSync: new Date().toISOString() }, { key: 'IN_TRANSIT' }),
    ]);
    assert.deepEqual(ages, [null, null, 5]);
    await page.evaluate(() => {
      window.savedOpenOrder = openOrderView; window.openedOrder = null; openOrderView = id => { openedOrder = id; };
    });
    await page.click('#scc-body .scc-order-link');
    assert.ok(await page.evaluate(() => openedOrder));
    await page.evaluate(() => { openOrderView = savedOpenOrder; });
    await page.click('#scc-body .dd-toggle');
    assert.equal(await page.evaluate(() => document.activeElement.matches('.dd-menu-portal button')), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.matches('.dd-toggle')), true);
    await page.evaluate(() => {
      history.replaceState(history.state, '', '?shipStage=Ready&shipCarrier=Bosta&shipSort=date-asc#dashboard');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    assert.equal(await page.$eval('#scc-status', el => el.value), 'Ready');
    assert.equal(await page.$eval('#scc-carrier', el => el.value), 'Bosta');
    assert.ok(await page.$$eval('#scc-body tr td:nth-child(3)', els => els.every(el => el.textContent.includes('Bosta'))));
    const skillPath = 'C:/Users/UAS/.codex/skills/design-taste-frontend/scripts/lib/';
    const inspector = fs.existsSync(skillPath + 'probe.mjs') ? await import(pathToFileURL(skillPath + 'probe.mjs').href) : null;
    const rules = inspector ? await import(pathToFileURL(skillPath + 'rules.mjs').href) : null;
    const inspections = [];
    for (const [width, lang, dark] of [[1440, 'en', false], [1440, 'ar', false], [1024, 'en', false], [390, 'ar', false], [390, 'ar', true]]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(({ lang, dark }) => {
        currentLang = lang; document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.body.classList.toggle('dark-mode', dark); applyLang(); SouliaShipping.select('all', true); renderDutyBoard();
      }, { lang, dark });
      await new Promise(resolve => setTimeout(resolve, 250));
      await page.click('#scc-status-trigger');
      await page.waitForSelector('#scc-status-listbox.show');
      await new Promise(resolve => setTimeout(resolve, 50));
      const menu = await page.$eval('#scc-status-listbox', el => {
        const r = el.getBoundingClientRect();
        const list = el.querySelector('.fsel-list');
        return { fits: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
          verticalOnly: getComputedStyle(list).overflowX === 'hidden' && list.scrollWidth <= list.clientWidth,
          searchable: !!el.querySelector('input'), options: el.querySelectorAll('[role="option"]').length };
      });
      assert.ok(menu.fits && menu.searchable && menu.options > 7, `${width}/${lang}: dropdown fits and supports search`);
      assert.ok(menu.verticalOnly, `${width}/${lang}: filter list has no horizontal overflow`);
      await page.evaluate(() => SouliaShipping.render(transactions));
      assert.equal(await page.$eval('#scc-status-trigger', el => el.getAttribute('aria-expanded')), 'true', 'Unchanged refresh preserves open filter');
      await page.screenshot({ path: path.join(artifacts, `filters-${lang}-${width}${dark ? '-dark' : ''}.png`) });
      const query = lang === 'en' ? 'Ready to Ship' : 'جاهز للشحن';
      await page.type('#scc-status-listbox input', query);
      assert.equal(await page.$$eval('#scc-status-listbox .fsel-opt', els => els.length), 1);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      assert.equal(await page.$eval('#scc-status', el => el.value), 'Ready');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'scc-status-trigger');
      await page.click('#scc-sort-trigger');
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'scc-sort-trigger');
      await page.click('#scc-reset');
      assert.equal(await page.$eval('#scc-status-trigger', el => el.classList.contains('is-active')), false);
      await new Promise(resolve => setTimeout(resolve, 180));
      await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); qs('#main').scrollTop = 0; });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}/${lang}: page overflow`);
      await page.screenshot({ path: path.join(artifacts, `${lang}-${width}${dark ? '-dark' : ''}.png`), fullPage: true });
      if (inspector) {
        // Inspect only the changed section; the ERP keeps many unrelated,
        // off-screen dialogs mounted in the same document.
        const snapshot = await page.evaluate(() => ({
          css: [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules].map(rule => rule.cssText); } catch { return []; } }).join('\n'),
          markup: qs('#shipping-command-center').outerHTML,
        }));
        const isolated = await browser.newPage();
        await isolated.setViewport({ width, height: 1000 });
        await isolated.setContent(`<html dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><style>${snapshot.css}</style></head><body class="${dark ? 'dark-mode' : ''}" style="padding:16px"><main class="dashboard-v2">${snapshot.markup}</main></body></html>`);
        const metrics = await isolated.evaluate(inspector.probe), app = await isolated.evaluate(inspector.app);
        // This is a section inside the established ERP, whose page heading is
        // outside this isolated shipping screenshot; retaining h3 is intentional.
        inspections.push({ width, lang, dark, findings: rules.judgeApp(app, metrics, { width, allow: ['no-title'] }) });
        await isolated.close();
      }
    }
    await page.evaluate(() => {
      currentUser = { _id: 'staff', role: 'staff', perms: ['dashboard'] }; SouliaShipping.render(transactions); renderDutyBoard();
    });
    assert.equal(await page.$('.scc-kpi[data-ship-stage="DELIVERED"]'), null);
    assert.equal(await page.$('#scc-stages [data-ship-stage="DELIVERED"]'), null);
    assert.equal(await page.$('#scc-status option[value="DELIVERED"]'), null);
    assert.equal(await page.$('.scc-manage-team'), null);
    await page.evaluate(() => SouliaShipping.select('DELIVERED'));
    assert.notEqual(await page.$eval('#scc-status', el => el.value), 'DELIVERED');
    await page.evaluate(() => { currentUser = { _id: 'admin', role: 'admin' }; transactions = []; SouliaShipping.render([]); });
    assert.equal(await page.$eval('#scc-empty', el => el.hidden), false);
    assert.equal(await page.$$eval('#scc-body tr', els => els.length), 0);
    await page.evaluate(() => { window.savedLoadFailed = loadFailed; loadFailed = key => key === 'transactions'; SouliaShipping.render([]); });
    assert.ok(await page.$$eval('.scc-kpi strong', els => els.every(el => el.textContent === '—')));
    assert.ok(await page.$('#scc-empty button'));
    await page.evaluate(() => { loadFailed = savedLoadFailed; });
    const performance = await page.evaluate(() => {
      const large = Array.from({ length: 5000 }, (_, index) => ({ ...shippingFixture[index % 67], _id: 'large-' + index }));
      const start = performance.now(); SouliaShipping.render(large);
      return { rows: large.length, mounted: qs('#scc-body').children.length, renderMs: Math.round(performance.now() - start) };
    });
    assert.equal(performance.mounted, 20);
    fs.writeFileSync(path.join(artifacts, 'validation.json'), JSON.stringify({ performance, inspections }, null, 2));
    assert.deepEqual(errors, []);
    console.log('PASS: shipping counts, stages, search, carrier, exceptions, pagination, sorting, stable refresh, real shipment age, order actions, permissions, empty state, RTL and responsive layouts.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
