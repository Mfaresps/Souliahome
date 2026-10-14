/* Shopify period KPIs + report image, over the SHIPPED index.html + shopify-kpis.js in Chromium.
 * Every request is intercepted; nothing reaches a live service.
 * Run: node backend/test/browser/shopify-kpis.cjs [--shots <dir>]
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

/* Orders are placed relative to the browser's local midnight, inside the page. */
const SPEC = [
  // today: 3 confirmed (all with a deposit) · 4 follow-up · 2 cancelled → 33%
  { day: 0, ref: '2701', dep: 'معتمد' }, { day: 0, ref: '2702', dep: 'معتمد' }, { day: 0, ref: '2703', dep: 'معلق' },
  { day: 0, ref: '2704', fu: 'في انتظار العميل' }, { day: 0, ref: '2705', fu: 'العميل لم يرد' },
  { day: 0, ref: '2706', fu: 'في انتظار المتابعة' }, { day: 0, ref: '2707', fu: 'العميل مازال متردد' },
  { day: 0, ref: '2708', cancelled: true }, { day: 0, ref: '2709', cancelled: true, fu: 'في انتظار العميل' },
  // yesterday: 3 confirmed (1 deposit + 2 without) · settled follow-up → open · 1 open → 60%, 2 open
  { day: -1, ref: '2690', dep: 'معتمد' }, { day: -1, ref: '2691', swd: true }, { day: -1, ref: '2692', status: 'approved' },
  { day: -1, ref: '2693', fu: 'تمت عملية التأكيد' }, { day: -1, ref: '2694' },
  // 3 days ago: rejected counts as cancelled; 8 days ago is outside every window
  { day: -3, ref: '2680', status: 'rejected' }, { day: -8, ref: '2600', dep: 'معتمد' },
];

