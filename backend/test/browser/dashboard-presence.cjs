/* Real dashboard toolbar markup, presence renderer and sales chart; isolated data. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const pub = path.resolve(__dirname, '../../../frontend/public');
const source = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const start = source.indexOf('<div class="page dashboard-v2" id="page-dashboard">');
const chartStart = source.indexOf('<section id="dash-sales-overview"', start);
const toolbar = source.slice(start, chartStart);
const chart = source.slice(chartStart).match(/^<section[\s\S]*?<\/section>/)[0];
const styles = [...source.slice(0, source.indexOf('</head>')).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
const css = ['design-system.css', 'compact-pages.css', 'employee-home.css', 'dashboard-clarity.css', 'sales-overview.css', 'shipping-command-center.css']
  .map(file => fs.readFileSync(path.join(pub, file), 'utf8')).join('\n');
const renderStart = source.indexOf('function renderUsersStatus()');
const renderer = source.slice(renderStart, source.indexOf('\nfunction _puSidebarOrderCount', renderStart));
const out = path.resolve(__dirname, '../../../artifacts/dashboard-presence');

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      if (request.resourceType() === 'image') return request.respond({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="#d4e5dc"/><circle cx="32" cy="25" r="11" fill="#527764"/><path d="M12 60a20 20 0 0140 0" fill="#527764"/></svg>' });
      return request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Dashboard presence</title>' });
    });
    await page.goto('http://presence.test/');
    await page.setContent(`<!doctype html><html lang="en" dir="ltr"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}\n${css}</style><style>body{display:block!important;overflow:auto!important;margin:0;padding:16px;background:var(--bg)}#main{display:block!important;margin:0!important;padding:0!important;width:100%}#page-dashboard{display:block!important;padding:12px!important}*{box-sizing:border-box}@media(max-width:650px){body{padding:0}}</style></head><body><main id="main">${toolbar}${chart}<div class="scc-zone"><section class="scc-heading"><h3>Shipping command center</h3></section></div></div></main></body></html>`);
    await page.evaluate(() => {
      const OriginalDate = Date;
      window.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : ['2026-11-11T10:00:00Z'])); }
        static now() { return new OriginalDate('2026-11-11T10:00:00Z').getTime(); }
      };
      window.currentLang = 'en'; window.isAdmin = () => true; window._apiWriteRevision = 0;
      document.getElementById('page-dashboard').classList.add('active', 'sales-home');
      window.qs = value => document.querySelector(value);
      window.esc = window.escHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      window.sanitizeUrl = value => value.startsWith('/') ? value : '';
      window.placeholderAvatarUrl = () => '/avatar.svg';
      window.users = Array.from({ length: 6 }, (_, i) => ({ _id: 'u' + i, name: 'Team member ' + (i + 1), avatar: '/avatar.svg' }));
      users.push({ _id: 'disabled', name: 'Disabled user', isActive: false });
      window.currentUser = users[0];
      window.onlineUsers = { u0: { status: 'online' }, u1: { status: 'online' }, u2: { status: 'offline', lastSeen: '2026-11-09T10:00:00Z' } };
      window._presenceKnown = true;
      window.t = (key, args = {}) => {
        const entries = { dsUsersOnlineCount: ['{n} of {total} online', '{n} من {total} متصلون'], dsPresenceUnknown: ['Checking connection', 'جارٍ التحقق من الاتصال'], dsPresenceUnknownShort: ['Checking', 'جارٍ التحقق'], dsUserOnlineNow: ['Online now', 'أونلاين الآن'], dsUserOffline: ['Offline', 'غير متصل'], dsUserYou: ['you', 'أنت'], dsLastSeenTwoDays: ['2 days ago', 'منذ يومين'] };
        return (entries[key]?.[currentLang === 'en' ? 0 : 1] || key).replace(/\{(\w+)\}/g, (_, name) => args[name] ?? '');
      };
      document.getElementById('dash-refresh-slot').innerHTML = '<button type="button" class="btn btn-outline btn-sm">Last update · 3m ago</button>';
      window.api = async url => {
        const p = new URLSearchParams(url.split('?')[1]), month = p.get('year') + '-' + p.get('month').padStart(2, '0');
        const days = Array.from({ length: 11 }, (_, i) => ({ date: month + '-' + String(i + 1).padStart(2, '0'), orders: 8 + i % 5, receivedValue: 1000, confirmedValue: 800, confirmedOrders: 6 }));
        return { month, days, totalOrders: days.reduce((sum, day) => sum + day.orders, 0), totalRevenue: 8800, confirmedOrders: 66, averageOrderValue: 800 };
      };
    });
    await page.addScriptTag({ content: renderer });
    await page.addScriptTag({ path: path.join(pub, 'daily-orders-analysis.js') });
    await page.addScriptTag({ path: path.join(pub, 'sales-overview.js') });
    await page.evaluate(async () => { renderUsersStatus(); await salesOverview.load(); });
    assert.equal(await page.$$eval('#users-status-grid .ds-pu', nodes => nodes.length), 6, 'inactive users are excluded');
    assert.equal(await page.$eval('#dash-users-count', node => node.textContent), '2 of 6 online');
    assert.match(await page.$eval('.ds-pu.is-me', node => node.getAttribute('aria-label')), /Team member 1.*Online now/);
    await page.focus('.ds-pu');
    assert.equal(await page.$eval('.ds-pu', node => node === document.activeElement), true, 'presence remains keyboard accessible');
    const measurements = [];
    for (const lang of ['en', 'ar']) for (const dark of [false, true]) for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewport({ width, height: 1000 });
      await page.evaluate(({ lang, dark }) => {
        currentLang = lang; document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.body.classList.toggle('dark-mode', dark); renderUsersStatus(); salesOverview.render();
      }, { lang, dark });
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
      const m = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        return { presence: rect('#dash-users-presence'), header: rect('#page-dashboard > .page-header'), actions: rect('.page-header-actions'),
          chart: rect('#dash-sales-overview'), shipping: rect('.scc-zone'), avatar: rect('.ds-pu-av'),
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          inHeader: !!document.querySelector('#page-dashboard > .page-header > #dash-users-presence'),
          statusHidden: getComputedStyle(document.querySelector('.ds-pu-status')).display === 'none' };
      });
      assert(m.inHeader, 'presence is physically in the toolbar');
      assert.equal(m.overflow, false, `${lang}/${width}: page does not overflow`);
      assert(m.presence.left - m.header.left < 2, `${lang}/${width}: presence stays on the left`);
      assert(m.avatar.width <= 28, 'avatars are compact');
      assert(m.statusHidden, 'full status text does not create another row');
      assert(m.shipping.top - m.chart.bottom >= 10 && m.shipping.top - m.chart.bottom <= 20, 'the old presence row leaves no empty space below the chart');
      if (width > 650) assert(m.presence.right <= m.actions.left && m.header.height <= 56, `toolbar fits at ${lang}/${width}: ${JSON.stringify(m)}`);
      measurements.push({ lang, dark, width, ...m });
      if ([1440, 390].includes(width)) await page.screenshot({ path: path.join(out, `presence-${lang}-${dark ? 'dark' : 'light'}-${width}.png`), fullPage: true });
    }
    await page.evaluate(() => { _presenceKnown = false; renderUsersStatus(); });
    assert.equal(await page.$eval('#dash-users-count', node => node.textContent), 'جارٍ التحقق من الاتصال', 'unknown presence does not claim an online count');
    await page.evaluate(() => { _presenceKnown = true; onlineUsers.u1.status = 'offline'; renderUsersStatus(); });
    assert.equal(await page.$eval('#dash-users-count', node => node.textContent), '1 من 6 متصلون', 'live updates keep working');
    await page.evaluate(() => { users.push(...Array.from({ length: 24 }, (_, i) => ({ _id: 'extra' + i, name: 'Extra ' + i }))); renderUsersStatus(); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'large teams stay inside the mobile header');
    assert.equal(await page.$eval('#users-status-grid', node => node.scrollWidth > node.clientWidth), true, 'large teams scroll within the avatar strip');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'measurements.json'), JSON.stringify(measurements, null, 2));
    console.log(`PASS compact dashboard presence: ${measurements.length} language/theme/width combinations, live updates, unknown state, inactive users, keyboard and large teams.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
