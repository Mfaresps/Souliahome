// New sale form: every piece is scanned or explicitly «بيع بدون مسح» before saving.
// Runs the SHIPPED sales-scanner.js with a minimal form and a fake API.
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict'), puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const js = fs.readFileSync(path.join(root, 'sales-scanner.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'sales-scanner.css'), 'utf8');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.setContent('<html dir="rtl"><body><div id="tx-sale-scanner"></div><div id="tx-items"></div></body></html>');
    await page.addStyleTag({ content: ':root{--primary:#2f7a4f;--border:#ddd;--surface:#fff;--muted:#666;--text:#111}' + css });
    await page.evaluate(() => {
      window.currentLang = 'ar'; window.currentPage = 'transaction'; window.txType = 'مبيعات'; window._txSaving = false;
      window.products = [{ _id: 'p1', code: 'CUS-K-BS', name: 'Stripe Harmony Cushion', sellPrice: 650 }];
      window.txItems = []; window.toasts = [];
      window.toast = (m, e) => toasts.push((e ? 'ERR:' : '') + m);
      window.markTxDirty = () => {}; window.calcTxSummary = () => {}; window._dsbDismissed = false;
      window.hasPerm = () => true; window.getTxAvailableStock = () => 10; window.isProductListable = () => true;
      window.promptAnswer = '2'; window.showPrompt = async () => promptAnswer;
      window.currentUser = { _id: 'u1' };
      window.api = async url => ({ unit: { _id: 'a'.repeat(23) + (url.includes('U-2') ? '2' : '1'), status: 'available', productId: 'p1', warehouseCode: 'MAIN', manualCode: decodeURIComponent(url.split('/').pop()) } });
      window.renderTxItems = () => {
        document.getElementById('tx-items').innerHTML = txItems.map(() => '<div class="tx-item-card"><div class="tx-item-info"><div>item</div></div></div>').join('');
        window.SalesScanner.render();
      };
    });
    await page.addScriptTag({ content: js });
    const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); };
    const line = () => page.evaluate(() => { const b = document.querySelector('.sale-line-scan'); return b && { cls: b.className, txt: b.querySelector('.sale-line-status').textContent, skip: !!b.querySelector('[data-skip]'), unskip: !!b.querySelector('[data-unskip]') }; });

    // product picked from the list → line asks for a scan
    await page.evaluate(() => { txItems.push({ productId: 'p1', qty: 1, price: 650 }); renderTxItems(); });
    let l = await line();
    ok(l.cls.includes('is-need') && l.skip && l.txt.includes('0 / 1'), 'picked product: line asks to scan or sell without scan');
    ok(await page.evaluate(() => SalesScanner.ready() === false && toasts.at(-1).startsWith('ERR:') && document.querySelector('.tx-item-card').classList.contains('sale-line-flash')), 'save is blocked and points at the line');
    ok(await page.evaluate(() => { try { SalesScanner.attach({ warehouseCode: 'MAIN' }); return false; } catch (_) { return true; } }), 'attach refuses an unlinked line too');

    // scanning the piece links it to the same line (qty stays 1)
    await page.evaluate(() => SalesScanner.submit('U-1'));
    await page.waitForFunction(() => document.querySelector('.sale-line-scan.is-done'));
    ok(await page.evaluate(() => txItems.length === 1 && txItems[0].qty === 1 && txItems[0]._saleScans.length === 1), 'scan fills the picked line, quantity unchanged');
    ok(await page.evaluate(() => SalesScanner.ready()), 'fully scanned line can be saved');

    // quantity 3: one scanned, sell 2 without scan through the prompt
    await page.evaluate(() => { txItems[0].qty = 3; renderTxItems(); });
    ok((await line()).txt.includes('1 / 3'), 'qty raised: 1 of 3 linked');
    await page.click('[data-skip]'); await new Promise(r => setTimeout(r, 30));
    l = await line();
    ok(l.cls.includes('is-skip') && l.txt.includes('3 / 3') && l.unskip && !l.skip, 'sell 2 without scan completes the line');
    ok(await page.evaluate(() => SalesScanner.ready()), 'skipped pieces allow saving');

    // a later scan replaces a skipped piece instead of raising the quantity
    await page.evaluate(() => SalesScanner.submit('U-2'));
    await page.waitForFunction(() => txItems[0]._saleScans.length === 2);
    ok(await page.evaluate(() => txItems[0].qty === 3 && txItems[0]._saleSkip === 1), 'scan replaces a skipped piece, qty stays 3');

    // undo skip → asks again; unlink keeps the line
    await page.click('[data-unskip]');
    ok((await line()).cls.includes('is-need'), 'undo skip asks for the piece again');
    await page.click('[data-unlink="0"]');
    ok(await page.evaluate(() => txItems.length === 1 && txItems[0].qty === 3 && txItems[0]._saleScans.length === 1), 'unlinking a piece keeps the line and its quantity');

    // invalid prompt answer is refused
    await page.evaluate(() => { promptAnswer = '9'; toasts.length = 0; });
    await page.click('[data-skip]'); await new Promise(r => setTimeout(r, 30));
    ok(await page.evaluate(() => txItems[0]._saleSkip === 0 && toasts[0]?.startsWith('ERR:')), 'more than the open quantity is refused');

    // purchases are untouched
    ok(await page.evaluate(() => { txType = 'مشتريات'; return SalesScanner.ready(); }), 'purchases are not gated');
    assert.deepEqual(errors, []); console.log('  ✓ no page errors');
    console.log('PASS sales-scan-gate');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
