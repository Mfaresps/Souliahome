// Orders Bosta already collected/delivered: the «جاهز للشحن» window must list exactly the
// card's orders (39 vs 35, Nov 23, 2026), and an admin sees a notice that moves the stuck
// ones to «تم الشحن» after a preview + confirm. Mocked API (needs `node frontend/server.js`).
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const admin = { _id: 'adm', name: 'Admin', role: 'admin', perms: [] };
const staff = { _id: 'stf', name: 'Staff', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit'] };
const order = (n, extra = {}) => ({
  _id: String(n).padStart(24, '0'), ref: '32' + String(n).padStart(2, '0'), type: 'مبيعات', client: 'Customer ' + n,
  date: '2026-11-19', total: 100, remaining: 100, pickupStatus: 'Ready', pickupRef: '131-23NOV', pickupDate: '2026-11-23',
  shipCo: 'Bosta', bostaOrderId: 'B' + n, bostaTrackingNumber: 'T' + n, bostaStatus: 'CREATED', warehouseCode: 'MAIN',
  items: [{ code: 'T', name: 'Basket', qty: 1, price: 100 }], ...extra,
});

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

async function openBoard(browser, { user, lang = 'ar' }) {
  const orders = [1, 2, 3, 4, 5].map(n => order(n))
    .concat([6, 7].map(n => order(n, { bostaStatus: 'DELIVERED', shippedAt: null })))
    // Collected on Nov 19 and still active → «تم الشحن», day 2026-11-19.
    .concat([8, 9].map(n => order(n, { pickupStatus: 'Shipped', pickupRef: 'SH-2026-11-19-0D5F', bostaStatus: 'IN_TRANSIT', shippedAt: '2026-11-19T16:20:28.603Z', total: 300, remaining: 200 })))
    // Exchange replacement on the same pickup: invoice 2,000, 1,700 of it is the returned piece's credit.
    .concat([order(11, { ref: '20268000011', pickupStatus: 'Delivered', pickupRef: 'SH-2026-11-19-0D5F', bostaOrderId: '', bostaStatus: 'RETURNED',
      shippedAt: '2026-11-19T16:20:28.603Z', deliveredAt: '2026-11-20T10:00:00.000Z', total: 2000, remaining: 0, afterSales: { role: 'replacement', creditApplied: 1700, caseRef: 'AS-1' } })]);
  // Same pickup day, cancelled after the courier took it (failed delivery closed).
  const history = [order(10, { pickupStatus: 'Shipped', pickupRef: 'SH-2026-11-19-0D5F', bostaStatus: 'RETURNED', shippedAt: '2026-11-19T16:20:28.603Z', cancelled: true, total: 999 })];
  const page = await browser.newPage(), errors = [], calls = [];
  await page.setViewport({ width: 1440, height: 1000 });
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
    const route = url.pathname.slice(4);
    if (route === '/transactions/pickup-orders/shipped-history') return respond(history);
    if (route === '/transactions/backfill/courier-collected-board') {
      const body = JSON.parse(request.postData() || '{}');
      calls.push(body);
      const stuck = orders.filter(o => o.bostaStatus === 'DELIVERED' && o.pickupStatus === 'Ready');
      const rows = stuck.map(o => ({ _id: o._id, ref: o.ref, bostaStatus: o.bostaStatus, from: 'Ready', fromRef: o.pickupRef, toRef: 'SH-2026-11-19-0D5F', shippedAt: '2026-11-19T16:20:28.603Z' }));
      if (body.dryRun === false) stuck.forEach(o => { o.pickupStatus = 'Shipped'; o.pickupRef = 'SH-2026-11-19-0D5F'; o.shippedAt = '2026-11-19T16:20:28.603Z'; });
      return respond({ dryRun: body.dryRun !== false, found: rows.length, moved: body.dryRun === false ? rows.length : 0, orders: rows });
    }
    return respond(route === '/auth/me' ? user : route === '/settings' ? { lang } :
      ['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route) ? orders : []);
  });
  await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pu-ready-col .pu-group');
  return { page, errors, calls };
}

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const { page, errors, calls } = await openBoard(browser, { user: admin });
    const cardCount = await page.$eval('#pu-ready-col .pu-group[data-group-key="131-23NOV"] .pu-prep-order-count', el => el.textContent.replace(/\D+/g, ' ').trim());
    ok(/\b5\b/.test(cardCount), 'card counts the 5 orders still waiting for the courier: ' + cardCount);
    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(() => openPuCardOrdersModal('131-23NOV', 'ready'));
    await page.waitForFunction(() => /\d/.test(document.querySelector('#puco-count-badge')?.textContent || ''));
    const badge = await page.$eval('#puco-count-badge', el => el.textContent);
    ok(/\b5\b/.test(badge.replace(/\D+/g, ' ')), 'window badge equals the card: ' + badge);
    ok(await page.evaluate(() => _pucoGetGroup().orders.length) === 5, 'live window group equals the card');
    await page.evaluate(() => closePuCardOrdersModal());

    await page.waitForFunction(() => _puShippedHistory.length === 1, { timeout: 5000 });
    const day = await page.evaluate(() => {
      const g = _puDailyShippingGroups(_pickupOrders, 'shipped').find(x => x.pickupDate === '2026-11-19');
      return g && { n: g.orders.length, total: g.orders.reduce((s, o) => s + _puShippedMoney(o), 0),
        cancelledLabel: _puDailyOrderStatus(g.orders.find(o => o.cancelled)).label };
    });
    ok(day && day.n === 4, 'the Nov 19 pickup keeps all 4 parcels (cancelled + exchange included): ' + JSON.stringify(day));
    ok(day && day.total === 900, 'value = 300 + 300 + exchange difference 300; the cancelled parcel counts 0: ' + JSON.stringify(day));
    const exch = await page.evaluate(() => {
      const o = _pickupOrders.find(x => x.afterSales?.role === 'replacement');
      return { label: _puDailyOrderStatus(o).label, tag: _puAfterSalesTagHtml(o), due: _puGroupDueHtml(_puDailyShippingGroups(_pickupOrders, 'shipped').find(x => x.pickupDate === '2026-11-19').orders) };
    });
    ok(/تم الاستبدال/.test(exch.label), 'a delivered exchange reads «تم الاستبدال», not «مرتجع»');
    ok(/استبدال/.test(exch.tag), 'the replacement carries an «استبدال» tag');
    ok(/المطلوب تحصيله/.test(exch.due) && /400/.test(exch.due), 'the group states what is still to collect (400): ' + exch.due);
    ok(day && /ملغي بعد الشحن/.test(day.cancelledLabel), 'the cancelled parcel is labelled «ملغي بعد الشحن»');
    ok(await page.evaluate(() => !_puReadyCardOrders('131-23NOV').some(o => o.cancelled)
      && !(_pickupOrders || []).some(o => o._shippedHistory)), 'history never enters the board list or other columns');
    const shippedText = await page.evaluate(() => [...document.querySelectorAll('#pu-shipped-col .pu-daily-group')].map(c => c.textContent.replace(/\s+/g, ' ')).join(' | '));
    ok(/\b4\b/.test(shippedText.replace(/[^\d]+/g, ' ')), 'shipped card shows 4: ' + shippedText.slice(0, 300));

    ok(await page.$eval('#pu-courier-stuck', el => !el.hidden && /2/.test(el.textContent)), 'admin sees the notice with 2 orders');
    ok(calls.length >= 1 && calls.every(c => c.dryRun === true), 'loading the board only previews, never writes');
    const before = calls.length;
    await page.evaluate(() => document.querySelector('#pu-courier-stuck button').click());
    await page.waitForSelector('.pu-cstuck-list li');
    ok(calls.length === before + 1 && calls[before].dryRun === true, 'review asks the server for a preview first');
    ok(await page.$$eval('.pu-cstuck-list li', els => els.length) === 2, 'preview lists both orders');
    const confirmBtn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find(b => b.offsetParent && /تصحيح 2/.test(b.textContent)));
    ok(!!confirmBtn.asElement(), 'confirm button names the count');
    await confirmBtn.evaluate(b => b.click());
    await page.waitForFunction(() => document.querySelector('#pu-courier-stuck')?.hidden === true, { timeout: 5000 });
    ok(calls.filter(c => c.dryRun === false).length === 1, 'confirm sends dryRun:false once');
    ok(await page.$eval('#pu-courier-stuck', el => el.hidden), 'notice disappears once moved');
    ok(!errors.length, 'no page errors: ' + errors.join(' | '));
    await page.close();

    const s = await openBoard(browser, { user: staff, lang: 'en' });
    ok(await s.page.$eval('#pu-courier-stuck', el => el.hidden), 'staff does not see the notice');
    ok(!s.errors.length, 'no page errors (en/staff)');
    await s.page.close();
    console.log(`pickup-courier-collected: ${passed} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
