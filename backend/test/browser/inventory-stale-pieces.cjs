// Review of pieces stuck on «مُجهزة» (Nov 15, 2026): list, filters, nothing sent before approval,
// in-dialog confirmation, one request per approved piece with its version and target, failures named.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const output = path.resolve(__dirname, '../../../artifacts/inventory-stale-pieces');
const stock = [{ _id: 'p1', code: 'SKU-1', name: 'Basket', sellPrice: 100, buyPrice: 50, current: 4, warehouseBalances: { MAIN: 4 }, minStock: 1, isActive: true }];
const row = (i, proposal, review = null) => ({ unitId: String(i).padStart(24, 'a'), version: 3, manualCode: `U-0000-00${i}-1`, barcode: 'SU-X', warehouseCode: 'MAIN',
  product: { id: 'p1', name: 'Basket', code: 'SKU-1' }, registeredAt: '2026-10-01T10:00:00Z',
  order: { id: String(i).padStart(24, 'b'), ref: String(3000 + i), client: 'Client ' + i, pickupStatus: proposal === 'delivered' ? 'Delivered' : 'Shipped', bostaStatus: review ? 'RETURNED' : 'DELIVERED', shippedAt: '2026-10-03', deliveredAt: proposal === 'delivered' ? '2026-10-05' : null, cancelled: false },
  lastEvent: { action: 'prepared', at: '2026-10-02T09:00:00Z', by: 'Reem', reason: '' }, proposal, review });
