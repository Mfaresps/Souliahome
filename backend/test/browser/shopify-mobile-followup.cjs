const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
        return request.respond({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
      return request.respond({ status: 200, contentType: request.resourceType() === 'script' ? 'text/javascript' : 'application/json', body: request.resourceType() === 'script' ? '' : '[]' });
    });
    for (const width of [320, 390]) {
      await page.setViewport({ width, height: 850 });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
      await page.evaluate(() => {
        currentUser = { _id: 'staff-1', role: 'admin', perms: ['shopify-orders', 'complaints', 'shopify-deposit-upload', 'shopify-prepare-ship'] };
        qs('#login-page').style.display = 'none';
        qs('#app').style.display = '';
        qs('#splash-screen')?.remove();
        document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
        qs('#page-shopify-orders').classList.add('active');
        currentPage = 'shopify-orders';
        _spServerEnabled = false;
        _shopifyTab = 'all';
        _spFuFetchedAt = Date.now();
        closeSidebar();
        window.trailCalls = [];
        _spPeekOpenTrail = id => trailCalls.push(id);
      });
      for (const lang of ['en', 'ar']) {
        for (const payment of ['unpaid', 'paid', 'confirmed', 'without-deposit']) {
          await page.evaluate(({ lang, payment }) => {
            currentLang = lang;
            document.documentElement.lang = lang;
            document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
            const note = lang === 'ar' ? 'آخر متابعة: العميل طلب التسليم يوم الخميس' : 'Latest follow-up: customer requested delivery on Thursday';
            window.expectedNote = note;
            _shopifyOrders = [{ _id: 'order-3112', shopifyOrderId: 'shopify-3112', ref: '3112', type: 'shopify',
              status: payment === 'confirmed' ? 'approved' : 'pending', client: 'Zeina Momen', total: 1420,
              createdAt: '2026-11-09T03:01:00Z', items: [{ name: 'Product', qty: 1, price: 1420 }],
              depositReceipts: ['paid', 'confirmed'].includes(payment) ? [{ id: 'receipt-1', status: 'معتمد', amount: 500, method: 'Instapay' }] : [],
              shipWithoutDeposit: payment === 'without-deposit' }];
            // The latest note belongs to the older ticket, not the newest ticket.
            followUps = [
              { _id: 'new-ticket', shopifyOrderId: 'shopify-3112', orderRef: '3112', createdAt: '2026-11-09T12:00:00Z', status: 'جديد',
                comments: [{ authorName: 'System', text: 'Older automatic confirmation', createdAt: '2026-11-09T12:00:00Z' }] },
              { _id: 'old-ticket', orderRef: '#3112', createdAt: '2026-11-08T12:00:00Z', status: 'جديد',
                comments: [{ authorName: 'Souliahome', text: note, createdAt: '2026-11-10T12:00:00Z' },
                  { authorName: 'System', text: 'Older note', createdAt: '2026-11-08T12:00:00Z' }] },
            ];
            renderShopifyOrders();
          }, { lang, payment });
          await page.waitForSelector('#sp-mobile-list .sp-card-fu-last', { visible: true, timeout: 5000 });
          const state = await page.evaluate(() => {
            const card = qs('#sp-mobile-list .sp-card');
            const preview = card.querySelector('.sp-card-fu-last');
            const text = preview.querySelector('.sp-card-comment-text');
            const rect = preview.getBoundingClientRect();
            const bounds = card.getBoundingClientRect();
            return { note: text.textContent, author: preview.querySelector('b').textContent,
              time: !!preview.querySelector('time').textContent, height: text.getBoundingClientRect().height,
              fits: rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom,
              overflow: card.scrollWidth > card.clientWidth + 1,
              // Older callers must also keep the text visible after deposit approval.
              fullPreview: _spFuLastEntryHtml(_shopifyOrders[0], true).includes('sp-card-comment-text'),
              expected: expectedNote, paid: _spDepositOf(_shopifyOrders[0]).deposit };
          });
          const label = `${width}px ${lang} ${payment}`;
          assert.equal(state.note, state.expected, `${label}: latest note across all tickets`);
          assert.equal(state.author, 'Souliahome', `${label}: author`);
          assert.ok(state.time && state.height > 10 && state.fits, `${label}: note and date visible inside card`);
          assert.equal(state.overflow, false, `${label}: no horizontal overflow`);
          assert.equal(state.fullPreview, true, `${label}: deposit cannot suppress note text`);
          if (['paid', 'confirmed'].includes(payment)) assert.equal(state.paid, 500, `${label}: actual approved deposit fixture`);
          if (width === 390 && lang === 'ar' && payment === 'paid')
            await page.screenshot({ path: path.join(require('node:os').tmpdir(), 'soulia-mobile-followup-paid.png'), fullPage: true });
          await page.evaluate(() => { closeSidebar(); trailCalls = []; _spPeekOpenTrail = id => trailCalls.push(id); });
          await page.click('#sp-mobile-list .sp-card-fu-last');
          assert.deepEqual(await page.evaluate(() => trailCalls), ['old-ticket'], `${label}: opens matching trail`);
          // A new note stays visible after the card is refreshed.
          await page.evaluate(() => {
            followUps[1].comments.push({ authorName: 'Staff', text: 'Updated follow-up', createdAt: '2026-11-10T13:00:00Z' });
            _spPeekSyncFollowUps(followUps[1]);
          });
          assert.equal(await page.$eval('#sp-mobile-list .sp-card-comment-text', el => el.textContent), 'Updated follow-up', `${label}: refreshed note`);
        }
      }
    }
    assert.deepEqual(errors, []);
    console.log('shopify mobile follow-up: passed (16 payment, language and viewport combinations)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
