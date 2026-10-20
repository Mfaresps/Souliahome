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
    const imageRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      imageRequests.push(request.url());
      if (request.url().endsWith('/slow.svg')) return;
      if (request.url().endsWith('/missing.svg')) return request.respond({status:404, body:''});
      return request.respond({status:200, contentType:'image/svg+xml',
        headers:request.url().endsWith('/blocked.svg') ? {} : {'Access-Control-Allow-Origin':'*'},
        body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#ff0000"/></svg>'});
    });
    await page.setContent('<html lang="ar"><body></body></html>');
    await page.addScriptTag({ content: `
      var currentLang = 'ar', settings = { companyLegalName: 'SOULIA' }, products = [];
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
    const actionsHelper = html.slice(html.indexOf('function invoiceImageActions('), html.indexOf('async function printInvoice(id)'));
    const escapeHelper = html.slice(html.indexOf('function esc(str) {'), html.indexOf('\n/**', html.indexOf('function esc(str) {')));
    const escapeAttributeHelper = html.match(/function escHtml\(s\) \{[^\n]+/)[0];
    const menuHelper = html.slice(html.indexOf('function closeAllMenus() {'), html.indexOf("document.addEventListener('click', closeAllMenus);"));
    const sanitizeHelper = html.slice(html.indexOf('function sanitizeUrl(url) {'), html.indexOf('\n/**', html.indexOf('function sanitizeUrl(url) {')));
    const imageHelper = html.slice(html.indexOf('function _pwItemImgUrl(it) {'), html.indexOf('\n/**', html.indexOf('function _pwItemImgUrl(it) {')));
    await page.addScriptTag({ content: 'function closeDatePicker() {}\n' + escapeHelper + '\n' + escapeAttributeHelper + '\n' + menuHelper + '\n' + adapter + '\n' + actionsHelper + '\n' + sanitizeHelper + '\n' + imageHelper + '\n' + script });
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
        for (let i = 0; messages.length === before && i < 350; i++) await new Promise(resolve => setTimeout(resolve, 10));
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
      const modernClipboardItem = window.ClipboardItem;
      window.ClipboardItem = class {
        constructor(data) {
          if (!(data['image/png'] instanceof Blob)) throw new TypeError('Expected Blob');
          this.data = data;
        }
      };
      await clickMenu('shopify', 'order-1', 'copy');
      const legacyCopied = messages.at(-1);
      window.ClipboardItem = modernClipboardItem;
      const modernWrite = navigator.clipboard.write;
      navigator.clipboard.write = async items => {
        if (!(items[0].data['image/png'] instanceof Blob)) throw new TypeError('Promise data unsupported');
        return modernWrite(items);
      };
      await clickMenu('shopify', 'order-1', 'copy');
      const legacyWriteCopied = messages.at(-1);
      navigator.clipboard.write = async () => { throw new DOMException('Permission denied', 'NotAllowedError'); };
      currentLang = 'en';
      await exportInvoiceImage('shopify', 'order-1', 'copy');
      const permissionDenied = messages.at(-1);
      currentLang = 'ar';
      navigator.clipboard.write = async () => { throw new Error('Permission denied'); };
      await exportInvoiceImage('transaction', 'tx-1', 'copy');
      const denied = messages.at(-1);
      const buildCanvas = buildCompactInvoiceCanvas;
      buildCompactInvoiceCanvas = async () => { throw new Error('Identity lookup failed'); };
      await exportInvoiceImage('shopify', 'order-1', 'copy');
      const renderFailed = messages.at(-1);
      buildCompactInvoiceCanvas = buildCanvas;
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
      currentLang = 'ar';
      const sample = {...transactions[0].items[0], name:'منتج تجريبي', imageUrl:'http://images.test/good.svg'};
      products = [{_id:'catalogue-1', code:'CAT', imageUrl:'http://images.test/catalogue.svg'}];
      const photos = await loadInvoiceThumbnails([sample, sample,
        {...sample,imageUrl:'',productId:'catalogue-1'},
        {...sample,imageUrl:'http://images.test/missing.svg'},
        {...sample,imageUrl:'http://images.test/blocked.svg'}]);
      const photoFlags = photos.map(Boolean);
      const deduped = photos[0] === photos[1];
      const portrait = await buildCompactInvoiceCanvas({...transactions[0],items:[sample]});
      const portraitPixels = portrait.getContext('2d').getImageData(0,0,portrait.width,portrait.height).data;
      let redPixels = 0;
      for (let i=0;i<portraitPixels.length;i+=4) if (portraitPixels[i]>240 && portraitPixels[i+1]<20 && portraitPixels[i+2]<20) redPixels++;
      const layouts = [];
      let landscapePreview;
      for (const count of [5,6,12,30,60]) {
        const multi = {...transactions[0],items:Array.from({length:count},(_,i)=>({...sample,name:'منتج رقم '+(i+1)}))};
        const start = text.length;
        const sheet = await buildCompactInvoiceCanvas(multi);
        const rendered = text.slice(start);
        layouts.push({count,width:sheet.width,height:sheet.height,
          allItems:multi.items.every(item=>rendered.includes(item.name)),png:sheet.toDataURL('image/png').startsWith('data:image/png')});
        if(count===12) landscapePreview=sheet.toDataURL('image/png');
      }
      const started = performance.now();
      const slow = await buildCompactInvoiceCanvas({...transactions[0],items:[{...sample,imageUrl:'http://images.test/slow.svg'}]});
      const slowMs = performance.now()-started;
      const fallbackPng = slow.toDataURL('image/png').startsWith('data:image/png');
      return {info, arText, previewText, unsupported, copied, shopifyCopied, legacyCopied, legacyWriteCopied,
        permissionDenied, renderFailed, denied, restricted,
        longHeight:long.height, english, actions, written, downloads,
        photoFlags,deduped,redPixels,layouts,slowMs,fallbackPng,
        portraitPreview:portrait.toDataURL('image/png'),landscapePreview};
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
    assert.equal(result.legacyCopied.error, false);
    assert.equal(result.legacyWriteCopied.error, false);
    assert.equal(result.written.length, 4);
    assert.equal(result.written[0].type, 'image/png');
    assert.equal(result.permissionDenied.error, true);
    assert.match(result.permissionDenied.message, /Allow clipboard access/);
    assert.equal(result.renderFailed.error, true);
    assert.match(result.renderFailed.message, /Identity lookup failed/);
    assert.equal(result.denied.error, true);
    assert.equal(result.restricted.message.error, true);
    assert.equal(result.restricted.unchanged, true);
    assert.ok(result.longHeight > result.info.height);
    assert.ok(result.english.includes('Invoice summary'));
    assert.ok(result.actions.includes('Download invoice image'));
    assert.equal(result.downloads[0].name, 'invoice-2719.png');
    assert.deepEqual(result.photoFlags,[true,true,true,false,false]);
    assert.equal(result.deduped,true);
    assert.ok(imageRequests.includes('http://images.test/catalogue.svg'));
    assert.ok(result.redPixels>1000, 'product photo actually appears in the exported pixels');
    for (const layout of result.layouts) {
      assert.equal(layout.allItems,true, 'every item rendered at count '+layout.count);
      assert.equal(layout.png,true);
      if(layout.count>=6) assert.ok(layout.width>layout.height, 'horizontal image at count '+layout.count);
      else assert.equal(layout.width,1440);
    }
    assert.ok(result.slowMs<2600, 'slow image does not block receipt generation');
    assert.equal(result.fallbackPng,true);
    // Exercise the real ClipboardItem and OS clipboard, with a trusted click on localhost.
    const clipboardPage = await browser.newPage();
    await clipboardPage.setRequestInterception(true);
    clipboardPage.on('request', request => request.respond({status:200, contentType:'text/html', body:'<button id="copy" onclick="exportInvoiceImage(\'shopify\',\'order-1\',\'copy\')">Copy</button>'}));
    await clipboardPage.goto('http://localhost:18765');
    await browser.defaultBrowserContext().overridePermissions('http://localhost:18765', ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    await clipboardPage.addScriptTag({content: `
      var currentLang = 'en', settings = {}, messages = [];
      function toast(message, error) { messages.push({message, error:!!error}); }
      function t(key) { return key; }
      function _spOrderById() { return {ref:'real-clipboard', items:[{name:'Product', qty:1, price:100, total:100}], total:100}; }
      function _spDepositOf() { return {deposit:0}; }
    ` + adapter + '\n' + script});
    await clipboardPage.bringToFront();
    await clipboardPage.click('#copy');
    await clipboardPage.waitForFunction('messages.length > 0');
    const realMessage = await clipboardPage.evaluate(() => messages.at(-1));
    assert.equal(realMessage.error, false, realMessage.message);
    const realClipboard = await clipboardPage.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const png = await items[0].getType('image/png');
      return {message:messages.at(-1), type:png.type, size:png.size};
    });
    assert.equal(realClipboard.message.error, false, realClipboard.message.message);
    assert.equal(realClipboard.type, 'image/png');
    assert.ok(realClipboard.size > 1000);
    await clipboardPage.close();
    if(process.argv.includes('--preview')) {
      const folder=require('node:os').tmpdir();
      for(const [name,data] of [['portrait',result.portraitPreview],['landscape',result.landscapePreview]]) {
        const file=path.join(folder,'soulia-invoice-'+name+'.png');
        fs.writeFileSync(file,Buffer.from(data.split(',')[1],'base64'));
        console.log('Preview: '+file);
      }
    }
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS: real PNG clipboard write/read, legacy clipboard fallbacks, permission/render errors, menu clicks, totals, photos, landscape grids, and shipped HTML syntax');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
