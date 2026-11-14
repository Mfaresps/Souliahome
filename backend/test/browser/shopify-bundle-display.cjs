// Shopify bundles (Phase 2) on every screen that lists an order's lines — over the SHIPPED index.html,
// full app, API mocked. Invented data shaped like the real #3146 (two parts priced at their share of 3000).
//   node test/browser/shopify-bundle-display.cjs
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const PUB = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/shopify-bundle-display');
fs.mkdirSync(output, { recursive: true });

const parts = [
  { productId: 'p1', code: 'Code 10', name: 'Boho Charm Basket L', qty: 1, price: 1302.75, total: 1302.75, shopifyPrice: 1302.75, shopifyLineId: '1001', bundleGroupId: 'g1', priceBasis: 'bundle', listPrice: 1420 },
  { productId: 'p2', code: 'HEARTH-1', name: 'Hearth Blanket Throw', qty: 1, price: 1697.25, total: 1697.25, shopifyPrice: 1697.25, shopifyLineId: '1002', bundleGroupId: 'g1', priceBasis: 'bundle', listPrice: 1850 },
];
const single = { productId: 'p3', code: 'SOLO', name: 'Solo Cushion', qty: 1, price: 500, total: 500 };
const group = { groupId: 'g1', title: 'blanket with boho basket', quantity: 1, allocatedTotal: 3000, components: [] };
const base = { type: 'مبيعات', client: 'عميل تجربة', date: '2026-11-13', createdAt: '2026-11-13T10:00:00Z', itemsTotal: 3500, shipCost: 0, discount: 0,
  total: 3500, deposit: 0, remaining: 3500, payStatus: 'معلق', source: 'shopify', shopifyOrderId: '777', _fullyHydrated: true };
const saleVerified = { ...base, _id: 'tx-b1', ref: '9101', items: [...parts, single], bundleSnapshot: { verified: true, groups: [group] } };
const saleUnverified = { ...base, _id: 'tx-b2', ref: '9102', items: [...parts, single], bundleSnapshot: { verified: false, unverifiable: true, groups: [{ ...group, title: null, quantity: null }] } };
const plainSale = { ...base, _id: 'tx-p', ref: '9103', items: [single], itemsTotal: 500, total: 500, remaining: 500 };
const pendingOrder = { _id: 'so-1', ref: '9104', status: 'pending', items: [...parts, single], itemsTotal: 3500, total: 3500, shipCost: 0, discount: 0,
  shopifyCreatedAt: '2026-11-13T10:00:00Z', bundleCurrent: { verified: false, groups: [{ ...group, title: null, quantity: null }] } };
