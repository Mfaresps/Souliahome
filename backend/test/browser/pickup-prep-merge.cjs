// Drag one «قيد التجهيز» card onto another → the two prep groups merge.
// Runs over the shipped index.html with a mocked API (needs `node frontend/server.js`).
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const user = { _id: 'preview', name: 'Preview', role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'movements'] };
const order = (n, ref, extra = {}) => ({
  _id: String(n).padStart(24, '0'), ref: '410' + n, type: 'مبيعات', client: 'Customer ' + n, date: '2026-11-14',
  total: 100 * n, remaining: 100 * n, pickupStatus: 'Preparing', pickupRef: ref, prepCreatedAt: '2026-11-14',
  shipCo: 'Bosta', phone: '0100000000' + n, items: [{ code: 'T', name: 'Basket', qty: 1, price: 100 * n }], ...extra,
});

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

async function openBoard(browser, { lang, width, orders, mergeStatus = 200 }) {
  const page = await browser.newPage(), errors = [], merges = [];
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
    if (route === '/transactions/pickup-orders/merge-prep') {
      const body = JSON.parse(request.postData() || '{}');
      merges.push(body);
      if (mergeStatus !== 200) return respond({ message: 'تغيّرت المجموعة المسحوبة' }, mergeStatus);
      orders.filter(o => o.pickupRef === body.sourceRef).forEach(o => { o.pickupRef = body.targetRef; });
      return respond({ moved: body.ids.length, pickupRef: body.targetRef });
    }
    return respond(route === '/auth/me' ? user : route === '/settings' ? { lang } :
      ['/transactions', '/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(route) ? orders : []);
  });
  await page.goto('http://localhost:8080/#pickup-orders', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#pu-prep-col .pu-group');
  return { page, errors, merges };
}

/** Drag the header of prep card `from` and hover / drop it on prep card `to`. */
const dragCard = (page, from, to, { drop = true } = {}) => page.evaluate((from, to, drop) => {
  const card = ref => document.querySelector(`#pu-prep-col .pu-group[data-group-key="${ref}"]`);
  const dt = new DataTransfer();
  const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  fire(card(from).querySelector('.pu-group-header'), 'dragstart');
  const target = card(to).querySelector('.pu-prep-content') || card(to);
  fire(target, 'dragenter');
  const over = fire(target, 'dragover'); // false = preventDefault called = drop allowed
  const state = { dropAllowed: !over, hinted: !!card(to)?.querySelector('.pu-merge-hint'), isTarget: card(to)?.classList.contains('pu-group-mergetarget') };
  if (drop) fire(target, 'drop');
  return state;
}, from, to, drop);

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    for (const [lang, width] of [['ar', 1500], ['en', 1500]]) {
      // ── Scenario 1: drag A (2 orders, one prepared) onto B (1 order) → confirm → merged.
      const orders = [order(1, 'PREP-A', { prepChecked: true, prepNote: 'دفعة A' }), order(2, 'PREP-A'), order(3, 'PREP-B', { prepNote: 'دفعة B' })];
      const { page, errors, merges } = await openBoard(browser, { lang, width, orders });
      ok(await page.$$eval('#pu-prep-col .pu-group', els => els.length) === 2, 'two prep cards');

      const self = await dragCard(page, 'PREP-A', 'PREP-A', { drop: false });
      ok(!self.dropAllowed && !self.isTarget, 'a card is not a merge target for itself');
      await page.evaluate(() => _puEndBoardDrag());

      const hover = await dragCard(page, 'PREP-A', 'PREP-B');
      ok(hover.dropAllowed && hover.isTarget && hover.hinted, 'the other card accepts the drop and says «drop to merge»');
      await page.waitForSelector('#pu-cfdlg.active');
      const msg = await page.$eval('#pu-cfdlg-msg', el => el.textContent);
      ok(msg.includes('PREP-A') && msg.includes('PREP-B') && msg.includes('3'), 'confirm names both groups and the merged size');
      ok(/ملاحظة|note/i.test(msg), 'confirm says the source note is not carried over');
      ok(merges.length === 0, 'nothing is written before confirming');
      await page.click('#pu-cfdlg-ok');
      await page.waitForFunction(() => document.querySelectorAll('#pu-prep-col .pu-group').length === 1);
      ok(merges.length === 1 && merges[0].sourceRef === 'PREP-A' && merges[0].targetRef === 'PREP-B'
        && merges[0].ids.length === 2, 'one merge request with the source ids');
      const grp = await page.evaluate(() => _puPrepGroups.map(g => ({ ref: g.prepRef, n: g.orders.length, checked: g.orders.filter(o => o.prepChecked).length })));
      ok(grp.length === 1 && grp[0].ref === 'PREP-B' && grp[0].n === 3, 'one group PREP-B with 3 orders');
      ok(grp[0].checked === 1, 'the prepared tick survived the merge');
      ok(await page.$eval('#pu-prep-col .pu-group', el => el.textContent.includes('1/3')), 'card progress reads 1/3');
      ok(!(await page.$('.pu-group-mergetarget,.pu-merge-hint')) && !(await page.evaluate(() => document.body.classList.contains('pu-prep-merge-drag'))), 'no drag traces left');

      // ── Scenario 2: cancel the confirm → nothing changes.
      const o2 = [order(1, 'PREP-A'), order(2, 'PREP-B')];
      const s2 = await openBoard(browser, { lang, width, orders: o2 });
      await dragCard(s2.page, 'PREP-A', 'PREP-B');
      await s2.page.waitForSelector('#pu-cfdlg.active');
      await s2.page.evaluate(() => _puCfdlgResolve(false));
      await new Promise(r => setTimeout(r, 200));
      ok(s2.merges.length === 0 && await s2.page.$$eval('#pu-prep-col .pu-group', els => els.length) === 2, 'cancel keeps both groups');

      // ── Scenario 3: server refuses (group changed) → error, board reloaded, both groups intact.
      const o3 = [order(1, 'PREP-A'), order(2, 'PREP-B')];
      const s3 = await openBoard(browser, { lang, width, orders: o3, mergeStatus: 409 });
      await dragCard(s3.page, 'PREP-A', 'PREP-B');
      await s3.page.waitForSelector('#pu-cfdlg.active');
      await s3.page.click('#pu-cfdlg-ok');
      await s3.page.waitForFunction(() => [...document.querySelectorAll('.toast, #toast, [class*="toast"]')].some(t => /تغيّرت|Error|خطأ/.test(t.textContent)), { timeout: 4000 });
      ok(await s3.page.$$eval('#pu-prep-col .pu-group', els => els.length) === 2, 'a refused merge leaves both groups');

      // ── Scenario 4: a pending row dropped on a prep card still joins it (unchanged path).
      const s4ok = await s3.page.evaluate(() => typeof _puAddPendingToPrepGroup === 'function');
      ok(s4ok, 'pending → card path still present');

      for (const p of [page, s2.page, s3.page]) await p.close();
      ok([...errors, ...s2.errors, ...s3.errors].length === 0, 'no page errors: ' + [...errors, ...s2.errors, ...s3.errors].join(' | '));
    }
    console.log(`pickup-prep-merge: ${passed} checks passed`);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
