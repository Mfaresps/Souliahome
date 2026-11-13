// Shipping discount (free shipping) on every screen that shows a sale — over the SHIPPED index.html,
// with the full app loaded and the API mocked. Invented data only.
//   node test/browser/shipping-discount-display.cjs
// Checks: the order WITHOUT a shipping discount renders as it always did; WITH one, free shipping is
// its own line, the product discount excludes it, and every total, refund and profit stays right.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const PUB = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/shipping-discount-display');
fs.mkdirSync(output, { recursive: true });

const base = { type: 'مبيعات', client: 'عميل تجربة', phone: '01000000000', date: '2026-11-10', createdAt: '2026-11-10T10:00:00Z',
  items: [{ productId: 'p1', code: 'T-1', name: 'Test Basket', qty: 1, price: 1302.75, total: 1302.75 },
    { productId: 'p2', code: 'T-2', name: 'Test Blanket', qty: 1, price: 1697.25, total: 1697.25 }],
  itemsTotal: 3000, shipCost: 120, discount: 120, total: 3000, deposit: 0, remaining: 3000, payStatus: 'معلق',
  shopifyOrderId: '999', source: 'shopify', _fullyHydrated: true };
const plain = { ...base, _id: 'tx-plain', ref: '9001' };                                   // as stored today
const free = { ...base, _id: 'tx-free', ref: '9002', shippingDiscount: 120, shippingDiscountSource: 'order' };
const mixed = { ...base, _id: 'tx-mixed', ref: '9003', discount: 220, total: 2900, remaining: 2900,
  shippingDiscount: 120, shippingDiscountSource: 'order' };                                // 100 product + 120 shipping
