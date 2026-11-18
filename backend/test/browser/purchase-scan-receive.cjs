// Purchase form «استلام بمسح QR المطبوع»: scanning builds the lines, duplicates and invalid codes are refused,
// removing a scan recalculates, a saved session resumes only if the server still agrees, and saving is one
// request that is retried identically when its outcome is unknown.
// Runs the SHIPPED purchase-scan-receive.js and the real mergeDuplicateTxItems from index.html, with a fake API.
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const js = fs.readFileSync(path.join(root, 'purchase-scan-receive.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'purchase-scan-receive.css'), 'utf8') + fs.readFileSync(path.join(root, 'sales-scanner.css'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const mergeFn = index.slice(index.indexOf('function mergeDuplicateTxItems('), index.indexOf('\n}\n', index.indexOf('function mergeDuplicateTxItems(')) + 3);
assert.ok(mergeFn.includes('_prelabelScans'), 'index.html merge carries the scanned codes');
// The page's real «Enter in a field submits the form» handler — on the transaction page it clicks «Save».
const fnText = name => { const at = index.indexOf('function ' + name + '('); assert.ok(at > 0, name); return index.slice(at, index.indexOf('\n}\n', at) + 3); };
const enterFns = ['collectElementsPreOrder', 'isSubmitButtonVisible', 'getEnterSubmitScopeRoot', 'findPrimarySubmitAfterField', 'handleEnterToSubmit'].map(fnText).join('\n')
  + "\ndocument.addEventListener('keydown', e => { if (e.key === 'Enter') handleEnterToSubmit(e); });";
// The real product-picker functions (the «Select item» window).
const pickerFns = ['_txPickerLineIndex', '_txPickerSync', 'pickerAddItem', 'pickerChangeQty'].map(fnText).join('\n');

const hex = c => c.repeat(24);
async function setup(browser, lang = 'ar', width = 1280) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // A real origin, so localStorage (the saved scan session) is available as in the app.
  const doc = `<html dir="${lang === 'ar' ? 'rtl' : 'ltr'}" lang="${lang}"><body><div class="page active" id="page-transaction"><input type="checkbox" id="tx-scan-receive" onchange="PurchaseScanReceive.toggle(this)"><div id="tx-items"></div><button class="btn btn-primary" id="tx-save-btn" onclick="window.saveCalls++">Save</button></div></body></html>`;
  await page.setRequestInterception(true);
  page.on('request', request => request.url().startsWith('http://soulia.test/') ? request.respond({ contentType: 'text/html', body: doc }) : request.abort());
  await page.goto('http://soulia.test/' + lang);
  await page.evaluate(() => localStorage.clear());
  await page.addStyleTag({ content: ':root{--primary:#2f7a4f;--border:#ddd;--surface:#fff;--muted:#666;--text:#111;--bg-alt:#f6f6f6}body{font-family:sans-serif;margin:16px}' + css });
  await page.evaluate((lang, hexes) => {
    const [A1, A2, A3, PB, LNK, NP, INP] = hexes;
    window.currentLang = lang; window.currentPage = 'transaction'; window.txType = 'مشتريات'; window._txSaving = false; window._dsbDismissed = false;
    window.currentUser = { _id: 'user-1' }; window.saveCalls = 0; window.qs = s => document.querySelector(s);
    window.products = [{ _id: 'pA', code: 'SKU-A', name: 'Basket A', buyPrice: 50 }, { _id: 'pB', code: 'SKU-B', name: 'Tray B', buyPrice: 30 }];
    window.txItems = []; window.toasts = []; window.calls = []; window.modals = [];
    window.toast = (m, e) => toasts.push((e ? 'ERR:' : '') + m);
    window.markTxDirty = () => {}; window.calcTxSummary = () => {}; window.hasPerm = () => true;
    window._txPurchasePrice = p => p.buyPrice; window.showConfirm = async () => window.confirmAnswer !== false;
    window.openModal = h => modals.push(h); window.closeModal = () => {};
    window.labels = {
      'U-A1': { unitId: A1, productId: 'pA', sku: 'SKU-A', state: 'unused', printCount: 1, manualCode: 'U-A1', batchId: 'b1' },
      'U-A2': { unitId: A2, productId: 'pA', sku: 'SKU-A', state: 'unused', printCount: 1, manualCode: 'U-A2', batchId: 'b1' },
      'U-A3': { unitId: A3, productId: 'pA', sku: 'SKU-A', state: 'unused', printCount: 1, manualCode: 'U-A3', batchId: 'b1' },
      'PK-B1': { unitId: PB, productId: 'pB', sku: 'SKU-B', state: 'unused', printCount: 1, manualCode: 'PK-000001-1', isPack: true, quantity: 2, piecesPerPack: 2, batchId: 'b2' },
      'U-LNK': { unitId: LNK, productId: 'pA', state: 'linked', printCount: 1, manualCode: 'U-LNK' },
      'U-NP': { unitId: NP, productId: 'pA', state: 'unused', printCount: 0, manualCode: 'U-NP' },
      'U-INPACK': { unitId: INP, productId: 'pB', state: 'unused', printCount: 1, piecesPerPack: 2, manualCode: 'U-INPACK' },
    };
    window.serverState = {}; // id → state reported by scan-check (default ok)
    window.receiveMode = 'ok';
    const fail = (status, message) => Object.assign(new Error(message), { status });
    window.api = async (url, opts = {}) => {
      calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      if (url.startsWith('/inventory-units/prelabels/lookup')) {
        const id = decodeURIComponent(url.split('identifier=')[1]);
        if (id === 'BAD') throw fail(400, 'bad'); const row = labels[id]; if (!row) throw fail(404, 'nf'); return row;
      }
      if (url === '/inventory-units/prelabels/scan-check') {
        if (window.checkDelay) await new Promise(r => setTimeout(r, window.checkDelay));
        const b = JSON.parse(opts.body), product = id => Object.values(labels).find(l => l.unitId === id)?.productId;
        return { pieces: b.unitIds.map(id => ({ id, productId: product(id), state: serverState[id] || 'ok' })),
          packs: b.packIds.map(id => ({ id, productId: product(id), quantity: 2, state: serverState[id] || 'ok' })) };
      }
      if (url === '/inventory-units/purchases/receive-scanned') {
        if (receiveMode === 'network') throw new Error('Failed to fetch');
        if (receiveMode === '409') throw fail(409, 'تغيرت حالة بعض الأكواد أثناء الاستلام');
        return { transaction: { _id: 'f'.repeat(24), ref: '300' }, receipt: { transactionId: 'f'.repeat(24), linkedUnits: 4, createdUnits: 1,
          lines: [{ name: 'Basket A', sku: 'SKU-A', receivedQty: 2, labelled: true }, { name: 'Tray B', sku: 'SKU-B', receivedQty: 2, labelled: true, packs: 1 }, { name: 'Basket A', sku: 'SKU-A', receivedQty: 1, labelled: false }] } };
      }
      throw fail(500, 'unexpected ' + url);
    };
    window.body = () => txItems.filter(it => it.productId).map(it => ({ productId: it.productId, qty: it.qty, price: it.price, total: it.qty * it.price }));
    window.renderTxItems = () => {
      document.getElementById('tx-items').innerHTML = txItems.map((it, i) => `<div class="tx-item-card"><div class="tx-item-info"><div>${it.productId} × ${it.qty}</div></div><div class="tx-item-qty"><button>-</button><input value="${it.qty}"><button>+</button></div></div>`).join('');
      window.PurchaseScanReceive.render();
    };
  }, lang, [hex('a'), 'a'.repeat(23) + 'b', 'a'.repeat(23) + 'c', hex('b'), hex('c'), hex('d'), hex('e')]);
  await page.addScriptTag({ content: js });
  await page.addScriptTag({ content: mergeFn });
  await page.addScriptTag({ content: enterFns });
  await page.addScriptTag({ content: 'window.updatePickerRowInPlace = () => true; window.filterTxPicker = () => {}; window._txPickerMaxFor = () => -1; window.getTxAvailableStock = () => 7; window.t = k => k;\n' + pickerFns });
  return { page, errors };
}
const scan = async (page, code) => { await page.evaluate(c => PurchaseScanReceive.submit(c), code); await page.waitForFunction(() => !document.querySelector('#tx-purchase-scanner .sale-reader-dot.is-busy')); };
const fb = page => page.evaluate(() => document.querySelector('#tx-purchase-scanner .sale-reader-feedback:last-child')?.textContent || '');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
  try {
    const { page, errors } = await setup(browser);
    // a line already in the form stays one line; all of its pieces are «without label»
    await page.evaluate(() => { txItems.push({ productId: 'pB', qty: 1, price: 30 }); renderTxItems(); document.getElementById('tx-scan-receive').click(); });
    await page.waitForFunction(() => !document.getElementById('tx-purchase-scanner').hidden);
    ok(await page.evaluate(() => txItems.length === 1 && !txItems[0]._prelabelScans && /1 بدون ملصق/.test(document.querySelector('.psr-line').textContent)), 'scan mode on: an existing line reads «1 without label»');
    await page.evaluate(() => { txItems.length = 0; renderTxItems(); });

    // a hand scanner types the code and presses Enter in the scan field: the code is added, the invoice is NOT saved
    await page.type('#psr-code', 'U-A1'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => txItems.length === 1);
    ok(await page.evaluate(() => window.saveCalls === 0 && txItems[0].qty === 1 && document.getElementById('psr-code').value === ''), 'Enter from the scanner adds the code and does not press «Save»');
    await page.focus('#psr-code'); await page.keyboard.press('Enter');
    ok(await page.evaluate(() => window.saveCalls === 0), 'an empty Enter in the scan field does not save either');
    // scanning builds the lines
    await scan(page, 'U-A2');
    ok(await page.evaluate(() => txItems.length === 1 && txItems[0].productId === 'pA' && txItems[0].qty === 2 && txItems[0]._prelabelScans.length === 2), 'two scans of A → one line, quantity 2');
    await scan(page, 'PK-B1');
    ok(await page.evaluate(() => txItems.length === 2 && txItems[1].qty === 2 && txItems[1]._prelabelScans[0].isPack), 'a pack scan adds the whole pack (2 pieces of B)');
    const before = await page.evaluate(() => JSON.stringify(txItems));
    for (const [code, re, label] of [['U-A1', /مُسح بالفعل/, 'a code scanned twice'], ['NOPE', /غير معروف/, 'an unknown code'], ['BAD', /غير صالح/, 'an invalid code'],
      ['U-LNK', /فاتورة سابقة/, 'a code received on an earlier invoice'], ['U-NP', /لم تُطلب طباعته/, 'an unprinted label'], ['U-INPACK', /داخل باك/, 'a piece that sits inside a pack']]) {
      await scan(page, code);
      const got = await fb(page); if (!re.test(got)) console.log("    feedback:", JSON.stringify(got));
      ok(re.test(got) && await page.evaluate(b => JSON.stringify(txItems) === b, before), `${label} is refused and changes nothing`);
    }
    await page.evaluate(() => { labels['U-A1'].state = 'unused'; });
    ok(await page.evaluate(() => document.querySelector('.tx-item-card:nth-child(1) .tx-item-qty button').disabled), '«−» is off while the quantity equals the scanned pieces');

    // ONE line per product: «Add item» or picker + adds a piece without a label to the same line
    await page.evaluate(() => PurchaseScanReceive.addManual('pA'));
    ok(await page.evaluate(() => txItems.length === 2 && txItems[0].qty === 3 && txItems[0]._prelabelScans.length === 2 && /2 ممسوحة/.test(document.querySelector('.psr-line').textContent) && /1 بدون ملصق/.test(document.querySelector('.psr-line').textContent)), '«Add item» on a scanned product: one line, 2 scanned + 1 without label');
    ok(await page.evaluate(() => !document.querySelector('.tx-item-card:nth-child(1) .tx-item-qty button').disabled), '«−» is available again for the unlabelled piece');
    ok(await page.evaluate(() => { pickerChangeQty('pB', 1); return txItems.length === 2 && txItems[1].qty === 3 && txItems[1]._prelabelScans.length === 1; }), 'picker + on a product whose pieces were all scanned adds a piece to the same line (the reported case)');
    ok(await page.evaluate(() => { pickerChangeQty('pB', -1); toasts.length = 0; pickerChangeQty('pB', -1); return txItems[1].qty === 2 && toasts[0]?.startsWith('ERR:'); }), 'picker − stops at the scanned pieces and says to remove a code');
    ok(await page.evaluate(() => { txItems.push({ productId: 'pA', qty: 1, price: 50 }); mergeDuplicateTxItems(true); const ok1 = txItems.length === 2 && txItems[0].qty === 4 && txItems[0]._prelabelScans.length === 2; pickerChangeQty('pA', -1); return ok1 && txItems[0].qty === 3; }), 'a duplicate line of a product merges into the one line');

    // removing a scan lowers the quantity; the unlabelled pieces stay; the last piece removes the line
    await scan(page, 'U-A3');
    ok(await page.evaluate(() => txItems[0].qty === 4 && txItems[0]._prelabelScans.length === 3), 'a scan adds one more piece to the line');
    await page.click('.tx-item-card:nth-child(1) [data-psr-unscan="2"]');
    ok(await page.evaluate(() => txItems[0].qty === 3 && txItems[0]._prelabelScans.map(s => s.code).join() === 'U-A1,U-A2'), 'removing a scanned code lowers the quantity, the unlabelled piece stays');
    await page.click('.tx-item-card:nth-child(2) [data-psr-unscan="0"]');
    ok(await page.evaluate(() => txItems.length === 1 && !txItems.some(it => it.productId === 'pB')), 'removing the only code of a line with no other piece removes the line');
    await scan(page, 'PK-B1');
    ok(await page.evaluate(() => calls.every(c => !c.url.includes('receive-scanned'))), 'nothing is sent to the receipt endpoint before saving');

    // the session is kept on the device
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('soulia-scan-receive:v1:user-1:session')));
    ok(stored.lines.length === 2 && stored.lines[0].qty === 3 && stored.lines[0].scans.length === 2, 'the scan session is saved on this device');

    // attach: lines and scans line up with the invoice items
    const attached = await page.evaluate(() => { const b = { items: body(), warehouseCode: 'MAIN', transactionDate: '2026-11-15', ref: '300', _debtAcked: true }; PurchaseScanReceive.attach(b); return b._scanReceive; });
    ok(attached.scans.length === 2 && attached.scans[0].lineIndex === 0 && attached.scans[0].unitIds.length === 2 && attached.invoice.items[0].qty === 3 && attached.scans[1].lineIndex === 1 && attached.scans[1].packIds.length === 1 && attached.pieces === 4 && attached.unlabelled === 1 && !('_debtAcked' in attached.invoice), 'the request sends one line of 3 with its 2 codes (the third gets a new barcode)');

    // unknown outcome → pending, the same request is retried; a definite answer clears it
    await page.evaluate(() => { receiveMode = 'network'; });
    const unknown = await page.evaluate(async () => { const b = { items: body(), warehouseCode: 'MAIN', transactionDate: '2026-11-15', ref: '300' }; PurchaseScanReceive.attach(b); try { await PurchaseScanReceive.save(b); } catch (e) { return { msg: e.message, key: b._scanReceive.operationKey }; } });
    ok(/غير مؤكدة/.test(unknown.msg) && await page.evaluate(() => !!localStorage.getItem('soulia-scan-receive:v1:user-1:pending')), 'a lost connection keeps the request as pending');
    ok(await page.evaluate(() => !document.querySelector('[data-psr-pending]')?.hidden || !!document.querySelector('[data-psr-retry]')), 'the panel offers to retry the pending receipt');
    const sameKey = await page.evaluate(() => { const b = { items: body(), warehouseCode: 'MAIN', transactionDate: '2026-11-15', ref: '300', date: 'later' }; PurchaseScanReceive.attach(b); return b._scanReceive.operationKey; });
    ok(sameKey === unknown.key, 'saving the same invoice again reuses the same operation key');
    ok(await page.evaluate(() => { try { PurchaseScanReceive.attach({ items: body(), warehouseCode: 'MAIN', transactionDate: '2026-11-15', ref: '999' }); return false; } catch (e) { return /معلق/.test(e.message); } }), 'a different invoice is refused while one is pending');
    await page.evaluate(() => { receiveMode = 'ok'; });
    const sent = await page.evaluate(async () => { const n = calls.length; const b = { items: body(), warehouseCode: 'MAIN', transactionDate: '2026-11-15', ref: '300' }; PurchaseScanReceive.attach(b); const r = await PurchaseScanReceive.save(b); return { r, req: calls.slice(n).find(c => c.url.includes('receive-scanned')).body }; });
    ok(sent.req.operationKey === unknown.key && sent.r._scanReceipt.linkedUnits === 4, 'the retry sends the identical request and returns the receipt');
    ok(await page.evaluate(() => !localStorage.getItem('soulia-scan-receive:v1:user-1:pending') && !localStorage.getItem('soulia-scan-receive:v1:user-1:session')), 'after saving, the pending request and the session are cleared');
    await page.evaluate(() => PurchaseScanReceive.showSummary({ transactionId: 'f'.repeat(24), linkedUnits: 4, createdUnits: 1, lines: [{ name: 'Basket A', sku: 'SKU-A', receivedQty: 3, labelled: true, linkedUnits: 2, createdUnits: 1 }] }));
    ok(await page.evaluate(() => /2 ممسوحة/.test(modals.at(-1)) && /1 باركود جديد/.test(modals.at(-1)) && /openPurchaseReceiptLabels/.test(modals.at(-1))), 'the summary shows scanned and new barcodes on one line and opens their label printing');

    // a definite refusal (409) clears the pending request and re-checks the scans
    await page.evaluate(() => { receiveMode = '409'; serverState[labels['U-A1'].unitId] = 'linked'; });
    await page.evaluate(async () => { const b = { items: body(), warehouseCode: 'MAIN', transactionDate: '2026-11-15', ref: '301' }; PurchaseScanReceive.attach(b); try { await PurchaseScanReceive.save(b); } catch (_) {} });
    await page.waitForFunction(() => !!document.querySelector('.psr-outdated'));
    ok(await page.evaluate(() => !localStorage.getItem('soulia-scan-receive:v1:user-1:pending') && /U-A1/.test(document.querySelector('.psr-outdated').textContent) && document.getElementById('psr-code').disabled), 'a refused save re-checks the codes and blocks the changed session');
    ok(await page.evaluate(() => { try { PurchaseScanReceive.attach({ items: body(), warehouseCode: 'MAIN' }); return false; } catch (e) { return true; } }), 'an outdated session cannot be saved');
    await page.click('[data-psr-restart]');
    ok(await page.evaluate(() => txItems.length === 1 && txItems[0].qty === 1 && !txItems[0]._prelabelScans && !document.querySelector('.psr-outdated')), '«Start scanning again» drops the scanned pieces and keeps the unlabelled one');

    // resume on a fresh form: allowed when the server agrees, refused when a code changed
    await page.evaluate(() => { serverState = {}; receiveMode = 'ok'; txItems.length = 0; PurchaseScanReceive.reset(); renderTxItems(); document.getElementById('tx-scan-receive').checked = true; return PurchaseScanReceive.toggle(document.getElementById('tx-scan-receive')); });
    await scan(page, 'U-A1'); await scan(page, 'PK-B1');
    await page.evaluate(() => { txItems.length = 0; PurchaseScanReceive.reset(); document.getElementById('tx-scan-receive').checked = true; return PurchaseScanReceive.toggle(document.getElementById('tx-scan-receive')); });
    await page.waitForFunction(() => !!document.querySelector('[data-psr-resume]'));
    ok(true, 'a fresh form offers to resume the saved session');
    await page.click('[data-psr-resume]');
    await page.waitForFunction(() => txItems.length === 2);
    ok(await page.evaluate(() => txItems[0].qty === 1 && txItems[1].qty === 2 && calls.at(-1).url.includes('scan-check')), 'resume re-checks every code with the server, then restores the lines');
    await page.evaluate(() => { txItems.length = 0; PurchaseScanReceive.reset(); serverState[labels['PK-B1'].unitId] = 'linked'; document.getElementById('tx-scan-receive').checked = true; return PurchaseScanReceive.toggle(document.getElementById('tx-scan-receive')); });
    await page.click('[data-psr-resume]');
    await page.waitForFunction(() => !!document.querySelector('.psr-outdated'));
    ok(await page.evaluate(() => txItems.length === 0 && /PK-000001-1/.test(document.querySelector('.psr-outdated').textContent)), 'a session whose codes changed on the server is not resumed');
    await page.click('[data-psr-restart]');
    ok(await page.evaluate(() => !localStorage.getItem('soulia-scan-receive:v1:user-1:session') && !document.querySelector('[data-psr-resume]')), 'the outdated session is discarded');

    // a page snapshot that brings scans back is checked before it can be saved
    await page.evaluate(() => { serverState = {}; window.checkDelay = 400; labels['U-A4'] = { unitId: '9'.repeat(24), productId: 'pA', state: 'unused', printCount: 1, manualCode: 'U-A4' }; txItems = [{ productId: 'pA', qty: 1, price: 50, _prelabelScans: [{ id: '9'.repeat(24), isPack: false, quantity: 1, code: 'U-A4', productId: 'pA' }] }]; renderTxItems(); });
    ok(await page.evaluate(() => { try { PurchaseScanReceive.attach({ items: body(), warehouseCode: 'MAIN' }); return false; } catch (_) { return true; } }), 'scans restored by a snapshot are not saved before the check');
    await page.waitForFunction(() => !document.querySelector('.psr-checking'));
    ok(await page.evaluate(() => { const b = { items: body(), warehouseCode: 'MAIN', transactionDate: 'x', ref: '1' }; PurchaseScanReceive.attach(b); return b._scanReceive.scans.length === 1; }), 'after the check passes the receipt can be saved');

    // turning the mode off asks, then removes the scanned lines; a receipt with no scan is refused
    await page.evaluate(() => { confirmAnswer = false; const c = document.getElementById('tx-scan-receive'); c.checked = false; return PurchaseScanReceive.toggle(c); });
    ok(await page.evaluate(() => PurchaseScanReceive.active() && document.getElementById('tx-scan-receive').checked), 'cancelling the «turn off» question keeps the scans');
    await page.evaluate(() => { txItems = [{ productId: 'pA', qty: 2, price: 50 }]; renderTxItems(); });
    ok(await page.evaluate(() => { try { PurchaseScanReceive.attach({ items: body(), warehouseCode: 'MAIN' }); return false; } catch (e) { return /لم يُمسح/.test(e.message); } }), 'a receipt with no scanned label is refused');
    assert.deepEqual(errors, []); console.log('  ✓ no page errors (ar)');
    await page.close();

    // English + phone width: the panel fits and reads left to right
    const en = await setup(browser, 'en', 390);
    await en.page.evaluate(() => { const c = document.getElementById('tx-scan-receive'); c.checked = true; return PurchaseScanReceive.toggle(c); });
    await scan(en.page, 'U-A1'); await scan(en.page, 'NOPE');
    const layout = await en.page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, txt: document.getElementById('tx-purchase-scanner').textContent }));
    ok(layout.over <= 0 && /Scanner ready/.test(layout.txt) && /Unknown code/.test(layout.txt), 'English at 390px: no horizontal overflow, English messages');
    await en.page.screenshot({ path: path.resolve(__dirname, '../../../artifacts/purchase-scan-receive-en-390.png'), fullPage: true });
    assert.deepEqual(en.errors, []); console.log('  ✓ no page errors (en)');
    console.log('PASS purchase-scan-receive');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
