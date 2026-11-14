// Quick sort chips in the prep-group workspace: oldest / newest / highest / lowest / quickest.
// Runs over the shipped index.html with a mocked API (needs `node frontend/server.js`).
const assert = require('node:assert/strict');
const path = require('path');
const puppeteer = require('puppeteer');

const user = { _id: 'preview', name: 'Preview', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements'] };
const day = n => new Date(Date.now() - n * 86400000).toISOString();
const item = (code, qty) => ({ code, name: 'Item ' + code, qty, price: 50 });
// id · placed (days ago) · total · items
const orders = [
  { n: 1, ago: 2, total: 900, items: [item('A', 3), item('B', 2)] },          // 5 pcs, 2 products
  { n: 2, ago: 6, total: 150, items: [item('A', 1)] },                         // 1 pc  (oldest)
  { n: 3, ago: 0.1, total: 2400, items: [item('C', 2)] },                     // 2 pcs (newest, highest)
  { n: 4, ago: 4, total: 300, items: [item('A', 1), item('D', 1)], prepChecked: true }, // prepared → always last
  { n: 5, ago: 3, total: 120, items: [item('E', 2)] },                         // 2 pcs, lowest
].map(o => ({
  _id: String(o.n).padStart(24, '0'), ref: '610' + o.n, type: 'مبيعات', client: 'Customer ' + o.n,
  date: day(o.ago).slice(0, 10), shopifyCreatedAt: day(o.ago), createdAt: day(o.ago), total: o.total, remaining: o.total,
  pickupStatus: 'Preparing', pickupRef: 'PREP-S', prepCreatedAt: '2026-11-14', prepChecked: !!o.prepChecked,
  shipCo: 'Bosta', phone: '0100000000' + o.n, items: o.items,
}));
const id = n => String(n).padStart(24, '0');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const [lang, width] of [['ar', 1440], ['en', 1440]]) {
      const page = await browser.newPage(), errors = [];
      await page.setViewport({ width, height: 900 });
      page.on('pageerror', e => errors.push(e.message));
      await page.evaluateOnNewDocument((user, lang) => {
        if (!sessionStorage.getItem('seeded')) { localStorage.clear(); sessionStorage.setItem('seeded', '1'); }
        localStorage.setItem('token', 'preview'); localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('soulia_lang_pref', lang);
      }, user, lang);
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        const respond = data => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
        if (url.origin !== 'http://localhost:8080') return request.respond({ status: 200, contentType: 'text/javascript', body: url.hostname === 'cdn.socket.io' ? 'window.io=()=>({on(){},emit(){},disconnect(){}})' : '' });
        if (!url.pathname.startsWith('/api/')) return request.continue();
        const route = url.pathname.slice(4);
        return respond(route === '/auth/me' ? user : route === '/settings' ? { lang } :
          ['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route) ? orders : []);
      });
      const open = async () => {
        await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#pu-prep-col .pu-group');
        await page.evaluate(() => openPuCardOrdersModal('PREP-S', 'prep'));
        await page.waitForSelector('.pw-ocard');
      };
      const listed = () => page.$$eval('#puco-orders-list .pw-ocard', els => els.map(e => e.dataset.orderId));
      // The bar is redrawn with the list, so click through the page rather than a held handle.
      const KEYS = ['', 'oldest', 'newest', 'high', 'low', 'easy'];
      // Open the sort button's menu and pick an entry (the button is redrawn with the list).
      const chip = async key => {
        await page.evaluate(() => document.querySelector('#pw-sort-btn').click());
        await page.waitForSelector('.pu-ctx [data-ctx-item]');
        await page.evaluate(i => document.querySelectorAll('.pu-ctx [data-ctx-item]')[i].click(), KEYS.indexOf(key));
      };

      await open();
      ok(await page.$$eval('#pw-sortbar .pw-sort-btn', els => els.length) === 1, 'one compact sort button');
      await page.evaluate(() => document.querySelector('#pw-sort-btn').click());
      await page.waitForSelector('.pu-ctx');
      ok(await page.$$eval('.pu-ctx [data-ctx-item]', els => els.length) === 6, 'menu: group order + five sorts');
      ok(await page.$eval('.pu-ctx', el => { const r = el.getBoundingClientRect(); const b = document.querySelector('#pw-sort-btn').getBoundingClientRect(); return r.top >= b.bottom - 1 && r.right <= innerWidth && r.left >= 0; }), 'menu opens under the button, inside the window');
      await page.keyboard.press('Escape');
      const base = await listed();
      ok(base[base.length - 1] === id(4), 'prepared order sits at the bottom by default');

      const expect = {
        oldest: [2, 5, 1, 3, 4],
        newest: [3, 1, 5, 2, 4],
        high:   [3, 1, 2, 5, 4],
        low:    [5, 2, 1, 3, 4],
        easy:   [2, 5, 3, 1, 4], // 3 and 5 tie on effort → the one waiting longer first
      };
      for (const [key, order] of Object.entries(expect)) {
        await chip(key);
        const got = await listed();
        ok(JSON.stringify(got) === JSON.stringify(order.map(id)), `${key}: ${got.map(x => +x).join(',')} ≠ ${order.join(',')}`);
        ok(await page.$eval('#pw-sort-btn', el => el.classList.contains('is-set')), `${key}: button shows a sort is on`);
        ok(await page.evaluate(() => _pwSelId) === id(order[0]), `${key}: the top order opens`);
      }
      // auto-advance follows the sort: after the quickest one, the next quickest
      ok(await page.evaluate(i => _pwNextPending(_pwOrderForDisplay(_pucoGetGroup().orders), i)?._id, id(2)) === id(5), 'auto-advance follows the chosen sort');

      // age chip only on age sorts
      await chip('oldest');
      ok(await page.$eval(`.pw-ocard[data-order-id="${id(2)}"]`, el => !!el.querySelector('.pw-chip.is-age') && /6/.test(el.querySelector('.pw-chip.is-age').textContent)), 'waiting time shown while sorting by age');
      await page.screenshot({ path: path.join(__dirname, `../../../artifacts/pickup-sort-${lang}.png`) }).catch(() => {});

      // «ترتيب المجموعة» → back to the group order; choice survives a reload
      await chip('');
      ok(JSON.stringify(await listed()) === JSON.stringify(base), '«group order» returns to the group order');
      ok(!(await page.$('.pw-ocard .pw-chip.is-age')), 'no waiting-time chip without an age sort');
      await chip('easy');
      await open();
      ok(await page.$eval('#pw-sort-btn', el => el.classList.contains('is-set') && /أسرع|Quickest/.test(el.textContent)), 'the chosen sort is remembered after a reload');
      ok(JSON.stringify(await listed()) === JSON.stringify(expect.easy.map(id)), 'remembered sort is applied');

      // search still works on top of the sort
      await page.type('#puco-search-input', 'Customer 1');
      await page.waitForFunction(() => document.querySelectorAll('#puco-orders-list .pw-ocard').length === 1);
      ok(true, 'search filters within the sorted list');

      const fits = await page.$eval('.pw-nav-search', el => el.scrollWidth <= el.clientWidth + 1);
      ok(fits, 'search + sort button fit the navigator width');
      ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
      await page.close();
    }
    console.log(`pickup-prep-sort: ${passed} checks passed`);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
