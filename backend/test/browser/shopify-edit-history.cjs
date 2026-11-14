// Edit history window (pencil mark) + «what changed» in the confirm-with-a-difference dialog, over the SHIPPED
// index.html (API mocked).   node test/browser/shopify-edit-history.cjs
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const PUB = path.join(root, 'frontend/public');
const IMG = 'https://img.test/basket.png';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const basket = { productId: 'p1', code: 'Code 10L', name: 'Boho Charm Basket XL', qty: 1, price: 1950, total: 1950, imageUrl: IMG };
const tray = { productId: 'p2', code: 'TRAY', name: 'Rattan Tray', qty: 1, price: 830, total: 830, imageUrl: IMG };
const v0 = { items: [basket], itemsTotal: 1950, manualDiscount: 0, codesDiscount: 0, shipCost: 120, total: 2070 };
const v1 = { items: [basket, tray], itemsTotal: 2780, total: 2960 };
const v2 = { manualDiscount: 60, total: 2900 };
const order = { _id: 'so-1', ref: '3143', status: 'pending', items: [basket, tray], itemsTotal: 2780, shipCost: 120, manualDiscount: 60, codesDiscount: 0, discount: 0, total: 2900,
  editRequest: { id: 'r3', status: 'معتمد', requestedBy: 'Souliahome', requestedAt: '2026-11-13T21:47:00Z', reviewedBy: 'Souliahome', reviewedAt: '2026-11-13T21:47:00Z',
    before: { ...v0, ...v1, manualDiscount: 0 }, patch: v2, changes: ['الخصم اليدوي: 0 ← 60'] } };