const products = [{ _id: 'p1', code: 'Code 10', name: 'Boho Charm Basket L', sellPrice: 1420, buyPrice: 500 },
  { _id: 'p2', code: 'HEARTH-1', name: 'Hearth Blanket Throw', sellPrice: 1850, buyPrice: 423 }, { _id: 'p3', code: 'SOLO', name: 'Solo Cushion', sellPrice: 500, buyPrice: 200 }];

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
      const txById = { 'tx-b1': saleVerified, 'tx-b2': saleUnverified, 'tx-p': plainSale };
      const txm = /\/api\/transactions\/(tx-[a-z0-9]+)$/.exec(url.pathname);
      if (txm && txById[txm[1]] && request.method() === 'GET') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(txById[txm[1]]) });
      if (/\/api\/transactions\/tx-[a-z0-9]+\/lock$/.test(url.pathname)) return request.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      if (url.pathname === '/config.js') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.BACKEND_URL="http://soulia.test/api";' });
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'application/json', body: request.resourceType() === 'stylesheet' ? '' : '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((d) => {
      currentUser = { _id: 'admin', role: 'admin', perms: [], name: 'Admin' };
      transactions = d.txs; products = d.products; _shopifyOrders = [d.order]; inventoryCache = d.products.map(p => ({ ...p, current: 10 }));
    }, { txs: [saleVerified, saleUnverified, plainSale], products, order: pendingOrder });

    for (const lang of ['ar', 'en']) {
      console.log('— ' + lang);
      const r = await page.evaluate((lang) => {
        currentLang = lang;
        const tx = id => transactions.find(x => x._id === id);
        const pageOf = (t1) => { window._invoiceViewTxId = t1._id; window._invoiceViewRef = t1.ref; renderInvoiceViewPage(); const el = document.querySelector('#inv-view-content');
          return { heads: [...el.querySelectorAll('.inv2-bundle-head')].map(x => x.textContent.replace(/\s+/g, ' ').trim()), parts: el.querySelectorAll('.inv2-line.is-bundle-part').length, lines: el.querySelectorAll('.inv2-line').length }; };
        const modalOf = (t1) => { showInvoiceDetail(t1._id); const el = document.querySelector('#inv-detail-content');
          return { heads: [...el.querySelectorAll('.inv-bundle-head')].map(x => x.textContent.replace(/\s+/g, ' ').trim()), parts: el.querySelectorAll('tr.is-bundle-part').length }; };
        const out = { label: t('bdlBundle'), unver: t('bdlUnverifiable'), pend: t('bdlPending') };
        out.pageV = pageOf(tx('tx-b1')); out.pageU = pageOf(tx('tx-b2')); out.pageP = pageOf(tx('tx-p'));
        out.modalV = modalOf(tx('tx-b1')); out.modalP = modalOf(tx('tx-p'));
        out.printV = buildInvoiceHtml(tx('tx-b1')); out.printU = buildInvoiceHtml(tx('tx-b2')); out.printP = buildInvoiceHtml(tx('tx-p'));
        out.peek = _spPeekHtml(_shopifyOrders[0]);
        return out;
      }, lang);
      ok(r.pageV.heads.length === 1 && r.pageV.heads[0].includes('blanket with boho basket') && /3,000/.test(r.pageV.heads[0]), `invoice page: one bundle heading with its name and total (${r.pageV.heads[0]})`);
      ok(r.pageV.parts === 2 && r.pageV.lines === 3, 'invoice page: the two parts are marked, the single item is not');
      ok(r.pageU.heads[0].includes(r.unver), 'invoice page: an unverified sale says «Unverifiable Bundle Composition»');
      ok(r.pageP.heads.length === 0 && r.pageP.parts === 0, 'invoice page: an order without a bundle is unchanged');
      ok(r.modalV.heads.length === 1 && r.modalV.parts === 2 && r.modalP.heads.length === 0, 'invoice window: heading + marked parts only for the bundle');
      ok(r.printV.includes('باقة: blanket with boho basket') && !r.printP.includes('iv-bundle'), 'printed invoice: bundle row only when there is one');
      ok(r.printU.includes('تكوين الباقة غير قابل للتحقق'), 'printed invoice: unverified composition stated');
      ok(r.peek.includes('sp-bundle-head') && r.peek.includes(r.pend), 'quick view: pending order shows the bundle awaiting Shopify verification');
    }

    // Shopify items popover and edit window on the pending order.
    const sp = await page.evaluate(async () => {
      currentLang = 'ar';
      let pop = '';
      try { showSpItemsPopover('so-1', document.body); pop = (document.querySelector('.mov-items-popover') || {}).innerHTML || ''; } catch (e) { pop = 'ERR ' + e.message; }
      let edit = '';
      try { await editShopifyOrder('so-1'); edit = [...document.querySelectorAll('.sp-bundle-head, .sp-edit-item-row')].map(el => el.outerHTML.slice(0, 120)).join(' | '); } catch (e) { edit = 'ERR ' + e.message; }
      return { pop, edit };
    });
    ok(sp.pop.includes('sp-bundle-head') && sp.pop.includes('is-bundle-part'), 'items popover: bundle heading and marked parts');
    ok(!/سعر مختلف/.test(sp.pop), 'items popover: no «price differs» flag on bundle parts');
    ok(!sp.edit.startsWith('ERR') && sp.edit.includes('sp-bundle-head') && sp.edit.includes('is-bundle-part'), 'edit window: bundle heading and marked parts' + (sp.edit.startsWith('ERR') ? ' — ' + sp.edit : ''));

    // Lists: a violet «باقة» mark on the items cell — only on orders that hold a bundle.
    const lists = await page.evaluate(() => {
      currentLang = 'ar';
      const tx = id => transactions.find(x => x._id === id);
      const movPop = _movItemsDetailHtml(tx('tx-b1'));
      let editHtml = '';
      const ed = [...document.querySelectorAll('.sp-bundle-head')].find(h => h.nextElementSibling && h.nextElementSibling.classList.contains('sp-edit-item-row'));
      if (ed) editHtml = ed.outerHTML;
      return {
        movB: _movItemsCell(tx('tx-b1')), movP: _movItemsCell(tx('tx-p')),
        spB: _spItemsCell(_shopifyOrders[0]), spP: _spItemsCell({ ..._shopifyOrders[0], _id: 'so-x', items: [_shopifyOrders[0].items[2]] }),
        movPop, editHtml,
      };
    });
    ok(lists.movB.includes('bdl-mark') && !lists.movP.includes('bdl-mark'), 'Movements list: «باقة» mark only on the order with a bundle');
    ok(lists.spB.includes('bdl-mark') && !lists.spP.includes('bdl-mark'), 'Shopify list: «باقة» mark only on the order with a bundle');
    ok(/title="[^"]*blanket with boho basket/.test(lists.movB), 'list mark names the bundle in its tooltip');
    ok(lists.movPop.includes('mid-bundle-head') && (lists.movPop.match(/is-bundle-part/g) || []).length === 2, 'Movements items popover: bundle heading + 2 marked parts');
    ok(lists.editHtml.includes('bdl-lock'), 'edit window: the bundle states what is locked and what breaks it');

    // Invoice edit window (سجل المعاملات) — same bundle rules as the Shopify edit window.
    const ed = await page.evaluate(async () => {
      currentLang = 'ar';
      const out = {};
      try { await openEditMovement('tx-b1'); } catch (e) { out.err = e.message; }
      for (let i = 0; i < 20 && !document.querySelector('#edit-tx-items .tx-item-card'); i++) await new Promise(r => setTimeout(r, 100));
      const box = document.querySelector('#edit-tx-items');
      out.boxLen = box ? box.innerHTML.length : -1; out.cards = box ? box.querySelectorAll('.tx-item-card').length : -1; out.cls = box ? [...box.querySelectorAll('.tx-item-card')].map(c => c.className).join('|') : '';
      out.head = !!box?.querySelector('.tx-bundle-head .bdl-lock');
      out.parts = box ? box.querySelectorAll('.tx-item-card.is-bundle-part').length : -1;
      out.locked = box ? [...box.querySelectorAll('.tx-item-card.is-bundle-part input')].every(i => i.readOnly) : false;
      out.note = !!box?.querySelector('.sp-bundle-disc-note');
      out.lineIds = editTxItems.filter(x => x.bundleGroupId).map(x => x.lineId || x.shopifyLineId).filter(Boolean).length;
      adjustEditTxItemQty(0, 1);   // + on a part → a separate line at the normal price
      out.afterPlus = editTxItems.map(x => [x.code, x.qty, x.price, !!x.bundleGroupId]);
      // − on a part asks first; answer «cancel» → nothing changes
      const realConfirm = window.showConfirm; let asked = 0;
      window.showConfirm = async () => { asked++; return false; };
      await _editBreakBundle(0, 0);
      out.askedCancel = asked; out.stillBundle = editTxItems.filter(x => x.bundleGroupId).length;
      window.showConfirm = async () => { asked++; return true; };
      await _editBreakBundle(0, 0);
      window.showConfirm = realConfirm;
      out.afterBreak = editTxItems.map(x => [x.code, x.price, !!x.bundleGroupId]);
      out.confirmFlag = _editConfirmBreak;
      try { closeModal(); } catch (_) {}
      // Movements items popover
      const btn = document.createElement('button'); document.body.appendChild(btn);
      document.querySelectorAll('.mov-items-popover').forEach(x => x.remove());
      try { showMovItemsPopover('tx-b1', btn); } catch (e) { out.popErr = e.message; }
      const pop = [...document.querySelectorAll('.mov-items-popover')].pop();
      out.popHead = !!pop?.querySelector('.mid-bundle-head');
      out.popWas = pop ? pop.querySelectorAll('.bdl-was').length : 0;
      try { _closeMovItemsPopover(); } catch (_) {}
      // summary groups
      const os = _offerSummaryOf(transactions.find(x => x._id === 'tx-b1').items, undefined, undefined, transactions.find(x => x._id === 'tx-b1'));
      out.sum = os && { before: os.before, saved: os.saved, bundle: os.hasBundle, name: os.groups[0]?.name, label: _sumBeforeLabel(os) };
      return out;
    });
    ok(!ed.err && ed.head && ed.parts === 2 && ed.locked, 'invoice edit window: bundle heading with the lock line, 2 parts, price and qty locked ' + JSON.stringify({ err: ed.err, head: ed.head, parts: ed.parts, locked: ed.locked, ids: ed.lineIds, boxLen: ed.boxLen, cards: ed.cards, cls: ed.cls }));
    ok(ed.note, 'invoice edit window: the discount note (outside the bundle only)');
    ok(ed.lineIds === 2, 'invoice edit window: each part keeps its line id (the server matches it)');
    ok(JSON.stringify(ed.afterPlus) === JSON.stringify([['Code 10', 1, 1302.75, true], ['HEARTH-1', 1, 1697.25, true], ['SOLO', 1, 500, false], ['Code 10', 1, 1420, false]]),
      '+ on a part adds a separate line at the normal price ' + JSON.stringify(ed.afterPlus));
    ok(ed.askedCancel === 1 && ed.stillBundle === 2, '− on a part asks first; cancelling changes nothing');
    ok(ed.confirmFlag && ed.afterBreak.every(r => !r[2]) && ed.afterBreak.some(r => r[0] === 'HEARTH-1' && r[1] === 1850), 'confirmed break reprices the rest at its own price and flags the confirmation ' + JSON.stringify(ed.afterBreak));
    ok(ed.popHead && ed.popWas === 2, 'Movements items popover: bundle heading and the struck own price on both parts ' + JSON.stringify({ h: ed.popHead, w: ed.popWas, e: ed.popErr }));
    ok(ed.sum && ed.sum.bundle && ed.sum.saved === 270 && ed.sum.before === 3770 && ed.sum.name === 'blanket with boho basket' && ed.sum.label === 'الأصناف قبل الباقة',
      'order summary: «الأصناف قبل الباقة» + the bundle savings by name ' + JSON.stringify(ed.sum));

    // Screenshots: list cells, items popover and edit-window heading, light + dark.
    for (const dark of [false, true]) {
      await page.setViewport({ width: 760, height: 900 });
      await page.evaluate(({ dark, l }) => {
        document.documentElement.dir = 'rtl'; document.body.classList.toggle('dark-mode', dark);
        let box = document.querySelector('#bdl-preview');
        if (!box) { box = document.createElement('main'); box.id = 'bdl-preview'; document.body.appendChild(box); }
        [...document.body.children].forEach(el => { if (el !== box && !['STYLE', 'SCRIPT', 'LINK'].includes(el.tagName)) el.style.display = 'none'; });
        box.style.cssText = 'display:block;padding:16px;max-width:720px;margin:auto;background:var(--bg,#fff);color:var(--text);box-sizing:border-box;width:100%;font-family:inherit';
        box.innerHTML = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">' + l.movB + l.movP + l.spB + '</div>'
          + '<div class="mov-items-popover" style="position:static;display:block;max-height:none;margin-bottom:14px;width:420px">' + l.movPop + '</div>'
          + '<div style="width:520px">' + l.editHtml + '</div>';
      }, { dark, l: lists });
      const el = await page.$('#bdl-preview');
      if (el) await el.screenshot({ path: path.join(output, `lists-ar${dark ? '-dark' : ''}.png`) });
    }

    for (const [lang, width, dark] of [['ar', 1440, false], ['en', 390, false], ['ar', 390, true]]) {
      await page.setViewport({ width, height: 900 });
      const lay = await page.evaluate(({ lang, dark }) => {
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; document.body.classList.toggle('dark-mode', dark);
        const t1 = transactions.find(x => x._id === 'tx-b1');
        window._invoiceViewTxId = t1._id; window._invoiceViewRef = t1.ref;
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.querySelector('#page-invoice-view').classList.add('active');
        document.querySelectorAll('.modal-overlay.active, #inv-detail-overlay.active').forEach(el => el.classList.remove('active'));
        renderInvoiceViewPage();
        // The app shell is hidden (no login in this harness): show the rendered invoice in a visible box.
        let box = document.querySelector('#bdl-preview');
        if (!box) { box = document.createElement('main'); box.id = 'bdl-preview'; document.body.appendChild(box); }
        [...document.body.children].forEach(el => { if (el !== box && !['STYLE', 'SCRIPT', 'LINK'].includes(el.tagName)) el.style.display = 'none'; });
        box.style.cssText = 'display:block;padding:16px;max-width:1100px;margin:auto;background:var(--bg,#fff);box-sizing:border-box;width:100%';
        box.innerHTML = '<div class="inv2-card"><div class="inv2-card-body inv2-items" style="padding:0">' + document.querySelector('#inv-view-content .inv2-items').innerHTML + '</div></div>';
        const head = box.querySelector('.inv2-bundle-head');
        window.scrollTo(0, 0);
        return { overflow: document.documentElement.scrollWidth > window.innerWidth + 1 || box.scrollWidth > box.clientWidth + 1, shown: !!head && head.getBoundingClientRect().width > 0 };
      }, { lang, dark });
      ok(lay.shown && !lay.overflow, `invoice page ${lang}/${width}${dark ? '/dark' : ''}: bundle heading visible, no horizontal overflow`);
      const el = await page.$('#bdl-preview');
      if (el) await el.screenshot({ path: path.join(output, `invoice-${lang}-${width}${dark ? '-dark' : ''}.png`) });
    }
    ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) { failed = true; console.error('✗', e.message); }
  finally { await browser.close(); }
  process.exit(failed ? 1 : 0);
})();
