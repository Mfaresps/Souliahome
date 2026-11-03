const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');

// Exercise the real application shell, router and global CSS with isolated API fixtures.
const batchId = '507f1f77bcf86cd799439033';
const batch = { batchId, productId: '507f1f77bcf86cd799439011', sku: 'Code 53 - 40size',
  productName: 'Brown jute coaster 40cm', quantity: 100, printed: 40, linked: 20, unused: 80,
  firstUnprinted: 41, createdAt: '2026-11-03T08:00:00Z', createdBy: 'System Manager',
  source: 'internal-prepurchase', printRequests: 2, lastPrintRequestedAt: '2026-11-03T09:00:00Z' };
(async () => {
  const browser = await puppeteer.launch({ headless: true, ...(process.platform === 'win32' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}) });
  const artifacts = path.resolve(__dirname, '../../../artifacts/preprinted-labels');
  mkdirSync(artifacts, { recursive: true });
  const page = await browser.newPage(), errors = [];
  try {
    page.on('pageerror', e => {
      // The isolated fixture leaves the unrelated stock-movement view unhydrated.
      if (!String(e.stack || '').includes('at renderMovements ')) errors.push(e.stack || e.message);
    });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('token', 'isolated-supplier-page-test');
      localStorage.setItem('user', JSON.stringify({ name: 'System Manager', role: 'admin', perms: [] }));
    });
    await page.setRequestInterception(true);
    page.on('request', async req => {
      const url = new URL(req.url()), pathname = url.pathname;
      if (pathname === '/supplier-labels.js') return setTimeout(() => req.continue(), 250);
      if (!pathname.startsWith('/api/')) return req.continue();
      let data = [];
      if (pathname === '/api/auth/me') data = { name: 'System Manager', role: 'admin', perms: [] };
      if (pathname === '/api/settings' || pathname === '/api/transactions/dashboard') data = {};
      if (pathname === '/api/inventory-units/receipts') data={receipts:[],total:0};
      if (pathname === '/api/inventory-units/units') data={units:[],total:0,products:[]};
      if (pathname === '/api/products') data = [{ _id: batch.productId, name: batch.productName, code: batch.sku, isActive: true }];
      if (pathname === '/api/inventory-units/prelabels/batches/page') data = { batches: [batch], page: 1, totalPages: 1, total: 1 };
      if (pathname === '/api/inventory-units/prelabels/batches/' + batchId) data = { batch, linkedPurchases: [], linkedPurchaseTotal: 0, linkedPurchaseLimit: 20 };
      if (pathname === '/api/inventory-units/config') data = { statuses:['available'], symbology:'QR', labelSizes: [{ id: '50x25', widthMm: 50, heightMm: 25 }] };
      if (pathname === '/api/warehouse-layout') data = { warehouses:[{ code:'MAIN', name:'Main warehouse' }], locations:[], labelSizes:[{ id:'50x25', widthMm:50, heightMm:25 }] };
      if (pathname === '/api/inventory-units/prelabels/batches/' + batchId + '/preview') {
        const body = JSON.parse(req.postData());
        data = { size:{id:'50x25',widthMm:50,heightMm:25,qrMm:17,marginMm:1.5}, selectionHash:'a'.repeat(64),
          labels:await Promise.all(Array.from({length:body.quantity},async(_,i)=>{
            const unitId=(1000+i).toString(16).padStart(24,'0'), barcode='SU-'+unitId.toUpperCase();
            return {unitId,barcode,manualCode:'U-0000-'+String(i+1).padStart(4,'0')+'-8',productName:'Ribbon Storage',sku:'Code 32',printCount:1,svg:await QRCode.toString(barcode,{type:'svg',margin:4})};
          })) };
      }
      if (pathname === '/api/inventory-units/prelabels/bulk/preview') {
        const selection = JSON.parse(req.postData()), reprints = selection.mode === 'all-unused' ? 20 : 0, total = 60 + reprints;
        data = { total, reprints, maxLabels:1000, selectionHash:'a'.repeat(64), labels:[], summary:[{...batch,printable:total,reprints}] };
      }
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    for (const width of [1440, 768, 390]) {
      await page.setViewport({ width, height: 900 });
      await page.goto('http://127.0.0.1:8080/#warehouse-management/supplier-labels', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#page-supplier-labels.active [data-batch]', { timeout: 20000 });
      await page.waitForFunction(() => !document.querySelector('#splash-screen'));
      assert.equal(await page.$('#sidebar [data-page="supplier-labels"]'),null);
      assert(await page.$('#sidebar [data-page="barcodes"].active'));
      assert(await page.$('#page-barcodes.active #page-supplier-labels'));
      assert.equal(await page.$eval('#iu-tab-supplier-labels',el=>el.getAttribute('aria-selected')),'true');
      for (const view of ['list', 'detail', 'new']) {
        if (view === 'detail') { await page.click('[data-open-batch]'); await page.waitForSelector('#sl-print'); }
        if (view === 'new') { await page.$eval('#sl-back',el=>el.scrollIntoView({block:'center',behavior:'instant'})); await page.click('#sl-back'); await page.waitForSelector('#sl-new'); await page.click('#sl-new'); await page.waitForSelector('[data-product]'); }
        // Pixel bounds catch clipped/transformed layouts that scrollWidth alone misses.
        const bounds = await page.$eval('.sl-workspace', el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, viewport: innerWidth }; });
        assert(bounds.left >= -1 && bounds.right <= width + 1, `${view} at ${width}: ${JSON.stringify(bounds)}`);
        assert.equal(await page.$('dialog[open]'), null);
        await page.screenshot({ path: path.join(artifacts, `app-${view}-${width}.png`), fullPage: true });
        if (view === 'detail') {
          await page.$eval('#sl-print-quantity',el=>{el.value='10';});
          await page.click('#sl-print');
          await page.waitForSelector('#slp-confirm',{timeout:15000});
          const geometry=await page.$eval('#sl-print-preview',el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,overflow:el.scrollWidth>el.clientWidth+1};});
          assert(geometry.x>=0 && geometry.y>=0 && geometry.right<=width && geometry.bottom<=900 && !geometry.overflow,JSON.stringify(geometry));
          assert.equal(await page.$eval('#slp-print',el=>el.disabled),true);
          await page.screenshot({path:path.join(artifacts,`app-print-preview-${width}.png`)});
          await page.keyboard.press('Escape'); await page.waitForSelector('#sl-print-preview',{hidden:true});
          assert.equal(await page.evaluate(()=>document.activeElement.id),'sl-print');
        }
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#page-supplier-labels.active [data-product]');
      assert.equal(new URL(page.url()).hash, '#warehouse-management/supplier-labels/new');
      await page.click('#sl-cancel'); await page.waitForSelector('[data-batch]');
      await page.click('[data-open-batch]'); await page.waitForSelector('#sl-print');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#page-supplier-labels.active #sl-print', {timeout:15000}).catch(async error => {
        throw new Error(JSON.stringify({width, url:page.url(), state:await page.evaluate(()=>({current:currentPage, message:document.querySelector('#sl-message')?.textContent, title:document.querySelector('#sl-title')?.textContent})),errors}) + ' ' + error.message);
      });
      assert.equal(new URL(page.url()).hash, '#warehouse-management/supplier-labels/batch/' + batchId);
      await page.goBack(); await page.waitForSelector('#sl-query');
      await page.waitForSelector('[data-select-batch]'); await page.click('#sl-select-page'); await page.click('#sl-review-print');
      await page.waitForSelector('.sl-bulk-rows article');
      await page.select('#sl-bulk-mode','all-unused'); await page.waitForSelector('#sl-reprint-confirm');
      const bulkBounds = await page.$eval('.sl-workspace',el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right};});
      assert(bulkBounds.left>=-1 && bulkBounds.right<=width+1);
      await page.screenshot({path:path.join(artifacts,`app-bulk-${width}.png`),fullPage:true});
    }
    await page.click('#iu-tab-units'); await page.waitForSelector('#iu-registry:not([hidden])');
    assert.equal(new URL(page.url()).hash,'#warehouse-management/units');
    assert.equal(await page.$('#page-supplier-labels'),null);
    await page.goBack(); await page.waitForSelector('.sl-bulk-rows article');
    await page.click('#iu-tab-receipts'); await page.waitForSelector('#iu-invoice-detail:not([hidden])');
    assert.equal(new URL(page.url()).hash,'#warehouse-management');
    await page.evaluate(() => { window.barcodeTabsBeforeSwitch = document.querySelector('.iu-tabs'); });
    await page.focus('#iu-tab-receipts'); await page.keyboard.press('End'); await page.waitForSelector('#page-warehouse-layout');
    assert.equal(new URL(page.url()).hash,'#warehouse-management/layout');
    assert.equal(await page.evaluate(() => window.barcodeTabsBeforeSwitch === document.querySelector('.iu-tabs')),true);
    await page.focus('#iu-tab-layout'); await page.keyboard.press('ArrowRight'); await page.waitForSelector('#sl-new');
    assert.equal(new URL(page.url()).hash,'#warehouse-management/supplier-labels');
    assert.equal(await page.evaluate(() => window.barcodeTabsBeforeSwitch === document.querySelector('.iu-tabs')),true);
    await page.goto('http://127.0.0.1:8080/#supplier-labels/batch/'+batchId,{waitUntil:'domcontentloaded'});
    await page.waitForSelector('#sl-print');
    assert.equal(new URL(page.url()).hash,'#warehouse-management/supplier-labels/batch/'+batchId);
    assert.deepEqual(errors, []);
    console.log('PASS: supplier page routing, direct links, reload, browser Back and viewport bounds at 1440/768/390.');
  } catch (e) {
    console.error(await page.evaluate(() => ({url:location.href,current:currentPage, message:document.querySelector('#sl-message')?.textContent,title:document.querySelector('#sl-title')?.textContent, view:document.querySelector('#sl-content')?.textContent?.slice(0,400)})));
    await page.screenshot({path:path.join(artifacts,'app-navigation-error.png'),fullPage:true});
    throw e;
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
