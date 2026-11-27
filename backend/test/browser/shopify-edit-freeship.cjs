// «شحن مجاني» in the edit history + edit window (Nov 27, 2026), over the SHIPPED index.html (API mocked).
//   node test/browser/shopify-edit-freeship.cjs        screenshots → artifacts/shopify-edit-freeship-*.png
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const PUB = path.join(root, 'frontend/public');
const basket = { productId: 'p1', code: 'BLA-BEI', name: 'Laundry Basket', qty: 1, price: 2050, total: 2050 };
// #3266: Shopify discount 2050, shipping 120. An approved edit added a manual 120; the pending one removes it and turns free shipping on.
const before = { items: [basket], itemsTotal: 2050, discount: 2050, manualDiscount: 120, codesDiscount: 0, shipCost: 120, total: 120 };
const order = { _id: 'so-1', ref: '3266', status: 'pending', ...before,
  editRequest: { id: 'r2', status: 'معلق', requestedBy: 'Malak Abbas', requestedAt: '2026-11-27T21:33:00Z', before,
    patch: { manualDiscount: 0, codesDiscount: 0, freeShipping: { amount: 120, by: 'Malak Abbas' }, total: 0 }, changes: [] } };
const detail = { ...order, rawData: {}, editRequestHistory: [
  { id: 'r1', status: 'معتمد', requestedBy: 'Malak Abbas', requestedAt: '2026-11-25T01:24:00Z', reviewedBy: 'Sallonaz', reviewedAt: '2026-11-25T01:26:00Z',
    before: { ...before, manualDiscount: 0 }, patch: { manualDiscount: 120, total: 120 }, changes: [] },
  { id: 'r0', status: 'معتمد', requestedBy: 'Admin', requestedAt: '2026-11-24T10:00:00Z', reviewedBy: 'Admin', reviewedAt: '2026-11-24T10:00:00Z',
    before: { ...before, manualDiscount: 0, freeShipping: true, total: 0 }, patch: { manualDiscount: 0, freeShipping: null, total: 120 }, changes: [] },
  order.editRequest] };

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
  let failed = false;
  try {
    for (const [lang, dark] of [['ar', false], ['en', true]]) {
      console.log(lang + (dark ? ' dark' : ''));
      const page = await browser.newPage();
      await page.setViewport({ width: 900, height: 1000 });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === 'http://soulia.test' && url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(PUB, 'index.html'), 'utf8') });
        const local = path.join(PUB, url.pathname.slice(1));
        if (url.origin === 'http://soulia.test' && /\.(js|css)$/.test(url.pathname) && fs.existsSync(local))
          return request.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(local, 'utf8') });
        if (url.pathname === '/config.js') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.BACKEND_URL="http://soulia.test/api";' });
        if (/\/shopify\/orders\/detail\/so-1$/.test(url.pathname)) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) });
        if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
        return request.respond({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'application/json', body: request.resourceType() === 'stylesheet' ? '' : '[]' });
      });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      await page.evaluate((d, lng, dk) => {
        currentUser = { _id: 'u1', role: 'admin', perms: [], name: 'Admin' }; currentLang = lng;
        document.documentElement.dir = lng === 'en' ? 'ltr' : 'rtl';
        document.body.classList.toggle('dark-mode', dk);
        products = []; inventoryCache = []; _shopifyOrders = [d]; transactions = [];
      }, order, lang, dark);
      await page.evaluate(() => openShopifyEditReview('so-1'));
      await page.waitForSelector('.sp-eh-entry', { timeout: 5000 });
      const r = await page.evaluate(() => {
        const pend = document.querySelector('.sp-eh-pending');
        const feat = pend.querySelector('.edit-feature-change');
        const notes = [...pend.querySelectorAll('.edit-discount-note')].map(n => n.textContent.replace(/^\s*%/, '').trim());
        const chips = [...document.querySelectorAll('.sp-eh-feat')].map(c => ({ text: c.textContent.trim(), off: c.classList.contains('is-off') }));
        const icon = pend.querySelector('.edit-discount-icon')?.getBoundingClientRect();
        return { feat: feat && { cls: feat.className, text: feat.textContent, svg: !!feat.querySelector('svg'), first: pend.querySelector('.edit-diff-fields').firstElementChild === feat },
          notes, chips, icon: icon && Math.round(icon.width) };
      });
      ok(r.feat && r.feat.svg && /is-on/.test(r.feat.cls), 'pending request shows a free-shipping feature row with a truck icon');
      ok(r.feat.first, 'the free-shipping row comes first in the changes');
      ok(lang === 'ar' ? /تم تفعيل الشحن المجاني/.test(r.feat.text) : /Free shipping turned on/.test(r.feat.text), 'it says «free shipping turned on», not a discount: ' + r.feat.text.slice(0, 60));
      ok(r.notes.some(n => lang === 'ar' ? n.startsWith('إلغاء الخصم') : n.startsWith('Discount removed')), 'a discount set to 0 reads «discount removed»: ' + r.notes.join(' | '));
      ok(r.icon === 16, 'the % icon is smaller (16px): ' + r.icon);
      ok(r.chips.some(c => c.off), 'the turned-off entry carries a «free shipping off» chip in its summary');
      await page.screenshot({ path: path.join(root, `artifacts/shopify-edit-freeship-${lang}${dark ? '-dark' : ''}.png`) });
      // Shipping column: «Free» marked the same way whether the system set it or Shopify sent it.
      const cells = await page.evaluate(() => {
        closeModal();
        const sys = { shipCost: 120, discount: 2050, freeShipping: { amount: 120, by: 'Malak Abbas' } };
        const shop = { shipCost: 120, discount: 120, shippingDiscount: 120, shippingDiscountCodes: ['FREESHIP'] };
        const part = { shipCost: 120, discount: 50, shippingDiscount: 50 };
        const tx = { type: 'مبيعات', shipCost: 0, freeShipping: { amount: 120, by: 'Admin' } };
        const html = [_spShipCell(sys), _spShipCell(shop), _spShipCell(part), _movShipCell(tx), _spShipCell({ shipCost: 120 })];
        const box = document.createElement('div');
        box.id = 'ship-test'; box.style.cssText = 'position:fixed;top:20px;left:20px;z-index:99999;display:flex;gap:28px;padding:16px;background:var(--surface,#fff);border:1px solid #ccc';
        box.innerHTML = html.map(h => `<div>${h}</div>`).join('');
        document.body.append(box);
        const info = [...box.children].map(c => ({ tag: !!c.querySelector('.ship-free-tag'), title: c.querySelector('.mov-ship-cell')?.title || '', text: c.textContent.trim() }));
        const tag = box.querySelector('.ship-free-tag');
        return { info, bg: tag && getComputedStyle(tag).backgroundColor, svg: !!tag?.querySelector('svg') };
      });
      ok(cells.info[0].tag && /النظام|system/.test(cells.info[0].title), 'system free shipping is marked, source in the tooltip');
      ok(cells.info[1].tag && /Shopify/.test(cells.info[1].title) && /FREESHIP/.test(cells.info[1].title), 'Shopify free shipping is marked too, with its code');
      ok(!cells.info[2].tag && !cells.info[4].tag, 'partial or no shipping discount is not marked free');
      ok(cells.info[3].tag && /120/.test(cells.info[3].text), 'a confirmed sale shows «Free» with the waived 120 struck');
      ok(cells.svg && cells.bg !== 'rgba(0, 0, 0, 0)', 'the mark is a tinted pill with a truck icon');
      const el = await page.$('#ship-test');
      await el.screenshot({ path: path.join(root, `artifacts/ship-free-cell-${lang}${dark ? '-dark' : ''}.png`) });
      ok(!errors.length, 'no page errors ' + errors.join(' | '));
      await page.close();
    }
  } catch (e) { failed = true; console.error(e.message); }
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
