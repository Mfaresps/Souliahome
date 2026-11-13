// «شيل العرض من السطر ده» over the SHIPPED index.html: the real notice, dialog, take-off / put-back
// and per-window glue, the real CSS. Only the windows' own renderers and the network are faked.
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const fnSrc = (name) => {
  const m = new RegExp('\\n(?:async )?function ' + name + '\\(').exec(html);
  assert.ok(m, 'extract ' + name);
  return html.slice(m.index + 1, html.indexOf('\n}\n', m.index + 1) + 3);
};
const line = (start) => { const i = html.indexOf(start); assert.ok(i > 0, 'extract ' + start); return html.slice(i, html.indexOf('\n', i)); };
const code = [line('const PROMO_PERMS ='), line('const PO_RM_REASONS ='),
  ...['promoPerm', 'requirePromoPerm', '_offerActiveOn', '_effectiveSellPrice', '_offerCoversOrder', '_psDate', 'todayLocalISO',
    '_offerNoticeHtml', '_offerRemovedHtml', '_offerRemoveAsk', '_offerTakeOff', '_offerPutBack', '_txOfferOff', '_txOfferBack',
    '_editOfferProduct', '_editOfferOff', '_editOfferBack', '_spOfferProduct', '_spOfferOff', '_spOfferBack', '_spApplyOfferPrice'].map(fnSrc)].join('\n');
