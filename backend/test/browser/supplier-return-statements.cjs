// «بيانات المرتجعات» over the SHIPPED files (supplier-return-statements.js + .css and the app's
// stylesheet). Only the network is faked — an in-memory copy of the API rules.
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
  const shot = async (pg, name) => { if (process.env.RS_SHOTS) await pg.screenshot({ path: path.join(process.env.RS_SHOTS, name + '.png') }); };
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    const PNG = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CFC0F01F0005000201E2265E0A0000000049454E44AE426082', 'hex');
    page.on('request', (r) => /\.(jpg|png)$/.test(r.url()) ? r.respond({ status: 200, contentType: 'image/png', body: PNG }) : r.respond({ status: 200, contentType: 'text/html; charset=utf-8',
      body: '<html dir="rtl"><body><div id="main"><div class="page active" id="page-supplier-profile"><div id="sp-panel-statements"></div></div></div><div id="modal-overlay"><div id="modal-content"></div></div></body></html>' }));
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto('https://soulia.test/');
    await page.addStyleTag({ content: html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1] });
    await page.addStyleTag({ path: path.join(root, 'supplier-return-statements.css') });
    await page.evaluate(() => {
      window.qs = (s) => document.querySelector(s);
      window.currentLang = 'ar';
      window.currentUser = { _id: 'u1', name: 'Fares', role: 'admin', perms: [] };
      window.isAdmin = () => currentUser.role === 'admin';
      window._myUserId = () => currentUser._id;
      window.toasts = []; window.toast = (m, err) => toasts.push((err ? 'ERR:' : '') + m);
      window.showConfirm = async () => true;
      window.openModal = (h) => { qs('#modal-content').innerHTML = h; qs('#modal-overlay').classList.add('active'); };
      window.closeModal = () => { qs('#modal-overlay').classList.remove('active'); qs('#modal-content').innerHTML = ''; };
      window.suppliers = [{ _id: 's1', name: 'مصنع النور', phone: '01000000000' }];
      window.products = [
        { _id: 'p1', name: 'Cushion Blue', code: 'CUS-1', imageUrl: 'https://cdn.test/p1.jpg' },
        { _id: 'p2', name: 'مفرش سفرة', code: 'TBL-9' },
      ];
      window.purchaseOrders = [{ _id: 'po1', supplierId: 's1', poNumber: 'PO-0007', createdDate: '2026-11-10' }];
      window.transactions = [{ _id: 'tx1', type: 'مشتريات', client: 'مصنع النور', ref: '900020', date: '2026-11-11' }];
      window.settings = { companyLegalName: 'SOULIA Home' };
      // In-memory API with the server's rules that matter to the UI.
      window.DB = []; window.calls = [];
      let seq = 0;
      const err = (m) => { const e = new Error(m); throw e; };
      window.api = async (p, o = {}) => {
        const m = (o.method || 'GET').toUpperCase(); const body = typeof o.body === 'string' ? JSON.parse(o.body) : o.body;
        calls.push([m, p, body]);
        const prod = (id) => products.find((x) => x._id === id);
        const build = (ls) => ls.map((l) => ({ ...l, code: prod(l.productId).code, name: prod(l.productId).name, imageUrl: prod(l.productId).imageUrl || '', unitPrice: l.productId === 'p1' ? 150 : null, priceSource: l.productId === 'p1' ? 'supplier' : '', attachments: [] }));
        window.hidePrices = window.hidePrices || false;
        const mask = (d) => (window.hidePrices ? { ...d, pricesHidden: true, lines: d.lines.map(({ unitPrice, priceSource, ...l }) => l) } : d);
        if (m === 'GET' && p.startsWith('/supplier-return-statements?')) return DB.filter((d) => !d.deletedAt).map(mask);
        if (m === 'POST' && p === '/supplier-return-statements') {
          if (body.lines.some((l) => l.reason === 'other' && !String(l.reasonNote || '').trim())) err('اكتب وصف السبب');
          seq++; const d = { _id: 'r' + seq, seq, number: 'SR-' + String(seq).padStart(5, '0'), supplierId: body.supplierId, supplierName: 'مصنع النور', date: body.date, notes: body.notes,
            linkedDoc: body.linkedDoc ? { ...body.linkedDoc, ref: body.linkedDoc.kind === 'po' ? 'PO-0007' : '900020' } : null,
            status: 'draft', lines: build(body.lines), revision: 1, createdBy: 'Fares', createdById: 'u1', createdAt: new Date().toISOString(), history: [{ action: 'created', by: 'Fares', at: new Date().toISOString() }] };
          DB.push(d); return d;
        }
        const id = (p.match(/^\/supplier-return-statements\/([^/?]+)/) || [])[1]; const d = DB.find((x) => x._id === id);
        if (m === 'GET' && /^\/supplier-return-statements\/[^/]+$/.test(p)) return mask(d);
        if (m === 'PATCH') { Object.assign(d, { date: body.date, notes: body.notes, lines: build(body.lines), revision: d.revision + 1 }); d.history.push({ action: 'edited', by: 'Fares', at: new Date().toISOString() }); return d; }
        if (m === 'POST' && p.endsWith('/status')) { d.history.push({ action: 'status', from: d.status, to: body.status, by: 'Fares', at: new Date().toISOString() }); d.status = body.status; d.revision++; return d; }
        if (m === 'POST' && p.endsWith('/printed')) return { ok: true };
        if (m === 'POST' && p.includes('/photos')) { const lid = p.split('/lines/')[1].split('/')[0]; d.lines.find((l) => l.lineId === lid).attachments.push({ id: 'a'.repeat(64), name: 'x.png' }); return d; }
        if (m === 'GET' && p.includes('/photos/')) return { data: 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==' };
        if (m === 'DELETE') { d.deletedAt = 'now'; return { ok: true }; }
        err('unhandled ' + m + ' ' + p);
      };
    });
    await page.addScriptTag({ path: path.join(root, 'supplier-return-statements.js') });
    const render = () => page.evaluate(() => SupplierReturnStatements.render(qs('#sp-panel-statements'), 's1'));
    await render();
    await page.waitForSelector('.rs-empty');
    ok(await page.$eval('.rs-empty p', (e) => e.textContent.includes('لا توجد بيانات مرتجعات')), 'empty supplier shows an empty state, not a table');
    ok(await page.$eval('.rs-note', (e) => e.textContent.includes('لا يغيّر المخزون')), 'the panel states it has no stock or accounting effect');

    // ── Create ──
    await page.click('[data-rs-act="new"]');
    await page.waitForSelector('[data-rs-editor]');
    ok(await page.$$eval('.rs-line', (l) => l.length) === 1, 'editor opens with one empty line');
    await shot(page, '1-editor-empty');
    ok(await page.$eval('[data-rs-ed="date"]', (e) => /^\d{4}-\d{2}-\d{2}$/.test(e.value)), 'date defaults to today');
    ok(await page.$$eval('[data-rs-ed="linked"] option', (o) => o.map((x) => x.textContent).join('|').includes('PO-0007') && o.map((x) => x.textContent).join('|').includes('900020')), 'linked-document list offers this supplier\'s PO and purchase invoice');
    await page.click('[data-rs-act="ed-save"]');
    ok(await page.$eval('[data-rs-ed-err]', (e) => !e.hidden && e.textContent.includes('اختر المنتج')), 'saving a line with no product is refused inline');
    await page.type('[data-rs-prod="0"]', 'cush');
    await page.waitForSelector('[data-rs-prod-list="0"]:not([hidden]) .rs-combo-opt');
    ok(await page.$$eval('[data-rs-prod-list="0"] .rs-combo-opt', (o) => o.length === 1), 'product search narrows the list');
    await page.keyboard.press('Enter');
    ok(await page.$eval('.rs-sku', (e) => e.textContent.includes('CUS-1')), 'picking a product shows its SKU');
    await page.click('[data-rs-act="ed-add-line"]');
    await page.type('[data-rs-prod="1"]', 'مفرش');
    await page.click('[data-rs-prod-list="1"] .rs-combo-opt');
    await page.select('select[data-rs-line="reason"][data-i="1"]', 'other');
    ok(!!(await page.$('[data-rs-line="reasonNote"][data-i="1"]')), '«Other» reveals a required description field');
    await page.click('[data-rs-act="ed-save"]');
    ok(await page.$eval('[data-rs-ed-err]', (e) => e.textContent.includes('وصف السبب')), '«Other» without a description is refused before sending');
    await page.type('[data-rs-line="reasonNote"][data-i="1"]', 'لون باهت');
    await page.$eval('[data-rs-line="qty"][data-i="0"]', (e) => { e.value = ''; });
    await page.type('[data-rs-line="qty"][data-i="0"]', '3');
    await page.evaluate(() => { const i = document.querySelector('[data-rs-line="qty"][data-i="0"]'); i.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.select('select[data-rs-line="reason"][data-i="0"]', 'shipping-damage');
    await page.select('[data-rs-ed="linked"]', 'po:po1');
    // One photo queued on the first line.
    const fileInput = await page.$('[data-rs-photo-input="0"]');
    const png = path.join(require('os').tmpdir(), 'rs-test.png');
    fs.writeFileSync(png, Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D4944415478DA63F8CFC0F01F0005000201E2265E0A0000000049454E44AE426082', 'hex'));
    await fileInput.uploadFile(png);
    await page.waitForSelector('.rs-thumb.is-pending');
    ok(true, 'a photo is queued with a preview before saving');
    await shot(page, '2-editor-filled');
    await page.click('[data-rs-act="ed-save"]');
    await page.waitForSelector('[data-rs-view]');
    await new Promise((r) => setTimeout(r, 300)); await shot(page, '3-view');
    const posted = await page.evaluate(() => calls.find((c) => c[0] === 'POST' && c[1] === '/supplier-return-statements')[2]);
    ok(posted.supplierId === 's1' && /^[a-f0-9]{32}$/.test(posted.requestKey), 'create sends the supplier and an idempotency key');
    ok(posted.lines.length === 2 && posted.lines[0].qty === 3 && posted.lines[0].reason === 'shipping-damage' && posted.lines[1].reasonNote === 'لون باهت', 'lines are sent with qty, reason and description');
    ok(posted.linkedDoc.kind === 'po' && posted.linkedDoc.id === 'po1', 'the linked PO is sent');
    ok(await page.evaluate(() => calls.some((c) => c[1].includes('/lines/') && c[1].endsWith('/photos'))), 'the queued photo uploads after the statement is created');
    ok(await page.$eval('.rs-ed-title', (e) => e.textContent.includes('SR-00001')), 'the details window opens on the new number');
    ok(await page.$$eval('.rs-vline', (l) => l.length) === 2, 'details list both items');
    ok(await page.$$eval('.rs-thumb.is-view', (l) => l.length) === 1, 'details show the photo');
    ok(await page.$$eval('.rs-vline .rs-pimg', (l) => l.length === 2) && await page.$eval('.rs-vline .rs-pimg img', (i) => i.getAttribute('src') === 'https://cdn.test/p1.jpg'), 'each line shows the product photo (placeholder when none)');
    ok(await page.$$eval('.rs-reason-tag', (l) => l.length === 2 && getComputedStyle(l[0]).backgroundColor !== 'rgba(0, 0, 0, 0)'), 'the reason is a highlighted tag');
    ok(await page.$eval('.rs-vline-price', (e) => e.textContent.includes('150.00') && e.textContent.includes('450.00') && e.textContent.includes('سعر المورد')), 'line shows unit price × qty = total and where the price came from');
    ok(await page.$eval('.rs-fact-total', (e) => e.textContent.includes('450.00') && e.textContent.includes('1 بدون سعر')), 'total value, with the unpriced line stated');

    // ── Status ──
    await page.select('[data-rs-status-to]', 'sent');
    await page.click('[data-rs-act="status-apply"]');
    await page.waitForFunction(() => document.querySelector('.rs-ed-title .rs-pill.is-sent'));
    ok(true, 'status change updates the pill');
    ok(await page.$eval('.rs-history', (e) => e.textContent.includes('غيّر الحالة')), 'status change appears in the change history');

    // ── Print ──
    await page.evaluate(() => { window.__printed = 0; const orig = HTMLIFrameElement.prototype; });
    await page.evaluate(() => {
      const mo = new MutationObserver(() => { const f = document.querySelector('iframe[aria-hidden="true"]'); if (f && f.contentWindow && !f.__p) { f.__p = 1; f.contentWindow.print = () => { window.__printed++; window.__printHtml = f.contentDocument.documentElement.outerHTML; }; } });
      mo.observe(document.body, { childList: true });
    });
    await page.click('[data-rs-act="print"][data-kind="print"]');
    await page.waitForFunction(() => window.__printed === 1, { timeout: 8000 });
    const printed = await page.evaluate(() => window.__printHtml);
    if (process.env.RS_SHOTS) fs.writeFileSync(path.join(process.env.RS_SHOTS, 'print.html'), printed);
    ok(printed.includes('SR-00001') && printed.includes('مصنع النور') && printed.includes('Cushion Blue') && printed.includes('PO-0007') && printed.includes('@page'), 'print sheet carries number, supplier, items, linked PO and A4 page');
    ok(printed.includes('لون باهت') && printed.includes('صور توثيقية'), 'print sheet carries the reason description and the photos');
    ok(printed.includes('class="pimg" src="https://cdn.test/p1.jpg"'), 'print sheet: product photo in the row');
    ok((printed.match(/class="rtag"/g) || []).length === 2, 'print sheet: reasons highlighted');
    ok(printed.includes('سعر القطعة') && printed.includes('150.00') && printed.includes('450.00 EGP') && printed.includes('بدون سعر مورد'), 'print sheet: unit price, line total, grand total and unpriced note');
    ok(await page.evaluate(() => calls.some((c) => c[1].endsWith('/printed'))), 'the print is recorded in the history');

    // ── List + filters ──
    await page.click('[data-rs-act="view-close"]');
    await page.waitForSelector('.rs-row');
    await shot(page, '4-list');
    ok(await page.$eval('[data-rs-summary]', (e) => e.textContent.includes('1') && e.textContent.includes('4')), 'summary counts 1 statement and 4 pieces');
    await page.type('[data-rs-filter="q"]', 'zzz');
    ok(await page.$eval('[data-rs-table]', (e) => e.textContent.includes('لا توجد نتائج')), 'a search with no match says so and offers to clear');
    await page.click('[data-rs-act="clear-filters"]');
    ok(await page.$$eval('.rs-row', (r) => r.length) === 1, 'clearing filters brings the row back');
    await page.select('[data-rs-filter="status"]', 'closed');
    ok(await page.$$eval('.rs-row', (r) => r.length) === 0, 'status filter hides non-matching statements');
    await page.select('[data-rs-filter="status"]', '');

    // ── Delete ──
    await page.click('.rs-row');
    await page.waitForSelector('[data-rs-view]');
    await page.click('[data-rs-act="delete"]');
    await page.waitForSelector('.rs-empty');
    ok(await page.evaluate(() => calls.some((c) => c[0] === 'DELETE')), 'delete asks, then removes the statement from the list');

    // ── Permissions: view only ──
    await page.evaluate(() => { currentUser = { _id: 'u2', role: 'staff', perms: ['suppliers-rs-view'] }; DB.forEach((d) => { delete d.deletedAt; }); SupplierReturnStatements._state.loadedFor = ''; });
    await render(); await page.waitForSelector('.rs-row');
    ok(await page.$eval('[data-rs-act="new"]', (b) => b.disabled), 'view-only: «new statement» is disabled');
    await page.evaluate(() => { window.hidePrices = true; SupplierReturnStatements._state.loadedFor = ''; });
    await render(); await page.waitForSelector('.rs-row');
    ok(!(await page.$('.rs-c-value')), 'no purchase perms: no value column');
    await page.click('.rs-row'); await page.waitForSelector('[data-rs-view]');
    ok(!(await page.$('.rs-vline-price')) && !(await page.$('.rs-fact-total')), 'no purchase perms: no prices in details');
    ok(!(await page.$('[data-rs-act="edit"]')) && !(await page.$('[data-rs-act="delete"]')) && !(await page.$('[data-rs-status-to]')) && !(await page.$('[data-rs-act="print"]')), 'view-only: no edit, delete, status or print');
    await page.click('[data-rs-act="view-close"]');
    await page.evaluate(() => { currentUser = { _id: 'u2', role: 'staff', perms: ['suppliers'] }; });
    ok(await page.evaluate(() => !SupplierReturnStatements.canView()), 'no statement perm → tab not visible');

    // ── English, dark, phone ──
    await page.evaluate(() => { window.hidePrices = false; SupplierReturnStatements._state.loadedFor = ''; currentUser = { _id: 'u1', role: 'admin', perms: [] }; currentLang = 'en'; document.documentElement.dir = 'ltr'; document.body.parentElement.setAttribute('dir', 'ltr'); document.body.classList.add('dark-mode'); });
    await render(); await page.waitForSelector('.rs-row');
    ok(await page.$eval('.rs-new-btn', (b) => b.textContent.includes('New return statement')), 'English labels');
    await page.setViewport({ width: 390, height: 844 });
    await render(); await page.waitForSelector('.rs-row');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '390px: no horizontal page overflow');
    await shot(page, '5-phone-dark');
    ok(await page.$eval('.rs-table thead', (e) => getComputedStyle(e).display === 'none'), '390px: rows become cards');
    await page.click('[data-rs-act="new"]'); await page.waitForSelector('[data-rs-editor]');
    await shot(page, '6-phone-editor');
    ok(await page.evaluate(() => { const r = document.querySelector('.rs-line').getBoundingClientRect(); return r.right <= window.innerWidth + 1 && r.left >= -1; }), '390px: an editor line fits the screen');
    ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    console.log('\nAll supplier-return-statement browser checks passed');
  } catch (e) {
    console.error('✗', e.message); process.exitCode = 1;
  } finally { await browser.close(); }
})();
