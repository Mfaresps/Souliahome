const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const output = path.join(root, 'artifacts/order-status-filters');
fs.mkdirSync(output, { recursive: true });
const sale = { _id: 't1', ref: '2950', client: 'مريم نبيه', type: 'مبيعات', total: 1814,
  remaining: 1314, deposit: 500, payStatus: 'معلق', pickupStatus: 'Ready', shipCo: 'Bosta',
  bostaOrderId: 'b1', bostaStatus: 'CREATED', date: '2026-10-25', createdAt: '2026-10-25T17:12:00Z',
  items: [{ name: 'Runner', code: '37', qty: 1, price: 1814, total: 1814 }] };
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && ['/', '/invoice.html'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : 'invoice.html';
        return request.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(root, 'frontend/public', file), 'utf8') });
      }
      if (['/order-status.js', '/order-status.css', '/shopify-edit-approvals.js'].includes(url.pathname)) return request.respond({ status: 200,
        contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: fs.readFileSync(path.join(root, 'frontend/public', url.pathname.slice(1)), 'utf8') });
      if (url.origin === 'http://soulia.test' && url.pathname.endsWith('.css') && fs.existsSync(path.join(root, 'frontend/public', url.pathname.slice(1)))) return request.respond({ status: 200, contentType: 'text/css', body: fs.readFileSync(path.join(root, 'frontend/public', url.pathname.slice(1)), 'utf8') });
      if (url.pathname === '/config.js') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.BACKEND_URL="http://soulia.test/api";' });
      if (url.pathname.includes('/transactions/')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(sale) });
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'application/json', body: request.resourceType() === 'stylesheet' ? '' : '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    for (const lang of ['ar', 'en']) for (const width of [1440, 390, 320]) {
      await page.setViewport({ width, height: 1050 });
      const result = await page.evaluate(({ lang, sale }) => {
        currentLang = lang; currentUser = { _id: 'admin', role: 'admin', perms: [] };
        document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.documentElement.style.cssText = 'width:100%;min-width:0;overflow-x:hidden';
        document.body.style.cssText = 'display:block!important;position:static!important;min-width:0;width:100%;margin:0;padding:0;overflow-x:hidden';
        const ready = { ...sale }, moving = { ...sale, _id: 't2', ref: '2951', bostaStatus: 'IN_TRANSIT' };
        transactions = [ready, moving];
        _shopifyOrders = [{ _id: 's1', ref: '2952', status: 'pending', shipWithoutDeposit: true }];
        searchResults = [
          { id: 's1', type: 'shopify_order', title: '#2952', subtitle: 'Shopify — مريم نبيه', icon: '🛍️', total: 1814, itemsCount: 4 },
          { id: 's2', type: 'shopify_order', title: '#2953', subtitle: 'Shopify — Ahmed', icon: '🛍️', total: 2000, itemsCount: 2, orderState: { status: 'pending', depositReceipts: [{ status: 'معلق', amount: 500 }] } },
          ...transactions.map(tx => ({ id: tx._id, type: 'order', title: '#' + tx.ref, subtitle: 'مبيعات — ' + tx.client, icon: '📦', total: tx.total, itemsCount: 1 })),
        ];
        searchSelectedIdx = -1;
        let searchHtml = '';
        openSearchDropdown = html => { searchHtml = html; };
        renderSearchDropdown();
        let preview = document.querySelector('#state-preview');
        if (!preview) { preview = document.createElement('main'); preview.id = 'state-preview'; document.body.appendChild(preview); }
        [...document.body.children].forEach(el => { if (el !== preview && !['STYLE', 'SCRIPT', 'LINK'].includes(el.tagName)) el.style.display = 'none'; });
        preview.style.cssText = 'padding:16px;width:100%;box-sizing:border-box;max-width:1000px;margin:auto;background:var(--bg,#fff)';
        const title = lang === 'ar' ? 'حالات الأوردر' : 'Order status';
        const all = [
          _orderStateBadge({ status: 'pending' }, 'shopify'), _spPeekStatePill(_shopifyOrders[0]),
          ...['Pending','Preparing','Ready','Shipped','Delivered'].map(pickupStatus => _puStatusBadge(pickupStatus, { pickupStatus, shipCo: 'Bosta' })),
          ...['PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','FAILED_ATTEMPT','DELIVERY_FAILED','RETURNED','CANCELLED'].map(bostaStatus => _puStatusBadge('Shipped', { bostaStatus, hasShipment: true, shipCo: 'Bosta' })),
        ];
        preview.innerHTML = `<h2 style="font-size:20px">${title}</h2><div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px">${all.join('')}</div><section id="search-preview" style="border:1px solid var(--border);border-radius:16px;overflow:hidden">${searchHtml}</section><table style="width:100%;border-collapse:collapse;margin-top:24px"><tbody>${transactions.map(tx => `<tr><td style="padding:12px">#${tx.ref}</td><td>${_puStatusBadge(tx.pickupStatus, tx)}</td></tr>`).join('')}</tbody></table>`;
        const overflow = [...preview.querySelectorAll('.order-state')].some(el => el.scrollWidth > el.clientWidth + 1);
        const labels = [...preview.querySelectorAll('#search-preview .order-state')].map(el => el.textContent);
        const searchReady = preview.querySelector('#search-preview [data-order-state="Ready"]').outerHTML;
        const tableReady = preview.querySelector('table [data-order-state="Ready"]').outerHTML;
        window.scrollTo(0, 0);
        const bounds = preview.getBoundingClientRect();
        return { overflow: overflow || preview.scrollWidth > preview.clientWidth + 1, labels, equal: searchReady === tableReady, ready: tableReady,
          bounds: { left: bounds.left, right: bounds.right, viewport: window.innerWidth } };
      }, { lang, sale });
      assert.equal(result.overflow, false, `Badge text fits ${lang}/${width}`);
      assert.ok(result.bounds.left >= -1 && result.bounds.right <= width + 1, 'Preview fits viewport: ' + JSON.stringify({lang,width,...result.bounds}));
      assert.equal(result.equal, true, 'Search and table use identical state markup');
      assert.ok(result.labels[0].includes(lang === 'en' ? 'Confirmed' : 'مؤكّد'));
      assert.ok(result.labels[1].includes(lang === 'en' ? 'Unconfirmed' : 'بانتظار التأكيد'));
      await page.screenshot({ path: path.join(output, `${lang}-${width}.png`), fullPage: true });
      await page.evaluate(() => document.body.classList.add('dark-mode'));
      if (width === 390) await page.screenshot({ path: path.join(output, `${lang}-${width}-dark.png`), fullPage: true });
      await page.evaluate(() => document.body.classList.remove('dark-mode'));
    }
    for (const lang of ['en', 'ar']) {
      await page.setViewport({ width: 700, height: 720 });
      const geometry = await page.evaluate(({lang,sale}) => {
        currentLang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        const rows = [
          {...sale,bostaStatus:'CREATED'}, {...sale,bostaStatus:'IN_TRANSIT'},
          {...sale,bostaStatus:'DELETED'}, {...sale,bostaStatus:'OUT_FOR_DELIVERY'},
          {...sale,bostaStatus:'FAILED_ATTEMPT'}, {...sale,bostaStatus:'CREATED',shipCo:'A very long courier name'},
        ];
        const preview = document.querySelector('#state-preview');
        preview.innerHTML = `<table id="narrow-status" style="table-layout:fixed;width:100%;border-collapse:collapse"><colgroup><col style="width:70px"><col style="width:108px"><col style="width:108px"><col></colgroup><thead><tr><th>#</th><th>Pick-Up</th><th>Bosta</th><th>Tag</th></tr></thead><tbody>${rows.map((row,i)=>`<tr><td>${2950+i}</td><td data-col="pickup">${_puStatusBadge(row.pickupStatus,row,true)}</td><td data-col="bosta">${_bostaPrimaryStatusBadge(row)}</td><td>—</td></tr>`).join('')}</tbody></table>`;
        const style = document.createElement('style');
        style.textContent = '#narrow-status td,#narrow-status th{padding:10px 6px;border:1px solid #e2e8f0;text-align:center}#narrow-status tr:nth-child(even){background:#f5f7f8}';
        preview.append(style);
        return [...preview.querySelectorAll('tbody tr')].map(row=>({height:row.getBoundingClientRect().height,badges:[...row.querySelectorAll('.order-state')].map(el=>({height:el.getBoundingClientRect().height,wrap:getComputedStyle(el).whiteSpace}))}));
      },{lang,sale});
      assert.ok(geometry.every(row=>row.height<48 && row.badges.every(badge=>badge.height<=22 && badge.wrap==='nowrap')), '108px columns stay compact: '+JSON.stringify(geometry));
      await page.screenshot({path:path.join(output,`narrow-table-${lang}.png`),fullPage:true});
    }
    for (const lang of ['en', 'ar']) {
      await page.setViewport({width:560,height:700});
      const labels = await page.evaluate(lang => {
        currentLang=lang; document.documentElement.dir=lang==='ar'?'rtl':'ltr';
        const preview=document.querySelector('#state-preview');
        preview.innerHTML=['pickup','bosta'].map(kind=>_puQuickFilterHtml(kind)).join('');
        preview.style.cssText='display:flex;gap:16px;padding:16px;width:100%;box-sizing:border-box';
        preview.querySelectorAll('.mov-qf-menu').forEach(el=>{el.classList.add('open');el.style.cssText='position:relative;inset:auto;display:block;opacity:1;transform:none;flex:1;min-width:0;max-height:none';});
        preview.querySelectorAll('.mov-qf-list').forEach(el=>el.style.maxHeight='none');
        return [...preview.querySelectorAll('#mov-qf-pickup .order-state-label')].map(el=>el.textContent);
      },lang);
      assert.ok(labels.includes(lang==='en'?'Awaiting Prep':'بانتظار التجهيز'));
      assert.ok(labels.includes(lang==='en'?'Ready':'جاهز للشحن'));
      await page.screenshot({path:path.join(output,`filters-${lang}.png`),fullPage:true});
    }
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    for (const width of [1920, 390]) {
      await page.setViewport({ width, height: 1050 });
      await page.evaluate(sale => {
        currentLang = 'ar'; document.documentElement.dir = 'rtl';
        currentUser = { _id: 'admin', role: 'admin', perms: [] };
        transactions = [sale]; users = []; inventoryCache = []; followUps = [];
        _shopifyOrders = [
          { ...sale, _id: 's1', status: 'pending', bostaOrderId: '', bostaStatus: '', shipWithoutDeposit: true, depositReceipts: [] },
          { ...sale, _id: 's2', ref: '2951', status: 'pending', bostaOrderId: '', bostaStatus: '', depositReceipts: [{ id: 'r1', amount: 500, method: 'Instapay', status: 'معلق' }] },
        ];
        qs('#login-page').style.display = 'none'; qs('#app').style.display = ''; qs('#splash-screen')?.remove();
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        qs('#page-shopify-orders').classList.add('active'); currentPage = 'shopify-orders';
        renderShopifyOrders();
      }, sale);
      const selector = width === 1920 ? '#shopify-orders-table-body [data-order-state]' : '#sp-mobile-list .order-state';
      await page.waitForSelector(selector);
      const labels = await page.$$eval(selector, elements => elements.map(el => el.getAttribute('aria-label') || el.textContent));
      assert.ok(labels.some(label => label.includes('مؤكّد')) && labels.some(label => label.includes('بانتظار تأكيد العميل')), 'Actual Shopify table/cards expose the two confirmation states');
      await page.$eval('#sp-orders-tab-content', el => el.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: path.join(output, `shopify-ar-${width}.png`), fullPage: true });
    }
    await page.evaluate(sale => {
      transactions = [sale]; currentPage = 'invoice-view'; window._invoiceViewTxId = sale._id;
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      qs('#page-invoice-view').classList.add('active'); renderInvoiceViewPage();
    }, sale);
    await page.waitForSelector('#inv-view-content .inv-order-state-heading .order-state');
    assert.equal(await page.$$eval('#inv-view-content [data-order-state="Ready"]', els => els.length), 1, 'Invoice shows its current order state only once');
    assert.ok(await page.$eval('#inv-view-content .inv-order-state-heading .order-state', el => el.textContent.includes('جاهز للشحن') && !el.querySelector('.order-state-carrier')));
    await page.screenshot({ path: path.join(output, 'invoice-app-ar-390.png'), fullPage: true });
    await page.goto('http://soulia.test/invoice.html?tx=t1', { waitUntil: 'networkidle0' });
    await page.waitForSelector('.inv-order-state .order-state');
    assert.ok(await page.$eval('.inv-order-state', el => el.textContent.includes('جاهز للشحن') && !el.querySelector('.order-state-carrier')));
    await page.screenshot({ path: path.join(output, 'invoice-ar-390.png'), fullPage: true });
    console.log('Passed Arabic/English at 1440/390/320px, light/dark, search/table parity, actual Shopify table/cards, and both invoice pages.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
