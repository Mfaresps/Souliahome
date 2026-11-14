// Prep workspace: a prepared Bosta order skipped with «لاحقاً» keeps a «إرسال Bosta» button;
// once sent it shows «أُرسل لبوسطة» + its tracking number. An exchange shipped from its
// after-sales case (tracking number, no bostaOrderId) counts as sent and can print its label.
const assert = require('node:assert/strict');
const path = require('path');
const puppeteer = require('puppeteer');

const user = { _id: 'preview', name: 'Preview', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements'] };
const base = (n, extra = {}) => ({
  _id: String(n).padStart(24, '0'), ref: '710' + n, type: 'مبيعات', client: 'Customer ' + n, date: '2026-11-14',
  total: 500, remaining: 500, pickupStatus: 'Preparing', pickupRef: 'PREP-L', prepCreatedAt: '2026-11-14',
  carrierCode: 'bosta', shipCo: 'Bosta', shippingAddress: 'Street 1', shippingGov: 'Cairo', phone: '0100000000' + n,
  items: [{ code: 'T', name: 'Basket', qty: 1, price: 500 }], ...extra,
});
const id = n => String(n).padStart(24, '0');
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const [lang, width] of [['ar', 1440], ['en', 1440]]) {
      const orders = [
        base(1, { prepChecked: true }),                                   // prepared, «later» pressed
        base(2, { prepChecked: false }),                                  // not prepared yet
        base(3, { prepChecked: true, bostaTrackingNumber: '78221930', afterSales: { caseId: 'case-3' } }), // exchange shipped from its case
        base(4, { prepChecked: true, afterSales: { caseId: 'case-4' } }), // exchange not shipped yet
      ];
      const page = await browser.newPage(), errors = [], calls = [];
      await page.setViewport({ width, height: 900 });
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
        const route = url.pathname.slice(4);
        if (request.method() !== 'GET') calls.push(route);
        if (route.startsWith('/shipping/create-order/')) {
          Object.assign(orders.find(o => route.endsWith(o._id)), { bostaOrderId: 'bo-1', bostaTrackingNumber: 'TR-5566', bostaStatus: 'CREATED' });
          return respond({ bostaOrderId: 'bo-1', trackingNumber: 'TR-5566' });
        }
        return respond(route === '/auth/me' ? user : route === '/settings' ? { lang } :
          ['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route) ? orders : []);
      });
      await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#pu-prep-col .pu-group');
      await page.evaluate(() => {
        _awbPrepareSoon = () => {}; _awbForget = () => {}; _awbWarm = () => {};
        window._printCalls = []; printBostaAwb = async id => { _printCalls.push(id); return false; };
        openPuCardOrdersModal('PREP-L', 'prep');
      });
      await page.waitForSelector('.pw-ocard');
      const select = n => page.evaluate(i => { pwSelectOrder(i); }, id(n));
      const actions = () => page.$eval('.pw-actions', el => el.innerText.replace(/\s+/g, ' '));

      // 1 · prepared, not sent → send button
      await select(1);
      await page.waitForSelector('.pw-actions .pw-abtn.is-send');
      ok(!(await page.$('.pw-actions .pw-ship-sent')), 'not sent: no «sent» state');
      await page.click('.pw-actions .pw-abtn.is-send');
      await page.waitForSelector('#bsf-overlay [data-stage="ask"]');
      ok(true, 'the button reopens the send dialog');
      await page.click('#bsf-overlay [data-bsf="send"]');
      await page.waitForFunction(() => _printCalls.length === 1);
      ok(calls.some(r => r === `/shipping/create-order/${'1'.padStart(24, '0')}`), 'one create-order request');
      await page.waitForSelector('#bsf-overlay [data-bsf="close"]:not([disabled])');
      await page.click('#bsf-overlay [data-bsf="close"]');
      await page.waitForSelector('.pw-actions .pw-ship-sent');
      const a1 = await actions();
      ok(/TR-5566/.test(a1) && (lang === 'en' ? /Bosta/ : /بوسطة/).test(a1), 'sent: one chip «Bosta · tracking»');
      ok(await page.$eval('.pw-ship-sent', el => /With Bosta|أُرسل لبوسطة/.test(el.title)), 'chip says «sent to Bosta» in its tooltip');
      // compact bar: one row, icon buttons, less frequent actions in «⋯»
      const bar = await page.$eval('.pw-actions', el => {
        const kids = [...el.querySelectorAll(':scope > button, :scope > .pw-transfer-actions')];
        const ys = kids.map(k => { const r = k.getBoundingClientRect(); return r.top + r.height / 2; });
        return { rows: Math.max(...ys) - Math.min(...ys) < 8 ? 1 : 2, icons: el.querySelectorAll('.pw-abtn.is-icon').length, text: el.innerText };
      });
      ok(bar.rows === 1, 'the bar fits on one row');
      ok(bar.icons === 3, 'print, invoice and «more» are icon buttons');
      ok(!/معاينة البوليصة|Preview label|إرجاع إلى المعلّق|Return to pending/.test(bar.text), 'rare actions are not on the bar');
      await page.evaluate(() => document.querySelector('.pw-actions [aria-haspopup="menu"]').click());
      await page.waitForSelector('.pu-ctx');
      const more = await page.$$eval('.pu-ctx [data-ctx-item]', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
      ok(more.some(x => /معاينة البوليصة|Preview label/.test(x)) && more.some(x => /المعلّق|pending/i.test(x)) && more.some(x => /TR-5566/.test(x)), '«⋯» holds preview, copy tracking and back to pending');
      ok(await page.$eval('.pu-ctx', el => el.getBoundingClientRect().bottom <= document.querySelector('.pw-actions [aria-haspopup="menu"]').getBoundingClientRect().top + 1), '«⋯» opens upward, above the bar');
      await page.keyboard.press('Escape');
      ok(!(await page.$('.pw-actions .pw-abtn.is-send')), 'sent: send button gone');
      await page.screenshot({ path: path.join(__dirname, `../../../artifacts/pickup-bosta-later-${lang}.png`) }).catch(() => {});

      // 2 · not prepared → nothing
      await select(2);
      await page.waitForFunction(i => document.querySelector('.pw-actions') && _pwSelId === i, {}, id(2));
      ok(!(await page.$('.pw-actions .pw-abtn.is-send')) && !(await page.$('.pw-actions .pw-ship-sent')), 'not prepared: no send button');

      // 3 · exchange shipped from its case → sent with tracking + printable label
      await select(3);
      await page.waitForSelector('.pw-actions .pw-ship-sent');
      ok(/78221930/.test(await actions()), 'exchange: tracking number shown');
      ok(await page.evaluate(i => _bsfIsSent(_pucoGetGroup().orders.find(o => o._id === i)), id(3)), 'exchange with a tracking number counts as sent');
      const printBtn = await page.$('.pw-actions [onclick^="printBostaAwb"]');
      ok(!!printBtn, 'exchange: print-label button present');
      await printBtn.click();
      ok(await page.evaluate(i => _printCalls.includes(i), id(3)), 'exchange label goes to print');

      // 4 · exchange not shipped → the button opens its case
      await select(4);
      await page.waitForSelector('.pw-actions .pw-abtn.is-send');
      ok((lang === 'en' ? /Exchange case/ : /ملف الاستبدال/).test(await actions()), 'unshipped exchange: button leads to its case');

      ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
      await page.close();
    }
    console.log(`pickup-prep-bosta-later: ${passed} checks passed`);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
