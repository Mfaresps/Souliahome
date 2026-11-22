/* Stock Demand Analysis — the window reads the server's oldest-first plan, states the
 * three kinds of stock, and recalculates by itself when orders or stock change.
 * Runs the SHIPPED index.html in Chromium; every request is intercepted.
 * Run: node backend/test/browser/demand-fifo.cjs [--shots <dir>]
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

const day = d => `2026-11-${String(d).padStart(2, '0')}T10:00:00.000Z`;
const plan = (id, d, pos, state, items) => ({ transactionId: id, ref: id.slice(1), client: 'Client ' + id, date: day(d), orderTotal: 500,
  deposit: 0, payment: '', state, position: pos, items });
const lineA = { sku: 'A-1', name: 'Basket A', imageUrl: '', supplier: '', required: 4, available: 7, onHand: 7, reservedConfirmed: 2,
  notSellable: 1, sellable: 4, reservedOlder: 2, reserved: 2, freeToUse: 2, shortage: 2, safetyStock: 0, suggestedPurchase: 2,
  status: 'shortage', statusAr: '', buyPrice: 0, sellPrice: 0, lastPurchasePrice: 0, ordersCount: 3,
  affectedOrders: [] };
const base = { skippedOrders: [], totalSkus: 1, totalRequiredQty: 4, totalShortageQty: 2, totalSuggestedPurchaseQty: 2, shortageSkus: 1,
  lowSkus: 0, availableSkus: 0, estimatedPurchaseCost: 0, unknownSkus: [], unmappedItems: [], unlinkedOrders: [], generatedAt: '', ordersCount: 3, queueSize: 6 };
const FIRST = { ...base, lines: [lineA], orderPlan: [
  plan('o3', 2, 2, 'ready', [{ sku: 'A-1', name: 'Basket A', qty: 2, missing: 0, freeAtTurn: 2 }]),
  plan('o1', 3, 3, 'short', [{ sku: 'A-1', name: 'Basket A', qty: 1, missing: 1, freeAtTurn: 0 }]),
  plan('o2', 4, 4, 'short', [{ sku: 'A-1', name: 'Basket A', qty: 1, missing: 1, freeAtTurn: 0 }]),
] };
// An older order was cancelled: its 2 units go to the next in line.
const SECOND = { ...base, queueSize: 5, lines: [{ ...lineA, reservedOlder: 0, reserved: 0, freeToUse: 4, shortage: 0, status: 'available' }], orderPlan: [
  plan('o3', 2, 1, 'ready', [{ sku: 'A-1', name: 'Basket A', qty: 2, missing: 0, freeAtTurn: 4 }]),
  plan('o1', 3, 2, 'ready', [{ sku: 'A-1', name: 'Basket A', qty: 1, missing: 0, freeAtTurn: 2 }]),
  plan('o2', 4, 3, 'ready', [{ sku: 'A-1', name: 'Basket A', qty: 1, missing: 0, freeAtTurn: 1 }]),
] };

// Needs action: a ready order with an edit waiting, a short one with a deposit under review and a cancel request.
const ACT = { ...base, lines: [lineA], orderPlan: [
  { ...plan('o3', 2, 1, 'ready', [{ sku: 'A-1', name: 'Basket A', qty: 2, missing: 0, freeAtTurn: 4 }]), blocks: ['edit-pending'] },
  { ...plan('o1', 3, 2, 'ready', [{ sku: 'A-1', name: 'Basket A', qty: 1, missing: 0, freeAtTurn: 2 }]), blocks: [] },
  { ...plan('o2', 4, 3, 'short', [{ sku: 'A-1', name: 'Basket A', qty: 1, missing: 1, freeAtTurn: 0 }]), blocks: ['deposit-review', 'cancel-request'] },
  { ...plan('o4', 5, 4, 'ready', [{ sku: 'A-1', name: 'Basket A', qty: 1, missing: 0, freeAtTurn: 1 }]), blocks: ['divergence'],
    divergence: { shopifyTotal: 1200, erpTotal: 1100, diff: -100, by: 'Reem', at: '2026-11-20T09:00:00Z', changes: ['الخصم اليدوي: 0 ← 100', 'الإجمالي: 1200 ← 1100'] } },
] };

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const calls = [];
  let reply = FIRST;
  let detailCalls = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setRequestInterception(true);
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', req => {
      const url = new URL(req.url());
      const json = (d, s = 200) => req.respond({ status: s, contentType: 'application/json', body: JSON.stringify(d) });
      if (url.origin === 'http://soulia.test' && url.pathname === '/') return req.respond({ status: 200, contentType: 'text/html', body: html });
      if (url.pathname === '/config.js') return req.respond({ status: 200, contentType: 'text/javascript', body: 'window.__ENV__={API_BASE_URL:""};' });
      if (url.pathname === '/api/shopify/orders/detail/o4') { detailCalls++; return json({ _id: 'o4', ref: '4', items: [] }); }
      if (url.pathname === '/api/demand-planning/analyze-shopify') { calls.push(JSON.parse(req.postData() || '{}')); return json(reply); }
      if (url.origin === 'http://soulia.test' && /\.(css|js)$/.test(url.pathname) && fs.existsSync(path.join(PUB, url.pathname.slice(1))))
        return req.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(path.join(PUB, url.pathname.slice(1))) });
      if (url.pathname.startsWith('/api/')) return json([]);
      if (req.resourceType() === 'script') return req.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      if (req.resourceType() === 'stylesheet') return req.respond({ status: 200, contentType: 'text/css', body: '' });
      return req.respond({ status: 200, contentType: 'text/plain', body: '' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 15000 });
    await page.evaluate(async () => {
      localStorage.setItem('token', 't');
      currentUser = { _id: 'a1', name: 'Admin', username: 'admin', role: 'admin', perms: [] };
      currentLang = 'ar'; document.documentElement.dir = 'rtl';
      qs('#login-page').style.display = 'none'; qs('#app').style.display = ''; qs('#splash-screen')?.remove();
      await _dpRunAnalysis('shopify', '/demand-planning/analyze-shopify', { orderIds: ['o1', 'o2', 'o3'] }, ['o1', 'o2', 'o3'], null);
    });

    let s = await page.evaluate(() => ({
      ready: _dpOrdersPivot.ready.map(o => o.ref), short: _dpOrdersPivot.missing.map(o => o.ref),
      shortRows: qsa('#dp-ord-tbody-missing tr .dp-ord-ref').map(e => e.textContent),
      pos: qsa('#dp-ord-tbody-missing .dpx-pos').map(e => e.textContent),
      sortReady: qs('#dp-ord-sort-ready').value, sortMissing: qs('#dp-ord-sort-missing').value,
      avail: qs('#dp-ord-tbody-missing').textContent.includes('0 / '),
      notice: qs('#dp-notice-wrap').textContent,
    }));
    check(s.ready.join() === '3' && s.short.join() === '1,2', 'ready/short come from the server plan');
    check(s.sortReady === 'date-asc' && s.sortMissing === 'date-asc', 'both order tabs open oldest first');
    check(s.shortRows.join() === '#1,#2', 'short orders listed in queue order');
    check(s.pos.join() === 'الدور 3,الدور 4', 'each order states its turn in the queue');
    check(s.avail, '«available / missing» uses what was free at the order\'s turn');
    check(/بالأقدم أولًا/.test(s.notice) && /6 أوردر معلّق/.test(s.notice), 'notice explains oldest-first over 6 pending orders');

    await page.evaluate(() => _dpToggleRow('A-1'));
    const chain = await page.evaluate(() => [...qsa('#dp-tbody .dpx-eq .c')].map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    check(chain[0] === 'في المخزن فعليًا7', 'chain starts with stock physically in the warehouse');
    check(chain.includes('محجوز لأوردرات مؤكدة2') && chain.includes('غير صالح للبيع1'), 'held for confirmed orders and not sellable, each once');
    check(chain.includes('صالح للبيع4') && chain.includes('محجوز لأوردرات أقدم2') && chain.includes('المتاح لهذه الطلبات2'), 'sellable − older orders = free for these');
    if (shotsDir) { fs.mkdirSync(shotsDir, { recursive: true }); await page.screenshot({ path: path.join(shotsDir, 'dp-fifo-chain.png') }); }

    // Live: a burst of events → one recalculation, oldest-first redistribution.
    reply = SECOND;
    await page.evaluate(() => { for (let i = 0; i < 6; i++) _dpScheduleLiveRefresh(); });
    await page.waitForFunction(() => _dpOrdersPivot.ready.length === 3, { timeout: 6000 });
    s = await page.evaluate(() => ({ toast: [...qsa('.toast, #toast, [class*="toast"]')].map(e => e.textContent).join(' '), tab: qs('.dp-tab.active')?.dataset.dpTab }));
    check(calls.length === 2 && calls[1].persistLog === false, 'six live events → one recalculation, not logged');
    check(/تغيّر توزيع المخزون/.test(s.toast), 'the redistribution is announced');

    // Manual refresh with no change
    await page.evaluate(() => qs('#dp-refresh-btn').click());
    await page.waitForFunction(n => window.__calls === undefined, {}, calls.length);
    await new Promise(r => setTimeout(r, 400));
    check(calls.length === 3, 'the refresh button recalculates');
    check(!(await page.evaluate(() => qs('#dp-refresh-btn').classList.contains('is-busy'))), 'refresh button settles');

    // Closed window: events do nothing
    await page.evaluate(() => { closeDemandPlanning(); _dpScheduleLiveRefresh(); });
    await new Promise(r => setTimeout(r, 1800));
    check(calls.length === 3, 'no recalculation while the window is closed');

    // Bulk confirm checks stock oldest first
    const order = await page.evaluate(() => {
      _shopifyOrders = [
        { _id: 'n', ref: 'N', status: 'pending', shopifyCreatedAt: '2026-11-05T00:00:00Z', items: [] },
        { _id: 'o', ref: 'O', status: 'pending', shopifyCreatedAt: '2026-11-01T00:00:00Z', items: [] },
      ];
      return ['n', 'o'].sort((x, y) => _spCreatedMs(x) - _spCreatedMs(y)).join();
    });
    check(order === 'o,n', 'bulk confirm orders the batch by creation date');

    // «يحتاج إجراء»
    reply = ACT;
    await page.evaluate(async () => {
      window.__acted = [];
      openSpOrderPeek = id => window.__acted.push('peek:' + id);
      approveShopifyOrder = id => window.__acted.push('approve:' + id);
      _shopifyOrders = [];
      await _dpRunAnalysis('shopify', '/demand-planning/analyze-shopify', { orderIds: ['o1', 'o2', 'o3', 'o4'] }, ['o1', 'o2', 'o3', 'o4'], null);
      _dpGoTab('action');
    });
    await new Promise(r => setTimeout(r, 300));
    const act = await page.evaluate(() => ({
      ready: _dpOrdersPivot.ready.map(o => o.ref).join(), short: _dpOrdersPivot.missing.map(o => o.ref).join(),
      tab: getComputedStyle(qs('.dp-tab[data-dp-tab="action"]')).display !== 'none', cnt: qs('#dp-tab-cnt-action').textContent,
      groups: qsa('#dp-act-groups .dpx-act-head h4').map(h => h.textContent.replace(/\s+/g, ' ').trim()),
      more: qsa('#dp-act-groups .dpx-act-more span').map(e => e.textContent),
      stock: qsa('#dp-act-groups .dp-badge').map(e => e.textContent.trim()),
      blocks: qsa('#dp-summary .dpx-blocks i.is-act').length,
      line: qs('#dp-summary').textContent.includes('يحتاج إجراء قبل التأكيد'),
      keyLeak: /dpAct/.test(qs('#dp-tabpane-action').textContent),
    }));
    check(act.ready === '1' && act.short === '', 'blocked orders leave «ready» and «short»');
    check(act.tab && act.cnt === '3', '«يحتاج إجراء» tab shown with 3');
    check(act.groups.join('|') === 'طلب إلغاء بانتظار القرار 1|تعديل بانتظار الموافقة 1|الإجمالي مختلف عن Shopify 1', 'grouped by the most urgent reason, in order');
    check(act.more.join() === 'عربون قيد المراجعة', 'a second reason is listed under the order');
    check(act.stock.join() === 'المخزون ناقص,المخزون محجوز له,المخزون محجوز له', 'each row states whether its stock is held');
    check(act.blocks === 3 && act.line, 'headline counts orders that need an action');
    check(!act.keyLeak, 'no raw translation keys');
    await page.evaluate(() => { qsa('#dp-act-groups .dpx-unl-btn').forEach(b => b.click()); });
    const acted = await page.evaluate(() => window.__acted.join());
    check(acted === 'peek:o2,peek:o3,approve:o4', 'each button opens the window that resolves it');
    // Where the difference is
    const div = await page.evaluate(() => qs('#dp-act-groups .dpx-div').textContent.replace(/\s+/g, ' ').trim());
    check(/Shopify/.test(div) && /1,200/.test(div) && /1,100/.test(div), 'both totals are stated');
    check(/النظام أقل بـ/.test(div) && /100/.test(div), 'the gap is said in words, not as a bare sign');
    await page.evaluate(() => qs('#dp-act-groups .dpx-div .dpx-link').click());
    await page.waitForFunction(() => !!qs('#dp-act-groups .dpx-div-detail') && !qs('#dp-act-groups .dpx-div-detail .dpx-spin'), { timeout: 4000 });
    const det = await page.evaluate(() => ({ text: qs('#dp-act-groups .dpx-div-detail').textContent, lines: qsa('#dp-act-groups .dpx-div-lines li').length,
      exp: qs('#dp-act-groups .dpx-div .dpx-link').getAttribute('aria-expanded') }));
    check(det.lines === 2 && /الخصم اليدوي/.test(det.text), '«ما الذي تغيّر؟» lists the edit\'s changes');
    check(/عدّله Reem/.test(det.text), 'who made the edit and when');
    check(detailCalls === 1 && det.exp === 'true', 'the order detail is read once for the photo explanation');
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, 'dp-action.png') });
    await page.evaluate(() => qs('#dp-act-groups .dpx-div .dpx-link').click());
    check(!(await page.evaluate(() => !!qs('#dp-act-groups .dpx-div-detail'))), 'it folds back'); 

    check(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log(`\n${checks} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); if (errors.length) console.error('page errors:', errors); process.exit(1); });
