const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('../backend/node_modules/puppeteer');
const html = fs.readFileSync(path.resolve(__dirname, '../frontend/public/index.html'), 'utf8');
const section = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));
const css = section('.dashboard-v2{', '.dashboard-v2 .page-header') + section('.dashboard-v2 .ds-presence{', '/* Section headings */');
const source = section('function applyUsersPresence(', 'function _puSidebarOrderCount(');
const helpers = section('function sanitizeUrl(', 'function debounce(');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#237e65"/><circle cx="32" cy="24" r="11" fill="#f5d6b4"/><path d="M10 64v-9a22 22 0 0144 0v9" fill="#e2e8f0"/></svg>';

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (req.url().startsWith('data:')) return req.continue();
      if (req.url().includes('/uploads/alice.svg') || req.url().includes('/uploads/fatima.svg')) return req.respond({ status: 200, contentType: 'image/svg+xml', body: svg });
      return req.abort();
    });
    for (const width of [390, 1280]) {
      await page.setViewport({ width, height: 400 });
      await page.setContent('<base href="https://soulia.test/"><style>*{box-sizing:border-box}body{margin:0;padding:24px;font-family:Arial;background:#f7f8fa}:root{--bg:white;--border:#e6e8eb;--accent:#237e65}' + css + '</style><main class="dashboard-v2" dir="rtl"><div class="ds-presence"><div id="users-status-grid" class="ds-presence-strip"></div><span id="dash-users-count" class="ds-presence-count"></span></div></main>');
      await page.addScriptTag({ content: 'window.presenceTranslations={' + section('  dsUsersOnlineCount:', '  /* Dashboard — my assigned orders') + '};' });
      await page.evaluate(() => {
        Object.assign(window, {
          onlineUsers: {}, _presenceKnown: false, _presenceVersion: 0, currentPage: 'dashboard', currentLang: 'ar',
          currentUser: { _id: 'alice', name: 'أحمد', avatar: '/uploads/alice.svg' },
          users: [
            { _id: 'alice', name: 'أحمد', avatar: '/uploads/alice.svg' },
            { _id: 'fatima', name: 'فاطمة', avatar: '/uploads/fatima.svg' },
            { _id: 'broken', name: 'مريم', avatar: 'https://soulia.test/missing.jpg' },
            { _id: 'empty', name: 'عمر', avatar: '' },
            { _id: 'unsafe', name: 'حسن', avatar: 'javascript:alert(1)' },
            { _id: 'disabled', name: 'Disabled', isActive: false },
          ],
          qs: s => document.querySelector(s), renderUsers: () => {},
          esc: s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
          t: (key, args = {}) => (window.presenceTranslations[key]?.[window.currentLang] || key).replace(/\{(\w+)\}/g, (_, name) => args[name]),
          api: async () => ({ users: [] }),
        });
        window.escHtml = window.esc;
      });
      await page.addScriptTag({ content: helpers + source });
      await page.evaluate(() => {
        applyUsersPresence([{ id: 'alice', isOnline: true }, { id: 'fatima', isOnline: false, lastSeen: new Date(Date.now()-60000).toISOString() }, { id: 'broken', isOnline: false, lastSeen: new Date(Date.now()-3600000).toISOString() }, { id: 'empty', isOnline: false, lastSeen: new Date(Date.now()-7200000).toISOString() }, { id: 'unsafe', isOnline: false, lastSeen: new Date(Date.now()-120000).toISOString() }]);
        renderUsersStatus();
      });
      await page.waitForFunction(() => [...document.querySelectorAll('.ds-pu-av img')].every(img => img.complete));
      const result = await page.evaluate(() => ({
        count: qs('#dash-users-count').textContent,
        people: document.querySelectorAll('.ds-pu').length,
        online: document.querySelectorAll('.ds-pu.is-online').length,
        photos: document.querySelectorAll('.ds-pu-av img').length,
        empty: [...document.querySelectorAll('.ds-pu-av')].some(el => !el.textContent.trim() && !el.querySelector('img')),
        avatarWidth: qs('.ds-pu-av').getBoundingClientRect().width,
        offlineOpacity: getComputedStyle(document.querySelectorAll('.ds-pu-av')[1]).opacity,
        overflow: document.documentElement.scrollWidth > innerWidth,
        me: qs('.ds-pu.is-me')?.getAttribute('aria-label'),
        sources: [...document.querySelectorAll('.ds-pu-av img')].map(img => img.getAttribute('src')),
      }));
      assert.equal(result.count, '1 من 5 متصلون');
      assert.equal(result.people, 5); assert.equal(result.online, 1);
      assert.equal(result.photos, 2); assert.equal(result.empty, false);
      assert.equal(result.avatarWidth, 48); assert.equal(result.offlineOpacity, '1');
      assert.equal(result.overflow, false); assert(result.me.includes('أنت'));
      assert(result.sources.includes('/uploads/alice.svg'));
      assert.deepEqual(await page.$$eval('.ds-pu-status', els => els.map(el => el.textContent)), ['أونلاين الآن', 'منذ دقيقة', 'منذ ساعة', 'منذ ساعتين', 'منذ دقيقتين']);
      assert.equal(await page.$$eval('.ds-pu-name', els => els.length), 0);
      await page.screenshot({ path: path.join(__dirname, 'dashboard-presence-' + width + '.png') });
      await page.evaluate(async () => {
        let resolve; api = () => new Promise(done => resolve = done);
        const pending = syncUsersStatus();
        applyUsersPresence([{ id: 'fatima', isOnline: true }]);
        resolve({ users: [{ id: 'alice', isOnline: true }] }); await pending; renderUsersStatus();
      });
      assert((await page.$eval('.ds-pu.is-online', el => el.getAttribute('aria-label'))).includes('فاطمة'));
      await page.evaluate(async () => {
        let resolve; api = () => new Promise(done => resolve = done);
        const pending = syncUsersStatus(); invalidateUsersPresence();
        resolve({ users: [{ id: 'alice', isOnline: true }] }); await pending;
      });
      assert.equal(await page.$$eval('.ds-pu.is-online', els => els.length), 0);
      assert.equal(await page.$eval('#dash-users-count', el => el.textContent), 'تعذر تأكيد حالة الاتصال');
      assert.equal(await page.$eval('.ds-pu-status', el => el.textContent), 'غير معروف');
      for (const [minutes, expected] of [[0, 'منذ لحظات'], [5, 'منذ 5 دقائق'], [11, 'منذ 11 دقيقة'], [180, 'منذ 3 ساعات'], [1440, 'منذ يوم'], [2880, 'منذ يومين'], [4320, 'منذ 3 أيام']]) {
        await page.evaluate(minutes => {
          applyUsersPresence([{id:'alice',isOnline:false,lastSeen:new Date(Date.now()-minutes*60000).toISOString()}]);
          renderUsersStatus();
        }, minutes);
        assert.equal(await page.$eval('.ds-pu.is-me .ds-pu-status', el => el.textContent), expected);
      }
      await page.evaluate(() => { currentLang='en'; applyUsersPresence([{id:'alice',isOnline:true}]); renderUsersStatus(); });
      assert.equal(await page.$eval('.ds-pu.is-me .ds-pu-status', el => el.textContent), 'Online now');
      console.log('PASS ' + width + 'px: photos, initials fallback, active accounts, 48px avatars, presence counts, disconnect and HTTP/socket races.');
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
