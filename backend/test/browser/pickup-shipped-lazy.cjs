// «تم الشحن» draws only the newest days; older days load as the column is scrolled to its end.
// Runs over the shipped index.html with a mocked API (needs `node frontend/server.js`).
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const user = { _id: 'adm', name: 'Admin', role: 'admin', perms: [] };
// 20 shipping days × 3 parcels, newest = 2026-11-20.
const orders = [];
for (let d = 1; d <= 20; d++) for (let k = 0; k < 3; k++) {
  const n = d * 10 + k, day = `2026-11-${String(d).padStart(2, '0')}`;
  orders.push({ _id: String(n).padStart(24, '0'), ref: String(4000 + n), type: 'مبيعات', client: 'Customer ' + n, date: day,
    total: 100, remaining: 50, pickupStatus: 'Shipped', pickupRef: 'SH-' + day + '-0D5F', shipCo: 'Bosta', bostaOrderId: 'B' + n,
    bostaTrackingNumber: 'T' + n, bostaStatus: 'IN_TRANSIT', shippedAt: day + 'T10:00:00.000Z', items: [{ code: 'T', name: 'Basket', qty: 1, price: 100 }] });
}
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage(), errors = [];
    await page.setViewport({ width: 1440, height: 950 });
    page.on('pageerror', e => errors.push(e.message));
    await page.evaluateOnNewDocument(u => { localStorage.clear(); localStorage.setItem('token', 'x'); localStorage.setItem('user', JSON.stringify(u)); localStorage.setItem('soulia_lang_pref', 'ar'); }, user);
    await page.setRequestInterception(true);
    page.on('request', r => {
      const url = new URL(r.url());
      const respond = d => r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(d) }).catch(() => {});
      if (url.origin !== 'http://localhost:8080') return r.respond({ status: 200, contentType: 'text/javascript', body: url.hostname === 'cdn.socket.io' ? 'window.io=()=>({on(){},emit(){},disconnect(){}})' : '' });
      if (!url.pathname.startsWith('/api/')) return r.continue();
      const route = url.pathname.slice(4);
      if (route === '/auth/me') return respond(user);
      if (route === '/settings') return respond({ lang: 'ar' });
      if (route === '/transactions/backfill/courier-collected-board') return respond({ found: 0, orders: [] });
      if (['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route)) return respond(orders);
      return respond([]);
    });
    await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#pu-shipped-col .pu-daily-group');
    await new Promise(r => setTimeout(r, 800));
    const cards = () => page.$$eval('#pu-shipped-col .pu-daily-group', els => els.length);
    ok(await cards() === 8, 'only the newest 8 days are drawn: ' + await cards());
    ok(await page.$eval('#pu-shipped-col .pu-daily-group', el => el.dataset.dailyGroup.includes('2026-11-20')), 'the first card is the newest day');
    ok(await page.$eval('#pu-shipped-count', el => el.textContent.trim()) === '20', 'the column count still states all 20 days');
    ok(await page.$eval('#pu-shipped-col .pu-shipped-more', el => /12/.test(el.textContent)), 'the button states 12 older days');
    ok(await page.evaluate(() => /6,000|6000/.test(document.querySelector('#pu-shipped-col-amt')?.textContent || '')), 'the column total still covers every day');
    await page.evaluate(() => { const c = document.querySelector('#pu-shipped-col'); c.scrollTop = c.scrollHeight; });
    await page.waitForFunction(() => document.querySelectorAll('#pu-shipped-col .pu-daily-group').length > 8, { timeout: 4000 });
    ok(await cards() === 16, 'scrolling to the end adds the next 8 days: ' + await cards());
    await page.click('#pu-shipped-col .pu-shipped-more');
    ok(await cards() === 20 && !(await page.$('#pu-shipped-col .pu-shipped-more')), 'the last click draws the rest and the button goes away');
    await page.evaluate(() => renderPickupBoard());
    ok(await cards() === 20, 'a live repaint keeps what was already opened');
    await page.evaluate(() => { const s = document.querySelector('#pu-shipped-search'); s.value = '4012'; s.dispatchEvent(new Event('input', { bubbles: true })); renderPickupBoard(); });
    ok(await cards() === 1, 'a search finds a parcel in an older day: ' + await cards());
    await page.evaluate(() => { const s = document.querySelector('#pu-shipped-search'); s.value = ''; renderPickupBoard(); });
    ok(await cards() === 8, 'clearing the search starts again from the newest 8');
    ok(!errors.length, 'no page errors: ' + errors.join(' | '));
    console.log(`pickup-shipped-lazy: ${passed} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