let data = { rows: [row(1, 'delivered'), row(2, 'delivered'), row(3, 'shipped'), row(4, null, 'order-returned')], summary: { total: 4, delivered: 2, shipped: 1, review: 1 } };
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  let passed = 0; const ok = (c, m) => { assert(c, m); passed++; };
  try {
    const page = await browser.newPage(), errors = [], posts = [];
    page.on('pageerror', error => errors.push(error.stack));
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('token', 'stale-test');
      localStorage.setItem('user', JSON.stringify({ name: 'Owner', role: 'admin', perms: [] }));
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (!pathname.startsWith('/api/')) return request.continue();
      const respond = (d, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(d) });
      if (pathname === '/api/inventory-units/stale-prepared/correct') {
        const body = JSON.parse(request.postData()); posts.push(body);
        if (body.unitId === row(2).unitId) return respond({ message: 'تغيّرت حالة الطلب منذ المراجعة؛ حدّث القائمة' }, 409);
        data = { ...data, rows: data.rows.filter(r => r.unitId !== body.unitId) };
        data.summary = { total: data.rows.length, delivered: data.rows.filter(r => r.proposal === 'delivered').length, shipped: data.rows.filter(r => r.proposal === 'shipped').length, review: data.rows.filter(r => !r.proposal).length };
        return respond({ unit: { status: body.target } });
      }
      if (pathname === '/api/inventory-units/stale-prepared') return respond(data);
      if (pathname === '/api/transactions/inventory') return respond(stock);
      if (pathname === '/api/transactions/inventory/breakdown') return respond({});
      if (pathname === '/api/auth/me') return respond({ name: 'Owner', role: 'admin', perms: [] });
      if (pathname === '/api/settings') return respond({ lang: 'ar' });
      if (pathname === '/api/notifications' || pathname === '/api/notifications/preferences') return respond({ preferences: { enabled: false }, subscriptions: [] });
      if (pathname === '/api/products') return respond(stock);
      if (pathname === '/api/warehouses') return respond([{ code: 'MAIN', name: 'Main', active: true, isDefault: true }]);
      if (pathname === '/api/transactions/startup-overview') return respond({ rows: [], activeCount: 0 });
      return respond([]);
    });
    await page.goto(origin + '/#inventory', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof currentPage !== 'undefined' && currentPage === 'inventory' && !document.querySelector('#splash-screen'));
    await page.waitForFunction(() => { const n = document.querySelector('#inv-stale-notice'); return n && !n.hidden; });
    ok(/4 قطعة/.test(await page.$eval('#inv-stale-notice', el => el.textContent)), 'notice states the count');
    await page.click('#inv-stale-notice button');
    await page.waitForSelector('#isp-dialog[open] .isp-table tbody tr');
    const rowsShown = await page.$$eval('.isp-table tbody tr', trs => trs.length);
    ok(rowsShown === 4, 'all stuck pieces listed');
    const first = await page.$eval('.isp-table tbody tr', tr => tr.textContent);
    ok(/U-0000-001-1/.test(first) && /#3001/.test(first) && /Client 1/.test(first) && /Reem/.test(first) && /تم التسليم/.test(first), 'row shows piece, order, last movement and proposal');
    ok(await page.$eval('.isp-table tbody tr.is-review', tr => !tr.querySelector('input[type=checkbox]') && /مرتجع/.test(tr.textContent)), 'returned order: no checkbox, asks for a decision');
    ok(await page.$eval('#isp-approve', b => b.disabled), 'approve disabled with nothing selected');
    await page.click('[data-isp-filter="shipped"]');
    ok((await page.$$eval('.isp-table tbody tr', t => t.length)) === 1, 'filter: with the carrier');
    await page.click('[data-isp-filter="all"]');
    await page.click('#isp-page-check');
    ok(/\(3\)/.test(await page.$eval('#isp-approve', b => b.textContent)), 'select page picks the 3 correctable pieces');
    await page.click('#isp-approve');
    ok(!(await page.$eval('#isp-confirm', b => b.hidden)) && posts.length === 0, 'first click asks, sends nothing');
    ok(/«تم التسليم»: 2/.test(await page.$eval('#isp-confirm', b => b.textContent)), 'confirmation names what will change');
    await page.screenshot({ path: path.join(output, 'confirm-ar.png') });
    const box = await page.$eval('#isp-dialog', d => { const r = d.getBoundingClientRect(); const cs = getComputedStyle(d); return { l: r.left, r: r.right, w: innerWidth, m: cs.margin, pos: cs.position, inset: cs.inset, cw: document.documentElement.clientWidth }; }); ok(Math.abs((box.l + box.r) / 2 - box.cw / 2) <= 8, 'dialog centred ' + JSON.stringify(box));
    await page.click('[data-isp-no]');
    ok(await page.$eval('#isp-confirm', b => b.hidden) && posts.length === 0, 'back cancels');
    await page.click('#isp-approve');
    await page.click('[data-isp-yes]');
    await page.waitForFunction(() => document.querySelector('.isp-result'));
    ok(posts.length === 3, 'one request per piece');
    ok(posts.every(p => p.expectedVersion === 3 && p.reason.length >= 5 && /^stale-/.test(p.operationKey)), 'each request carries the version, reason and its own key');
    ok(posts.find(p => p.unitId === row(3).unitId).target === 'shipped' && posts.find(p => p.unitId === row(1).unitId).target === 'delivered', 'targets follow the proposal');
    const result = await page.$eval('.isp-result', el => el.textContent);
    ok(/تم تصحيح 2/.test(result) && /لم تُصحَّح 1/.test(result) && /U-0000-002-1/.test(result), 'result names the failed piece and why');
    ok((await page.$$eval('.isp-table tbody tr', t => t.length)) === 2, 'list reloaded: failed + review remain');
    await page.screenshot({ path: path.join(output, 'result-ar.png') });
    await page.evaluate(() => { document.querySelector('#isp-dialog').close(); currentLang = 'en'; document.documentElement.dir = 'ltr'; applyLang(); window.InventoryStalePieces.open(); });
    await page.waitForSelector('#isp-dialog[open] .isp-table tbody tr');
    ok(/With the carrier|Delivered/.test(await page.$eval('.isp-table', t => t.textContent)), 'English');
    await page.setViewport({ width: 390, height: 844 });
    ok(await page.evaluate(() => document.querySelector('#isp-dialog').getBoundingClientRect().width <= innerWidth), 'fits a phone');
    await page.evaluate(() => { document.querySelector('#isp-dialog').close(); currentUser.role = 'staff'; window.InventoryStalePieces.refreshNotice(true); });
    await new Promise(r => setTimeout(r, 200));
    ok(await page.$eval('#inv-stale-notice', n => n.hidden), 'staff never see it');
    assert.deepEqual(errors, []);
    console.log(`PASS stale pieces review: ${passed} checks`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
