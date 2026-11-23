// Several orders selected in a prep group window (Ctrl/Shift+click) → one right-click menu:
// move to another group / a new group, TAG all of them, back to pending.
// Runs over the shipped index.html with a mocked API (needs `node frontend/server.js`).
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const user = { _id: 'preview', name: 'Preview', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements'] };
const masterTags = [{ _id: 't1', name: 'VIP', color: '#fff', bg: '#a855f7' }];
const order = (n, ref, extra = {}) => ({
  _id: String(n).padStart(24, '0'), ref: '510' + n, type: 'مبيعات', client: 'Customer ' + n, date: '2026-11-14',
  total: 100 * n, remaining: 100 * n, pickupStatus: 'Preparing', pickupRef: ref, prepCreatedAt: '2026-11-14',
  shipCo: 'Bosta', phone: '0100000000' + n, items: [{ code: 'T', name: 'Basket', qty: 1, price: 100 * n }], ...extra,
});

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

async function open(browser, lang) {
  const orders = [1, 2, 3, 4].map(n => order(n, 'PREP-A')).concat([order(5, 'PREP-B'), order(6, 'PREP-B')]);
  const page = await browser.newPage(), errors = [], calls = [];
  await page.setViewport({ width: 1440, height: 950 });
  page.on('pageerror', e => errors.push(e.message));
  await page.evaluateOnNewDocument((user, lang) => {
    localStorage.clear(); localStorage.setItem('token', 'preview'); localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('soulia_lang_pref', lang);
  }, user, lang);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    const respond = (data, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
    if (url.origin !== 'http://localhost:8080') return request.respond({ status: 200, contentType: 'text/javascript', body: url.hostname === 'cdn.socket.io' ? 'window.io=()=>({on(){},emit(){},disconnect(){}})' : '' });
    if (!url.pathname.startsWith('/api/')) return request.continue();
    const route = url.pathname.slice(4), method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    if (method !== 'GET') calls.push({ route, body });
    if (route === '/transactions/pickup-orders/move-prep') {
      body.ids.forEach(id => { orders.find(x => x._id === id).pickupRef = body.targetRef; });
      return respond({ moved: body.ids.length, pickupRef: body.targetRef });
    }
    if (route === '/transactions/pickup-orders/split-prep') {
      body.ids.forEach(id => { orders.find(x => x._id === id).pickupRef = '777-14NOV'; });
      return respond({ moved: body.ids.length, pickupRef: '777-14NOV' });
    }
    const tagRoute = route.match(/^\/transactions\/([0-9a-f]{24})\/tags$/);
    if (tagRoute) { orders.find(x => x._id === tagRoute[1]).tags = body.tags; return respond({ _id: tagRoute[1], tags: body.tags }); }
    return respond(route === '/auth/me' ? user : route === '/settings' ? { lang } : route === '/tags' ? masterTags :
      ['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route) ? orders : []);
  });
  await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pu-prep-col .pu-group');
  await new Promise(r => setTimeout(r, 400));
  await page.evaluate(() => openPuCardOrdersModal('PREP-A', 'prep'));
  await page.waitForSelector('#puco-orders-list .pw-ocard');
  return { page, errors, calls, orders };
}
const cardSel = n => `#puco-orders-list .pw-ocard[data-order-id="${String(n).padStart(24, '0')}"]`;
const click = (page, n, mods = {}) => page.evaluate((sel, mods) => {
  document.querySelector(sel).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
}, cardSel(n), mods);
const rightClick = (page, n) => page.evaluate(sel => {
  const el = document.querySelector(sel), r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20, button: 2 }));
}, cardSel(n));
const menu = page => page.$$eval('.pu-ctx [data-ctx-item]', els => els.map(e => ({ text: e.textContent.trim().replace(/\s+/g, ' '), disabled: e.disabled })));
const clickItem = (page, src) => page.evaluate(src => {
  const b = [...document.querySelectorAll('.pu-ctx [data-ctx-item]')].find(e => new RegExp(src).test(e.textContent));
  if (!b) throw new Error('no menu item ' + src); b.click();
}, src);
const multiCount = page => page.$$eval('#puco-orders-list .pw-ocard.is-multi', els => els.length);

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    // ── Arabic: select, menu, move to an existing group ──
    let s = await open(browser, 'ar');
    let { page } = s;
    await click(page, 1);
    await click(page, 2, { ctrlKey: true });
    ok(await multiCount(page) === 2, 'Ctrl+click adds a second order to the selection');
    ok(await page.$eval('#pw-multi-bar', el => /2/.test(el.textContent)), 'a bar states 2 orders selected');
    await click(page, 4, { shiftKey: true });
    ok(await page.evaluate(() => [..._pwMulti].sort().join()) === ['2', '3', '4'].map(n => n.padStart(24, '0')).join(), 'Shift+click selects the range from the last Ctrl+clicked order (2–4)');
    await click(page, 3, { ctrlKey: true });
    await click(page, 4, { ctrlKey: true });
    ok(await page.evaluate(() => [..._pwMulti].join()) === '2'.padStart(24, '0'), 'Ctrl+click toggles orders off again');
    ok(await page.evaluate(() => !document.querySelector('#pw-multi-bar')), 'the bar disappears below 2 orders');
    // reset to exactly orders 1 + 2
    await click(page, 1); await click(page, 2, { ctrlKey: true });
    await rightClick(page, 2);
    await page.waitForSelector('.pu-ctx [data-ctx-item]');
    const items = await menu(page);
    ok(items.some(i => /مجموعة تحضير جديدة \(2\)/.test(i.text) && !i.disabled), 'menu: move the 2 to a new group');
    ok(items.some(i => /PREP-B/.test(i.text)), 'menu: lists the other prep group as a target');
    ok(!items.some(i => /PREP-A/.test(i.text)), 'menu: never offers the group they are in');
    ok(items.some(i => /TAG/.test(i.text)), 'menu: TAG');
    ok(items.some(i => /المعلّق \(2\)/.test(i.text)), 'menu: back to pending for the 2');
    await clickItem(page, 'PREP-B');
    await page.waitForSelector('#pu-cfdlg.active');
    ok(await page.$eval('#pu-cfdlg-msg', el => /PREP-A/.test(el.textContent) && /PREP-B/.test(el.textContent)), 'confirm names both groups');
    await page.click('#pu-cfdlg-ok');
    await page.waitForFunction(() => document.querySelectorAll('#puco-orders-list .pw-ocard').length === 2);
    const mv = s.calls.find(c => c.route === '/transactions/pickup-orders/move-prep');
    ok(mv && mv.body.sourceRef === 'PREP-A' && mv.body.targetRef === 'PREP-B' && mv.body.ids.length === 2, 'one move-prep request with both ids');
    ok(await page.evaluate(() => _puPrepGroups.find(g => g.prepRef === 'PREP-B').orders.length) === 4, 'PREP-B now holds 4 orders');
    ok(await page.evaluate(() => !document.querySelector('#pw-multi-bar') && !_pwMulti.size), 'selection cleared after the move');
    ok(!s.errors.length, 'no page errors (ar): ' + s.errors.join(' | '));
    await page.close();

    // ── TAG on the selection, Escape clears, all selected → no «new group» ──
    s = await open(browser, 'en'); page = s.page;
    await click(page, 1); await click(page, 3, { ctrlKey: true });
    await rightClick(page, 3);
    await page.waitForSelector('.pu-ctx [data-ctx-item]');
    await clickItem(page, '^\\s*TAG');
    await page.waitForSelector('.pu-tagpick [data-tag="VIP"]');
    await page.click('.pu-tagpick [data-tag="VIP"]');
    await page.waitForFunction(() => _pickupOrders.filter(o => (o.tags || []).includes('VIP')).length === 2);
    const tagCalls = s.calls.filter(c => /\/tags$/.test(c.route));
    ok(tagCalls.length === 2, 'TAG sent once per selected order: ' + tagCalls.length);
    ok(s.orders.filter(o => (o.tags || []).includes('VIP')).map(o => o.ref).sort().join() === '5101,5103', 'only the selected orders got the TAG');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => !_pwMulti.size) && await page.$eval('#pu-card-orders-modal', el => el.classList.contains('active')), 'Escape clears the selection before closing the window');
    await page.evaluate(() => { _pwMulti.clear(); ['000000000000000000000001','000000000000000000000002','000000000000000000000003','000000000000000000000004'].forEach(id => _pwMulti.add(id)); _pwPaintMulti(); });
    await rightClick(page, 2);
    await page.waitForSelector('.pu-ctx [data-ctx-item]');
    ok((await menu(page)).some(i => /new prep group \(4\)/.test(i.text) && i.disabled), 'all orders selected → «new group» disabled');
    await page.keyboard.press('Escape');
    await click(page, 2);
    ok(await multiCount(page) === 0 && await page.evaluate(() => _pwSelId === '000000000000000000000002'), 'a plain click goes back to one order');
    ok(!s.errors.length, 'no page errors (en): ' + s.errors.join(' | '));
    await page.close();
    console.log(`pickup-prep-multi-select: ${passed} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
