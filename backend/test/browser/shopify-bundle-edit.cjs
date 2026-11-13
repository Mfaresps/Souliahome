// Phase 3 — bundle protection in the Shopify edit window and the confirm step, over the SHIPPED index.html
// (full app, API mocked, invented data shaped like #3146).   node test/browser/shopify-bundle-edit.cjs
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const PUB = path.join(root, 'frontend/public');

const parts = [
  { productId: 'p1', code: 'Code 10', name: 'Boho Charm Basket L', qty: 1, price: 1302.75, total: 1302.75, shopifyLineId: '1001', bundleGroupId: 'g1', priceBasis: 'bundle' },
  { productId: 'p2', code: 'HEARTH-1', name: 'Hearth Blanket Throw', qty: 1, price: 1697.25, total: 1697.25, shopifyLineId: '1002', bundleGroupId: 'g1', priceBasis: 'bundle' },
];
const single = { productId: 'p3', code: 'SOLO', name: 'Solo Cushion', qty: 1, price: 500, total: 500 };
const order = { _id: 'so-1', ref: '9104', status: 'pending', items: [...parts, single], itemsTotal: 3500, total: 3500, shipCost: 0, discount: 0,
  shopifyCreatedAt: '2026-11-13T10:00:00+02:00', rawData: { current_total_price: '3500.00' },
  bundleOriginal: { verified: true, groups: [{ groupId: 'g1', title: 'blanket with boho basket', quantity: 1, allocatedTotal: 3000 }] } };