const trKeys = [...html.matchAll(/^  (po[A-Za-z_]+):\{ar:'[^\n]*$/gm)].map((m) => m[0]).join('\n');
// the three save paths must carry the record, or it dies between the window and the server
for (const [label, needle] of [['new sale save', "total: it.qty * it.price, ...(it.offerRemoved ? { offerRemoved: it.offerRemoved } : {}) };"],
  ['invoice edit load', "productId: resolvedProductId, ...(it.offerRemoved ? { offerRemoved: it.offerRemoved } : {}) });"]]) {
  assert.ok(html.includes(needle), label + ' carries offerRemoved');
}
assert.equal((html.match(/total: it\.qty \* it\.price, \.\.\.\(it\.offerRemoved/g) || []).length, 2, 'new sale + invoice edit both send offerRemoved');

const TODAY = (() => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); })();

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
  let failed = false;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', (r) => r.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: '<html dir="rtl"><body><div id="rows"></div><input id="tx-transaction-date"></body></html>' }));
    await page.setViewport({ width: 1280, height: 860 });
    await page.goto('https://soulia.test/');
    await page.addStyleTag({ content: html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1] });
    await page.evaluate((trKeys, TODAY) => {
      window.qs = (s) => document.querySelector(s); window.qsa = (s) => [...document.querySelectorAll(s)];
      window.currentLang = 'ar';
      const TR = eval('({' + trKeys + '\n cancel:{ar:"إلغاء",en:"Cancel"} })');
      window.t = (k, p) => { const e = TR[k]; let v = e ? (e[currentLang] || e.ar) : k; if (p) for (const x in p) v = v.replace('{' + x + '}', p[x]); return v; };
      window.esc = (v) => { const x = document.createElement('div'); x.textContent = v == null ? '' : String(v); return x.innerHTML; };
      window.escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      window.fmtN = (n) => Number(n || 0).toLocaleString('en-US');
      window.fmtJ = (n) => `<span class="amt-cur">EGP</span> <span class="amt-num">${Number(n || 0).toLocaleString('en-US')}</span>`;
      window.currentUser = { role: 'admin', perms: [] };
      window.isAdmin = () => currentUser.role === 'admin';
      window.hasPerm = (p) => isAdmin() || (currentUser.perms || []).includes(p);
      window.toasts = []; window.toast = (m, e) => toasts.push((e ? 'ERR:' : '') + m);
      qs('#tx-transaction-date').value = TODAY;
      window.products = [{ _id: 'p1', name: 'Cross Weave Blanket', code: 'CW-1', sellPrice: 1350,
        priceOffers: [{ id: 'o1', price: 1215, from: '2020-01-01', to: '2999-01-01', reason: 'Limited-time offer' }] }];
      window.txItems = [{ productId: 'p1', qty: 2, price: 1215 }];
      window.renders = 0; window.markTxDirty = () => {}; window.calcTxSummary = () => {};
      window.renderTxItems = () => { renders++; const it = txItems[0]; qs('#rows').innerHTML = _offerNoticeHtml(products[0], it.price, { day: TODAY, removed: it.offerRemoved, removeAct: '_txOfferOff(0)', restoreAct: '_txOfferBack(0)' }); };
      window._shopifyEditItems = [{ productId: 'p1', code: 'CW-1', name: 'Cross Weave Blanket', qty: 1, price: 1215, total: 1215 }];
      window._spEditOrder = { shopifyCreatedAt: new Date().toISOString() };
      window._spOfferCtx = () => ({ day: TODAY });
      window._renderShopifyEditItems = () => { const it = _shopifyEditItems[0]; qs('#rows').innerHTML = _offerNoticeHtml(products[0], it.price, { day: TODAY, applyIdx: 0, removed: it.offerRemoved, removeAct: '_spOfferOff(0)', restoreAct: '_spOfferBack(0)' }); };
    }, trKeys, TODAY);
    await page.addScriptTag({ content: code });

    // ── new-sale line ──────────────────────────────────────────────────────────────────────
    await page.evaluate(() => renderTxItems());
    ok(await page.$('#rows .po-notice.is-applied .po-notice-x:not([disabled])'), 'applied offer carries an enabled × for a user with the perm');
    await page.click('#rows .po-notice-x');
    await page.waitForSelector('#po-rm-dlg');
    const impact = await page.$eval('.po-rm-impact', (e) => e.textContent.replace(/\s+/g, ' '));
    ok(/1,215/.test(impact) && /1,350/.test(impact) && /EGP \+270/.test(impact), `dialog states the impact: 1,215 → 1,350, +270 for 2 pcs (${impact.trim()})`);
    ok(!(await page.$('.po-rm-warn')), 'no Shopify warning on a manual sale');
    await page.click('[data-po-rm="ok"]');
    ok((await page.$eval('.po-rm-err', (e) => e.textContent)) !== '', 'confirming with no reason is refused inline');
    await page.keyboard.press('Escape');
    ok(!(await page.$('#po-rm-dlg')) && (await page.evaluate(() => txItems[0].price)) === 1215, 'Escape cancels: the line is untouched');

    await page.click('#rows .po-notice-x'); await page.waitForSelector('#po-rm-dlg');
    await page.click('#po-rm-dlg input[value="__other"]');
    ok(await page.$eval('#po-rm-other', (e) => !e.hidden && document.activeElement === e), '«سبب تاني» reveals and focuses a text field');
    await page.type('#po-rm-other', 'طلب العميل بالسعر الكامل');
    await page.keyboard.press('Enter');
    await new Promise((r) => setTimeout(r, 50));
    const it = await page.evaluate(() => txItems[0]);
    ok(it.price === 1350 && it.offerRemoved.offerId === 'o1' && it.offerRemoved.reason === 'طلب العميل بالسعر الكامل' && !it.offerRemoved.by,
      'take-off: base price, record with offer id + reason (by/at left to the server)');
    const chip = await page.$eval('#rows .po-notice', (e) => ({ cls: e.className, txt: e.textContent }));
    ok(chip.cls.includes('is-removed') && chip.txt.includes('أُزيل') && chip.txt.includes('طلب العميل') && chip.txt.includes('إعادة العرض'), 'line now shows «أُزيل عرض … · السبب» with «إعادة العرض»');
    await page.click('#rows .po-notice-apply');
    const back = await page.evaluate(() => txItems[0]);
    ok(back.price === 1215 && !back.offerRemoved, '«إعادة العرض» puts the offer price back and drops the record');

    // a line typed back to the offer price is not "removed" any more
    ok(await page.evaluate(() => _offerNoticeHtml(products[0], 1215, { removed: { offerId: 'o1', reason: 'x' } }).includes('is-applied')), 'record + offer price = applied, not removed');

    // ── Shopify edit window ────────────────────────────────────────────────────────────────
    await page.evaluate(() => _renderShopifyEditItems());
    await page.click('#rows .po-notice-x'); await page.waitForSelector('#po-rm-dlg');
    ok(await page.$('.po-rm-warn'), 'Shopify line: the dialog warns that the Shopify order is not changed');
    await page.click('#po-rm-dlg input[name="po-rm-r"]'); await page.click('[data-po-rm="ok"]');
    const sp = await page.evaluate(() => _shopifyEditItems[0]);
    ok(sp.price === 1350 && sp.total === 1350 && sp.offerRemoved.reason === 'تم الطلب قبل بدء العرض', 'Shopify line: price and total updated, preset reason stored');
    await page.screenshot({ path: path.resolve(__dirname, '../../../artifacts/offer-remove-chip.png'), clip: { x: 0, y: 0, width: 700, height: 80 } });
    await page.evaluate(() => _spApplyOfferPrice(0));
    ok(await page.evaluate(() => !_shopifyEditItems[0].offerRemoved && _shopifyEditItems[0].price === 1215), '«طبّق سعر العرض» also clears a removal');

    // ── permissions ────────────────────────────────────────────────────────────────────────
    await page.evaluate(() => { currentUser = { role: 'staff', perms: ['transaction'] }; txItems[0] = { productId: 'p1', qty: 1, price: 1215 }; renderTxItems(); });
    ok(await page.$('#rows .po-notice-x[disabled]'), 'without promotions-offers the × is disabled, not hidden');
    await page.evaluate(() => _txOfferOff(0));
    ok(!(await page.$('#po-rm-dlg')) && (await page.evaluate(() => toasts.at(-1))).startsWith('ERR:'), 'and calling it anyway is refused before any dialog');

    // dialog look: ar light and en dark
    await page.evaluate(() => { currentUser = { role: 'admin', perms: [] }; });
    for (const [lang, dark, w] of [['ar', false, 1280], ['en', true, 390]]) {
      await page.setViewport({ width: w, height: 860 });
      await page.evaluate((lang, dark) => { currentLang = lang; document.documentElement.dir = lang === 'en' ? 'ltr' : 'rtl'; document.body.classList.toggle('dark-mode', dark); txItems[0] = { productId: 'p1', qty: 3, price: 1215 }; renderTxItems(); _txOfferOff(0); }, lang, dark);
      await page.waitForSelector('#po-rm-dlg');
      const box = await page.$eval('.po-rm-card', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom }; });
      await page.screenshot({ path: path.resolve(__dirname, `../../../artifacts/offer-remove-dialog-${lang}${dark ? '-dark' : ''}-${w}.png`) });
      ok(box.l >= 0 && box.r <= w + 0.5 && box.b <= 860, `dialog fits the screen at ${w}px ${lang}${dark ? ' dark' : ''}`);
      await page.keyboard.press('Escape');
    }
    ok(!errors.length, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  } catch (e) { failed = true; console.error('✗', e.message); } finally { await browser.close(); }
  if (failed) process.exit(1);
  console.log('offer-remove-line: all checks passed');
})();
