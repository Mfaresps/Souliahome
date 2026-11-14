// Invoice window (showInvoiceDetail) — height budget and layout. Shipped index.html, API mocked.
//   node test/browser/invoice-window-compact.cjs [--measure]
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const PUB = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/invoice-window-compact');
fs.mkdirSync(output, { recursive: true });
const MEASURE = process.argv.includes('--measure');

const parts = [
  { productId: 'p1', code: 'Code 05', name: 'Terra Red Basket XL', qty: 1, price: 1200.58, total: 1200.58, listPrice: 1420, bundleGroupId: 'g1', priceBasis: 'bundle', lineId: 'sh:1' },
  { productId: 'p2', code: 'Code 06', name: 'Terra Red Basket M', qty: 1, price: 1056.85, total: 1056.85, listPrice: 1250, bundleGroupId: 'g1', priceBasis: 'bundle', lineId: 'sh:2' },
  { productId: 'p3', code: 'Code 07', name: 'Terra Red Basket S', qty: 1, price: 642.57, total: 642.57, listPrice: 760, bundleGroupId: 'g1', priceBasis: 'bundle', lineId: 'sh:3' },
];
const tx = { _id: 'tx-1', type: 'مبيعات', ref: '3148', client: 'طلب تجريبي — باقة', phone: '1000000000', date: '2026-11-14', createdAt: '2026-11-14T14:02:00Z',
  items: parts, itemsTotal: 2900, discount: 0, shipCost: 120, total: 3020, deposit: 0, remaining: 3020, payStatus: 'معلق', payment: 'كاش',
  shipCo: 'Bosta', carrierCode: 'bosta', shippingCity: 'Cairo', shippingAddress: 'عنوان تجريبي', pickupStatus: 'Preparing', employee: 'Souliahome',
  notes: 'طلب تجريبي لعرض الباقة — احذفه بعد المراجعة', shopifyOrderId: '9990000003148', _fullyHydrated: true,
  bundleSnapshot: { verified: true, groups: [{ groupId: 'g1', title: 'طقم سلال Terra Red (3 مقاسات)', quantity: 1, allocatedTotal: 2900, components: [] }] } };
