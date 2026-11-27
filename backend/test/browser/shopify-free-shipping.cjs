// «شحن مجاني» in the Shopify edit window (Nov 27, 2026), over the SHIPPED index.html (API mocked).
// Shaped like #3266: one basket 2050, Shopify discount 2050, shipping 120 → total 120.
//   node test/browser/shopify-free-shipping.cjs        (screenshots → artifacts/shopify-free-shipping/)
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const PUB = path.join(root, 'frontend/public');
const OUT = path.join(root, 'artifacts/shopify-free-shipping');
fs.mkdirSync(OUT, { recursive: true });

const order = { _id: 'so-1', ref: '3266', client: 'Mariam kamal mohamed', status: 'pending', cancelled: false,
  items: [{ productId: 'p1', code: 'BLA-BEI-LAU-BAS-108331', name: 'Black & Beige Laundry Basket', qty: 1, price: 2050, total: 2050 }],
  itemsTotal: 2050, total: 120, shipCost: 120, discount: 2050, shippingDiscount: 0, manualDiscount: 0, codesDiscount: 0,
  shopifyCreatedAt: '2026-11-27T10:00:00+02:00', rawData: { current_total_price: '120.00' }, depositReceipts: [] };
const products = [{ _id: 'p1', code: 'BLA-BEI-LAU-BAS-108331', name: 'Black & Beige Laundry Basket', sellPrice: 2050, buyPrice: 700 }];

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
  let failed = false;
  const sent = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(PUB, 'index.html'), 'utf8') });
      const local = path.join(PUB, url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && /\.(js|css|png|svg)$/.test(url.pathname) && fs.existsSync(local))
        return request.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.js') ? 'text/javascript' : 'image/png', body: fs.readFileSync(local) });
      if (url.pathname === '/config.js') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.BACKEND_URL="http://soulia.test/api";' });
      if (/\/shopify\/orders\/so-1\/edit$/.test(url.pathname)) { sent.push(JSON.parse(request.postData() || '{}')); return request.respond({ status: 200, contentType: 'application/json', body: '{"success":true,"total":0}' }); }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'application/json', body: request.resourceType() === 'stylesheet' ? '' : '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((d) => {
      document.getElementById('splash-screen')?.remove();
      currentUser = { _id: 'u1', role: 'admin', perms: [], name: 'Admin' }; currentLang = 'ar';
      products = d.products; inventoryCache = d.products.map(p => ({ ...p, current: 0 })); _shopifyOrders = [d.order]; transactions = [];
      window.__toasts = []; window.toast = (m, e) => window.__toasts.push((e ? 'ERR:' : '') + m);
      window.showConfirm = async () => true;
      window.loadShopifyOrders = async () => {};
    }, { products, order });

    const state = () => page.evaluate(() => ({
      err: document.querySelector('#sp-disc-err')?.textContent || '',
      sum: document.querySelector('#sp-disc-sum')?.innerText || '',
      grand: document.querySelector('#sp-disc-sum .sp-sum-row.is-total .sp-sum-v')?.innerText || '',
      bar: document.querySelector('#shopify-edit-summary')?.innerText || '',
      box: !!document.querySelector('#sp-free-ship'),
    }));

    // 1. the reported case: an extra 120 has no room — stated, not shown as applied
    await page.evaluate(async () => { await editShopifyOrder('so-1'); });
    await page.evaluate(() => { const i = document.querySelector('#sp-disc-entry'); i.value = '120'; _spDiscEntryInput(i); });
    let s = await state();
    ok(s.box, 'the window has a «شحن مجاني» switch when the order has shipping');
    ok(/يتجاوز ما تبقّى/.test(s.err) && /شحن مجاني/.test(s.err), 'an extra 120 on fully discounted items says why and points to «شحن مجاني»');
    ok(/غير مُطبَّق/.test(s.sum), 'the summary marks the 120 as not applied');
    ok(/120/.test(s.grand), `grand total stays 120 (${s.grand})`);
    await page.screenshot({ path: path.join(OUT, 'ar-over-room.png') });
    const before = sent.length;
    await page.evaluate(async () => { await _saveShopifyEdit(); });
    ok(sent.length === before && (await page.evaluate(() => window.__toasts.slice(-1)[0] || '')).startsWith('ERR:'), 'saving it is refused before any request');

    // 2. clear it and tick free shipping → 0
    await page.evaluate(() => { const i = document.querySelector('#sp-disc-entry'); i.value = ''; _spDiscEntryInput(i); });
    await page.click('#sp-free-ship');
    s = await state();
    ok(s.err.trim() === '', 'no error once the extra discount is cleared');
    ok(/^EGP\s*0(\.00)?$|^0/.test(s.grand.replace(/\s+/g, ' ').trim()) || /\b0\b/.test(s.grand), `grand total is 0 (${s.grand})`);
    ok(/شحن مجاني/.test(s.sum) && /120/.test(s.sum), 'the summary states the shipping and «شحن مجاني −120»');
    ok(/\b0\b/.test(s.bar.split('\n').join(' ')), 'the footer total follows (0)');
    const box = await page.evaluate(() => { const r = document.querySelector('.sp-freeship-txt').getBoundingClientRect(); const c = document.querySelector('#sp-free-ship').getBoundingClientRect(); return { txt: r.width, cb: c.width }; });
    ok(box.cb <= 20 && box.txt > 150, `the checkbox keeps its size and the label is readable (checkbox ${Math.round(box.cb)}px, text ${Math.round(box.txt)}px)`);
    await page.evaluate(() => document.querySelector('.sp-freeship')?.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: path.join(OUT, 'ar-free-shipping.png') });

    // 3. saving sends it with the discount
    await page.evaluate(async () => { await _saveShopifyEdit(); });
    ok(sent.length === before + 1 && sent.at(-1).discount?.freeShipping === true && sent.at(-1).discount.manualDiscount === 0,
      'save sends freeShipping:true with the discount (extra discount 0)');

    // 4. staff over the approval limit: the waived shipping counts toward it
    const otp = await page.evaluate(async (d) => {
      _shopifyOrders = [{ ...d }];
      currentUser = { _id: 'u2', role: 'staff', perms: ['shopify-orders'], name: 'Reem' };
      settings = { ...(settings || {}), otpEnabled: true, highValueDiscountLimit: 100 };
      let asked = null; window._spOpenDiscountOtp = (amount) => { asked = amount; };
      await editShopifyOrder('so-1');
      _spToggleFreeShip(true);
      const pass = await _spDiscountPreflight();
      return { pass, asked, need: _isOtpRequired() };
    }, order);
    ok(otp.need && otp.pass === false && otp.asked === 120, `staff: free shipping of 120 over a 100 limit asks for a manager code (${otp.asked})`);

    // 5. outside the window
    const outside = await page.evaluate(() => ({ cell: _spShipCell({ shipCost: 120, freeShipping: { amount: 120 } }), plain: _spShipCell({ shipCost: 120 }) }));
    ok(/مجاني/.test(outside.cell) && /<s /.test(outside.cell), 'the orders table shows «مجاني» with 120 struck');
    ok(!/مجاني/.test(outside.plain), '…and an ordinary order still shows its shipping');

    // 6. English, dark mode
    await page.evaluate(async (d) => {
      currentUser = { _id: 'u1', role: 'admin', perms: [], name: 'Admin' }; currentLang = 'en';
      document.documentElement.dir = 'ltr'; document.body.classList.add('dark-mode');
      _shopifyOrders = [{ ...d, freeShipping: { amount: 120, by: 'Admin' }, total: 0 }];
      document.getElementById('shopify-edit-modal')?.remove();
      await editShopifyOrder('so-1');
      document.querySelector('.sp-freeship')?.scrollIntoView({ block: 'center' });
    }, order);
    s = await state();
    ok(/Free shipping/.test(await page.evaluate(() => document.querySelector('.sp-freeship').innerText)) && (await page.evaluate(() => document.querySelector('#sp-free-ship').checked)),
      'English: the saved free shipping opens ticked');
    await page.screenshot({ path: path.join(OUT, 'en-dark-saved.png') });
    ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) { failed = true; console.error('✗', e.message); }
  finally { await browser.close(); }
  process.exit(failed ? 1 : 0);
})();
