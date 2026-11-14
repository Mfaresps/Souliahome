// Invoice edit window — «بيانات الطلب» fields locked until their own pencil, and the «العربون» card with
// «إضافة عربون» (same dialogs as a Shopify order). Shipped index.html, API mocked.
//   node test/browser/edit-window-deposit.cjs
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const PUB = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/edit-window-deposit');
fs.mkdirSync(output, { recursive: true });

const base = { type: 'مبيعات', client: 'منى سعيد', phone: '01012345678', ref: '9201', date: '2026-11-13', createdAt: '2026-11-13T10:00:00Z',
  shippingCity: 'Cairo', shippingGov: 'Cairo', shippingAddress: 'شارع التحرير 12', shipCo: 'Bosta', shipZone: 'cairo', shipCost: 120,
  items: [{ productId: 'p1', code: 'C1', name: 'سلة', qty: 1, price: 2900, total: 2900, lineId: 'l1' }],
  itemsTotal: 2900, discount: 0, total: 3020, payment: 'كاش', _fullyHydrated: true, employee: 'x' };
const sale = { ...base, _id: 'tx-1', deposit: 700, remaining: 2320, payStatus: 'معلق', depMethod: 'Instapay',
  deposits: [{ id: 'dr_a', amount: 700, method: 'Instapay', date: '2026-11-13T10:05:00Z', by: 'ملك', source: 'deposit-receipt', receiptId: 'dr_a', vaultTxNo: 'SAL-1253' }],
  depositReceipts: [{ id: 'dr_a', amount: 700, method: 'Instapay', imageKey: 'k', imageDeleted: false }],
  depositRequests: [{ id: 'dr_b', status: 'معلق', amount: 300, method: 'فودافون كاش', submittedBy: 'أحمد', submittedById: 'u-staff', noImage: true, imageKey: '' }] };
