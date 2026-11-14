// After a refresh, TAG pills on the prep board used the default colour until the tag picker
// reloaded the tag list: startup published tags only after EVERY background request (inventory,
// transactions…) had finished, and nothing repainted the board. Now the board repaints as soon as
// the tag list itself arrives. Runs over the shipped index.html (needs frontend/server.js on :8080).
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const user = { _id: 'preview', name: 'Preview', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements'] };
const order = { _id: '1'.padStart(24, '0'), ref: '9001', type: 'مبيعات', client: 'Customer', date: '2026-11-10', total: 500, remaining: 500,
  carrierCode: 'bosta', shipCo: 'Bosta', pickupStatus: 'Preparing', pickupRef: '306-10NOV', prepCreatedAt: '2026-11-10',
  tags: ['stock needed'], items: [{ lineId: 'a', code: 'A', name: 'Basket A', qty: 1, price: 500 }] };
const PURPLE = 'rgb(124, 58, 237)';
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.evaluateOnNewDocument(user => {
      if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
      localStorage.clear(); localStorage.setItem('token', 'preview'); localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('soulia_lang_pref', 'ar');
    }, user);
    let tagDelay = 300;
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const respond = (data, delay = 0) => setTimeout(() => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {}), delay);
      if (url.origin !== 'http://localhost:8080') return request.respond({ status: 200, contentType: 'text/javascript', body: url.hostname === 'cdn.socket.io' ? 'window.io=()=>({on(){},emit(){},disconnect(){}})' : '' });
      if (!url.pathname.startsWith('/api/')) return request.continue();
      const route = url.pathname.slice(4);
      if (route === '/tags') return respond([{ _id: 't1', name: 'stock needed', bg: PURPLE, color: '#fff' }], tagDelay);
      const fast = ['/auth/me', '/settings', '/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'];
      if (!fast.includes(route)) return respond([], 6000); // every other startup request is slow
      return respond(route === '/auth/me' ? user : route === '/settings' ? { lang: 'ar' } : [order]);
    });
    await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#pu-prep-col .pu-card-tag');
    const colour = () => page.$eval('#pu-prep-col .pu-card-tag', el => getComputedStyle(el).getPropertyValue('--tag-c').trim());
    await page.waitForFunction(p => getComputedStyle(document.querySelector('#pu-prep-col .pu-card-tag')).getPropertyValue('--tag-c').trim() === p, { timeout: 3000 }, PURPLE)
      .catch(() => {});
    ok((await colour()) === PURPLE, 'the tag takes its own colour well before the slow startup requests finish: ' + await colour());

    // Refresh with the tag list slow: the colour comes from the saved copy at the first paint.
    tagDelay = 6000;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#pu-prep-col .pu-card-tag');
    ok((await colour()) === PURPLE, 'after a refresh the tag is in its own colour from the first paint: ' + await colour());
    ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
    console.log(`pickup-tag-colour: ${passed} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
