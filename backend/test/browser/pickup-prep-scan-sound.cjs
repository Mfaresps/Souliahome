// Prep workspace scan feedback: a correct piece plays one soft tick; any other rejected scan
// plays a short warning beep only; a product that is NOT in the order plays the alarm and
// shows a solid red banner. Runs over the shipped index.html with a mocked API
// (needs `node frontend/server.js` on :8080).
const assert = require('node:assert/strict');
const path = require('path');
const puppeteer = require('puppeteer');

const user = { _id: 'preview', name: 'Preview', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements', 'inventory-units-view', 'inventory-units-allocate'] };
const order = {
  _id: '1'.padStart(24, '0'), ref: '8301', type: 'مبيعات', client: 'Customer', date: '2026-11-14',
  total: 400, remaining: 400, carrierCode: 'bosta', shipCo: 'Bosta', shippingAddress: 'Street 1', shippingGov: 'Cairo', phone: '01000000001',
  pickupStatus: 'Preparing', pickupRef: 'PREP-S', prepCreatedAt: '2026-11-14',
  items: [{ lineId: 'a', code: 'A', name: 'Basket A', qty: 2, price: 200 }],
};
const GOOD = 'SU-' + 'A'.repeat(24), GOOD2 = 'SU-' + 'C'.repeat(24), WRONG = 'SU-' + 'B'.repeat(24);
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const [lang, dark] of [['ar', false], ['en', true]]) {
      const summary = { lines: [{ lineId: 'a', qty: 2, units: [], skippedCount: 0 }] };
      const page = await browser.newPage(), errors = [];
      await page.setViewport({ width: 1440, height: 900 });
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
        const route = url.pathname.slice(4), body = request.postData() ? JSON.parse(request.postData()) : {};
        if (route.endsWith('/picking/scans')) {
          // the real server's wording for a piece whose product is not on the order
          if (body.identifier === WRONG) return respond({ statusCode: 409, message: 'Barcode does not match one exact sale line' }, 409);
          const unit = { _id: body.identifier.slice(3), barcode: body.identifier, manualCode: 'U-' + body.identifier.slice(-4), status: 'picking', productId: 'p' };
          return respond({ lineId: 'a', unit, quantity: 1 });
        }
        if (route.endsWith('/picking')) return respond(summary);
        return respond(route === '/auth/me' ? user : route === '/settings' ? { lang, darkMode: dark } :
          ['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route) ? [order] : []);
      });
      await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#pu-prep-col .pu-group');
      await page.evaluate(() => {
        _awbPrepareSoon = () => {}; _awbWarm = () => {}; _pwAutoPrepareScannedOrder = async () => {};
        window._sounds = []; const real = _pwScanSound; _pwScanSound = kind => { _sounds.push(kind); real(kind); };
        openPuCardOrdersModal('PREP-S', 'prep');
      });
      await page.waitForFunction(() => !!_pwPickState(_pwSelId).summary);
      const sel = await page.evaluate(() => _pwSelId);
      const scan = code => page.evaluate((i, c) => _pwSubmitScan(i, c), sel, code);
      const result = () => page.$eval('#pw-work [data-pw-scan-result]', el => ({ cls: el.className, text: el.innerText, bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));

      await scan(GOOD);
      let r = await result();
      ok(/is-success/.test(r.cls), 'correct piece → success result');
      ok(JSON.stringify(await page.evaluate(() => _sounds)) === '["ok"]', 'correct piece → one soft tick');
      ok(!!(await page.$('#pw-work .pw-manual-toggle')), 'manual barcode entry offered while pieces remain (1/2)');

      await scan(GOOD);
      r = await result();
      ok(/is-error/.test(r.cls) && !/is-wrong-product/.test(r.cls), 'duplicate piece → ordinary rejected result, not the red banner');
      ok((await page.evaluate(() => _sounds.at(-1))) === 'warn', 'duplicate piece → warning beep only');

      await scan(WRONG);
      r = await result();
      ok(/is-wrong-product/.test(r.cls), 'wrong product → red banner: ' + JSON.stringify(r) + JSON.stringify(await page.evaluate(() => _pwPickState(_pwSelId).feedback)));
      ok(r.bg === 'rgb(192, 39, 27)' || r.bg === 'rgb(179, 38, 28)', 'banner is solid red: ' + r.bg);
      ok(r.color === 'rgb(255, 255, 255)', 'banner text is white');
      ok(await page.$eval('#pw-work .is-wrong-product .pw-result-copy strong', el => getComputedStyle(el).color === 'rgb(255, 255, 255)'), 'banner title is white (light and dark)');
      ok(lang === 'ar' ? r.text.includes('هذا المنتج غير موجود في الطلب') : r.text.includes('This product is not in the order'), 'says the product is not in the order');
      ok(r.text.includes(WRONG), 'shows the scanned code');
      ok((await page.evaluate(() => _sounds.at(-1))) === 'alarm', 'wrong product → alarm');
      ok(await page.$eval('#pw-work .pw-scan-station', el => el.classList.contains('has-wrong-product')), 'scan station outlined red');
      await new Promise(res => setTimeout(res, 700));
      ok(await page.$eval('#pw-work [data-pw-scan-result]', el => getComputedStyle(el).opacity === '1'), 'banner fully opaque once shown');
      await page.screenshot({ path: path.join(__dirname, `../../../artifacts/prep-wrong-product-${lang}.png`), clip: { x: 0, y: 60, width: 1440, height: 420 }, captureBeyondViewport: false }).catch(() => {});
      ok(summary.lines[0].units.length === 0, 'nothing was added for the wrong product (server mock untouched)');

      await scan(GOOD2);
      r = await result();
      ok(/is-success/.test(r.cls) && !(await page.$eval('#pw-work .pw-scan-station', el => el.classList.contains('has-wrong-product'))), 'next correct scan clears the red banner');
      ok((await page.evaluate(() => _sounds.at(-1))) === 'ok', 'and ticks again');
      ok(!(await page.$('#pw-work .pw-manual-toggle')) && !(await page.$('#pw-order-scan')), 'all pieces scanned → no manual barcode entry');
      await page.evaluate(() => _pwRenderWork());
      ok((await page.evaluate(() => _sounds.length)) === 4, 'a re-render plays no sound');
      // The order is now prepared. Scanning again is not «the order changed».
      await page.evaluate(id => { _pucoGetGroup().orders.find(o => String(o._id) === id).prepChecked = true; _pickupOrders.find(o => String(o._id) === id).prepChecked = true; }, sel);
      const scansBefore = await page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.name.includes('/picking/scans')).length);
      await scan(GOOD);
      r = await result();
      ok(!/is-error/.test(r.cls) && /is-success/.test(r.cls), 'own piece on a prepared order: calm confirmation, not an error');
      ok(lang === 'ar' ? r.text.includes('الطلب محضّر بالفعل') && r.text.includes('مسجلة لهذا الطلب') : r.text.includes('Order already prepared') && r.text.includes('already registered for this order'), 'says it is already prepared and registered');
      ok(!r.text.includes(lang === 'ar' ? 'تغيّرت حالة الطلب' : 'The order has changed'), 'no «order changed» message');
      ok((await page.evaluate(() => _sounds.at(-1))) === 'ok', 'own piece → success chime');
      await scan('SU-' + 'D'.repeat(24));
      r = await result();
      ok(/is-exception/.test(r.cls) && !/is-error/.test(r.cls), 'another piece on a prepared order: neutral note, not red');
      ok(r.text.includes(lang === 'ar' ? 'لم تُضف أي قطعة' : 'No piece was added'), 'says nothing was added');
      ok((await page.evaluate(() => _sounds.at(-1))) === 'warn', 'another piece → soft warning tone');
      ok((await page.evaluate(() => performance.getEntriesByType('resource').filter(e => e.name.includes('/picking/scans')).length)) === scansBefore, 'nothing sent to the server');
      ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
      await page.close();
    }
    console.log(`pickup-prep-scan-sound: ${passed} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