const products = [
  { _id: 'p1', code: 'Code 10', name: 'Boho Charm Basket L', sellPrice: 1420, buyPrice: 500 },
  { _id: 'p2', code: 'HEARTH-1', name: 'Hearth Blanket Throw', sellPrice: 1850, buyPrice: 423,
    priceOffers: [{ id: 'o1', price: 1000, from: '2026-11-12', to: '2026-11-19', reason: 'black friday', createdAt: '2026-11-12T00:00:00Z' }] },
  { _id: 'p3', code: 'SOLO', name: 'Solo Cushion', sellPrice: 500, buyPrice: 200 },
];

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
  let failed = false;
  const sent = [];
  let approveCalls = 0;
  try {
    const page = await browser.newPage();
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
      if (/\/shopify\/orders\/so-1\/edit$/.test(url.pathname)) { sent.push(JSON.parse(request.postData() || '{}')); return request.respond({ status: 200, contentType: 'application/json', body: '{"success":true}' }); }
      if (/\/shopify\/orders\/so-1\/approve$/.test(url.pathname)) {
        approveCalls++;
        const body = JSON.parse(request.postData() || '{}');
        if (!body.acknowledgeDivergence) return request.respond({ status: 400, contentType: 'application/json',
          body: JSON.stringify({ statusCode: 400, code: 'SHOPIFY_DIVERGENCE_ACK_REQUIRED', message: 'differs', divergence: { shopifyTotal: 3500, erpTotal: 2350, diff: -1150 } }) });
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, txId: 't1', ack: true }) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'application/json', body: request.resourceType() === 'stylesheet' ? '' : '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((d) => {
      currentUser = { _id: 'u1', role: 'admin', perms: [], name: 'Admin' }; currentLang = 'ar';
      products = d.products; inventoryCache = d.products.map(p => ({ ...p, current: 10 })); _shopifyOrders = [d.order]; transactions = [];
      window.__confirms = []; window.showConfirm = async (q, o) => { window.__confirms.push({ q, rows: o?.rows || [] }); return true; };
      window.__toasts = []; window.toast = (m, e) => window.__toasts.push((e ? 'ERR:' : '') + m);
    }, { products, order });

    const r1 = await page.evaluate(async () => {
      await editShopifyOrder('so-1');
      const rows = [...document.querySelectorAll('.sp-edit-item-row')];
      const bundleRows = rows.filter(r => r.classList.contains('is-bundle-part'));
      const readonly = bundleRows.reduce((n, r) => n + r.querySelectorAll('input[readonly]').length, 0);
      const notices = bundleRows.reduce((n, r) => n + r.querySelectorAll('.po-notice').length, 0);
      // discount base = lines outside the bundle (500): 10% manual = 50, not 350
      _spDiscType = 'percent';
      const dv = document.querySelector('#sp-disc-value') || (() => { const i = document.createElement('input'); i.id = 'sp-disc-value'; document.body.appendChild(i); return i; })();
      dv.value = '10';
      const manual = _spManualAmount(3500);
      dv.value = '0';
      return { bundleRows: bundleRows.length, readonly, notices, manual, base: _spDiscBase(3500) };
    });
    ok(r1.bundleRows === 2, 'edit window: the two bundle parts are marked');
    ok(r1.readonly === 4, 'edit window: price and quantity of bundle parts are read-only');
    ok(r1.notices === 0, 'edit window: no offer notice / «apply offer» on a bundle part');
    ok(r1.base === 500 && r1.manual === 50, `discount base is the lines outside the bundle (base ${r1.base}, 10% = ${r1.manual})`);

    const r2 = await page.evaluate(() => {
      _shopifyEditQty(0, 1);
      const items = _shopifyEditItems.map(i => ({ code: i.code, qty: i.qty, price: i.price, b: !!i.bundleGroupId }));
      return { items, toast: window.__toasts.slice(-1)[0] };
    });
    ok(r2.items.length === 4 && r2.items[0].qty === 1 && r2.items[0].b, '«+» on a bundle part leaves the part as it is');
    ok(r2.items[3].code === 'Code 10' && !r2.items[3].b && r2.items[3].price === 1420, `…and adds a separate line at the normal price (${r2.items[3].price})`);

    const r3 = await page.evaluate(async () => {
      _shopifyEditItems.pop();                       // drop the extra line from the previous step
      _shopifyEditRemoveItem(0);                     // remove the basket → breaks the bundle
      await new Promise(r => setTimeout(r, 50));
      const c = window.__confirms.slice(-1)[0];
      return { items: _shopifyEditItems.map(i => ({ code: i.code, price: i.price, b: !!i.bundleGroupId, from: i.brokenFrom || '' })), confirm: c, flag: _spEditConfirmBreak };
    });
    ok(!!r3.confirm && r3.confirm.rows.some(r => /1,697.25|1697.25/.test(r[1]) && /1,000|1000/.test(r[1])), 'removing a part asks first, showing old → new price');
    ok(r3.items.length === 2 && r3.items[0].code === 'HEARTH-1' && r3.items[0].price === 1000 && !r3.items[0].b && r3.items[0].from === 'g1',
      `the rest is repriced at the ORDER day's standalone price, offer included (${r3.items[0].price})`);
    ok(r3.flag === true, 'the confirmed break is remembered for the save');

    const r4 = await page.evaluate(async () => { await _saveShopifyEdit(); await new Promise(r => setTimeout(r, 50)); return true; });
    ok(sent.length === 1 && sent[0].confirmBundleBreak === true, 'save sends the confirmation with the proposal');

    const r5 = await page.evaluate(async () => {
      const before = window.__confirms.length;
      const res = await _spApproveRequest('so-1', 'bosta');
      let bulkErr = '';
      try { await _spApproveRequest('so-1', 'bosta', { noAsk: true }); } catch (e) { bulkErr = e.code || e.message; }
      return { res, asked: window.__confirms.length - before, bulkErr };
    });
    ok(r5.res?.success && r5.asked === 1, 'confirming an order that differs from Shopify asks, then resends with the acknowledgement');
    ok(r5.bulkErr === 'SHOPIFY_DIVERGENCE_ACK_REQUIRED', 'bulk confirmation never acknowledges on the operator\'s behalf');
    ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) { failed = true; console.error('✗', e.message); }
  finally { await browser.close(); }
  process.exit(failed ? 1 : 0);
})();
