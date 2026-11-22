/* Stock Demand Analysis — orders with an unlinked item leave «Ready to ship»,
 * get their own «Not linked» tab, claim no stock, and re-analyse after linking.
 * Runs the SHIPPED index.html in Chromium; every request is intercepted.
 * Run: node backend/test/browser/demand-unlinked.cjs [--shots <dir>]
 */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const PUB = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : '';
let checks = 0;
const errors = [];
function check(c, m) { assert.ok(c, m); checks++; console.log('  ✓ ' + m); }

const ord = (id, ref, date, qty = 1) => ({ transactionId: id, ref, client: 'Client ' + ref, phone: '', date, qty, variant: '',
  cancelled: false, pickupStatus: '', bostaStatus: '', orderTotal: 1000, deposit: 0, payment: '', notes: '', tags: '' });
const line = (free, orders) => ({ sku: 'A-1', name: 'Basket A', imageUrl: '', supplier: '', required: orders.reduce((s, o) => s + o.qty, 0),
  available: free, reserved: 0, freeToUse: free, shortage: Math.max(0, orders.reduce((s, o) => s + o.qty, 0) - free), safetyStock: 0,
  suggestedPurchase: 0, status: 'available', statusAr: '', buyPrice: 0, sellPrice: 0, lastPurchasePrice: 0, ordersCount: orders.length, affectedOrders: orders });
const base = { skippedOrders: [], totalSkus: 1, totalShortageQty: 0, totalSuggestedPurchaseQty: 0, shortageSkus: 0, lowSkus: 0,
  availableSkus: 1, estimatedPurchaseCost: 0, unknownSkus: [], generatedAt: new Date().toISOString() };
/* Stock 2. #2 (oldest, highest value) also holds an unlinked line: it must NOT take a unit,
   so #1 and #3 are both ready. Before the fix #2 took one and #3 read «short». */
const FIRST = { ...base, ordersCount: 3, totalRequiredQty: 3, unmappedItems: ['Bow dining "12"'],
  lines: [line(2, [ord('o2', '2', '2026-11-01T10:00:00Z'), ord('o1', '1', '2026-11-02T10:00:00Z'), ord('o3', '3', '2026-11-03T10:00:00Z')])],
  unlinkedOrders: [{ transactionId: 'o2', ref: '2', client: 'Client 2', date: '2026-11-01T10:00:00Z', orderTotal: 1000,
    items: [{ name: 'Bow dining "12"', code: 'SHOPIFY', qty: 2 }] },
  { transactionId: 'o4', ref: '4', client: 'Client 4', date: '2026-10-30T10:00:00Z', orderTotal: 600,
    items: [{ name: 'Bow dining "12"', code: 'SHOPIFY', qty: 1 }, { name: 'Rug X', code: 'RUG-X', qty: 1 }] }] };
