// «أداء الباقات» over the SHIPPED bundle-analytics.js / .css with a known data set, figures checked
// against hand-computed values. Network is faked.
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', (r) => r.respond({ status: 200, contentType: 'text/html; charset=utf-8',
      body: '<html dir="rtl"><body><div id="rep-bundles-section"></div><div id="promo-host"></div><div id="modal-overlay"><div id="modal-content"></div></div></body></html>' }));
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto('https://soulia.test/');
    await page.addStyleTag({ content: html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1] });
    await page.addStyleTag({ path: path.join(root, 'bundle-analytics.css') });
    await page.evaluate(() => {
      window.qs = (s) => document.querySelector(s);
      window.currentLang = 'ar';
      window.currentUser = { role: 'admin', perms: [] };
      window.isAdmin = () => currentUser.role === 'admin';
      window.hasPerm = (p) => isAdmin() || (currentUser.perms || []).includes(p);
      window.esc = (v) => { const d = document.createElement('div'); d.textContent = v == null ? '' : String(v); return d.innerHTML; };
      window.escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      window.fmtN = (n) => Number(n || 0).toLocaleString('en-US');
      window.fmtJ = (n) => `<span class="amt-cur">EGP</span> <span class="amt-num">${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}</span>`;
      window.openModal = (h) => { qs('#modal-content').innerHTML = h; qs('#modal-overlay').classList.add('active'); };
      window.closeModal = () => { qs('#modal-overlay').classList.remove('active'); qs('#modal-content').innerHTML = ''; };
      window.opened = []; window.openOrderView = (id) => opened.push(id);
      window.products = [{ _id: 'p10', code: 'Code 10', name: 'Boho Charm Basket', sellPrice: 1420, buyPrice: 500 },
        { _id: 'pHB', code: 'HB-1', name: 'Hearth Blanket', sellPrice: 1850, buyPrice: 423 },
        { _id: 'pL', code: 'BOW-L', name: 'Bow L', sellPrice: 100, buyPrice: 40 }, { _id: 'pS', code: 'BOW-S', name: 'Bow S', sellPrice: 100, buyPrice: 40 }];
      window.settings = { discountBundles: [{ id: 'b1', name: 'Bow dining offer' }] };
      const part = (code, productId, price, list, cost, g) => ({ code, productId, name: code, qty: 1, price, listPrice: list, unitCost: cost, costSource: 'sale-snapshot', bundleGroupId: g, priceBasis: 'bundle' });
      const snap = (g, title) => ({ groups: [{ groupId: g, title, quantity: 1, productId: '', components: [] }] });
      window.transactions = [
        { _id: 't1', ref: '3146', type: 'مبيعات', date: '2026-11-10', client: 'Mona', total: 3000, bundleSnapshot: snap('G1', 'blanket with boho basket'),
          items: [part('Code 10', 'p10', 1302.75, 1420, 500, 'G1'), part('HB-1', 'pHB', 1697.25, 1850, 423, 'G1')] },
        { _id: 't2', ref: '3150', type: 'مبيعات', date: '2026-11-11', client: 'Omar', total: 3000, bundleSnapshot: snap('G2', 'blanket with boho basket'),
          items: [part('Code 10', 'p10', 1302.75, 1420, 500, 'G2'), part('HB-1', 'pHB', 1697.25, 1850, 423, 'G2')] },
        { _id: 't3', ref: '3151', type: 'مبيعات', cancelled: true, date: '2026-11-11', bundleSnapshot: snap('G3', 'blanket with boho basket'),
          items: [part('Code 10', 'p10', 1302.75, 1420, 500, 'G3')] },
        // the same products sold separately
        { _id: 't4', ref: '3152', type: 'مبيعات', date: '2026-11-12', items: [
          { code: 'Code 10', productId: 'p10', qty: 1, price: 1420, unitCost: 500, costSource: 'sale-snapshot' },
          { code: 'HB-1', productId: 'pHB', qty: 1, price: 1850, unitCost: 423, costSource: 'sale-snapshot' }] },
        // a bundle broken after confirmation
        { _id: 't5', ref: '3153', type: 'مبيعات', date: '2026-11-12', bundleSnapshot: snap('G9', 'blanket with boho basket'), items: [
          { code: 'Code 10', productId: 'p10', qty: 1, price: 1420, unitCost: 500, costSource: 'sale-snapshot', brokenFrom: 'G9', priceBasis: 'regular' }] },
        // smart bundle: tracked invoice + an untracked old one with the same code
        { _id: 't6', ref: '3154', type: 'مبيعات', date: '2026-11-14', createdAt: '2026-11-14T10:00:00Z', discountCode: 'BOWDINING',
          appliedBundles: [{ id: 'b1', name: 'Bow dining offer', kind: 'full', discount: 300, productIds: ['pL', 'pS'] }],
          items: [{ productId: 'pL', code: 'BOW-L', qty: 6, price: 100 }, { productId: 'pS', code: 'BOW-S', qty: 6, price: 100 }] },
        { _id: 't7', ref: '1000', type: 'مبيعات', date: '2026-10-01', discountCode: 'BOWDINING',
          items: [{ productId: 'pL', code: 'BOW-L', qty: 6, price: 100 }, { productId: 'pS', code: 'BOW-S', qty: 6, price: 100 }] },
      ];
    });
    await page.addScriptTag({ path: path.join(root, 'bundle-analytics.js') });

    const d = await page.evaluate(() => SouliaBundleStats.compute('', ''));
    const b = d.shopify.find((r) => r.title === 'blanket with boho basket');
    ok(d.shopify.length === 1 && b, 'one Shopify bundle, grouped by title across orders');
    ok(b.invoices === 2 && b.bundles === 2, 'sold on 2 invoices — the cancelled order is left out');
    ok(b.revenue === 6000 && b.listValue === 6540 && b.saved === 540, 'revenue 6,000, normal price 6,540, customer saving 540');
    ok(b.cost === 1846 && b.profit === 4154, 'cost 1,846 (frozen line cost), profit 4,154');
    ok(Math.abs(b.margin - 69.23) < 0.01 && Math.abs(b.looseMargin - 71.77) < 0.01, 'margin 69.23% vs 71.77% when the same products sold separately');
    ok(b.broken === 1, 'one order broke the bundle after confirmation');
    ok(d.smart.length === 1 && d.smart[0].invoices === 1 && d.smart[0].revenue === 1200 && d.smart[0].discount === 300,
      'smart bundle: only the tracked invoice counts (1 invoice, 1,200 of its products, 300 discount) — the old one with the same code is not guessed');
    ok(d.trackedSince === '2026-11-14T10:00:00Z', 'tracking start = first tracked invoice');

    await page.evaluate(() => SouliaBundleStats.renderReport('', ''));
    const card = await page.$eval('#rep-bundles-section', (e) => e.textContent);
    ok(card.includes('أداء الباقات') && card.includes('blanket with boho basket') && card.includes('Bow dining offer'), 'report card lists both kinds');
    ok(card.includes('أقل من البيع المنفرد بـ') && card.includes('2.5'), 'the margin gap to separate sales is stated (2.5 pts lower)');
    ok(card.includes('تُحتسب من'), 'the card says from when smart bundles are counted');
    ok(card.includes('فُكّت') && !card.includes('اتفكّت'), 'standard Arabic wording');
    ok(await page.$$eval('#rep-bundles-section .ba-tbl th', (t) => t.some((x) => x.textContent === 'الربح')), 'admin sees cost, profit and margin');

    // staff without purchase prices: no cost columns
    await page.evaluate(() => { currentUser = { role: 'staff', perms: ['reports'] }; SouliaBundleStats.renderReport('', ''); });
    ok(await page.$$eval('#rep-bundles-section .ba-tbl th', (t) => !t.some((x) => ['التكلفة', 'الربح', 'الهامش'].includes(x.textContent))), 'staff without purchase prices: no cost / profit / margin');
    await page.evaluate(() => { currentUser = { role: 'admin', perms: [] }; });

    // period filter
    const p = await page.evaluate(() => SouliaBundleStats.compute('2026-11-11', '2026-11-11').shopify[0]);
    ok(p.invoices === 1 && p.revenue === 3000, 'a date range counts only its own invoices');

    // promotions-style clickable table → invoices window → order
    await page.evaluate(() => { qs('#promo-host').innerHTML = SouliaBundleStats.shopifyTableHtml(SouliaBundleStats.compute('', '').shopify, { clickable: true }); });
    await page.click('#promo-host [data-ba-open]');
    ok(await page.$$eval('#modal-content [data-ba-tx]', (r) => r.length === 2), 'clicking a bundle lists its 2 invoices');
    await page.click('#modal-content [data-ba-tx]');
    ok(await page.evaluate(() => opened[0] === 't2'), 'an invoice row opens that order (newest first)');

    // English + dark + phone
    await page.evaluate(() => { currentLang = 'en'; document.documentElement.dir = 'ltr'; document.body.classList.add('dark-mode'); SouliaBundleStats.renderReport('', ''); });
    ok(await page.$eval('#rep-bundles-section', (e) => e.textContent.includes('Bundle performance') && e.textContent.includes('below separate sales by')), 'English labels');
    await page.setViewport({ width: 390, height: 844 });
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '390px: the page does not scroll sideways (the table scrolls in its box)');
    ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log('\nAll bundle-analytics browser checks passed');
  } catch (e) {
    console.error('✗', e.message); process.exitCode = 1;
  } finally { await browser.close(); }
})();