const legacy = { ...base, _id: 'tx-2', ref: '9202', phone: '1012345678', deposit: 500, remaining: 2520, payStatus: 'معلق', depMethod: 'كاش', deposits: [], depositReceipts: [] };
const delivered = { ...base, _id: 'tx-3', ref: '9203', deposit: 0, remaining: 3020, bostaStatus: 'DELIVERED', deposits: [] };
const byId = { 'tx-1': sale, 'tx-2': legacy, 'tx-3': delivered };

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
      if (url.origin === 'http://soulia.test' && /\.(js|css|svg)$/.test(url.pathname) && fs.existsSync(local))
        return request.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript', body: fs.readFileSync(local, 'utf8') });
      if (url.pathname === '/config.js') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.BACKEND_URL="http://soulia.test/api";' });
      const m = /\/api\/transactions\/(tx-\d)$/.exec(url.pathname);
      if (m && request.method() === 'GET') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(byId[m[1]]) });
      if (/\/lock$/.test(url.pathname)) return request.respond({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: request.resourceType() === 'stylesheet' ? 'text/css' : 'application/json', body: request.resourceType() === 'stylesheet' ? '' : '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate((d) => {
      currentUser = { _id: 'u-admin', role: 'admin', perms: [], name: 'Admin' };
      transactions = d.txs; products = [{ _id: 'p1', code: 'C1', name: 'سلة', sellPrice: 2900 }]; inventoryCache = [];
      settings = { ...(settings || {}), shipCos: [{ name: 'Bosta', code: 'bosta', cairo: 120 }] };
      // the app shell is hidden without a login — show the modal layer on its own
      document.body.classList.add('dark-mode-test');
    }, { txs: [sale, legacy, delivered] });
    const open = async (id, user) => page.evaluate(async ({ id, user }) => {
      if (user) currentUser = user;
      try { closeModal(); } catch (_) {}
      const mc = document.querySelector('#modal-content'); if (mc) mc.innerHTML = '';
      await openEditMovement(id);
      const want = '#' + transactions.find(x => x._id === id).ref;
      for (let i = 0; i < 40 && !(document.querySelector('.edit-tx-section.ef-flow') && (document.querySelector('.edit-tx-ref-badge')?.textContent || '') === want); i++) await new Promise(r => setTimeout(r, 100));
      toggleEditMetaPanel(true);
      await new Promise(r => setTimeout(r, 50));
    }, { id, user });

    for (const lang of ['ar', 'en']) {
      console.log('— ' + lang);
      await page.evaluate(l => { currentLang = l; document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr'; }, lang);
      await open('tx-1', { _id: 'u-admin', role: 'admin', perms: [], name: 'Admin' });
      const r = await page.evaluate(() => {
        const g = id => document.querySelector('#' + id)?.closest('.form-group');
        const phone = qs('#edit-tx-phone');
        const out = {
          editable: ['edit-tx-client', 'edit-tx-phone', 'edit-tx-address', 'edit-tx-shipcost', 'edit-tx-notes'].every(id => g(id)?.classList.contains('ef-field') && !qs('#' + id).readOnly),
          pens: document.querySelectorAll('.edit-tx-section .form-group .ef-pen, .ef-acts').length,
          style: (() => { const cs = getComputedStyle(phone); return { h: phone.getBoundingClientRect().height, r: cs.borderTopLeftRadius, bw: cs.borderTopWidth, bg: cs.backgroundColor }; })(),
          labelAbove: g('edit-tx-phone').querySelector('label').getBoundingClientRect().bottom <= phone.getBoundingClientRect().top + 1,
          phoneW: g('edit-tx-phone')?.getBoundingClientRect().width, addrW: g('edit-tx-address')?.getBoundingClientRect().width,
        };
        phone.focus();
        phone.style.transition = 'none';
        out.focusGreen = getComputedStyle(phone).borderTopColor !== 'rgb(195, 203, 212)';
        phone.style.transition = '';
        phone.value = '01099999999'; phone.dispatchEvent(new Event('input', { bubbles: true }));
        out.kept = g('edit-tx-phone').classList.contains('ef-changed');
        phone.value = '01012345678'; phone.dispatchEvent(new Event('input', { bubbles: true }));
        out.reverted = !g('edit-tx-phone').classList.contains('ef-changed');
        const card = qs('#edit-dep-card');
        out.card = !!card && /700/.test(card.querySelector('.edcard-sum b')?.textContent || '');
        out.rows = card?.querySelectorAll('.edcard-list .edcard-row:not(.is-pending)').length;
        out.logo = !!card?.querySelector('.edcard-row .edcard-logo img, .edcard-row .edcard-logo svg');
        out.thumb = !!card?.querySelector('.edcard-row [data-spdep-image="dr_a"]');
        out.pending = card?.querySelectorAll('.edcard-row.is-pending').length;
        out.approveBtn = !!card?.querySelector('.edcard-row.is-pending .btn-primary');
        out.amountPen = !!card?.querySelector('.edcard-head .ef-pen');   // receipt deposits → amount not editable
        out.addBtn = !!card?.querySelector('.edcard-add');
        out.depositHidden = !!qs('#edit-tx-deposit') && !!qs('#edit-tx-deposit').closest('[hidden]') && qs('#edit-tx-deposit').getClientRects().length === 0
          && [...document.querySelectorAll('#edit-dep-card .edcard-fix')].every(e => getComputedStyle(e).display === 'none');
        return out;
      });
      ok(r.editable, 'fields are ordinary editable inputs');
      ok(r.pens === 0, 'no pencil or keep/undo controls beside the labels');
      ok(Math.round(r.style.h) === 42 && r.style.r === '8px' && r.style.bw === '1px' && r.style.bg === 'rgb(255, 255, 255)', 'standard field: 42px, 8px radius, 1px border, white (' + JSON.stringify(r.style) + ')');
      ok(r.labelAbove, 'label sits above its input');
      ok(r.focusGreen, 'focus turns the border to the brand colour');
      ok(r.phoneW < r.addrW * 0.75, `widths follow the content: phone ${Math.round(r.phoneW)}px < address ${Math.round(r.addrW)}px`);
      ok(r.kept, 'typing a new value marks the field changed');
      ok(r.reverted, 'typing the saved value back clears the mark');
      ok(r.card && r.rows === 1 && r.logo && r.thumb, 'deposit card: paid amount, a row with the vault logo and the receipt thumbnail');
      ok(r.pending === 1 && r.approveBtn, 'a request waiting for a manager is listed with approve for an admin');
      ok(!r.amountPen && r.depositHidden, 'amount not editable when deposits came from receipts; the input stays (hidden) for the save');
      ok(r.addBtn, '«إضافة عربون» is offered');
      if (lang === 'ar') {
        await page.setViewport({ width: 1440, height: 1900 });
        await page.evaluate(() => {
          toggleEditMetaPanel(true);
          let box = document.querySelector('#ew-preview');
          if (!box) { box = document.createElement('main'); box.id = 'ew-preview'; document.body.appendChild(box); }
          [...document.body.children].forEach(el => { if (el !== box && !['STYLE','SCRIPT','LINK'].includes(el.tagName)) el.style.display = 'none'; });
          box.style.cssText = 'display:block;padding:16px;max-width:900px;margin:auto;background:var(--bg,#fff);box-sizing:border-box;width:100%';
          box.innerHTML = '<div class="edit-tx-modal"><div class="edit-tx-modal-body">' + qs('#edit-tx-meta-body').outerHTML.replace(' hidden', '') + '</div></div>';
          box.querySelector('#edit-tx-meta-body').removeAttribute('hidden');
        });
        const el = await page.$('#ew-preview'); if (el) await el.screenshot({ path: path.join(output, 'edit-ar-1440.png') });
        await page.evaluate(() => { qs('#ew-preview')?.remove(); [...document.body.children].forEach(el => { if (!['STYLE','SCRIPT','LINK'].includes(el.tagName)) el.style.display = ''; }); });
      }
    }

    // legacy deposit (no receipts): admin may edit the amount and sees the vault impact; staff may not
    await open('tx-2', { _id: 'u-admin', role: 'admin', perms: [], name: 'Admin' });
    ok(await page.evaluate(() => !_editHasChanges() && qs('#edit-tx-save-btn')?.style.display === 'none'), 'a Shopify phone stored without its leading 0 does not make the window open as changed');
    const adm = await page.evaluate(() => {
      const pen = qs('#edit-dep-card .edcard-head .ef-pen');
      if (!pen) return { pen: false, head: qs('#edit-dep-card')?.outerHTML?.slice(0, 600), admin: isAdmin(), ref: qs('.edit-tx-ref-badge')?.textContent };
      pen.click();
      const inp = qs('#edit-tx-deposit'); inp.value = '800'; inp.dispatchEvent(new Event('input', { bubbles: true }));
      return new Promise(res => setTimeout(() => res({ pen: true, visible: !inp.closest('[hidden]'), impact: qs('#edcard-impact')?.textContent || '' }), 60));
    });
    ok(adm.pen && adm.visible && /300/.test(adm.impact), 'admin: amount pencil opens the input and states the vault impact — ' + (adm.impact || JSON.stringify(adm)));
    await open('tx-2', { _id: 'u-staff', role: 'staff', perms: ['movements'], name: 'Staff' });
    ok(await page.evaluate(() => !qs('#edit-dep-card .edcard-head .ef-pen') && !!qs('#edit-tx-deposit')?.closest('[hidden]') && qs('#edit-tx-deposit').getClientRects().length === 0), 'staff: no amount pencil (adds only through «إضافة عربون»)');

    // delivered: no add button, the reason instead
    const blocks = await page.evaluate((d) => {
      currentLang = 'ar';
      const r = [_saleDepBlock(d.delivered), _saleDepBlock({ ...d.sale, cancelled: true }), _saleDepBlock({ ...d.sale, carrierSettlement: { status: 'pending' } }),
        _saleDepBlock({ ...d.sale, remaining: 300 }), _saleDepBlock(d.sale)];
      currentLang = 'en';
      return r;
    }, { delivered, sale });
    ok(/سُلِّم/.test(blocks[0]) && /ملغاة/.test(blocks[1]) && /تسوية/.test(blocks[2]) && /متبقٍ/.test(blocks[3]) && blocks[4] === '',
      'blocked: delivered, cancelled, in carrier settlement, nothing left once waiting requests are counted; allowed otherwise');

    // add deposit → the edit window closes and the receipt dialog opens on the sale, capped at its true remaining
    await open('tx-1', { _id: 'u-admin', role: 'admin', perms: [], name: 'Admin' });
    const add = await page.evaluate(async () => {
      await openSaleDeposit('tx-1', 'image', false);
      await new Promise(r => setTimeout(r, 150));
      const o = _spOrderById('tx-1');
      return { form: !!qs('#sp-receipt-form'), sale: !!o?.saleDeposit, cap: _spReceiptAmountCap(o, null), editGone: !qs('.edit-tx-modal') };
    });
    ok(add.form && add.sale && add.editGone, 'add deposit opens the same receipt dialog for this sale');
    ok(add.cap === 2020, 'its cap is the remaining minus the request still waiting (2320 − 300 = 2020): ' + add.cap);
    const noimg = await page.evaluate(async () => {
      try { _spCancelReceiptForm(); } catch (_) {}
      closeModal();
      await openSaleDeposit('tx-1', 'noimage', false);
      await new Promise(r => setTimeout(r, 150));
      return { form: !!qs('.spdep-noimg'), cap: Number(qs('#spdep-amount')?.max) };
    });
    ok(noimg.form && noimg.cap === 2020, 'without an image: the no-image dialog, same cap');

    await page.setViewport({ width: 390, height: 860 });
    await page.evaluate(() => { currentLang = 'en'; document.documentElement.dir = 'ltr'; document.body.classList.add('dark-mode'); closeModal(); });
    await open('tx-1', { _id: 'u-admin', role: 'admin', perms: [], name: 'Admin' });
    const mob = await page.evaluate(() => ({ over: document.documentElement.scrollWidth > window.innerWidth + 1 || [...document.querySelectorAll('#edit-dep-card, .edit-tx-section')].some(e => e.scrollWidth > e.clientWidth + 1) }));
    ok(!mob.over, 'en 390 dark: no horizontal overflow');
    await page.evaluate(() => {
          toggleEditMetaPanel(true);
          let box = document.querySelector('#ew-preview');
          if (!box) { box = document.createElement('main'); box.id = 'ew-preview'; document.body.appendChild(box); }
          [...document.body.children].forEach(el => { if (el !== box && !['STYLE','SCRIPT','LINK'].includes(el.tagName)) el.style.display = 'none'; });
          box.style.cssText = 'display:block;padding:16px;max-width:900px;margin:auto;background:var(--bg,#fff);box-sizing:border-box;width:100%';
          box.innerHTML = '<div class="edit-tx-modal"><div class="edit-tx-modal-body">' + qs('#edit-tx-meta-body').outerHTML.replace(' hidden', '') + '</div></div>';
          box.querySelector('#edit-tx-meta-body').removeAttribute('hidden');
        });
    const el = await page.$('#ew-preview'); if (el) await el.screenshot({ path: path.join(output, 'edit-en-390-dark.png') });
    const inv = await page.evaluate(() => {
      closeModal();
      const t1 = transactions.find(x => x._id === 'tx-1');
      window._invoiceViewTxId = t1._id; window._invoiceViewRef = t1.ref;
      document.querySelector('#page-invoice-view').classList.add('active');
      renderInvoiceViewPage();
      const box = document.querySelector('#inv-view-content .inv2-saledep');
      return { pending: box?.querySelectorAll('.edcard-row.is-pending').length, approve: !!box?.querySelector('.btn-primary'), add: !!box?.querySelector('.edcard-add') };
    });
    ok(inv.pending === 1 && inv.approve && inv.add, 'invoice page: the waiting request with approve for a manager, and «إضافة عربون»');
    // «حفظ التعديلات»: spinner + disabled while saving, a second click does nothing, restored afterwards
    await page.setViewport({ width: 1440, height: 900 });
    await open('tx-1', { _id: 'u-admin', role: 'admin', perms: [], name: 'Admin' });
    const sv = await page.evaluate(async () => {
      const orig = _saveEditMovementImpl; let calls = 0;
      _saveEditMovementImpl = () => { calls++; return new Promise(r => setTimeout(r, 600)); };
      const btn = qs('#edit-tx-save-btn'); btn.style.display = ''; const label = btn.textContent.trim();
      btn.click(); await new Promise(r => setTimeout(r, 60)); btn.click(); btn.click();
      const during = { disabled: btn.disabled, spin: !!btn.querySelector('.btn-spin'), busy: btn.getAttribute('aria-busy'), text: btn.textContent.trim() };
      await new Promise(r => setTimeout(r, 800));
      const after = { disabled: btn.disabled, spin: !!btn.querySelector('.btn-spin'), text: btn.textContent.trim() };
      _saveEditMovementImpl = orig;
      return { calls, during, after, label };
    });
    ok(sv.during.disabled && sv.during.spin && sv.during.busy === 'true' && /Saving|جارٍ الحفظ/.test(sv.during.text), 'save button shows a spinner and «Saving…» while saving');
    ok(sv.calls === 1, 'extra clicks during a save run nothing (' + sv.calls + ' save)');
    ok(!sv.after.disabled && !sv.after.spin && sv.after.text === sv.label, 'button returns to its label afterwards');
    ok(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  } catch (e) { failed = true; console.error('✗', e.message); }
  finally { await browser.close(); }
  process.exit(failed ? 1 : 0);
})();