(async () => {
  const browser = await puppeteer.launch({ headless: true });
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
      const local = { '/shopify-kpis.js': 'text/javascript', '/shopify-kpis.css': 'text/css', '/shopify-edit-approvals.js': 'text/javascript', '/soulia-logo.svg': 'image/svg+xml' }[url.pathname];
      if (local) return req.respond({ status: 200, contentType: local, body: fs.readFileSync(path.join(PUB, url.pathname.slice(1))) });
      /* The real local stylesheets (navigation-shell.css hides the sidebar on phones). */
      if (url.origin === 'http://soulia.test' && url.pathname.endsWith('.css') && fs.existsSync(path.join(PUB, url.pathname.slice(1))))
        return req.respond({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(PUB, url.pathname.slice(1))) });
      if (url.pathname.startsWith('/api/')) return reply([]);
      if (req.resourceType() === 'script') return req.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      if (req.resourceType() === 'stylesheet' && url.origin !== 'http://soulia.test') return req.respond({ status: 200, contentType: 'text/css', body: '' });
      return req.respond({ status: 200, contentType: 'text/plain', body: '' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    const setup = () => page.evaluate(spec => {
      localStorage.setItem('token', 't');
      currentUser = { _id: 'a1', name: 'Admin', username: 'admin', role: 'admin', perms: [] };
      currentLang = 'en'; document.documentElement.dir = 'ltr';
      const n = new Date(), sod = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
      const elapsed = Math.max(60000, n.getTime() - sod);
      followUps = [];
      _shopifyOrders = spec.map((s, i) => {
        /* Spread inside the part of the day that has already happened, so the
           «same time yesterday» window holds yesterday's orders too. */
        const at = new Date(n.getFullYear(), n.getMonth(), n.getDate() + s.day).getTime() + Math.floor(elapsed * (i % 9 + 1) / 11);
        if (s.fu) followUps.push({ _id: 'f' + i, orderRef: s.ref, status: s.fu, reason: 'عملية تأكيد الطلب', createdAt: new Date(at).toISOString() });
        return { _id: 'o' + i, ref: s.ref, client: 'C' + i, status: s.status || 'pending', cancelled: !!s.cancelled, total: 500,
          shipWithoutDeposit: !!s.swd, shopifyCreatedAt: new Date(at).toISOString(),
          depositReceipts: s.dep ? [{ id: 'r' + i, status: s.dep, amount: 200, method: 'Instapay' }] : [], items: [] };
      });
      transactions = []; inventoryCache = [];
      qs('#login-page').style.display = 'none'; qs('#app').style.display = ''; qs('#splash-screen')?.remove();
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      qs('#page-shopify-orders').classList.add('active');
      currentPage = 'shopify-orders';
      renderShopifyOrders();
    }, SPEC);
    await setup();

    const vals = () => page.$$eval('#sp-kpi .spk-tile', ts => Object.fromEntries(ts.map(t => [t.className.match(/is-(\w+)/)[1], t.querySelector('.spk-val').textContent.trim()])));
    const v0 = await vals();
    check(Object.keys(v0).length === 5 && !('nodep' in v0), 'five tiles render — no separate «without deposit» tile');
    check(v0.received === '9' && v0.confirmed === '3' && v0.followup === '4' && v0.cancelled === '2', 'today: 9 received · 3 / 4 / 2');
    check(v0.rate === '33%', 'today: confirmation rate 33%');
    check(await page.$eval('#sp-kpi', e => !e.querySelector('.spk-open')), 'no «no action» note when every order is bucketed');
    check(await page.$eval('#sp-kpi .is-received .spk-sub', e => /same time yesterday/.test(e.textContent)), 'received states its comparison window');
    check(await page.$eval('#sp-kpi .spk-tile.is-rate .spk-meter i', e => e.style.width === '33%'), 'rate meter at 33%');

    /* The period picker is ONE calendar icon beside «Report», opening a menu. */
    check(await page.$$eval('#sp-kpi .spk-seg, #sp-kpi .spk-seg-btn', e => e.length === 0), 'no five-tab period strip any more');
    check(await page.$eval('#spk-period-btn', b => b.closest('.spk-actions') && b.closest('.spk-actions').querySelector('.spk-report-btn') && !b.textContent.trim()), 'period control is an icon button beside Report');
    check(await page.$eval('#spk-period-btn', b => { const r = b.getBoundingClientRect(); return r.width <= 36 && r.height <= 36; }), 'icon button is small (≤36px)');
    check(await page.$eval('#sp-kpi .spk-range b', e => e.textContent === 'Today'), 'the applied period is named beside the date');
    check(await page.$eval('#spk-period-btn', b => b.getAttribute('aria-label') === 'Period: Today' && b.getAttribute('aria-expanded') === 'false'), 'icon button states the period in its label');
    await page.click('#spk-period-btn');
    check(await page.$$eval('#spk-period-menu .spk-pm-item', i => i.length === 5), 'click opens a menu of five periods');
    check(await page.$eval('#spk-period-btn', b => b.getAttribute('aria-expanded') === 'true'), 'button reports expanded');
    check(await page.evaluate(() => document.activeElement.classList.contains('is-on')), 'focus lands on the current period');
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement.textContent.trim() === 'Yesterday'), 'ArrowDown walks the menu');
    await page.keyboard.press('Escape');
    check(await page.evaluate(() => !document.getElementById('spk-period-menu') && document.activeElement.id === 'spk-period-btn'), 'Escape closes and returns focus');
    await page.click('#spk-period-btn');
    await page.mouse.click(5, 5);
    check(await page.evaluate(() => !document.getElementById('spk-period-menu')), 'outside click closes the menu');
    await page.click('#spk-period-btn');
    await page.evaluate(() => [...document.querySelectorAll('#spk-period-menu .spk-pm-item')].find(i => i.textContent.trim() === 'Yesterday').click());
    check(await page.evaluate(() => !document.getElementById('spk-period-menu') && _spkPeriod === 'yesterday'), 'choosing a period applies it and closes the menu');
    await page.evaluate(() => _spkSetPeriod('yesterday'));
    const v1 = await vals();
    check(v1.received === '5' && v1.confirmed === '3' && v1.followup === '0' && v1.cancelled === '0', 'yesterday: shipping without a deposit counts as confirmed; settled follow-up is not counted');
    check(await page.$eval('.spk-tile.is-confirmed .spk-sub', e => /1\s*With deposit · 2\s*Without deposit/.test(e.textContent)), 'confirmed tile states the split 1 + 2');
    check(v1.rate === '60%', 'yesterday: rate = confirmed ÷ received (3/5)');
    check(await page.$eval('#sp-kpi .spk-open', e => e.textContent.trim().startsWith('2')), 'yesterday: 2 orders with no action are stated');
    check(await page.$eval('#sp-kpi .spk-range b', e => e.textContent.trim() === 'Yesterday'), 'the chosen period is named in the row');
    check(await page.$eval('#spk-period-btn', b => b.classList.contains('is-set')), 'icon is tinted while a period other than today applies');

    await page.evaluate(() => _spkSetPeriod('week'));
    const v7 = await vals();
    check(v7.received === '15' && v7.cancelled === '3', 'last 7 days: 15 received, rejected counts as cancelled, 8-days-ago excluded');

    await page.evaluate(() => _spkSetPeriod('three'));
    check((await vals()).received === '14', 'last 3 calendar days: today and yesterday included, 3-days-ago excluded');
    check(await page.$eval('#spk-period-btn', b => b.getAttribute('aria-label') === 'Period: Last 3 days'), '3-day preset is selected');
    check(await page.evaluate(() => _spkReportText(_spkStats('three')).startsWith('📦 Orders Report — Last 3 Days')), '3-day report uses its own title');
    await page.evaluate(() => { _spkToggleMenu(); _spkSetPeriod('custom'); });
    check(await page.evaluate(() => !!document.querySelector('#spk-period-menu #spk-from') && document.activeElement.id === 'spk-from'), 'custom range opens its dates inside the menu, focused');
    await page.evaluate(() => {
      const n = new Date(), day = offset => _spkYmd(new Date(n.getFullYear(), n.getMonth(), n.getDate() + offset));
      document.getElementById('spk-from').value = day(-8);
      document.getElementById('spk-to').value = day(-3);
      _spkApplyDates({ preventDefault() {} });
    });
    check((await vals()).received === '2' && (await vals()).cancelled === '1', 'custom range includes the whole last day and orders older than 7 days');
    check(await page.evaluate(() => !document.getElementById('spk-period-menu')), 'applying the dates closes the menu');
    await page.evaluate(() => _spkToggleMenu());
    check(await page.$eval('#spk-from-named', e => /[A-Za-z]+/.test(e.textContent)), 'date controls spell out English month names');
    check(await page.evaluate(() => !_spkReportText(_spkStats('custom')).includes('Last 7 Days')), 'custom report has no incorrect 7-day title');
    await page.evaluate(() => {
      document.getElementById('spk-from').value = _spkYmd(new Date());
      _spkApplyDates({ preventDefault() {} });
    });
    check(await page.$eval('#spk-date-error', e => !!e.textContent), 'reversed date range shows a validation error');
    check((await vals()).received === '2', 'invalid date range does not change the applied figures');
    await page.evaluate(() => {
      _spkDateDraft('from', document.getElementById('spk-to').value);
      _spkRender();
    });
    check(await page.evaluate(() => document.getElementById('spk-from').value === _spkDraftFrom), 'draft dates survive live re-renders');

    /* The strip does not follow the table's search. */
    await page.evaluate(() => { _spkSetPeriod('today'); qs('#shopify-search').value = '2701'; renderShopifyOrders(); });
    check((await vals()).received === '9', 'table search does not change the strip');
    await page.evaluate(() => { qs('#shopify-search').value = ''; renderShopifyOrders(); });

    /* Report */
    let copied = '';
    await page.exposeFunction('__copied', t => { copied = t; });
    await page.evaluate(() => { _copyTextWithFallback = async t => { await window.__copied(t); return true; }; });
    await page.click('.spk-report-btn');
    await page.waitForSelector('#spk-rep-prev img', { timeout: 8000 });
    const img = await page.$eval('#spk-rep-prev img', i => new Promise(r => i.complete ? r([i.naturalWidth, i.naturalHeight]) : i.onload = () => r([i.naturalWidth, i.naturalHeight])));
    check(img[0] === 1080 && img[1] > 1200, `report image drawn ${img[0]}×${img[1]}`);
    check(await page.$eval('#spk-rep-dl', b => !b.disabled), 'download enabled once drawn');
    await page.evaluate(() => _spkCopyText());
    const expected = ['📦 Daily Orders Report', /^📅 Date: \d+\/\d+\/\d{4}$/, '', '📥 Received orders: 9', '',
      '✅ Confirmed: 3', '   💰 With deposit: 3', '   ⏳ Without deposit: 0', '🔄 Follow-up: 4', '❌ Cancelled: 2', '', '📊 Confirmation rate: 33%'];
    const lines = copied.split('\n');
    check(lines.length === expected.length && expected.every((e, i) => e instanceof RegExp ? e.test(lines[i]) : e === lines[i]), 'copied text matches the report format');
    const dl = await page.evaluate(() => new Promise(res => {
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () { HTMLAnchorElement.prototype.click = orig; res(this.download); };
      _spkDownload();
    }));
    check(/^soulia-orders-\d{4}-\d{2}-\d{2}\.png$/.test(dl), 'download named ' + dl);
    if (shotsDir) {
      const b64 = await page.evaluate(() => _spkRepCanvas.toDataURL('image/png').split(',')[1]);
      fs.writeFileSync(path.join(shotsDir, 'report-en.png'), Buffer.from(b64, 'base64'));
    }
    await page.evaluate(() => closeModal());

    const noOverflow = () => page.evaluate(() => {
      const host = qs('#sp-kpi'), r = host.getBoundingClientRect();
      const spill = [...host.querySelectorAll('*')].some(e => { const b = e.getBoundingClientRect(); return b.width && (b.right > r.right + 1 || b.left < r.left - 1); });
      return !spill && document.documentElement.scrollWidth <= innerWidth + 1;
    });
    check(await noOverflow(), 'desktop en: nothing spills');
    if (shotsDir) await (await page.$('#sp-kpi')).screenshot({ path: path.join(shotsDir, 'strip-en.png') });

    /* Arabic, dark */
    await page.evaluate(() => { currentLang = 'ar'; document.documentElement.dir = 'rtl'; document.body.classList.add('dark-mode'); renderShopifyOrders(); });
    check(await page.$eval('.spk-tile.is-received .spk-lbl', e => e.textContent === 'الأوردرات الواردة'), 'Arabic labels');
    check(await noOverflow(), 'desktop ar dark: nothing spills');
    if (shotsDir) await (await page.$('#sp-kpi')).screenshot({ path: path.join(shotsDir, 'strip-ar-dark.png') });
    await page.click('.spk-report-btn');
    await page.waitForSelector('#spk-rep-prev img', { timeout: 8000 });
    check(true, 'Arabic report image drawn');
    if (shotsDir) {
      const b64 = await page.evaluate(() => _spkRepCanvas.toDataURL('image/png').split(',')[1]);
      fs.writeFileSync(path.join(shotsDir, 'report-ar.png'), Buffer.from(b64, 'base64'));
    }
    await page.evaluate(() => closeModal());

    /* Phone */
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => { document.body.classList.remove('dark-mode'); renderShopifyOrders(); });
    await new Promise(r => setTimeout(r, 400));   // the shell's sidebar-margin transition
    const cols = await page.$eval('.spk-grid', g => getComputedStyle(g).gridTemplateColumns.split(' ').length);
    check(cols === 3, '390px: tiles in 3 columns');
    check(await page.$eval('#sp-kpi', e => e.getBoundingClientRect().width > 330), '390px: strip uses the phone width');
    check(await page.$$eval('#sp-kpi .spk-lbl', ls => ls.every(l => l.scrollWidth <= l.clientWidth + 1 && l.scrollHeight <= l.clientHeight + 1)), '390px: no tile label is clipped');
    check(await noOverflow(), '390px: nothing spills, no page overflow');
    await page.evaluate(() => { _spkToggleMenu(); _spkSetPeriod('custom'); });
    check(await page.$eval('#spk-period-menu', m => { const r = m.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; }), '390px: the period menu stays inside the screen');
    check(await page.$eval('#spk-to-named', e => /[\u0600-\u06ff]/.test(e.textContent)), 'custom controls spell out Arabic month names');
    check(await noOverflow(), '390px Arabic: date controls and five presets do not spill');
    await page.setViewport({ width: 320, height: 800 });
    await new Promise(r => setTimeout(r, 400));
    check(await noOverflow(), '320px Arabic: custom dates do not spill');
    await page.evaluate(() => { currentLang = 'en'; document.documentElement.dir = 'ltr'; _spkRender(); });
    check(await noOverflow(), '320px English: custom dates do not spill');
    await page.evaluate(() => _spkSetPeriod('today'));
    if (shotsDir) await (await page.$('#sp-kpi')).screenshot({ path: path.join(shotsDir, 'strip-ar-390.png') });

    /* Loading / error states */
    await page.evaluate(() => { _shopifyOrders = []; _spkRender('loading'); });
    check(await page.$$eval('.spk-tile.is-skel', t => t.length === 6), 'loading: skeleton tiles');
    await page.evaluate(() => _spkRender('error'));
    check(await page.$eval('#sp-kpi', e => !!e.querySelector('.spk-warn') && !e.querySelector('.spk-tile')), 'error: says it failed, shows no zeros');

    /* Hide / show — and the choice survives a reload. */
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluate(() => { localStorage.clear(); _spkState = 'ready'; });
    await setup();
    check(await page.$eval('#sp-kpi', e => !e.hidden && !!e.querySelector('.spk-tile')), 'strip shown by default');
    check(await page.$eval('#sp-kpi-toggle', b => b.getAttribute('aria-pressed') === 'true' && b.title === 'Hide summary'), 'toggle says «Hide summary»');
    await page.$eval('#sp-kpi-toggle', b => b.click());
    check(await page.$eval('#sp-kpi', e => e.hidden && !e.children.length && e.getBoundingClientRect().height === 0), 'click hides the strip');
    check(await page.$eval('#sp-kpi-toggle', b => b.getAttribute('aria-pressed') === 'false' && b.title === 'Show summary'), 'toggle now says «Show summary»');
    await page.evaluate(() => renderShopifyOrders());
    check(await page.$eval('#sp-kpi', e => e.hidden), 'a re-render (live update) keeps it hidden');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await setup();
    check(await page.$eval('#sp-kpi', e => e.hidden && !e.children.length), 'still hidden after a page reload');
    await page.evaluate(() => { currentUser = { _id: 'other', name: 'B', role: 'staff', perms: [] }; renderShopifyOrders(); });
    check(await page.$eval('#sp-kpi', e => !e.hidden), 'another user on the same browser still sees it');
    await page.evaluate(() => { currentUser = { _id: 'a1', name: 'Admin', role: 'admin', perms: [] }; renderShopifyOrders(); });
    await page.$eval('#sp-kpi-toggle', b => b.click());
    check(await page.$eval('#sp-kpi', e => !e.hidden && !!e.querySelector('.spk-tile')), 'click shows it again');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await setup();
    check(await page.$eval('#sp-kpi', e => !e.hidden), 'shown state also survives a reload');

    const own = errors.filter(e => /spk|shopify-kpis/.test(e));
    check(!own.length, 'no page errors from the KPI code' + (own.length ? ': ' + own.join(' | ') : ''));
    console.log(`\n${checks} checks passed`);
  } finally { await browser.close(); }
})().catch(e => { console.error('FAIL:', e.message); if (errors.length) console.error('page errors:', errors); process.exit(1); });
