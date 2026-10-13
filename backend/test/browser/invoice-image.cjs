/* Real Chromium canvas/PNG and clipboard flows, without network or live orders.
 * Run: node backend/test/browser/invoice-image.cjs
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const html = fs.readFileSync(path.join(root, 'frontend/public/index.html'), 'utf8');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc\s*=/.test(match[1]) && !/type\s*=\s*["']application\//.test(match[1])) new vm.Script(match[2]);
}
const script = fs.readFileSync(path.join(root, 'frontend/public/invoice-image.js'), 'utf8');
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true, timeout: 15000 });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<html lang="ar"><body></body></html>');
    await page.addScriptTag({ content: `
      var currentLang = 'ar', settings = { companyLegalName: 'SOULIA' };
      var messages = [], downloads = [], written = [];
      function toast(message, error) { messages.push({message, error: !!error}); }
      function t(key) { return key; }
      function isStatusCancelled(value) { return value === 'ملغى'; }
      function isMovExchangeSale() { return false; }
      var transactions = [{ _id: 'tx-1', ref: '2719', type: 'مبيعات', client: 'عميل تجريبي',
        date: '2026-10-13', phone: '01000000000', shippingAddress: 'القاهرة', total: 650,
        deposit: 100, remaining: 550, shipCost: 50, discount: 100,
        items: [{ name: 'منتج تجريبي', qty: 2, price: 350, total: 700 }] }];
      var order = { ...transactions[0], _id: 'order-1', approvedDeposit: 80 };
      function _spOrderById(id) { return id === order._id ? order : null; }
      function _spDepositOf(o) { return {deposit: o.approvedDeposit, primaryMethod: 'Instapay'}; }
      HTMLAnchorElement.prototype.click = function() { downloads.push({name:this.download, url:this.href}); };
    ` });
    // Use the shipped Shopify preview adapter rather than a second money implementation.
    const adapter = html.slice(html.indexOf('function _spPeekPrintTx(o) {'), html.indexOf('function printSpPeekPreview(orderId)'));
    const actionsHelper = html.slice(html.indexOf('function invoiceImageActions('), html.indexOf('function printInvoice(id)'));
    const escapeHelper = html.slice(html.indexOf('function esc(str) {'), html.indexOf('\n/**', html.indexOf('function esc(str) {')));
    const escapeAttributeHelper = html.match(/function escHtml\(s\) \{[^\n]+/)[0];
    const menuHelper = html.slice(html.indexOf('function closeAllMenus() {'), html.indexOf("document.addEventListener('click', closeAllMenus);"));
    await page.addScriptTag({ content: 'function closeDatePicker() {}\n' + escapeHelper + '\n' + escapeAttributeHelper + '\n' + menuHelper + '\n' + adapter + '\n' + actionsHelper + '\n' + script });
    const result = await page.evaluate(async () => {
      const text = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(value, ...args) { text.push(String(value)); return original.call(this, value, ...args); };
      async function clickMenu(source, id, action) {
        closeAllMenus();
        document.body.innerHTML = '<div class="actions-dd"><button id="menu-toggle" onclick="toggleActionMenu(event)">Options</button><div class="dd-menu">' + invoiceImageActions(source, id) + '</div></div>';
        document.querySelector('#menu-toggle').click();
        const buttons = document.querySelectorAll('.dd-menu-portal:not(.show), .dd-menu-portal.show');
        const portal = buttons[buttons.length - 1];
        const before = messages.length;
        portal.querySelectorAll('.dd-item')[action === 'copy' ? 1 : 0].click();
        for (let i = 0; messages.length === before && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
        if (messages.length === before) throw new Error('Menu click did not trigger invoice action: ' + source + '/' + action);
      }
      await clickMenu('transaction', 'tx-1', 'download');
      const png = await (await fetch(downloads[0].url)).blob();
      const bitmap = await createImageBitmap(png);
      const info = {type: png.type, bytes: png.size, width: bitmap.width, height: bitmap.height};
      const arText = text.splice(0);
      await clickMenu('shopify', 'order-1', 'download');
      const previewText = text.splice(0);
      await clickMenu('transaction', 'tx-1', 'copy');
      const unsupported = messages.at(-1);
      Object.defineProperty(window, 'isSecureContext', {value:true, configurable:true});
      window.ClipboardItem = class { constructor(data) { this.data = data; } };
      Object.defineProperty(navigator, 'clipboard', {value:{write: async items => {
        const blob = await items[0].data['image/png']; written.push({type:blob.type, size:blob.size});
      }}, configurable:true});
      await clickMenu('transaction', 'tx-1', 'copy');
      const copied = messages.at(-1);
      await clickMenu('shopify', 'order-1', 'copy');
      const shopifyCopied = messages.at(-1);
      navigator.clipboard.write = async () => { throw new Error('Permission denied'); };
      await exportInvoiceImage('transaction', 'tx-1', 'copy');
      const denied = messages.at(-1);
      transactions[0].purchaseDetailsHidden = true;
      const before = downloads.length;
      await exportInvoiceImage('transaction', 'tx-1', 'download');
      const restricted = {message:messages.at(-1), unchanged:downloads.length === before};
      transactions[0].purchaseDetailsHidden = false;
      transactions[0].items[0].name = 'اسم منتج طويل '.repeat(40);
      const long = await buildCompactInvoiceCanvas(transactions[0]);
      currentLang = 'en';
      await exportInvoiceImage('transaction', 'tx-1', 'download');
      const english = text.splice(0);
      const actions = invoiceImageActions('transaction', 'tx-1');
      return {info, arText, previewText, unsupported, copied, shopifyCopied, denied, restricted,
        longHeight:long.height, english, actions, written, downloads};
    });
    assert.equal(result.info.type, 'image/png');
    assert.equal(result.info.width, 1440);
    assert.ok(result.info.bytes > 10000);
    for (const expected of ['650 EGP', '100 EGP', '550 EGP', 'الشحن', 'الخصم']) assert.ok(result.arText.includes(expected), expected);
    assert.ok(result.previewText.includes('معاينة — فاتورة مختصرة'));
    assert.ok(result.previewText.includes('80 EGP'));
    assert.ok(result.previewText.includes('570 EGP'));
    assert.equal(result.unsupported.error, true);
    assert.equal(result.copied.error, false);
    assert.equal(result.shopifyCopied.error, false);
    assert.equal(result.written.length, 2);
    assert.equal(result.written[0].type, 'image/png');
    assert.equal(result.denied.error, true);
    assert.equal(result.restricted.message.error, true);
    assert.equal(result.restricted.unchanged, true);
    assert.ok(result.longHeight > result.info.height);
    assert.ok(result.english.includes('Invoice summary'));
    assert.ok(result.actions.includes('Download invoice image'));
    assert.equal(result.downloads[0].name, 'invoice-2719.png');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: transaction and Shopify menu clicks, PNG rendering, totals, approved deposit, wrapping, clipboard, restrictions, and shipped HTML syntax');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
