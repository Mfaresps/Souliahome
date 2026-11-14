// «تحضير هذا الطلب» stays locked until every piece is scanned or marked «تجهيز بدون مسح»;
// then it unlocks with a tick (once) and the usual approve → Bosta flow follows.
// Runs over the shipped index.html with a mocked API (needs `node frontend/server.js`).
const assert = require('node:assert/strict');
const path = require('path');
const puppeteer = require('puppeteer');

const user = { _id: 'preview', name: 'Preview', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements', 'inventory-units-view', 'inventory-units-allocate'] };
const mk = n => ({
  _id: String(n).padStart(24, '0'), ref: '820' + n, type: 'مبيعات', client: 'Customer ' + n, date: '2026-11-14',
  total: 400, remaining: 400, carrierCode: 'bosta', shipCo: 'Bosta', shippingAddress: 'Street 1', shippingGov: 'Cairo', phone: '0100000000' + n,
  pickupStatus: 'Preparing', pickupRef: 'PREP-K', prepCreatedAt: '2026-11-14',
  items: [{ lineId: 'a', code: 'A', name: 'Basket A', qty: 1, price: 200 }, { lineId: 'b', code: 'B', name: 'Basket B', qty: 1, price: 200 }],
});
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const lang of ['ar', 'en']) {
      const orders = [mk(1), mk(2)];
      const summaries = Object.fromEntries(orders.map(o => [o._id, { lines: o.items.map(i => ({ lineId: i.lineId, qty: i.qty, units: [], skippedCount: 0 })) }]));
      const calls = [];
      const page = await browser.newPage(), errors = [];
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 3 });
      page.on('pageerror', e => errors.push(e.message));
      await page.evaluateOnNewDocument((user, lang) => {
        localStorage.clear(); localStorage.setItem('token', 'preview'); localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('soulia_lang_pref', lang);
      }, user, lang);
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        const respond = data => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) }).catch(() => {});
        if (url.origin !== 'http://localhost:8080') return request.respond({ status: 200, contentType: 'text/javascript', body: url.hostname === 'cdn.socket.io' ? 'window.io=()=>({on(){},emit(){},disconnect(){}})' : '' });
        if (!url.pathname.startsWith('/api/')) return request.continue();
        const route = url.pathname.slice(4), body = request.postData() ? JSON.parse(request.postData()) : {};
        const id = route.split('/')[3];
        if (request.method() !== 'GET') calls.push(route);
        if (route.endsWith('/picking')) return respond(summaries[id]);
        if (route.endsWith('/picking/exceptions')) { summaries[id].lines.find(l => l.lineId === body.lineId).skippedCount += body.quantity || 1; return respond({ ok: true }); }
        if (route.endsWith('/picking/prepare')) { orders.find(o => o._id === id).prepChecked = true; summaries[id].prepChecked = true; return respond({ prepChecked: true, units: [] }); }
        return respond(route === '/auth/me' ? user : route === '/settings' ? { lang } :
          ['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route) ? orders : []);
      });
      await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#pu-prep-col .pu-group');
      await page.evaluate(() => { _awbPrepareSoon = () => {}; _awbWarm = () => {}; openPuCardOrdersModal('PREP-K', 'prep'); });
      await page.waitForFunction(() => !!_pwPickState(_pwSelId).summary);
      await page.waitForSelector('#pw-work .pw-tick-count');
      const btn = () => page.$eval('#pw-work .pw-head-tick', el => ({ disabled: el.disabled, cls: el.className, text: el.innerText.replace(/\s+/g, ' '), bg: getComputedStyle(el).backgroundColor }));
      const sel = await page.evaluate(() => _pwSelId);

      let b = await btn();
      ok(b.disabled && /is-locked/.test(b.cls), 'locked before any piece is handled');
      ok(/0\/2/.test(b.text), 'shows 0/2');
      await page.evaluate(i => { window._tickRun = pucoTickOrder(i, true); }, sel);
      await page.waitForSelector('#soulia-modal-overlay.active');
      ok(!calls.some(r => r.endsWith('/picking/prepare')), 'calling it anyway approves nothing (warning shown instead)');
      await page.evaluate(() => document.querySelector('#soulia-modal-cancel')?.click());
      await page.waitForFunction(() => !document.querySelector('#soulia-modal-overlay.active'));

      // first piece without scan → 1/2, still locked
      await page.evaluate(i => pwSkipDamagedLabel(i, 'a'), sel);
      await page.waitForFunction(() => /1\/2/.test(document.querySelector('#pw-work .pw-head-tick').innerText));
      b = await btn();
      ok(b.disabled, 'still locked at 1/2');

      // second piece without scan → unlocked with the tick animation
      await page.evaluate(i => pwSkipDamagedLabel(i, 'b'), sel);
      await page.waitForFunction(() => !document.querySelector('#pw-work .pw-head-tick').disabled);
      b = await btn();
      ok(/is-scan-ready/.test(b.cls) && !/is-locked/.test(b.cls), 'unlocked when every piece is handled');
      ok(/pw-tick-unlock/.test(b.cls), 'unlock animation class on that render');
      ok(!/\d\/\d/.test(b.text), 'counter gone once unlocked');
      ok(await page.$eval('#pw-work .pw-head-tick .pw-tickhead-c polyline', el => !!el), 'the tick is drawn in the circle');
      ok(await page.evaluate(() => document.activeElement?.matches('.pw-head-tick')), 'focus moves to the button');
      await page.screenshot({ path: path.join(__dirname, `../../../artifacts/prep-lock-unlocked-${lang}.png`) }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
      await page.screenshot({ path: path.join(__dirname, `../../../artifacts/prep-lock-ready-${lang}.png`), clip: { x: 0, y: 120, width: 1440, height: 160 } }).catch(() => {});
      await new Promise(r => setTimeout(r, 600)); // a screenshot resizes the page, which re-renders and replays the short draw
      ok(await page.$eval('#pw-work .pw-head-tick polyline', el => getComputedStyle(el).strokeDashoffset === '0px'), 'the tick is fully drawn');
      { const el = await page.$('#pw-work .pw-head-tick .pw-tickhead-c'); await el.screenshot({ path: path.join(__dirname, `../../../artifacts/prep-lock-tick-${lang}.png`), captureBeyondViewport: false }).catch(() => {}); }
      ok(await page.$eval('#pw-work .pw-head-tick', el => getComputedStyle(el).color === 'rgb(255, 255, 255)' && getComputedStyle(el).opacity === '1'), 'after the animation the button is solid green with white text');
      await page.evaluate(() => _pwRenderWork());
      ok(!(await page.$eval('#pw-work .pw-head-tick', el => el.classList.contains('pw-tick-unlock'))), 'animation plays once, not on every re-render');

      // approve → the usual next window (send to Bosta)
      await page.click('#pw-work .pw-head-tick');
      await page.waitForSelector('#bsf-overlay [data-stage="ask"]');
      ok(calls.some(r => r === `/inventory-units/orders/${sel}/picking/prepare`), 'one prepare request');
      ok(true, 'then the Bosta dialog opens');
      await page.click('#bsf-overlay [data-bsf="close"]');

      // the other order: locked screenshot
      await page.evaluate(i => pwSelectOrder(i), orders.find(o => o._id !== sel)._id);
      await page.waitForFunction(() => document.querySelector('#pw-work .pw-head-tick')?.disabled);
      await page.screenshot({ path: path.join(__dirname, `../../../artifacts/prep-lock-locked-${lang}.png`) }).catch(() => {});
      ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
      await page.close();
    }
    console.log(`pickup-prep-lock: ${passed} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