const detail = { ...order, rawData: {},
  editRequestHistory: [
    { id: 'r1', status: 'معتمد', requestedBy: 'Malak Abbas', requestedAt: '2026-11-13T18:10:00Z', reviewedBy: 'Admin', reviewedAt: '2026-11-13T18:30:00Z', before: v0, patch: { items: v1.items, itemsTotal: 2780, total: 2960 }, changes: ['add'] },
    { id: 'r2', status: 'مرفوض', requestedBy: 'Malak Abbas', requestedAt: '2026-11-13T20:57:00Z', reviewedBy: 'Admin', reviewedAt: '2026-11-13T21:00:00Z', rejectedReason: 'stale', before: { ...v0, ...v1 }, patch: v2, changes: ['disc'] },
    order.editRequest],
  editHistory: [
    { action: 'اعتماد تعديل أوردر', editedAt: '2026-11-13T18:30:00Z', editedBy: 'Malak Abbas', before: v0, after: v1, changes: [] }, // mirrors r1
    { action: 'تعديل أوردر', editedAt: '2026-11-13T21:47:00Z', editedBy: 'Souliahome', before: v0, after: v2, changes: [] },      // mirrors r3
    { action: 'تعديل الخصم', editedAt: '2026-11-13T17:00:00Z', editedBy: 'Reem', before: { manualDiscount: 0, total: 2070 }, after: { manualDiscount: 0, codesDiscount: 0, total: 2070 }, changes: ['x'] },
  ] };

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
  let failed = false;
  try {
    for (const lang of ['ar', 'en']) {
      console.log(lang);
      const page = await browser.newPage();
      await page.setViewport({ width: lang === 'ar' ? 1440 : 390, height: 900 });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.href === IMG) return request.respond({ status: 200, contentType: 'image/png', body: PNG });
        if (url.origin === 'http://soulia.test' && url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(PUB, 'index.html'), 'utf8') });
        const local = path.join(PUB, url.pathname.slice(1));
        if (url.origin === 'http://soulia.test' && /\.(js|css)$/.test(url.pathname) && fs.existsSync(local))
          return request.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(local, 'utf8') });
        if (url.pathname === '/config.js') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.BACKEND_URL="http://soulia.test/api";' });
        if (/\/shopify\/orders\/detail\/so-1$/.test(url.pathname)) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) });
        if (/\/shopify\/orders\/so-1\/approve$/.test(url.pathname)) {
          const body = JSON.parse(request.postData() || '{}');
          if (!body.acknowledgeDivergence) return request.respond({ status: 400, contentType: 'application/json',
            body: JSON.stringify({ statusCode: 400, code: 'SHOPIFY_DIVERGENCE_ACK_REQUIRED', message: 'differs', divergence: { shopifyTotal: 2070, erpTotal: 2900, diff: 830 } }) });
          return request.respond({ status: 200, contentType: 'application/json', body: '{"success":true}' });
        }
        if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
        return request.respond({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'application/json', body: request.resourceType() === 'stylesheet' ? '' : '[]' });
      });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      await page.evaluate((d, lng) => {
        currentUser = { _id: 'u1', role: 'admin', perms: [], name: 'Admin' }; currentLang = lng;
        document.documentElement.dir = lng === 'en' ? 'ltr' : 'rtl';
        products = []; inventoryCache = []; _shopifyOrders = [d]; transactions = [];
      }, order, lang);

      await page.evaluate(() => openShopifyEditReview('so-1'));
      await page.waitForSelector('.sp-eh-entry', { timeout: 5000 });
      await page.waitForFunction(() => [...document.querySelectorAll('.sp-eh img')].some(i => i.complete && i.naturalWidth > 0), { timeout: 5000 });
      const h = await page.evaluate(() => {
        const entries = [...document.querySelectorAll('.sp-eh-entry')];
        const box = document.querySelector('#modal-overlay .modal').getBoundingClientRect();
        return { n: entries.length, open: entries.map(e => e.open), titles: entries.map(e => e.querySelector('.sp-eh-titleline b').textContent),
          rejected: entries.filter(e => e.classList.contains('is-rejected')).length, reason: !!document.querySelector('.sp-eh-reason'),
          summary: document.querySelector('.sp-eh-summary')?.textContent || '', thumbs: entries[2]?.querySelectorAll('.sp-eh-thumb').length,
          overflow: document.documentElement.scrollWidth > innerWidth + 1, modalW: box.width, vw: innerWidth };
      });
      ok(h.n === 4, `four edits listed once each (${h.titles.join(' | ')})`);
      ok(h.open[0] && !h.open.slice(1).some(Boolean), 'newest edit open, the rest folded');
      ok(h.rejected === 1 && h.reason, 'rejected edit marked, with its reason');
      ok(/2,070/.test(h.summary) && /2,900/.test(h.summary), `summary: total from first to now (${h.summary})`);
      ok(h.thumbs >= 1, 'the item edit shows the product photo in its summary line');
      const bodyThumbs = await page.evaluate(() => { const e = document.querySelectorAll('.sp-eh-entry')[2]; e.open = true; return e.querySelectorAll('.edit-product-thumb').length; });
      ok(bodyThumbs >= 1, 'opening the item edit shows the product with its photo');
      ok(!h.overflow && h.modalW <= h.vw, 'no page overflow, window inside the screen');
      await page.screenshot({ path: path.join(require('os').tmpdir(), `sp-eh-${lang}.png`) });
      await page.evaluate(() => closeModal());

      const d = await page.evaluate(async () => {
        const p = _spApproveRequest('so-1', 'bosta');
        for (let i = 0; i < 40 && !document.querySelector('#soulia-modal-overlay.active .sp-dx'); i++) await new Promise(r => setTimeout(r, 50));
        const box = document.querySelector('#soulia-modal');
        const res = { rows: [...document.querySelectorAll('.sp-dx-row')].map(r => r.textContent.replace(/\s+/g, ' ').trim()),
          img: [...document.querySelectorAll('.sp-dx img')].length, diff: [...document.querySelectorAll('.sm-val')].map(v => v.textContent).pop(),
          wide: document.querySelector('#soulia-modal-overlay').classList.contains('sp-div-check'), boxW: box.getBoundingClientRect().width };
        return res;
      });
      await page.screenshot({ path: path.join(require('os').tmpdir(), `sp-dx-${lang}.png`) });
      const after = await page.evaluate(async () => { document.querySelector('#soulia-modal-confirm').click(); await new Promise(r => setTimeout(r, 300));
        return { cleaned: !document.querySelector('#soulia-modal-overlay').classList.contains('sp-div-check') }; });
      ok(d.rows.length === 2, `difference dialog lists what changed (${d.rows.join(' / ')})`);
      ok(d.rows.some(r => /Rattan Tray/.test(r) && /830/.test(r)) && d.img >= 1, 'the added product, with its photo and qty × price');
      ok(d.rows.some(r => /60/.test(r)), 'the manual discount change');
      ok(d.wide && after.cleaned, 'dialog widened while open, class removed after');
      ok(/^⁦\+/.test(d.diff), 'difference keeps its sign before the number (isolated)');
      ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
      await page.close();
    }
  } catch (e) { failed = true; console.error('✗', e.message); }
  finally { await browser.close(); }
  process.exit(failed ? 1 : 0);
})();