const plain = { ...tx, _id: 'tx-2', ref: '3149', items: [{ productId: 'p9', code: 'Code 02', name: 'Geo Basket', qty: 2, price: 1872, total: 3744 }], bundleSnapshot: null,
  itemsTotal: 3744, total: 3864, deposit: 500, remaining: 3364, depMethod: 'Instapay', notes: '', discount: 0 };

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
      if (url.origin === 'http://soulia.test' && /\.(js|css|svg|png)$/.test(url.pathname) && fs.existsSync(local))
        return request.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.svg') ? 'image/svg+xml' : url.pathname.endsWith('.png') ? 'image/png' : 'text/javascript', body: fs.readFileSync(local) });
      if (url.pathname === '/config.js') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.BACKEND_URL="http://soulia.test/api";' });
      const m = /\/api\/transactions\/(tx-\d)$/.exec(url.pathname);
      if (m) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(m[1] === 'tx-1' ? tx : plain) });
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'application/json', body: request.resourceType() === 'stylesheet' ? '' : '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((d) => {
      currentUser = { _id: 'u-admin', role: 'admin', perms: [], name: 'Souliahome' };
      transactions = d.txs; products = d.txs[0].items.map(i => ({ _id: i.productId, code: i.code, name: i.name, sellPrice: i.listPrice }));
      [...document.body.children].forEach(el => { if (el.id !== 'modal-overlay' && el.id !== 'inv-detail-overlay' && !['STYLE','SCRIPT','LINK'].includes(el.tagName)) el.style.display = 'none'; });
    }, { txs: [tx, plain] });

    const shoot = async (id, lang, width, dark, name) => {
      await page.setViewport({ width, height: 1000 });
      return page.evaluate(async ({ id, lang, dark }) => {
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr'; document.body.classList.toggle('dark-mode', dark);
        try { closeModal(); } catch (_) {}
        document.querySelectorAll('#inv-detail-overlay').forEach(o => o.classList.remove('active'));
        showInvoiceDetail(id);
        await new Promise(r => setTimeout(r, 1000));
        const host = document.querySelector('#inv-detail-content');
        const scroller = host ? ([host, ...host.querySelectorAll('*')].find(e => e.scrollHeight > e.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) || host) : null;
        const kids = host ? [...host.querySelectorAll(':scope > *, :scope > * > *')].map(c => ({ cls: (c.className || c.tagName).toString().slice(0, 40), h: Math.round(c.getBoundingClientRect().height) })) : [];
        const sections = {};
        for (const sel of ['.inv-title', '.inv-status-banner', '.inv-party-card', '.inv-items-table, table', '.inv-summary-section', '.inv-breakdown', '.fd-banner', '.inv-notes', '.inv-meta-chips']) {
          const e = host?.querySelector(sel); if (e) sections[sel] = Math.round(e.getBoundingClientRect().height);
        }
        const table = host?.querySelector('table');
        return { found: !!host, hostH: host ? Math.round(host.getBoundingClientRect().height) : 0, contentH: scroller ? scroller.scrollHeight : 0,
          hostW: host ? Math.round(host.getBoundingClientRect().width) : 0,
          nameW: host ? Math.min(...[...host.querySelectorAll('.inv-items-tbl tbody td.col-product')].map(td => Math.round(td.getBoundingClientRect().width))) : 0,
          textSpill: host ? [...host.querySelectorAll('.inv-items-tbl tbody td.col-product')].some(td => td.scrollWidth > td.clientWidth + 1) : false,
          cellSpill: host ? [...host.querySelectorAll('.inv-items-tbl td')].filter(td => getComputedStyle(td).display !== 'none' && getComputedStyle(td).visibility !== 'hidden').some(td => [...td.querySelectorAll('*')].some(e => { const a = e.getBoundingClientRect(), b = td.getBoundingClientRect(); return a.width > 0 && (a.right > b.right + 1 || a.left < b.left - 1); })) : false, tableOverflow: table ? table.scrollWidth - table.parentElement.clientWidth : 0,
          hscroll: !!host && [...host.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 2 && /(auto|scroll|hidden)/.test(getComputedStyle(e).overflowX) && e.closest('table, .inv-items, [class*="items"]')),
          kids, sections };
      }, { id, lang, dark });
    };

    const a = await shoot('tx-1', 'ar', 1440, false, 'ar-1440');
    if (MEASURE) { console.log(JSON.stringify(a, null, 1)); return; }
    const host = await page.$('#inv-detail-content');
    if (host) await host.screenshot({ path: path.join(output, 'bundle-ar-1440.png') });
    ok(a.found, 'the invoice window opens');
    ok(a.contentH <= 900, `content height for 3 bundle lines: ${a.contentH}px (≤ 900)`);
    ok(a.tableOverflow <= 1, `items table fits the window — no column cut off (overflow ${a.tableOverflow}px)`);
    for (const [id, lang, w, dark, name] of [['tx-1', 'en', 390, true, 'bundle-en-390-dark'], ['tx-2', 'ar', 1440, false, 'plain-ar-1440']]) {
      const r = await shoot(id, lang, w, dark, name);
      const el = await page.$('#inv-detail-content');
      if (el) await el.screenshot({ path: path.join(output, name + '.png') });
      ok(r.tableOverflow <= 1 && !r.cellSpill && r.nameW >= 110, `${name}: items table fits, product column ${r.nameW}px, nothing spills into its neighbour`);
    }
    const sync = await page.evaluate(async () => {
      currentLang = 'ar'; document.documentElement.dir = 'rtl'; document.body.classList.remove('dark-mode');
      document.querySelector('#inv-detail-overlay')?.classList.remove('active');
      const t1 = transactions.find(x => x._id === 'tx-1');
      window._invoiceViewTxId = t1._id; window._invoiceViewRef = t1.ref;
      document.querySelector('#page-invoice-view').classList.add('active');
      document.querySelector('#page-invoice-view').style.display = 'block';
      renderInvoiceViewPage();
      await new Promise(r => setTimeout(r, 400));
      const box = document.querySelector('#inv-view-content .ss-order');
      const side = box?.parentElement;
      return { found: !!box, inSide: !!side?.classList.contains('inv2-col-side'), last: side?.lastElementChild === box, h: box ? Math.round(box.getBoundingClientRect().height) : 0,
        top: !!document.querySelector('#inv-view-content > .ss-order') };
    });
    ok(sync.found && sync.inSide && sync.last && !sync.top && sync.h <= 34, `Shopify sync: one small line at the end of the side column, not on top (${sync.h}px)`);
    ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) { failed = true; console.error('✗', e.message); }
  finally { await browser.close(); }
  process.exit(failed ? 1 : 0);
})();
