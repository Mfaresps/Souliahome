const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const publicDir = path.resolve(__dirname, '../../../frontend/public');
const outDir = path.resolve(__dirname, '../../../artifacts/shopify-peek-fast-open');
fs.mkdirSync(outDir, { recursive: true });
const measureOnly = process.argv.includes('--measure');
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage(), errors = [], measurements = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
        return request.respond({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(file) });
      return request.respond({ status: 200, contentType: request.resourceType() === 'script' ? 'text/javascript' : 'application/json', body: request.resourceType() === 'script' ? '' : '[]' });
    });
    for (const width of measureOnly ? [1440] : [1440, 390]) {
      await page.setViewport({ width, height: 1000 });
      for (const lang of measureOnly ? ['en'] : ['en', 'ar']) {
        await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
        await page.evaluate(lang => {
          currentUser = { _id: 'peek-perf', name: 'Review', role: 'admin', perms: [] };
          currentLang = lang; document.documentElement.dir = document.dir = lang === 'ar' ? 'rtl' : 'ltr';
          qs('#login-page').style.display = 'none'; qs('#app').style.display = ''; qs('#splash-screen')?.remove();
          document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
          qs('#page-shopify-orders').classList.add('active'); currentPage = 'shopify-orders'; closeSidebar();
          _spServerEnabled = true; _spFuFetchedAt = 0; followUps = [];
          window.peekOrder = { _id: 'perf-order', ref: '3080', client: 'Momen Helmy', phone: '01124535353', total: 2482,
            status: 'pending', createdAt: '2026-11-07T11:07:00Z', shippingGov: 'Giza', shippingAddress: 'Delivery address',
            items: [{ name: 'NEST Organizer', qty: 1, price: 2482 }], depositReceipts: [
              { id: 'receipt-1', status: 'معتمد', amount: 1500, method: 'Instapay', noImage: true, noImageAuth: 'otp' }
            ], comments: [] };
          _shopifyOrders = [peekOrder];
          window.peekRequests = []; window.peekReleases = {};
          api = url => {
            peekRequests.push(url);
            return new Promise((resolve, reject) => { peekReleases[url.split('?')[0]] = { resolve, reject }; });
          };
          window.peekStart = performance.now();
          window.peekOpening = openSpOrderPeek('perf-order');
          window.peekImmediateOpen = !!qs('#sp-peek.is-open');
          window.peekRenderMs = performance.now() - peekStart;
          window.peekHeader = qs('#sp-peek .sp-pk-head');
        }, lang);
        await page.waitForSelector('#sp-peek.is-open', { timeout: 2000 });
        const initial = await page.evaluate(() => ({ ms: performance.now() - peekStart,
          requests: peekRequests.slice(), html: qs('#sp-peek').textContent,
          detailPending: !!peekReleases['/shopify/orders/detail/perf-order'],
          historyPending: !!peekReleases['/clients/order-profile'],
          followupsPending: !!peekReleases['/followups/shopify-order'], immediate: peekImmediateOpen, renderMs: peekRenderMs }));
        measurements.push({ width, lang, openMs: Math.round(initial.ms), renderMs: Math.round(initial.renderMs) });
        if (!measureOnly) {
          assert.equal(initial.immediate, true, 'opens synchronously while every data request is held');
          assert.ok(initial.detailPending && initial.followupsPending && initial.historyPending, 'independent data reads start together');
          assert.equal(/Customer history|سجل العميل|Loading order details/.test(initial.html), false, 'no temporary loading text');
          assert.ok(await page.$('#sp-peek .ss-skeleton'), 'in-place shimmer');
          await page.screenshot({ path: path.join(outDir, `pending-${lang}-${width}.png`) });
        }
        await page.evaluate(() => {
          peekReleases['/shopify/orders/detail/perf-order'].resolve({ ...peekOrder, comments: [{ text: 'Received', authorName: 'Review' }] });
          peekReleases['/followups/shopify-order'].resolve([]);
        });
        await page.waitForFunction(() => document.querySelector('#sp-peek .sp-pk-comment-count'));
        if (!measureOnly) assert.equal(await page.evaluate(() => peekHeader === qs('#sp-peek .sp-pk-head')), true, 'detail response preserves customer header DOM');
        await page.waitForFunction(() => !!peekReleases['/clients/order-profile']);
        await page.evaluate(() => peekReleases['/clients/order-profile'].resolve({ key: 'test-client', stats: { orders: 1 },
          history: [{ source: 'shopify', id: 'perf-order', outcome: 'pending' }], assessment: 'limited', profilePath: '#clients/profile/test-client' }));
        await page.waitForSelector('#sp-peek .cp-badge');
        await page.evaluate(() => peekOpening);
        if (!measureOnly) await page.screenshot({ path: path.join(outDir, `ready-${lang}-${width}.png`) });
        if (!measureOnly) {
          const cached = await page.evaluate(async () => {
            const n = peekRequests.length;
            const start = performance.now(); await openSpOrderPeek('perf-order');
            return { reads: peekRequests.length - n, ms: performance.now() - start,
              shimmer: !!qs('#sp-peek .ss-skeleton'), history: qs('#sp-peek .cp-badge')?.textContent };
          });
          assert.equal(cached.reads, 0, 'reopen reuses detail, follow-ups and customer history');
          assert.equal(cached.shimmer, false, 'cached data paints directly');
          assert.ok(cached.ms < 100, `cached open: ${cached.ms}ms`);
          assert.ok(cached.history);
          assert.equal(await page.evaluate(() => qs('#sp-peek .sp-pk-body').classList.contains('is-in') ||
            qs('#sp-peek .sp-peek').getAnimations().some(a => a.id === 'sp-pk-morph')), false, 'no arrival or height animation after background updates');
          // Missing list data still opens the actual invoice sections immediately.
          await page.evaluate(() => { peekOpening = openSpOrderPeek('cold-order'); });
          assert.ok(await page.$('#sp-peek.is-open .sp-pk-items-section .ss-skeleton'));
          assert.ok(await page.$('#sp-peek .spdep-payment-card .ss-skeleton'));
          await page.evaluate(() => {
            closeSpOrderPeek();
            peekReleases['/shopify/orders/detail/cold-order'].resolve({ ...peekOrder, _id: 'cold-order' });
            return peekOpening;
          });
          assert.equal(await page.$('#sp-peek.is-open'), null, 'late detail never reopens a closed invoice');
          await page.evaluate(() => {
            _spFullOrderCache.delete('perf-order');
            peekOpening = openSpOrderPeek('perf-order');
            peekReleases['/shopify/orders/detail/perf-order'].reject(new Error('Fixture: detail temporarily unavailable'));
            return peekOpening;
          });
          assert.ok(await page.$('#sp-peek.is-open .sp-pk-client'), 'failed background read retains the available invoice');
          assert.equal(await page.$eval('#sp-peek .sp-pk-client', el => el.textContent), 'Momen Helmy');
        }
      }
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify(measurements));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