const SECOND = { ...base, ordersCount: 3, totalRequiredQty: 3, unmappedItems: [], unlinkedOrders: [],
  lines: [line(3, [ord('o2', '2', '2026-11-01T10:00:00Z'), ord('o1', '1', '2026-11-02T10:00:00Z'), ord('o3', '3', '2026-11-03T10:00:00Z')])] };

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const calls = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setRequestInterception(true);
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', req => {
      const url = new URL(req.url());
      const reply = (d, s = 200) => req.respond({ status: s, contentType: 'application/json', body: JSON.stringify(d) });
      if (url.origin === 'http://soulia.test' && url.pathname === '/') return req.respond({ status: 200, contentType: 'text/html', body: html });
      if (url.pathname === '/config.js') return req.respond({ status: 200, contentType: 'text/javascript', body: 'window.__ENV__={API_BASE_URL:""};' });
      if (url.pathname === '/api/demand-planning/analyze-shopify') {
        const body = JSON.parse(req.postData() || '{}');
        calls.push(body);
        return reply(calls.length === 1 ? FIRST : SECOND);
      }
      if (url.origin === 'http://soulia.test' && /\.(css|js)$/.test(url.pathname) && fs.existsSync(path.join(PUB, url.pathname.slice(1))))
        return req.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(path.join(PUB, url.pathname.slice(1))) });
      if (url.pathname.startsWith('/api/')) return reply([]);
      if (req.resourceType() === 'script') return req.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      if (req.resourceType() === 'stylesheet') return req.respond({ status: 200, contentType: 'text/css', body: '' });
      return req.respond({ status: 200, contentType: 'text/plain', body: '' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 15000 });
    const boot = lang => page.evaluate(async lang => {
      localStorage.setItem('token', 't');
      currentUser = { _id: 'a1', name: 'Admin', username: 'admin', role: 'admin', perms: [] };
      currentLang = lang; document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl';
      qs('#login-page').style.display = 'none'; qs('#app').style.display = ''; qs('#splash-screen')?.remove();
      // The edit window is stood in for: it opens, and closing it is "saved".
      window.__edited = [];
      editShopifyOrder = async id => { window.__edited.push(id); const m = document.createElement('div'); m.id = 'shopify-edit-modal'; document.body.appendChild(m); };
      await _dpRunAnalysis('shopify', '/demand-planning/analyze-shopify', { orderIds: ['o1', 'o2', 'o3', 'o4'] }, ['o1', 'o2', 'o3', 'o4'], null);
    }, lang);
    await boot('ar');

    const state = () => page.evaluate(() => ({
      ready: _dpOrdersPivot.ready.map(o => o.ref).sort(),
      missing: _dpOrdersPivot.missing.map(o => o.ref),
      unlinked: _dpOrdersPivot.unlinked.map(o => o.ref),
      tabShown: getComputedStyle(qs('.dp-tab[data-dp-tab="unlinked"]')).display !== 'none',
      tabCnt: qs('#dp-tab-cnt-unlinked').textContent.trim(),
      readyRows: qs('#dp-ord-tbody-ready').textContent,
      linkBlocks: qsa('#dp-summary .dpx-blocks i.is-link').length,
      heroLine: qs('#dp-summary .dpx-unl-line')?.textContent || '',
      noticeBtn: !!qs('#dp-notice-wrap .dpx-link'),
    }));
    let s = await state();
    check(JSON.stringify(s.ready) === '["1","3"]', 'ready = #1 and #3 (the unlinked #2 claims no stock)');
    check(s.missing.length === 0, 'nothing reads «short»');
    check(JSON.stringify(s.unlinked) === '["2","4"]', 'unlinked = #2 and #4');
    check(!/#2|#4/.test(s.readyRows), 'unlinked orders are absent from the ready table');
    check(s.tabShown && s.tabCnt === '2', '«غير مربوط» tab shown with count 2');
    check(s.linkBlocks === 2, 'headline draws 2 amber blocks for unlinked orders');
    check(/2 أوردر/.test(s.heroLine), 'headline states the unlinked count');
    check(s.noticeBtn, 'unmapped notice links to the orders');

    await page.evaluate(() => _dpGoUnlinked());
    const tab = await page.evaluate(() => ({
      active: qs('#dp-tabpane-unlinked').classList.contains('active'),
      refs: qsa('#dp-ord-tbody-unlinked tr .dp-ord-ref').map(e => e.textContent),
      chips: qsa('#dp-unl-intro .dpx-unl-chip').map(e => e.textContent.replace(/\s+/g, ' ').trim()),
      btns: qsa('#dp-ord-tbody-unlinked .dpx-unl-btn').length,
      code: qs('#dp-ord-tbody-unlinked').textContent.includes('RUG-X'),
      placeholder: qs('#dp-ord-tbody-unlinked').textContent.includes('SHOPIFY'),
    }));
    check(tab.active, 'the link opens the «غير مربوط» tab');
    check(tab.refs.join() === '#4,#2', 'oldest first (#4 before #2)');
    check(tab.chips[0].startsWith('Bow dining "12"') && /2 أوردر/.test(tab.chips[0]), 'chip: the shared product, in 2 orders (quote kept)');
    check(tab.btns === 2, 'a «ربط الأصناف» button per order');
    check(tab.code && !tab.placeholder, 'a real code is shown, the SHOPIFY placeholder is not');

    await page.evaluate(() => qsa('#dp-unl-intro .dpx-unl-chip')[1].click());   // «Rug X»
    check((await page.evaluate(() => qsa('#dp-ord-tbody-unlinked tr .dp-ord-ref').map(e => e.textContent).join())) === '#4', 'chip filters to the orders holding that item');
    await page.evaluate(() => qsa('#dp-unl-intro .dpx-unl-chip')[1].click());
    check((await page.evaluate(() => qsa('#dp-ord-tbody-unlinked tr').length)) === 2, 'clicking it again clears the filter');

    // The underline slides; wait for it to land rather than reading it mid-way.
    const ink = await page.waitForFunction(() => {
      const i = qs('#demand-planning-modal .dpx-ink').getBoundingClientRect(), t = qs('.dp-tab[data-dp-tab="unlinked"]').getBoundingClientRect();
      return Math.abs(i.left - t.left) < 2 && Math.abs(i.width - t.width) < 2;
    }, { timeout: 3000 }).then(() => true, () => false);
    check(ink, 'tab underline sits under «غير مربوط»');
    if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, 'dp-unlinked-ar.png') }); }

    // Link #2: the edit window opens; closing it re-reads the analysis.
    await page.evaluate(() => qsa('#dp-ord-tbody-unlinked .dpx-unl-btn')[1].click());
    await page.waitForFunction(() => !!document.getElementById('shopify-edit-modal'));
    check((await page.evaluate(() => window.__edited.join())) === 'o2', 'the button opens the edit window of that order');
    await page.evaluate(() => document.getElementById('shopify-edit-modal').remove());
    await page.waitForFunction(() => _dpOrdersPivot.unlinked.length === 0, { timeout: 5000 });
    s = await state();
    check(calls.length === 2 && calls[1].persistLog === false && calls[1].orderIds.length === 4, 're-analysed the same orders, not logged');
    check(JSON.stringify(s.ready) === '["1","2","3"]', 'after linking, #2 moved to ready');
    check(!s.tabShown, 'the empty «غير مربوط» tab hides');
    check((await page.evaluate(() => qs('#dp-tabpane-ready').classList.contains('active'))), 'the window falls back to «جاهز للشحن»');
    check((await page.evaluate(() => qs('#demand-planning-modal').style.display)) === 'flex', 'the window stayed open');
    check(!s.heroLine, 'headline no longer mentions unlinked orders');

    // English, dark
    calls.length = 0;
    await page.evaluate(() => document.body.classList.add('dark-mode'));
    await boot('en');
    await page.evaluate(() => { try { applyLang(); } catch (_) {} _dpGoUnlinked(); });
    const en = await page.evaluate(() => ({ tab: qs('.dp-tab[data-dp-tab="unlinked"]').textContent, btn: qs('.dpx-unl-btn').textContent,
      chip: qs('.dpx-unl-chip').textContent, over: document.documentElement.scrollWidth > innerWidth + 1 }));
    check(/Not linked/.test(en.tab) && en.btn === 'Link items' && /in 2 orders/.test(en.chip), 'English labels');
    check(!en.over, 'no horizontal overflow');
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'dp-unlinked-en-dark.png') });

    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log(`\n${checks} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); if (errors.length) console.error('page errors:', errors); process.exit(1); });
