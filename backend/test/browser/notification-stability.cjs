const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const outputDir = path.resolve(__dirname, '../../../artifacts/notification-stability');

(async () => {
  const browser = await puppeteer.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const user = { _id: '507f1f77bcf86cd799439011', name: 'Preview', role: 'admin', perms: [] };
    const rows = Array.from({ length: 20 }, (_, i) => ({
      _id: i.toString(16).padStart(64, '0'), type: 'deposit', title: 'New Deposit',
      body: 'Malak Abbas added EGP 1,250.50 · Vodafone Cash · #2950 · Review Required',
      ref: '2950', recordId: 'shopify:order1', event: 'receipt' + i, eventId: 'deposit:receipt:receipt' + i,
      actorName: 'Malak Abbas', actorAvatar: '/stable-avatar.svg',
      createdAt: new Date(Date.now() - i * 60000).toISOString(), readAt: null,
    }));
    await page.evaluateOnNewDocument(user => {
      localStorage.clear(); localStorage.setItem('token', 'preview-only');
      localStorage.setItem('user', JSON.stringify(user)); localStorage.setItem('soulia_lang_pref', 'en');
    }, user);
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== 'http://localhost:8080') return request.respond({ status: 200, body: '' });
      if (url.pathname.startsWith('/socket.io/')) return request.abort();
      if (url.pathname === '/stable-avatar.svg') return request.respond({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#25614b"/><circle cx="40" cy="28" r="15" fill="#ead4b5"/><path d="M12 80a28 32 0 0156 0" fill="#ead4b5"/></svg>' });
      if (url.pathname.startsWith('/api/')) {
        let data = [];
        if (url.pathname === '/api/auth/me') data = user;
        if (url.pathname === '/api/settings') data = { lang: 'en' };
        if (url.pathname === '/api/notifications/history') data = { items: rows, unread: rows.filter(row => !row.readAt).length, next: '' };
        if (url.pathname === '/api/notifications/read-state') data = { ids: [] };
        if (url.pathname === '/api/notifications/read-all') {
          const { before } = JSON.parse(request.postData());
          rows.forEach(row => { if (Date.parse(row.createdAt) <= Date.parse(before)) row.readAt = before; });
          data = { before, unread: 0 };
        }
        return request.respond({ contentType: 'application/json', body: JSON.stringify(data) });
      }
      if (url.pathname === '/config.js') return request.respond({ contentType: 'text/javascript', body: 'window.__ENV__={API_BASE_URL:""};' });
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : '.' + url.pathname);
      if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file)) return request.respond({ status: 404, body: '' });
      return request.respond({ contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream'), body: fs.readFileSync(file) });
    });
    for (const width of [390, 1440]) {
      await page.setViewport({ width, height: 900 });
      await page.goto('http://localhost:8080/#inventory', { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.querySelector('#splash-screen') && typeof souliaRenderNotificationContent === 'function');
      await page.evaluate(async () => { await souliaRefreshNotificationHistory(); openNotifCenter(); });
      await page.waitForFunction(() => document.querySelector('#nc-main .notification-avatar.has-photo img'));
      // Let opening read receipts complete before taking the layout snapshot.
      await page.waitForFunction(() => document.querySelector('#notif-badge').textContent === '');
      const result = await page.evaluate(async () => {
        const main = document.querySelector('#nc-main');
        const card = main.querySelector('[data-notification-id]');
        const image = card.querySelector('img');
        const panel = document.querySelector('#notif-list');
        const panelImage = panel.querySelector('img');
        main.scrollTop = 220;
        card.focus({ preventScroll: true });
        const measure = () => {
          const rect = document.querySelector('#nc-overlay .nc-modal').getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height, main.scrollTop, main.scrollHeight];
        };
        const before = measure();
        for (let i = 0; i < 5; i++) {
          await souliaRefreshNotificationHistory();
          buildNotifications(); _ncAllNotifs = _buildNcUpdates(); _renderNcContent();
        }
        const strong = card.querySelector('.notification-amount');
        return {
          sameCard: card === main.querySelector('[data-notification-id]'),
          sameImage: image === card.querySelector('img'), samePanelImage: panelImage === panel.querySelector('img'),
          loaded: image.complete && image.parentNode.classList.contains('has-photo'),
          sameFocus: document.activeElement === card, before, after: measure(),
          amount: strong?.textContent, weight: strong && getComputedStyle(strong).fontWeight,
        };
      });
      assert.equal(result.sameCard, true); assert.equal(result.sameImage, true); assert.equal(result.samePanelImage, true);
      assert.equal(result.loaded, true); assert.equal(result.sameFocus, true);
      assert.deepEqual(result.after, result.before); assert.equal(result.amount, '1,250.50'); assert(Number(result.weight) >= 700);
      // A decision updates the existing card; new receipts insert without replacing its photo.
      rows[0].title = 'Request Approved'; rows[0].body = 'Malak Abbas · Deposit approval · EGP 1,250.50 · Approved';
      await page.evaluate(() => { window.stablePhoto = document.querySelector('#nc-main img'); });
      await page.evaluate(async () => { await souliaRefreshNotificationHistory(); });
      assert.equal(await page.evaluate(() => stablePhoto === document.querySelector('#nc-main img')), true);
      assert.equal(await page.$eval('#nc-main .nc-item-title', node => node.textContent), 'Request Approved · #2950');
      await page.evaluate(() => {
        document.documentElement.dir = 'rtl'; currentLang = 'ar';
        _ncAllNotifs[0].desc = 'أضافت ملك عباس ١٬٢٥٠٫٥٠ ج.م. · فودافون كاش';
        _renderNcContent(); document.querySelector('#nc-main').scrollTop = 0;
      });
      assert.equal(await page.$eval('#nc-main .notification-amount', node => node.textContent), '١٬٢٥٠٫٥٠');
      assert.equal(await page.evaluate(() => document.querySelector('#nc-overlay').scrollWidth > innerWidth), false);
      fs.mkdirSync(outputDir, { recursive: true });
      await page.screenshot({ path: path.join(outputDir, `rtl-${width}.png`) });
    }
    assert.deepEqual(errors, []);
    console.log('PASS: stable cards/photos/focus/scroll/window on repeated refresh, updated content, bold English/Arabic amounts, mobile and desktop.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
