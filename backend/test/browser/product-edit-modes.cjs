/* Product page edit modes + manager code + delivery-issue buttons (Nov 25, 2026).
   Real index.html served from disk, API mocked inside the page. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), publicDir = path.join(root, 'frontend/public');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setViewport({ width: 1440, height: 950 });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return request.respond({ contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentLang = 'ar';
      qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      window.calls = [];
      api = async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, method: options.method || 'GET', body });
        if (url === '/discount-otp/record-edit-request') return { otpId: 'f'.repeat(24), expiresAt: new Date(Date.now() + 6e5).toISOString() };
        if (url === '/discount-otp/validate') return body.otp === '1234' ? { valid: true } : { valid: false, message: 'الكود غير صحيح' };
        if (url.startsWith('/products/') && options.method === 'PUT') return { ...products[0], ...body };
        return [];
      };
      products = [{ _id: 'a'.repeat(24), code: 'BSK-1', name: 'سلة قطن', sellPrice: 500, isActive: true, features: [], colors: [], images: [] }];
      categories = []; collections = []; inventoryCache = [];
    });
    const open = async perms => page.evaluate(async perms => {
      currentUser = { _id: 'u', name: 'منى', role: 'staff', perms: ['products', ...perms] };
      calls.length = 0; document.querySelectorAll('.toast').forEach(el => el.remove());
      if (typeof _pmClearDirty === 'function') _pmClearDirty();
      currentProductId = 'a'.repeat(24); _prdDraft = null; _prdActivityTab = 'history'; currentPage = 'product';
      document.querySelectorAll('.page').forEach(el => el.classList.remove('active')); qs('#page-product').classList.add('active');
      renderProductPage();
      await new Promise(r => setTimeout(r, 300));
      document.querySelectorAll('.wl-product').forEach(el => { el.dataset.ready = 'true'; });
      const host = qs('#prd-host');
      return {
        note: host.querySelector('.prd-mode-note')?.textContent || '',
        readonly: host.classList.contains('prd-readonly'),
        nameDisabled: qs('#pm-name')?.disabled,
        sellDisabled: qs('#pm-sell')?.disabled,
        buyInput: !!qs('#pm-buy:not([type="hidden"])'),
        savebarHidden: getComputedStyle(qs('#prd-savebar')).display === 'none',
      };
    }, perms);

    // A saved product carries the form's material and size (the fixture starts without them).
    await open(['products-edit']);
    await page.evaluate(() => { products[0].material = qs('#pm-material-select')?.value || ''; products[0].sizeType = 'standard'; products[0].size = qs('#pm-size-standard')?.value || ''; });

    // 1. View only
    let r = await open([]);
    ok(r.readonly && /للعرض فقط/.test(r.note), 'view only: notice');
    ok(r.nameDisabled && r.sellDisabled, 'view only: fields disabled');
    ok(!r.buyInput, 'view only: no purchase-price field');
    await page.evaluate(() => saveProduct('a'.repeat(24)));
    ok(await page.evaluate(() => !calls.some(c => c.method === 'PUT')), 'view only: save sends nothing');

    // 2. Sale price only
    r = await open(['products-price-sell']);
    ok(/سعر البيع فقط/.test(r.note) && r.nameDisabled && !r.sellDisabled, 'price only: only the sale price is editable');
    await page.evaluate(async () => { qs('#pm-sell').value = '450'; await saveProduct('a'.repeat(24)); });
    const put1 = await page.evaluate(() => calls.find(c => c.method === 'PUT'));
    ok(put1 && JSON.stringify(put1.body) === JSON.stringify({ sellPrice: 450 }), 'price only: sends the sale price alone ' + JSON.stringify(put1?.body));

    // 3. Manager code
    r = await open(['products-edit-otp']);
    ok(/كود تحقق من المدير/.test(r.note) && !r.readonly, 'code mode: notice, editable');
    ok(r.sellDisabled, 'code mode: sale price locked without its permission');
    await page.evaluate(() => { qs('#pm-name').value = 'سلة قطن كبيرة'; saveProduct('a'.repeat(24)); });
    await page.waitForSelector('dialog.mgr-otp[open]', { timeout: 5000 });
    const req = await page.evaluate(() => calls.find(c => c.url === '/discount-otp/record-edit-request'));
    ok(req && req.body.entity === 'product' && JSON.stringify(req.body.fields) === '["name"]', 'code requested for exactly the changed field ' + JSON.stringify(req?.body));
    ok(await page.$eval('dialog.mgr-otp', d => /الاسم/.test(d.textContent)), 'dialog names the change');
    await page.evaluate(() => { const i = qs('#mgr-otp-input'); i.value = '9999'; i.dispatchEvent(new Event('input')); });
    await page.click('dialog.mgr-otp [data-act="ok"]');
    await page.waitForFunction(() => /غير صحيح/.test(qs('dialog.mgr-otp .mgr-otp-msg')?.textContent || ''));
    ok(await page.evaluate(() => !calls.some(c => c.method === 'PUT')), 'wrong code: nothing saved');
    await page.evaluate(() => { const i = qs('#mgr-otp-input'); i.value = '١٢٣٤'; i.dispatchEvent(new Event('input')); });
    await page.click('dialog.mgr-otp [data-act="ok"]');
    await page.waitForFunction(() => calls.some(c => c.method === 'PUT'), { timeout: 5000 });
    const put2 = await page.evaluate(() => calls.find(c => c.method === 'PUT'));
    ok(put2.body.otpId === 'f'.repeat(24) && put2.body.name === 'سلة قطن كبيرة' && !('sellPrice' in put2.body) && Object.keys(put2.body).length === 2, 'Arabic digits accepted; sends only the change + code ' + JSON.stringify(put2.body));

    // 4. Cancel the code → nothing saved
    await open(['products-edit-otp']);
    await page.evaluate(() => { qs('#pm-name').value = 'اسم آخر'; saveProduct('a'.repeat(24)); });
    await page.waitForSelector('dialog.mgr-otp[open]');
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 200));
    ok(await page.evaluate(() => !document.querySelector('dialog.mgr-otp') && !calls.some(c => c.method === 'PUT')), 'Escape cancels, nothing saved');

    // 5. Direct edit + cost
    r = await open(['products-edit', 'products-cost-view']);
    ok(!r.note && !r.readonly && r.buyInput, 'direct + cost view: no notice, purchase price visible');
    ok(await page.evaluate(() => qs('#pm-buy').disabled && !qs('#pm-lock-buy .pm-lock-btn')), 'purchase price read-only without «تعديل سعر الشراء»');

    // 6. Delivery-issue buttons
    const fd = await page.evaluate(() => {
      const tx = { _id: 'tx1', type: 'مبيعات', shipIssueState: 'open', failedDelivery: null, total: 500, deposit: 0, remaining: 500 };
      const out = {};
      for (const [k, perms] of Object.entries({ none: [], follow: ['delivery-issues-follow'], both: ['delivery-issues-follow', 'delivery-issues-close'] })) {
        currentUser = { _id: 'u', role: 'staff', perms };
        const div = document.createElement('div');
        div.innerHTML = typeof _fdDisabled === 'function' ? ['close', 'follow'].map(a => `<button ${_fdDisabled(a)}>${a}</button>`).join('') : '';
        out[k] = [...div.querySelectorAll('button')].map(b => b.disabled);
      }
      return out;
    });
    ok(JSON.stringify(fd.none) === '[true,true]' && JSON.stringify(fd.follow) === '[true,false]' && JSON.stringify(fd.both) === '[false,false]', 'delivery buttons follow their permissions ' + JSON.stringify(fd));

    // 7. Supplier hidden from a product editor without supplier visibility, and never sent
    r = await open(['products-edit']);
    ok(await page.evaluate(() => !qs('#pm-supplier')), 'supplier field removed without «رؤية مورد الصنف»');
    await page.evaluate(async () => { calls.length = 0; qs('#pm-name').value = 'اسم'; await saveProduct('a'.repeat(24)); });
    ok(await page.evaluate(() => { const put = calls.find(c => c.method === 'PUT'); return put && !('supplier' in put.body); }), 'save sends no supplier');
    await open(['products-edit', 'products-supplier-view']);
    ok(await page.evaluate(() => !!qs('#pm-supplier')), 'supplier field shown with the permission');

    // 8. Excel export, report printing and the smart card
    const gate = await page.evaluate(() => {
      const out = {}; let asked = null, approve = null;
      openExportOtpFlow = (label, cb) => { asked = label; approve = cb; };
      const written = [];
      window.XLSX = { utils: {}, writeFile: (wb, name) => written.push(name) };
      window.__souliaGuardXlsx();
      currentUser = { _id: 'u', role: 'staff', perms: ['products'] };
      XLSX.writeFile({}, 'stock.xlsx');
      out.blocked = written.length === 0 && asked === 'stock.xlsx';
      approve();
      out.afterCode = written.length === 1;
      XLSX.writeFile({}, 'second.xlsx');
      out.window = written.length === 2; // one-minute window after a code
      _exportGrantUntil = 0; asked = null;
      currentUser = { _id: 'u', role: 'staff', perms: ['products', 'data-export'] };
      XLSX.writeFile({}, 'direct.xlsx');
      out.direct = written.length === 3 && asked === null;
      // report printing
      currentUser = { _id: 'u', role: 'staff', perms: ['products'] };
      let printed = 0; window._dpPrintPDF.__orig = null;
      const g = window._dpPrintPDF; out.printGuarded = !!(g && g.__souliaGuarded);
      asked = null; try { window.printProducts([]); } catch (_) {}
      out.printAsks = asked !== null;
      // smart card
      document.querySelectorAll('.toast').forEach(el => el.remove());
      showProductCard();
      out.cardRefused = !qs('#modal-overlay.active') && /كارت المنتج الذكي/.test(document.body.textContent);
      return out;
    });
    ok(gate.blocked, 'Excel without permission asks for a manager code');
    ok(gate.afterCode && gate.window, 'the code unlocks the export (and a minute of exports)');
    ok(gate.direct, '«تصدير Excel» exports directly');
    ok(gate.printGuarded && gate.printAsks, 'report printing asks for a code without the permission');
    ok(gate.cardRefused, 'smart product card refused without its permission');

    ok(errors.length === 0, 'no page errors: ' + errors.join(' | '));
    console.log(`PASS product-edit-modes: ${n} checks`);
  } catch (e) { console.error(`FAIL after ${n} checks:`, e.message); process.exitCode = 1; }
  finally { await browser.close(); }
})();
