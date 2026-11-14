// Right-click menus on «قيد التجهيز»: group card (open / TAG / merge into / back to pending)
// and order card in the workspace (new prep group / TAG / back to pending), plus tag pills.
// Runs over the shipped index.html with a mocked API (needs `node frontend/server.js`).
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const user = { _id: 'preview', name: 'Preview', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements'] };
const masterTags = [{ _id: 't1', name: 'VIP', color: '#fff', bg: '#a855f7' }, { _id: 't2', name: 'Fragile', color: '#fff', bg: '#ef4444' }];
const order = (n, ref, extra = {}) => ({
  _id: String(n).padStart(24, '0'), ref: '510' + n, type: 'مبيعات', client: 'Customer ' + n, date: '2026-11-14',
  total: 100 * n, remaining: 100 * n, pickupStatus: 'Preparing', pickupRef: ref, prepCreatedAt: '2026-11-14',
  shipCo: 'Bosta', phone: '0100000000' + n, items: [{ code: 'T', name: 'Basket', qty: 1, price: 100 * n }], ...extra,
});

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openBoard(browser, { lang, width, orders }) {
  const page = await browser.newPage(), errors = [], calls = [];
  await page.setViewport({ width, height: 950 });
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
    if (method !== 'GET') calls.push({ route, method, body });
    if (route === '/transactions/pickup-orders/split-prep') {
      const o = orders.find(x => x._id === body.ids[0]); o.pickupRef = '777-14NOV';
      return respond({ moved: 1, pickupRef: '777-14NOV' });
    }
    if (route === '/transactions/pickup-orders/undo') {
      body.ids.forEach(id => Object.assign(orders.find(x => x._id === id), { pickupStatus: 'Pending', pickupRef: null }));
      return respond({ updated: body.ids.length });
    }
    const tagRoute = route.match(/^\/transactions\/([0-9a-f]{24})\/tags$/);
    if (tagRoute) { orders.find(x => x._id === tagRoute[1]).tags = body.tags; return respond({ _id: tagRoute[1], tags: body.tags }); }
    if (route === '/tags' && method === 'POST') return respond({ _id: 'new', ...body });
    return respond(route === '/auth/me' ? user : route === '/settings' ? { lang } : route === '/tags' ? masterTags :
      ['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route) ? orders : []);
  });
  await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pu-prep-col .pu-group');
  return { page, errors, calls };
}

const rightClick = (page, selector) => page.evaluate(sel => {
  const el = document.querySelector(sel);
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20, button: 2 }));
}, selector);
const menuItems = page => page.$$eval('.pu-ctx [data-ctx-item]', els => els.map(e => ({ text: e.textContent.trim().replace(/\s+/g, ' '), disabled: e.disabled })));
const clickItem = (page, re) => page.evaluate(src => {
  const rx = new RegExp(src);
  const b = [...document.querySelectorAll('.pu-ctx [data-ctx-item]')].find(e => rx.test(e.textContent));
  if (!b) throw new Error('no menu item ' + src);
  b.click();
}, re.source);
const card = ref => `#pu-prep-col .pu-group[data-group-key="${ref}"]`;

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const [lang, width] of [['ar', 1440], ['en', 1440]]) {
      const en = lang === 'en';
      const orders = [order(1, 'PREP-A', { prepChecked: true }), order(2, 'PREP-A'), order(3, 'PREP-B')];
      const { page, errors, calls } = await openBoard(browser, { lang, width, orders });
      await page.evaluate(() => { masterTags = []; });

      // ── Group card menu
      await rightClick(page, card('PREP-A'));
      await page.waitForSelector('.pu-ctx');
      let items = await menuItems(page);
      ok(items.some(i => /PREP-B/.test(i.text)), 'group menu offers merging into the other group');
      ok(items.some(i => (en ? /Return group to pending/ : /إرجاع المجموعة/).test(i.text)), 'group menu offers return to pending');
      const inView = await page.$eval('.pu-ctx', el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; });
      ok(inView, 'menu stays inside the window');
      await page.keyboard.press('Escape');
      ok(!(await page.$('.pu-ctx')), 'Escape closes the menu');

      // ── TAG the whole group (master tags load on demand)
      await rightClick(page, card('PREP-A'));
      await page.waitForSelector('.pu-ctx');
      await clickItem(page, en ? /TAG all/ : /TAG لكل/);
      await page.waitForSelector('.pu-tagpick [data-tag="VIP"]');
      await page.click('.pu-tagpick [data-tag="VIP"]');
      await page.waitForFunction(() => document.querySelector('.pu-tagpick [data-tag="VIP"]')?.classList.contains('is-on'));
      ok(calls.filter(c => /\/tags$/.test(c.route) && c.method === 'PATCH').length === 2, 'one PATCH per order in the group');
      ok(await page.$eval(card('PREP-A'), el => !!el.querySelector('.pu-card-tag') && el.textContent.includes('VIP')), 'VIP pill on the outside of the card');
      // New tag typed in the picker
      await page.type('.pu-tagpick [data-tagpick-input]', 'Gift');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.pu-tagpick [data-tag="Gift"]')?.classList.contains('is-on'));
      ok(calls.some(c => c.route === '/tags' && c.method === 'POST' && c.body.name === 'Gift'), 'a new TAG is created once');
      await page.keyboard.press('Escape');
      await page.mouse.click(5, 5);

      // ── Workspace: order menu
      await page.evaluate(() => openPuCardOrdersModal('PREP-A', 'prep'));
      await page.waitForSelector('.pw-ocard');
      await rightClick(page, `.pw-ocard[data-order-id="${orders[1]._id}"]`);
      await page.waitForSelector('.pu-ctx');
      items = await menuItems(page);
      ok(items.length === 3, 'order menu: new group, TAG, back to pending');
      // TAG one order only → the board card states «1/2» for that tag
      await clickItem(page, /^\s*TAG[\s\d]*$/);
      await page.waitForSelector('.pu-tagpick [data-tag="Fragile"]');
      await page.click('.pu-tagpick [data-tag="Fragile"]');
      await page.waitForFunction(() => document.querySelector('.pu-tagpick [data-tag="Fragile"]')?.classList.contains('is-on'));
      await page.screenshot({ path: require('path').join(__dirname, `../../../artifacts/pickup-tags-${lang}.png`) }).catch(() => {});
      await page.keyboard.press('Escape');
      ok(await page.$eval(card('PREP-A'), el => /Fragile[\s\S]*1\/2/.test(el.textContent)), 'a tag on some orders reads 1/2 on the card');
      ok(await page.$eval(`.pw-ocard[data-order-id="${orders[1]._id}"]`, el => el.textContent.includes('Fragile')), 'the order card shows its own tag');

      // Split the prepared order into a new group
      await rightClick(page, `.pw-ocard[data-order-id="${orders[0]._id}"]`);
      await page.waitForSelector('.pu-ctx');
      await clickItem(page, en ? /new prep group/ : /مجموعة تحضير جديدة/);
      await page.waitForSelector('#pu-cfdlg.active');
      ok(await page.$eval('#pu-cfdlg-msg', el => el.textContent.includes('5101') && el.textContent.includes('PREP-A')), 'split confirm names the order and its group');
      await page.click('#pu-cfdlg-ok');
      await page.waitForSelector(card('777-14NOV'));
      const split = await page.evaluate(() => _puPrepGroups.map(g => ({ ref: g.prepRef, ids: g.orders.map(o => o._id), checked: g.orders.filter(o => o.prepChecked).length })));
      const neu = split.find(g => g.ref === '777-14NOV'), a = split.find(g => g.ref === 'PREP-A');
      ok(neu && neu.ids.length === 1 && neu.checked === 1, 'new group holds the order, prepared tick kept');
      ok(a && a.ids.length === 1, 'the source group keeps the other order');
      ok(calls.some(c => c.route.endsWith('/split-prep') && c.body.sourceRef === 'PREP-A' && c.body.ids.length === 1), 'one split request');
      ok(await page.$('.pw-ocard') !== null, 'the workspace stays open on the remaining order');

      // Alone in its group → «new group» disabled
      await rightClick(page, `.pw-ocard[data-order-id="${orders[1]._id}"]`);
      await page.waitForSelector('.pu-ctx');
      items = await menuItems(page);
      ok(items[0].disabled, 'an order alone in its group cannot be split');
      // Back to pending (existing confirm)
      await clickItem(page, en ? /Return to pending/ : /إرجاعه إلى المعلّق/);
      await page.waitForSelector('#pu-cfdlg.active');
      await page.click('#pu-cfdlg-ok');
      await page.waitForFunction(() => !_puPrepGroups.some(g => g.prepRef === 'PREP-A'));
      ok(calls.some(c => c.route.endsWith('/undo') && c.body.ids[0] === orders[1]._id), 'order returned to pending');

      // ── Group card: return the whole group to pending
      await page.evaluate(() => closePuCardOrdersModal());
      await sleep(150);
      await rightClick(page, card('PREP-B'));
      await page.waitForSelector('.pu-ctx');
      await page.screenshot({ path: require('path').join(__dirname, `../../../artifacts/pickup-ctx-${lang}.png`) }).catch(() => {});
      await clickItem(page, en ? /Return group to pending/ : /إرجاع المجموعة/);
      await page.waitForSelector('#pu-cfdlg.active');
      await page.click('#pu-cfdlg-ok');
      await page.waitForFunction(() => !_puPrepGroups.some(g => g.prepRef === 'PREP-B'));
      ok(true, 'group returned to pending');

      ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
      await page.close();
    }
    console.log(`pickup-prep-context-menu: ${passed} checks passed`);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
