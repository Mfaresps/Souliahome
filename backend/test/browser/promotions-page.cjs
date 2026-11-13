// «العروض والخصومات» page over the SHIPPED files: promotions.js + promotions.css, the app's own
// stylesheet, and the real helpers extracted from index.html (promoPerm, requirePromoPerm, the
// offer/line rules, the code-date rules). Only the network and the old write functions are faked.
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const fnSrc = (name) => {
  const m = new RegExp('\\n(?:async )?function ' + name + '\\(').exec(html);
  assert.ok(m, 'extract ' + name);
  const end = html.indexOf('\n}\n', m.index + 1);
  return html.slice(m.index + 1, end + 3);
};
const line = (start) => { const i = html.indexOf(start); assert.ok(i > 0, 'extract ' + start); return html.slice(i, html.indexOf('\n', i)); };
const helpers = [
  line('const PROMO_PERMS ='), line('const PO_REASONS ='),
  ...['promoPerm', 'requirePromoPerm', '_offerActiveOn', '_effectiveSellPrice', '_lineOfferOf', '_codeNotStarted', '_codeExpired',
    '_liveCodeUsage', '_psDate', 'todayLocalISO', 'discBadgeHtml', 'fmtMoneyN', '_offerTagHtml', '_dmyText', '_dmySync'].map(fnSrc),
].join('\n');
const reasons = html.slice(html.indexOf('  poR_blackFriday:'), html.indexOf('\n', html.indexOf('  poR_limited:')));
// The page reaches the old write functions by name; their guard must be the real one.
const guardedToggle = fnSrc('toggleDiscountCodeActive');
assert.ok(/^async function toggleDiscountCodeActive\(id, active\) \{\n  if \(!requirePromoPerm\('codes'\)\) return;/.test(guardedToggle), 'toggleDiscountCodeActive starts with its perm guard');

const TODAY = (() => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); })();
const add = (n) => new Date(Date.parse(TODAY) + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
  let failures = 0;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', (r) => r.respond({ status: 200, contentType: 'text/html; charset=utf-8',
      body: '<html dir="rtl"><body><div id="main"><div class="page active" id="page-promotions"><div id="promo-root"></div></div></div><div id="modal-overlay"><div id="modal-content"></div></div></body></html>' }));
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto('https://soulia.test/');
    await page.addStyleTag({ content: html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1] });
    await page.addStyleTag({ path: path.join(root, 'promotions.css') });
    await page.evaluate((reasons, TODAY, d) => {
      window.qs = (s) => document.querySelector(s); window.qsa = (s) => [...document.querySelectorAll(s)];
      window.currentLang = 'ar'; window.currentPage = 'promotions';
      const TR = eval('({' + reasons + '})');
      window.t = (k) => (TR[k] ? (TR[k][currentLang] || TR[k].ar) : k);
      window.esc = (v) => { const x = document.createElement('div'); x.textContent = v == null ? '' : String(v); return x.innerHTML; };
      window.escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      window.fmtN = (n) => Number(n || 0).toLocaleString('en-US');
      window.fmtJ = (n) => `<span class="amt-cur">EGP</span> <span class="amt-num">${Number(n || 0).toLocaleString('en-US')}</span>`;
      window.sanitizeUrl = (u) => (/^https?:/.test(u || '') ? u : '');
      window.currentUser = { role: 'admin', perms: [] };
      window.isAdmin = () => currentUser.role === 'admin';
      window.hasPerm = (p) => isAdmin() || (currentUser.perms || []).includes(p);
      window.toasts = []; window.toast = (m, err) => toasts.push((err ? 'ERR:' : '') + m);
      window.confirms = []; window.showConfirm = async (msg, o) => { confirms.push({ msg, title: o?.title }); return true; };
      window.openModal = (h) => { qs('#modal-content').innerHTML = h; qs('#modal-overlay').classList.add('active'); };
      window.closeModal = () => { qs('#modal-overlay').classList.remove('active'); qs('#modal-content').innerHTML = ''; };
      window.navigateTo = (p) => { window.navigated = p; }; window.findFirstAllowedPage = () => 'dashboard';
      window.TAG_CATEGORY_LABELS = { operational: 'تشغيلي', risk: 'مخاطر', system: 'نظام' };
      window.writes = [];
      ['openAddDiscountCodeModal', 'openEditDiscountCodeModal', 'deleteDiscountCode', 'showCodeUsageHistory', 'openAddBundleModal',
        'openEditBundleModal', 'toggleBundleActive', 'deleteDiscountBundle', 'addMasterTag', 'setMasterTagCategory', 'deleteMasterTag', '_clearBundleAuditLog']
        .forEach((n) => { window[n] = async (...a) => { writes.push([n, ...a]); }; });
      window.products = [
        { _id: 'p1', name: 'Bow dining', code: 'BOW-1', sellPrice: 400, isActive: true, priceOffers: [] },
        { _id: 'p2', name: 'Ribbon Storage', code: 'RIB-2', sellPrice: 1000, isActive: true, priceOffers: [] },
        { _id: 'p3', name: 'Coaster set', code: 'CST-3', sellPrice: 250, isActive: true, priceOffers: [] },
      ];
      window.OFFERS = [
        { id: 'o1', price: 300, from: d.m3, to: d.p5, reason: 'عرض الصيف', by: 'Fares', status: 'active', productId: 'p1', productName: 'Bow dining', productCode: 'BOW-1', basePrice: 400 },
        { id: 'o2', price: 800, from: d.p3, to: d.p10, reason: 'بلاك فرايداي', by: 'Fares', status: 'upcoming', productId: 'p2', productName: 'Ribbon Storage', productCode: 'RIB-2', basePrice: 1000 },
        { id: 'o3', price: 200, from: d.m30, to: d.m20, reason: 'تصفية', status: 'ended', productId: 'p3', productName: 'Coaster set', productCode: 'CST-3', basePrice: 250 },
      ];
      window.transactions = [
        { _id: 't1', type: 'مبيعات', date: TODAY, items: [{ code: 'BOW-1', productId: 'p1', qty: 2, price: 300, listPrice: 400, priceSource: 'offer', offerId: 'o1', offerName: 'عرض الصيف' }], tags: ['VIP'], discountCode: "O'NEIL", discountCodeId: 'c2', discount: 50, total: 550 },
        { _id: 't2', type: 'مبيعات', date: TODAY, items: [{ code: 'BOW-1', productId: 'p1', qty: 1, price: 300, listPrice: 400, priceSource: 'offer', offerId: 'o1' }], tags: ['VIP', 'عاجل'] },
        { _id: 't3', type: 'مبيعات', cancelled: true, date: TODAY, items: [{ code: 'BOW-1', productId: 'p1', qty: 5, price: 300, listPrice: 400, priceSource: 'offer', offerId: 'o1' }] },
      ];
      window.settings = {
        discountCodes: [
          { id: 'c1', code: 'SAVE10', type: 'percent', value: 10, active: true, description: 'خصم ترحيبي' },
          { id: 'c2', code: "O'NEIL", type: 'fixed', value: 50, active: true },
          { id: 'c3', code: 'OLD', type: 'fixed', value: 20, active: true, endDate: d.m20 },
          { id: 'c4', code: 'OFF', type: 'percent', value: 5, active: false },
        ],
        discountBundles: [{ id: 'b1', name: 'باقة السفرة', productIds: ['p1', 'p3'], discountCodeId: 'c1', allowPartial: true, minQty: 2, priority: 1, active: true }],
      };
      window.masterTags = [{ _id: 'g1', name: 'VIP', bg: '#3b82f6', category: 'operational' }, { _id: 'g2', name: 'عاجل', bg: '#ef4444' }];
      window.AUDIT = [
        { id: 'a1', at: new Date().toISOString(), employee: 'Reem', kind: 'bundle', action: 'applied', label: 'SAVE10 / باقة السفرة', amount: 80 },
        { id: 'a2', at: new Date().toISOString(), employee: 'Fares', kind: 'offer', action: 'stopped', label: 'تصفية', amount: 200 },
      ];
      window.calls = [];
      window.api = async (url, opts = {}) => {
        const method = opts.method || 'GET';
        calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
        await new Promise((r) => setTimeout(r, 15));
        if (url === '/products/offers/all') return { today: TODAY, rows: OFFERS.map((o) => ({ ...o })) };
        if (url === '/settings/discount-codes') return settings.discountCodes;
        if (url === '/settings/discount-bundles') return settings.discountBundles;
        if (url === '/tags') return masterTags;
        if (url.startsWith('/promotions/audit')) return { rows: AUDIT, total: AUDIT.length, truncated: false };
        const end = /^\/products\/(\w+)\/offers\/(\w+)\/end$/.exec(url);
        if (end) { const o = OFFERS.find((x) => x.id === end[2]); o.status = o.status === 'upcoming' ? 'cancelled' : 'ended'; o.endedOn = TODAY; return o; }
        const patch = /^\/products\/(\w+)\/offers\/(\w+)$/.exec(url);
        if (patch && method === 'PATCH') { const o = OFFERS.find((x) => x.id === patch[2]); Object.assign(o, JSON.parse(opts.body)); if (o.from <= TODAY) o.status = 'active'; return o; }
        const post = /^\/products\/(\w+)\/offers$/.exec(url);
        if (post && method === 'POST') { const p = products.find((x) => x._id === post[1]); const b = JSON.parse(opts.body); const o = { id: 'o' + (OFFERS.length + 1), ...b, status: b.from > TODAY ? 'upcoming' : 'active', productId: p._id, productName: p.name, productCode: p.code, basePrice: p.sellPrice }; OFFERS.push(o); return o; }
        const tag = /^\/tags\/(\w+)$/.exec(url);
        if (tag && method === 'PATCH') { const g = masterTags.find((x) => x._id === tag[1]); Object.assign(g, JSON.parse(opts.body)); return { ...g }; }
        throw new Error('unexpected ' + method + ' ' + url);
      };
    }, reasons, TODAY, { m3: add(-3), p5: add(5), p3: add(3), p10: add(10), m30: add(-30), m20: add(-20) });
    await page.addScriptTag({ content: helpers + '\n' + guardedToggle.replace('async function toggleDiscountCodeActive', 'window.toggleDiscountCodeActive = async function') + '\n' });
    // the real toggle body talks to the API and the old renderer; keep only its guard observable
    await page.evaluate(() => { const real = window.toggleDiscountCodeActive; window.toggleDiscountCodeActive = async (id, a) => { writes.push(['toggleDiscountCodeActive', id, a]); window._realToggle = real; }; });
    await page.addScriptTag({ path: path.join(root, 'promotions.js') });

    const settle = () => new Promise((r) => setTimeout(r, 120));
    const rowCount = () => page.$$eval('#pr-tbl tbody tr', (r) => r.length);
    const text = (sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim());

    // ── entry, summary, tabs ────────────────────────────────────────────────────────────────
    await page.evaluate(() => Promotions.enter()); await settle();
    ok(await page.$$eval('#pr-tabs .pr-tab', (b) => b.length) === 5, 'admin sees five tabs incl. the audit log');
    const sum = await page.$$eval('.pr-sum-item', (els) => els.map((e) => e.querySelector('.pr-sum-val').textContent.trim()));
    ok(sum[0] === '1' && sum[1] === '2' && sum[2] === '1', `summary: 1 running offer, 2 active codes, 1 active bundle (${sum.slice(0, 3)})`);
    ok(/300/.test(sum[3]), `month markdown = (400−300)×3 on non-cancelled sales = 300 (${sum[3]})`);
    ok(await rowCount() === 2, 'offers open on running + upcoming (2 rows), ended one hidden');
    ok((await text('#pr-tbl tbody tr:first-child')).includes('2 فاتورة'), 'usage: 2 invoices for the running offer (cancelled sale ignored)');

    // ── stop / start now / bulk ────────────────────────────────────────────────────────────
    await page.click('#pr-tbl [data-act="offer-stop"][data-id="o1"]'); await settle();
    let last = await page.evaluate(() => calls.filter((c) => c.method !== 'GET').pop());
    ok(last.url === '/products/p1/offers/o1/end' && last.method === 'POST', 'Stop → POST /products/p1/offers/o1/end after a confirm');
    ok(await page.evaluate(() => confirms.at(-1).title === 'إيقاف العرض'), 'stop confirm states what happens');
    ok(await rowCount() === 1, 'stopped offer leaves the running list after the reload');
    await page.click('#pr-tbl [data-act="offer-start"][data-id="o2"]'); await settle();
    last = await page.evaluate(() => calls.filter((c) => c.method !== 'GET').pop());
    ok(last.method === 'PATCH' && last.body.from === TODAY && last.url === '/products/p2/offers/o2', '«تفعيل الآن» → PATCH from = today');
    ok((await text('#pr-tbl tbody tr:first-child .pr-pill')) === 'ساري', 'the upcoming offer now reads «ساري»');
    ok(await page.$eval('#pr-tbl tbody tr:first-child .pr-offer-name', (e) => !!e.querySelector('.po-tag') && e.textContent.includes('بلاك فرايداي')), 'offer name drawn with the app\'s offer tag (.po-tag)');

    // ── new offer dialog ───────────────────────────────────────────────────────────────────
    await page.click('.pr-head-act .pr-btn-primary'); await settle();
    ok(await page.$('#pr-dlg .pr-pick'), 'new offer opens with a product picker');
    await page.type('#pr-of-q', 'cst'); await settle();
    ok(await page.$$eval('#pr-dlg .pr-pick-row', (r) => r.length) === 1, 'picker search by code narrows to one product');
    await page.click('#pr-dlg [data-act="of-pick"]'); await settle();
    await page.click('#pr-dlg [data-act="of-reason"][data-key="poR_clearance"]');
    await page.click('#pr-dlg [data-act="of-pct"][data-val="20"]');
    await page.click('#pr-dlg [data-act="of-dur"][data-val="7"]');
    ok((await page.$eval('#pr-of-price', (e) => e.value)) === '200' && (await page.$eval('#pr-of-to', (e) => e.value)) === add(6), '−20% chip → 200, «أسبوع» → 7 days inclusive');
    ok(await page.$eval('#pr-of-to', (e) => e.classList.contains('sdp-input') && e.parentElement.classList.contains('dmy-date') && e.parentElement.dataset.dmy === e.value.split('-').reverse().join('/')),
      'dates use the system calendar (.sdp-input) and show DD/MM/YYYY, kept in step after a duration chip');
    ok((await text('#pr-of-preview')).includes('7 يوم'), 'preview states the price and the length');
    await page.$eval('#pr-of-price', (e) => { e.value = '260'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#pr-dlg [data-act="of-save"]'); await settle();
    ok((await text('#pr-of-err')).includes('أقل من'), 'a price above the base is refused inline, before any request');
    await page.$eval('#pr-of-price', (e) => { e.value = '199'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#pr-dlg [data-act="of-save"]'); await settle();
    last = await page.evaluate(() => calls.filter((c) => c.method !== 'GET').pop());
    ok(last.url === '/products/p3/offers' && last.body.price === 199 && last.body.reason === 'تصفية مخزون' && last.body.to === add(6), 'save → POST with price, name and dates');
    ok(!(await page.$('#pr-dlg')), 'dialog closes on success');

    // bulk stop
    await page.click('#pr-tbl [data-act="sel-all"]'); await settle();
    ok((await text('#pr-bulk')).includes('2'), 'select-all picks both live offers and shows the bulk bar');
    const before = await page.evaluate(() => calls.length);
    await page.click('#pr-bulk [data-act="bulk-stop"]'); await settle(); await settle();
    const ends = await page.evaluate((n) => calls.slice(n).filter((c) => c.url.endsWith('/end')).length, before);
    ok(ends === 2, 'bulk stop ends each selected offer');
    ok(await page.$eval('#pr-tbl', (e) => !!e.querySelector('.pr-empty')), 'nothing running afterwards → the empty state, not a blank table');

    // ── codes tab ──────────────────────────────────────────────────────────────────────────
    await page.click('#pr-tabs [data-tab="codes"]'); await settle();
    ok(await rowCount() === 4, 'codes tab lists all four codes');
    ok(await page.$$eval('#pr-tbl tbody tr', (rows) => rows.every((r) => r.querySelector('.disc-badge'))), 'every code is drawn with the app\'s discount badge (.disc-badge)');
    await page.focus('[data-filter="codes.q"]'); await page.keyboard.type('sa');
    ok(await rowCount() === 1 && (await page.evaluate(() => document.activeElement?.dataset.filter)) === 'codes.q', 'search filters and keeps focus while typing');
    await page.$eval('[data-filter="codes.q"]', (e) => { e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('[data-key="codes.status"][data-val="expired"]');
    ok(await rowCount() === 1 && (await text('#pr-tbl tbody')).includes('OLD'), 'status filter «منتهي» shows only the expired code');
    await page.click('[data-key="codes.status"][data-val=""]');
    ok((await text('#pr-tbl tbody tr:nth-child(2)')).includes('1 مرة'), "usage of O'NEIL counted from the invoices");
    await page.click('#pr-tbl [data-act="code-delete"][data-id="c2"]'); await settle();
    ok(await page.evaluate(() => JSON.stringify(writes.at(-1)) === JSON.stringify(['deleteDiscountCode', 'c2', "O'NEIL"])), 'a code with a quote reaches delete intact (no inline onclick)');
    await page.click('#pr-tbl [data-act="code-toggle"][data-id="c1"]'); await settle();
    ok(await page.evaluate(() => JSON.stringify(writes.at(-1)) === JSON.stringify(['toggleDiscountCodeActive', 'c1', false])), 'switch → toggleDiscountCodeActive(id, false)');

    // ── bundles, tags, audit ───────────────────────────────────────────────────────────────
    await page.click('#pr-tabs [data-tab="bundles"]'); await settle();
    ok((await text('#pr-tbl tbody')).includes('Bow dining') && (await text('#pr-tbl tbody')).includes('SAVE10'), 'bundle row names its products and code');
    await page.click('#pr-tabs [data-tab="tags"]'); await settle();
    ok(await page.$('#new-master-tag-name') && await page.$('#new-master-tag-category') && await page.$('#new-master-tag-bg'), 'tag add form keeps the ids addMasterTag reads');
    ok((await text('#pr-tbl tbody')).includes('2 معاملة'), 'VIP usage = 2 transactions');
    await page.$eval('[data-act="tag-color"][data-id="g1"]', (e) => { e.value = '#10b981'; e.dispatchEvent(new Event('change', { bubbles: true })); }); await settle();
    last = await page.evaluate(() => calls.filter((c) => c.method !== 'GET').pop());
    ok(last.url === '/tags/g1' && last.body.bg === '#10b981', 'colour picker → PATCH /tags/g1 {bg}');
    await page.click('#pr-tabs [data-tab="audit"]'); await settle();
    ok(await rowCount() === 2, 'audit tab loads the persisted log');
    await page.click('[data-key="audit.group"][data-val="usage"]');
    ok(await rowCount() === 1 && (await text('#pr-tbl tbody')).includes('Reem'), '«استخدام في البيع» shows only usage events');

    // ── layout: English, dark, phone ───────────────────────────────────────────────────────
    for (const [w, lang, dark] of [[1440, 'ar', false], [1280, 'en', true], [390, 'ar', false], [390, 'en', true]]) {
      await page.setViewport({ width: w, height: 900 });
      await page.evaluate((lang, dark) => { currentLang = lang; document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl'; document.body.classList.toggle('dark-mode', dark); Promotions.tab('offers'); qs('[data-key="offers.status"][data-val="all"]').click(); }, lang, dark);
      await settle();
      const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      await page.screenshot({ path: path.resolve(__dirname, `../../../artifacts/promotions-${w}-${lang}${dark ? '-dark' : ''}.png`), fullPage: true });
      ok(over <= 1, `no page overflow at ${w}px ${lang}${dark ? ' dark' : ''} (${over})`);
    }
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluate(() => { currentLang = 'ar'; document.documentElement.dir = 'rtl'; document.body.classList.remove('dark-mode'); });

    // ── permissions ────────────────────────────────────────────────────────────────────────
    await page.evaluate(() => { currentUser = { role: 'staff', perms: ['promotions-view'] }; Promotions.render(); }); await settle();
    ok(await page.$$eval('#pr-tabs .pr-tab', (b) => b.length) === 4, 'view-only staff: no audit tab');
    ok(await page.$eval('.pr-head-act .pr-btn-primary', (b) => b.disabled), 'view-only staff: the primary action is disabled, not hidden');
    await page.evaluate(() => Promotions.tab('codes')); await settle();
    ok(await page.$$eval('#pr-tbl [data-act="code-toggle"]', (b) => b.every((x) => x.disabled)), 'view-only staff: every switch is disabled');
    await page.evaluate(() => { currentUser = { role: 'staff', perms: ['promotions-codes'] }; Promotions.render(); }); await settle();
    ok(await page.$$eval('#pr-tbl [data-act="code-toggle"]', (b) => b.every((x) => !x.disabled)), 'promotions-codes alone opens the page and enables code actions');
    await page.evaluate(() => { currentUser = { role: 'staff', perms: ['promotions-view'] }; });
    ok(await page.evaluate(async () => { const n = writes.length; await window._realToggle?.('c1', false); return writes.length === n && toasts.at(-1).startsWith('ERR:'); }), 'the real toggleDiscountCodeActive refuses a user without promotions-codes');
    await page.evaluate(() => { currentUser = { role: 'staff', perms: ['products'] }; Promotions.render(); }); await settle();
    ok(await page.$eval('#promo-root', (e) => e.innerHTML === ''), 'no promotions perm: nothing renders');

    ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } catch (e) {
    failures++;
    console.error('✗', e.message);
  } finally {
    await browser.close();
  }
  if (failures) process.exit(1);
  console.log('promotions-page: all checks passed');
})();