const products = [{ _id: 'p1', code: 'T-1', name: 'Test Basket', sellPrice: 1420, buyPrice: 500 },
  { _id: 'p2', code: 'T-2', name: 'Test Blanket', sellPrice: 1850, buyPrice: 423 }];

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
  let failed = false;
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
      // The invoice edit window loads the full record and takes the edit lock first.
      const txm = /\/transactions\/(tx-[a-z]+)(\/lock)?$/.exec(url.pathname);
      if (txm) return request.respond({ status: 200, contentType: 'application/json',
        body: JSON.stringify(txm[2] ? { success: true } : [plain, free, mixed].find(x => x._id === txm[1])) });
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'application/json', body: request.resourceType() === 'stylesheet' ? '' : '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((data) => {
      currentUser = { _id: 'admin', role: 'admin', perms: [], name: 'Admin' };
      transactions = data.txs; products = data.products; _shopifyOrders = [];
    }, { txs: [plain, free, mixed], products });

    for (const lang of ['ar', 'en']) {
      console.log(`— ${lang}`);
      const r = await page.evaluate((lang) => {
        currentLang = lang;
        const freeLabel = t('sdFreeShipping');
        const text = (sel) => (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ');
        const pageOf = (tx) => { window._invoiceViewTxId = tx._id; window._invoiceViewRef = tx.ref; renderInvoiceViewPage();
          const row = document.querySelector('#inv-view-content .is-ship-disc'); return { rows: document.querySelectorAll('#inv-view-content .is-ship-disc').length, row: row ? row.textContent.replace(/\s+/g, ' ') : '', all: text('#inv-view-content') }; };
        const modalOf = (tx) => { showInvoiceDetail(tx._id); return document.querySelectorAll('#inv-detail-content .is-ship-disc').length; };
        const grand = () => text('.inv2-sum-total .inv2-sum-v');
        const tx = (id) => transactions.find(x => x._id === id);
        const out = { freeLabel };
        out.pagePlain = pageOf(tx('tx-plain')); out.grandPlain = grand();
        out.pageFree = pageOf(tx('tx-free')); out.grandFree = grand();
        out.pageMixed = pageOf(tx('tx-mixed'));
        out.modalPlain = modalOf(tx('tx-plain')); out.modalFree = modalOf(tx('tx-free'));
        out.printPlain = buildInvoiceHtml(tx('tx-plain')); out.printFree = buildInvoiceHtml(tx('tx-free'));
        out.badgePlain = _movDiscountBadge(tx('tx-plain')); out.badgeFree = _movDiscountBadge(tx('tx-free')); out.badgeMixed = _movDiscountBadge(tx('tx-mixed'));
        const refund = (t1) => { selectedRetTxId = t1._id; selectedRetItems = t1.items.map(i => ({ ...i, selected: true, retQty: i.qty, condition: 'سليم' })); return getRetRefundCeiling(); };
        out.refundPlain = refund(tx('tx-plain')); out.refundFree = refund(tx('tx-free'));
        const profit = (ids) => { selectedMovIds = new Set(ids); openProfitAnalysis(); return { sum: _paData.reduce((s, r) => s + r.netProfit, 0), head: text('#pa-detail-table thead'), cards: text('#pa-summary-cards') }; };
        out.profitPlain = profit(['tx-plain']); out.profitFree = profit(['tx-free']); out.profitPlainAgain = profit(['tx-plain']);
        closeProfitAnalysis();
        out.spPlain = _spTotalDiscount(tx('tx-plain')); out.spFree = _spTotalDiscount(tx('tx-free'));
        const sheets = _xpTxSheets([tx('tx-plain'), tx('tx-free')]);
        out.xlsHeader = sheets[0].header; out.xlsRows = sheets[0].rows;
        return out;
      }, lang);

      ok(r.pagePlain.rows === 0, 'invoice page: an order without a shipping discount has no free-shipping line');
      ok(r.pageFree.rows === 1 && r.pageFree.row.includes(r.freeLabel) && r.pageFree.row.includes('120'), `invoice page: free shipping is its own line (${r.pageFree.row.trim()})`);
      ok(r.grandPlain === r.grandFree, `invoice page: grand total unchanged (${r.grandFree})`);
      ok(r.pageMixed.rows === 1 && /100/.test(r.pageMixed.all), 'invoice page: product discount 100 + free shipping 120 shown apart');
      ok(r.modalPlain === 0 && r.modalFree === 1, 'invoice window: free-shipping line only when there is one');
      ok(!r.printPlain.includes('شحن مجاني') && r.printFree.includes('شحن مجاني'), 'printed invoice: free-shipping line only when there is one');
      ok(!/الخصم/.test(r.printFree.split('iv-tot')[1]?.split('iv-pay')[0] || ''), 'printed invoice: no product-discount line when the whole discount is shipping');
      ok(r.badgePlain !== '<span style="color:var(--muted)">—</span>', 'Movements badge: unchanged for the old row');
      ok(r.badgeFree.includes('—'), 'Movements badge: free shipping alone is not a discount badge');
      ok(/−?\s*100|100/.test(r.badgeMixed), 'Movements badge: shows the product discount only');
      ok(Math.abs(r.refundFree.itemsValue - 3000) < 0.01, 'refund cap: full items value with free shipping');
      ok(r.profitPlain.sum.toFixed(2) === r.profitFree.sum.toFixed(2), `profit analysis: net profit identical (${r.profitFree.sum.toFixed(2)})`);
      ok(r.profitFree.head.includes(r.freeLabel === 'Free shipping' ? 'Shipping subsidy' : 'دعم الشحن'), 'profit analysis: subsidy column appears with a subsidy');
      ok(!r.profitPlainAgain.head.includes(r.freeLabel === 'Free shipping' ? 'Shipping subsidy' : 'دعم الشحن'), 'profit analysis: subsidy column removed again without one');
      ok(r.spPlain === 120 && r.spFree === 0, 'Shopify discount badge: shipping excluded only when classified');
      const iSd = r.xlsHeader.indexOf('خصم الشحن'), iSc = r.xlsHeader.indexOf('الشحن المحصَّل'), iD = r.xlsHeader.indexOf('الخصم');
      ok(iSd > 0 && iSc > 0, 'Excel export: shipping discount and shipping collected columns');
      ok(r.xlsRows[0][iD] === 120 && r.xlsRows[0][iSd] === 0 && r.xlsRows[0][iSc] === 120, 'Excel export: old row = discount 120, shipping discount 0, collected 120');
      ok(r.xlsRows[1][iD] === 0 && r.xlsRows[1][iSd] === 120 && r.xlsRows[1][iSc] === 0, 'Excel export: classified row = discount 0, shipping discount 120, collected 0');

      // Refund cap: the old row still subtracts the stored 120 (unchanged); the classified one does not.
      const caps = await page.evaluate(() => {
        const cap = (id) => { const t1 = transactions.find(x => x._id === id); selectedRetTxId = id; selectedRetItems = t1.items.map(i => ({ ...i, selected: true, retQty: i.qty, condition: 'سليم' })); return getRetRefundCeiling(); };
        return { plain: cap('tx-plain'), free: cap('tx-free') };
      });
      ok(JSON.stringify(caps.plain) !== JSON.stringify(caps.free), `refund cap: differs only through the shipping part (${JSON.stringify(caps.plain).slice(0, 60)} vs ${JSON.stringify(caps.free).slice(0, 60)})`);
    }

    // Invoice edit window: removing the manual discount keeps the free shipping inside the discount.
    const edit = await page.evaluate(async () => {
      currentLang = 'ar';
      await openEditMovement('tx-free');
      const before = Number(document.querySelector('#edit-tx-discount')?.value);
      removeEditSummaryManualDisc();
      const afterManual = Number(document.querySelector('#edit-tx-discount')?.value);
      removeEditDiscount();
      const afterAll = Number(document.querySelector('#edit-tx-discount')?.value);
      const summary = (document.querySelector('#edit-tx-summary') || document.querySelector('[id^="edit-tx-sum"]') || document.body).textContent;
      if (typeof closeModal === 'function') closeModal();
      return { before, afterManual, afterAll, editShipDiscount, summaryHasFree: summary.includes('شحن مجاني') };
    });
    ok(edit.editShipDiscount === 120, 'edit window: free shipping recorded when the window opens');
    ok(edit.before === 120 && edit.afterManual === 120 && edit.afterAll === 120, `edit window: free shipping survives removing manual/all discounts (${edit.before}/${edit.afterManual}/${edit.afterAll})`);

    // Reports: the «Products & shipping» group, its note, and layout at phone width in both themes.
    for (const [lang, width, dark] of [['ar', 1440, false], ['en', 390, false], ['ar', 390, true]]) {
      await page.setViewport({ width, height: 900 });
      const rep = await page.evaluate(({ lang, dark }) => {
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.body.classList.toggle('dark-mode', dark);
        let host = document.querySelector('#rep-stats');
        if (!host) { host = document.createElement('div'); host.id = 'rep-stats'; document.body.appendChild(host); }
        [...document.body.children].forEach(el => { if (el !== host && !['STYLE', 'SCRIPT', 'LINK'].includes(el.tagName) && !el.contains(host)) el.style.display = 'none'; });
        let p = host.parentElement; while (p && p !== document.body) { p.style.display = ''; p.classList.add('active'); p = p.parentElement; }
        renderReportKPIs({ totalSales: 900000, productRevenue: 958000, productDiscounts: 11365, shippingCollected: 266, totalShipping: 266,
          shippingSubsidy: 38400, shippingSubsidyOrders: 305, actualCarrierCost: { amount: 22800, known: 200, of: 702, returnLegFees: 0 },
          grossProfit: 581243, netProfit: 400000, totalShipLoss: 0, totalDiscounts: 11365,
          shippingClassification: { effectiveAt: '2026-11-20T08:00:00Z', classifiedOnConfirm: 0, classifiedByCorrection: 0, historyCorrected: false } });
        const txt = host.textContent.replace(/\s+/g, ' ');
        host.scrollIntoView();
        return { txt, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, cards: host.querySelectorAll('[class*="rep-kpi-card--rep_shipsubsidy"],[class*="rep-kpi-card--rep_carriercost"],[class*="rep-kpi-card--rep_prodrevenue"],[class*="rep-kpi-card--rep_proddisc"]').length };
      }, { lang, dark });
      ok(rep.cards === 4, `reports ${lang}/${width}${dark ? '/dark' : ''}: four product & shipping cards`);
      ok(rep.txt.includes(lang === 'en' ? 'known for 200 of 702 orders' : 'معروفة لـ 200 من 702 طلب'), `reports ${lang}: carrier cost states its coverage`);
      ok(rep.txt.includes(lang === 'en' ? 'applied since' : 'مطبَّق منذ'), `reports ${lang}: effective date shown`);
      ok(!rep.overflow, `reports ${lang}/${width}: no horizontal overflow`);
      const group = await page.$('.rep-kpi-section--split');
      if (group) await group.screenshot({ path: path.join(output, `reports-${lang}-${width}${dark ? '-dark' : ''}.png`) });
    }
    ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) {
    failed = true; console.error('✗', e.message);
  } finally { await browser.close(); }
  process.exit(failed ? 1 : 0);
})();
