// Drag one «جاهز للشحن» card onto another → the two shipping groups merge (same carrier,
// same warehouse, not collected, not two different Bosta pickup requests).
// Runs over the shipped index.html with a mocked API (needs `node frontend/server.js`).
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const user = { _id: 'preview', name: 'Preview', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements'] };
const order = (n, ref, extra = {}) => ({
  _id: String(n).padStart(24, '0'), ref: '520' + n, type: 'مبيعات', client: 'Customer ' + n, date: '2026-11-14',
  total: 100 * n, remaining: 100 * n, pickupStatus: 'Ready', pickupRef: ref, pickupDate: '2026-11-15',
  shipCo: 'Bosta', bostaOrderId: 'B' + n, bostaTrackingNumber: 'T' + n, bostaStatus: 'CREATED', warehouseCode: 'MAIN',
  phone: '0100000000' + n, items: [{ code: 'T', name: 'Basket', qty: 1, price: 100 * n }], ...extra,
});

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

async function openBoard(browser, { lang, width, orders, requests = [], mergeStatus = 200 }) {
  const page = await browser.newPage(), errors = [], merges = [], opened = [];
  await page.setViewport({ width, height: 1000 });
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
    if (route === '/transactions/pickup-orders/merge-ready') {
      const body = JSON.parse(request.postData() || '{}');
      merges.push(body);
      if (mergeStatus !== 200) return respond({ message: 'تغيّرت المجموعة المسحوبة' }, mergeStatus);
      const date = orders.find(o => o.pickupRef === body.targetRef)?.pickupDate;
      orders.filter(o => o.pickupRef === body.sourceRef).forEach(o => { o.pickupRef = body.targetRef; o.pickupDate = date; });
      return respond({ moved: body.ids.length, pickupRef: body.targetRef, pickupDate: date });
    }
    if (route === '/shipping/pickup-preview') { opened.push(route); return respond({ orders: [], numberOfParcels: 0, requests }); }
    return respond(route === '/auth/me' ? user : route === '/settings' ? { lang } :
      ['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route) ? orders : []);
  });
  await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pu-ready-col .pu-group');
  await page.waitForFunction(() => typeof _bostaPickupRequestsKnown !== 'undefined' && _bostaPickupRequestsKnown, { timeout: 5000 }).catch(() => {});
  return { page, errors, merges, opened };
}

const dragCard = (page, from, to, { drop = true } = {}) => page.evaluate((from, to, drop) => {
  const card = ref => document.querySelector(`#pu-ready-col .pu-group[data-group-key="${ref}"]`);
  const dt = new DataTransfer();
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  fire(card(from).querySelector('.pu-group-header'), 'dragstart');
  const target = card(to).querySelector('.pu-prep-content') || card(to);
  fire(target, 'dragenter');
  const over = fire(target, 'dragover');
  const state = { dropAllowed: !over, hint: card(to)?.querySelector('.pu-merge-hint')?.textContent || '',
    blocked: card(to)?.classList.contains('pu-group-mergeblocked'), isTarget: card(to)?.classList.contains('pu-group-mergetarget') };
  if (drop) fire(target, 'drop');
  return state;
}, from, to, drop);

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const [lang, width] of [['ar', 1500], ['en', 1500]]) {
      // ── 1: the screenshot case — 1 order (no pickup request) onto 4 orders under a request.
      const orders = [order(1, '485-15NOV', { pickupDate: '2026-11-16' }), ...[2, 3, 4, 5].map(n => order(n, '248-14NOV'))];
      const requests = [{ id: 'P1', status: 'created', orderIds: [2, 3, 4, 5].map(n => String(n).padStart(24, '0')), scheduledDate: '2026-11-15', canAttach: true, canExtend: false }];
      const s1 = await openBoard(browser, { lang, width, orders, requests });
      const { page } = s1;
      ok(await page.$$eval('#pu-ready-col .pu-group', els => els.length) === 2, 'two ready cards');
      const self = await dragCard(page, '485-15NOV', '485-15NOV', { drop: false });
      ok(!self.dropAllowed && !self.isTarget, 'not a target for itself');
      ok(await page.evaluate(() => document.body.classList.contains('pu-ready-merge-drag')), 'other ready cards are outlined while dragging');
      await page.evaluate(() => _puEndBoardDrag());
      const over = await dragCard(page, '485-15NOV', '248-14NOV');
      ok(over.dropAllowed && over.isTarget && !over.blocked && over.hint, 'target accepts and says «drop to merge»');
      await page.waitForSelector('#pu-cfdlg.active');
      const msg = await page.$eval('#pu-cfdlg-msg', el => el.textContent);
      ok(msg.includes('485-15NOV') && msg.includes('248-14NOV') && msg.includes('5'), 'confirm names both groups and the size');
      ok(/بوسطة|Bosta/.test(msg) && msg.split('\n').length >= 3, 'confirm states the pickup-request and date notes');
      ok(s1.merges.length === 0, 'nothing written before confirming');
      await page.click('#pu-cfdlg-ok');
      await page.waitForFunction(() => document.querySelectorAll('#pu-ready-col .pu-group').length === 1);
      ok(s1.merges.length === 1 && s1.merges[0].sourceRef === '485-15NOV' && s1.merges[0].targetRef === '248-14NOV' && s1.merges[0].ids.length === 1, 'one merge request with the source ids');
      await page.waitForSelector('#pu-cfdlg.active');
      ok(/ضم|join/i.test(await page.$eval('#pu-cfdlg-title', el => el.textContent)), 'offers to join the pickup request');
      await page.evaluate(() => _puCfdlgResolve(false));
      ok(await page.$eval('#pu-ready-col .pu-group', el => el.textContent.includes('5')), 'merged card holds 5 orders');
      ok(!(await page.$('.pu-group-mergetarget,.pu-merge-hint')) && !(await page.evaluate(() => document.body.classList.contains('pu-ready-merge-drag'))), 'no drag traces left');

      // ── 2: different carrier → red hint, drop refused with the reason, no request.
      const o2 = [order(1, 'R-A', { bostaOrderId: '', bostaTrackingNumber: '', bostaStatus: '', shipCo: 'Mylerz' }), order(2, 'R-B')];
      const s2 = await openBoard(browser, { lang, width, orders: o2 });
      const blocked = await dragCard(s2.page, 'R-A', 'R-B');
      ok(blocked.blocked && /مختلفة|different/.test(blocked.hint), 'blocked target shows why in red');
      await new Promise(r => setTimeout(r, 300));
      ok(s2.merges.length === 0 && !(await s2.page.$('#pu-cfdlg.active')), 'no confirm, no request');

      // ── 3: two different pickup requests → refused; same from the right-click menu.
      const o3 = [order(1, 'R-A'), order(2, 'R-B')];
      const req3 = [{ id: 'P1', status: 'created', orderIds: [String(1).padStart(24, '0')] }, { id: 'P2', status: 'created', orderIds: [String(2).padStart(24, '0')] }];
      const s3 = await openBoard(browser, { lang, width, orders: o3, requests: req3 });
      ok((await dragCard(s3.page, 'R-A', 'R-B')).blocked, 'two pickup requests: blocked');
      await new Promise(r => setTimeout(r, 300));
      ok(s3.merges.length === 0, 'no request sent');
      await s3.page.evaluate(() => {
        const card = document.querySelector('#pu-ready-col .pu-group[data-group-key="R-A"]');
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
      });
      await s3.page.waitForSelector('.pu-ctx');
      ok(await s3.page.$$eval('.pu-ctx [disabled], .pu-ctx [aria-disabled="true"]', els => els.some(el => el.textContent.includes('R-B'))), 'menu lists R-B disabled with the reason');

      // ── 4: courier already collected the source → refused.
      const o4 = [order(1, 'R-A', { bostaStatus: 'PICKED_UP' }), order(2, 'R-A'), order(3, 'R-B')];
      const s4 = await openBoard(browser, { lang, width, orders: o4 });
      ok((await dragCard(s4.page, 'R-A', 'R-B')).blocked, 'collected source: blocked');

      // ── 5: server refuses (group changed) → error, reload, both groups stay.
      const o5 = [order(1, 'R-A'), order(2, 'R-B')];
      const s5 = await openBoard(browser, { lang, width, orders: o5, mergeStatus: 409 });
      await dragCard(s5.page, 'R-A', 'R-B');
      await s5.page.waitForSelector('#pu-cfdlg.active');
      await s5.page.click('#pu-cfdlg-ok');
      await new Promise(r => setTimeout(r, 800));
      ok(s5.merges.length === 1 && await s5.page.$$eval('#pu-ready-col .pu-group', els => els.length) === 2, 'refused merge keeps both groups');

      const all = [s1, s2, s3, s4, s5];
      for (const s of all) await s.page.close();
      const errs = all.flatMap(s => s.errors);
      ok(errs.length === 0, 'no page errors: ' + errs.join(' | '));
    }
    console.log(`pickup-ready-merge: ${passed} checks passed`);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
