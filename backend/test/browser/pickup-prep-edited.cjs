// An order edited while it is being prepared (owner's scenario): 4 products, A scanned, then the
// order is edited and A is removed. The prep screen names what changed and the piece to put back,
// pauses scanning and approval only until «تم الإرجاع — متابعة التحضير», and plays one warning beep.
// An edit that only adds/raises never pauses. Runs over the shipped index.html (needs frontend/server.js).
const assert = require('node:assert/strict');
const path = require('path');
const puppeteer = require('puppeteer');

const user = { _id: '6'.padStart(24, '0'), name: 'Picker', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements', 'inventory-units-view', 'inventory-units-allocate'] };
const items = [['a', 'A', 'Basket A', 1], ['b', 'B', 'Basket B', 2], ['c', 'C', 'Basket C', 1], ['d', 'D', 'Basket D', 1]]
  .map(([lineId, code, name, qty]) => ({ lineId, code, name, qty, price: 100 }));
const order = { _id: '1'.padStart(24, '0'), ref: '8401', type: 'مبيعات', client: 'Customer', date: '2026-11-14', total: 500, remaining: 500,
  carrierCode: 'bosta', shipCo: 'Bosta', shippingAddress: 'Street', shippingGov: 'Cairo', phone: '01000000001',
  pickupStatus: 'Preparing', pickupRef: 'PREP-E', prepCreatedAt: '2026-11-14', items };
const scansOf = calls => calls.filter(c => c.route.endsWith('/picking/scans')).length;
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const [lang, dark] of [['ar', false], ['en', true]]) {
      const summary = { lines: items.map(i => ({ lineId: i.lineId, qty: i.qty, skippedCount: 0,
        units: i.code === 'A' ? [{ unitId: 'u1', barcode: 'SU-' + 'A'.repeat(24), manualCode: 'U-0000-0001-7', status: 'picking' }] : [] })) };
      const calls = [];
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
        const route = url.pathname.slice(4);
        if (request.method() !== 'GET') calls.push({ route, body: request.postData() ? JSON.parse(request.postData()) : {} });
        if (route.endsWith('/prep-edit-ack')) return respond({ ok: true, cleared: true });
        if (route.endsWith('/picking/scans')) {
          const body = JSON.parse(request.postData());
          return respond({ lineId: 'b', unit: { _id: body.identifier.slice(3), barcode: body.identifier, status: 'picking' }, quantity: 1 });
        }
        if (route.endsWith('/picking')) return respond(summary);
        return respond(route === '/auth/me' ? user : route === '/settings' ? { lang, darkMode: dark } :
          ['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route) ? [JSON.parse(JSON.stringify(order))] : []);
      });
      await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#pu-prep-col .pu-group');
      await page.evaluate(() => {
        _awbPrepareSoon = () => {}; _awbWarm = () => {}; _pwAutoPrepareScannedOrder = async () => {};
        window._sounds = []; const real = _pwScanSound; _pwScanSound = kind => { _sounds.push(kind); real(kind); };
        openPuCardOrdersModal('PREP-E', 'prep');
      });
      await page.waitForFunction(() => !!_pwPickState(_pwSelId).summary);
      ok(!(await page.$('#pw-work .pw-prep-edit')), 'no notice before any edit');

      // The edit lands live: A removed, its scanned piece put back by the server.
      await page.evaluate(id => {
        const row = _pickupOrders.find(o => String(o._id) === id);
        _puMergeLiveTransaction({ ...row, items: row.items.filter(i => i.code !== 'A'), prepEditNotice: {
          id: 'n1', at: '2026-11-14T12:30:00Z', by: 'Mona', removed: [{ code: 'A', name: 'Basket A', qty: 1 }], added: [], changed: [],
          released: [{ unitId: 'u1', manualCode: 'U-0000-0001-7', code: 'A', name: 'Basket A' }], skipsUndone: 0, prepReset: false } });
      }, order._id);
      await page.waitForSelector('#pw-work .pw-prep-edit.is-blocking');
      const text = await page.$eval('#pw-work .pw-prep-edit', el => el.innerText);
      ok(text.includes(lang === 'ar' ? 'تم تعديل الطلب أثناء التحضير' : 'The order was edited during preparation'), 'notice title');
      ok(text.includes('Basket A') && text.includes('U-0000-0001-7'), 'names the removed product and the piece to put back');
      ok(text.includes(lang === 'ar' ? 'أرجع هذه القطعة إلى الرف' : 'Put this piece back on the shelf'), 'tells the picker to put it back');
      ok(text.includes('Mona'), 'says who edited');
      await new Promise(r => setTimeout(r, 50));
      ok(JSON.stringify(await page.evaluate(() => _sounds)) === '["warn"]', 'one warning beep when the edit arrives');
      await page.evaluate(() => _pwRenderWork());
      await new Promise(r => setTimeout(r, 50));
      ok((await page.evaluate(() => _sounds.length)) === 1, 'a re-render does not beep again');

      // Scanning is paused: no request goes out, a warning beep and a short message.
      await page.evaluate(id => _pwSubmitScan(id, 'SU-' + 'B'.repeat(24)), order._id);
      ok(scansOf(calls) === 0, 'scan paused: nothing sent');
      ok((await page.evaluate(() => _sounds.at(-1))) === 'warn', 'paused scan beeps');
      ok((await page.$eval('#pw-work [data-pw-scan-result]', el => el.innerText)).includes(lang === 'ar' ? 'أرجع القطع المذكورة أولًا' : 'Put back the listed pieces first'), 'says why');
      await page.evaluate(id => pucoTickOrder(id, true), order._id);
      await new Promise(r => setTimeout(r, 100));
      ok(!calls.some(c => c.route.endsWith('/picking/prepare')), 'approval paused too');
      await page.screenshot({ path: path.join(__dirname, `../../../artifacts/prep-edited-${lang}.png`), clip: { x: 300, y: 60, width: 1140, height: 560 }, captureBeyondViewport: false }).catch(() => {});

      // One click resumes.
      await page.click('#pw-work .pw-pe-ok');
      await page.waitForFunction(() => !document.querySelector('#pw-work .pw-prep-edit'));
      const ack = calls.find(c => c.route.endsWith('/prep-edit-ack'));
      ok(ack && ack.route === `/transactions/pickup-orders/${order._id}/prep-edit-ack` && ack.body.noticeId === 'n1', 'ack sends the notice id');
      await page.evaluate(id => _pwSubmitScan(id, 'SU-' + 'B'.repeat(24)), order._id);
      await page.waitForFunction(() => document.querySelector('#pw-work [data-pw-scan-result].is-success'));
      ok(scansOf(calls) === 1, 'scanning resumes after «continue»');

      // An edit that only adds a product: a notice, but nothing is paused.
      await page.evaluate(id => {
        const row = _pickupOrders.find(o => String(o._id) === id);
        _puMergeLiveTransaction({ ...row, items: [...row.items, { lineId: 'e', code: 'E', name: 'Basket E', qty: 1, price: 50 }], prepEditNotice: {
          id: 'n2', at: '2026-11-14T12:40:00Z', by: 'Mona', removed: [], added: [{ code: 'E', name: 'Basket E', qty: 1 }], changed: [], released: [], skipsUndone: 0, prepReset: false } });
      }, order._id);
      await page.waitForSelector('#pw-work .pw-prep-edit:not(.is-blocking)');
      ok((await page.$eval('#pw-work .pw-prep-edit', el => el.innerText)).includes('Basket E'), 'added product listed');
      ok(!(await page.$('#pw-work .pw-pe-paused')), 'not paused for an addition');
      await page.evaluate(id => _pwSubmitScan(id, 'SU-' + 'C'.repeat(24)), order._id);
      await page.waitForFunction(() => !_pwScanDrainTask);
      ok(scansOf(calls) === 2, 'scanning continues during an addition notice');
      ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
      await page.close();
    }
    console.log(`pickup-prep-edited: ${passed} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
