const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    const nativeDialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
    await page.setViewport({ width: 1280, height: 900 });
    await page.setContent('<!doctype html><html lang="ar"><head><meta charset="utf-8"></head><body><main id="page-warehouse-layout"></main><div id="modal-content"></div></body></html>');
    await page.addStyleTag({ path: path.resolve(__dirname, '../../../frontend/public/warehouse-layout.css') });
    await page.addStyleTag({ path: path.resolve(__dirname, '../../../frontend/public/warehouse-workspace.css') });
    await page.addStyleTag({ path: path.resolve(__dirname, '../../../frontend/public/inventory-scanner.css') });
    await page.evaluate(() => {
      window.currentLang = 'ar'; window.currentPage = 'warehouse-layout'; window.isAdmin = () => true;
      window.layoutFixture = {
        warehouses: [{ code: 'MAIN', name: 'المخزن الرئيسي' }],
        locations: [
          { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', warehouseCode: 'MAIN', parentId: null, kind: 'zone', code: 'A' },
          { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', warehouseCode: 'MAIN', parentId: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'rack', code: 'R1' },
          { _id: 'cccccccccccccccccccccccc', warehouseCode: 'MAIN', parentId: 'bbbbbbbbbbbbbbbbbbbbbbbb', kind: 'level', code: 'S02' },
          { _id: 'eeeeeeeeeeeeeeeeeeeeeeee', warehouseCode: 'MAIN', parentId: 'bbbbbbbbbbbbbbbbbbbbbbbb', kind: 'level', code: 'S03' },
          { _id: 'ffffffffffffffffffffffff', warehouseCode: 'MAIN', parentId: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'rack', code: 'R2' },
          { _id: '999999999999999999999999', warehouseCode: 'MAIN', parentId: 'ffffffffffffffffffffffff', kind: 'level', code: 'S02' },
        ],
        labelSizes: [{ id: '50x25', widthMm: 50, heightMm: 25 }, { id: '80x40', widthMm: 80, heightMm: 40 }],
      };
      window.products = [
        { _id: 'p1', code: 'SH-1024', name: 'طاولة جانبية رخامية', imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/yd0AAAAASUVORK5CYII=', storageLocationId: 'cccccccccccccccccccccccc' },
        { _id: 'p2', code: 'SH-2086', name: 'مصباح أرضي ذهبي', storageLocationId: '999999999999999999999999' },
      ];
      window.inventoryCache = [{ code: 'SH-1024', current: 14 }, { code: 'SH-2086', current: 8 }];
      window.api = async (url, options = {}) => {
        if (url === '/inventory-units/scans/validate') return { outcome: 'accepted', code: 'VALIDATED', operationId: 'f'.repeat(64), unit: { _id: 'u1', barcode: 'SOULIA-QR-1024', productId: 'p1', warehouseCode: 'MAIN', status: 'available' } };
        if (options.method === 'PATCH') {
          const row = window.layoutFixture.locations.find(item => url.endsWith(item._id));
          row.code = JSON.parse(options.body).code; return row;
        }
        if (options.method === 'DELETE') {
          const nodeId = url.split('/').pop();
          if (window.layoutFixture.locations.some(item => item.parentId === nodeId)) throw new Error('احذف المواقع الفرعية أولًا');
          window.layoutFixture.locations = window.layoutFixture.locations.filter(item => item._id !== nodeId);
          return { removed: true };
        }
        if (options.method === 'POST') {
          const body = JSON.parse(options.body);
          const row = { ...body, parentId: body.parentId || null, _id: 'dddddddddddddddddddddddd' };
          window.layoutFixture.locations.push(row); return row;
        }
        if (url === '/warehouse-layout') return structuredClone(window.layoutFixture);
        if (url === '/transactions/inventory') return [{ _id: 'p1', code: 'SH-1024', warehouseBalances: { MAIN: 14 } }];
        if (url === '/products/p1' && options.method === 'PUT') {
          Object.assign(window.products[0], JSON.parse(options.body));
          return structuredClone(window.products[0]);
        }
        if (url === '/products/p1') return structuredClone(window.products[0]);
        throw new Error('Unexpected API call: ' + url);
      };
    });
    await page.addScriptTag({ path: path.resolve(__dirname, '../../../frontend/public/warehouse-layout.js') });
    await page.evaluate(() => SouliaWarehouseLayout.render());
    await page.waitForSelector('.wl-grid .wl-panel');
    await page.waitForFunction(() => document.querySelector('.wl-product-result img')?.naturalWidth === 1);
    const screenshot = path.resolve(__dirname, '../../../artifacts/warehouse-layout/preview.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    await page.screenshot({ path: path.resolve(__dirname, '../../../artifacts/warehouse-layout/mobile.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile layout must not overflow');
    await page.setViewport({ width: 1280, height: 900 });
    assert.equal(await page.$eval('#wl-warehouse', el => el.value), 'MAIN');
    assert.equal(await page.$eval('.wl-print h2', el => el.textContent), 'ZONE A / R1 / S02');
    await page.evaluate(() => {
      const card = document.createElement('section'); card.id = 'location-card-test'; document.body.append(card);
      SouliaWarehouseLayout.renderLocationCard(card, products[0], 'MAIN');
    });
    assert.match(await page.$eval('#location-card-test', el => el.textContent), /ZONE A/);
    assert.match(await page.$eval('#location-card-test', el => el.textContent), /R1/);
    assert.match(await page.$eval('#location-card-test', el => el.textContent), /S02/);
    await page.evaluate(() => SouliaWarehouseLayout.renderLocationCard(document.getElementById('location-card-test'), products[0], 'SECONDARY'));
    assert.match(await page.$eval('#location-card-test .wl-location-warning', el => el.textContent), /مخزن آخر/);
    await page.addScriptTag({ path: path.resolve(__dirname, '../../../frontend/public/inventory-scanner.js') });
    await page.evaluate(async () => {
      Object.defineProperty(window.crypto, 'randomUUID', { configurable: true, value: () => '12345678-1234-4123-8123-123456789abc' });
      const root = document.createElement('div'); root.id = 'scanner-test'; document.body.append(root);
      const memory = new Map(), storage = { getItem: key => memory.get(key) || null, setItem: (key, value) => memory.set(key, value) };
      const scanner = SouliaScanner.mount(root, { api: window.api, actorId: 'warehouse-test', workflowKey: 'location-test', context: { intent: 'lookup' }, storage, lang: 'ar' });
      await scanner.client.submit('SOULIA-QR-1024');
    });
    await page.waitForSelector('#scanner-test [data-scan-location] .wl-location-grid');
    assert.match(await page.$eval('#scanner-test [data-scan-location]', el => el.textContent), /S02/);
    await (await page.$('#scanner-test')).screenshot({ path: path.resolve(__dirname, '../../../artifacts/warehouse-layout/scan-location.png') });
    assert.equal(await page.$eval('.wl-bay-slot.is-active', el => el.textContent.includes('S02')), true);
    assert.equal(await page.$eval('.wl-bay-slot.is-active', el => {
      const shelf = el.querySelector('rect').getBBox(), label = el.querySelector('.wl-bay-code').getBBox();
      return label.x >= shelf.x && label.x + label.width <= shelf.x + shelf.width;
    }), true, 'shelf code must stay inside the illustrated bay');
    await page.$eval('.wl-bay-slot[data-select="eeeeeeeeeeeeeeeeeeeeeeee"]', el => el.focus());
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-select')), 'eeeeeeeeeeeeeeeeeeeeeeee');
    await page.keyboard.press('Enter');
    assert.equal(await page.$eval('.wl-print h2', el => el.textContent), 'ZONE A / R1 / S03');
    await page.click('.wl-bay-slot[data-select="cccccccccccccccccccccccc"]');
    assert.equal(await page.$eval('.wl-print h2', el => el.textContent), 'ZONE A / R1 / S02');
    assert.equal(await page.$eval('.wl-row-actions [data-label] svg', el => el.tagName.toLowerCase()), 'svg');
    await page.$eval('#wl-product-search', el => { el.value = 'SH-2086'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('[data-product-location="999999999999999999999999"]');
    assert.equal(await page.$eval('.wl-print h2', el => el.textContent), 'ZONE A / R2 / S02');
    assert.equal(await page.$eval('.wl-rack-label.is-active text', el => el.textContent), 'R2');
    await page.click('[data-select="bbbbbbbbbbbbbbbbbbbbbbbb"]');
    assert.equal(await page.$eval('.wl-print h2', el => el.textContent), 'ZONE A / R1 / S02');
    await page.evaluate(async () => {
      const root = document.getElementById('modal-content');
      root.innerHTML = SouliaWarehouseLayout.productFields(products[0]);
      await SouliaWarehouseLayout.mountProduct(products[0]);
    });
    assert.equal(await page.$eval('#pm-storage-level', el => el.value), 'cccccccccccccccccccccccc');
    assert.equal(await page.$eval('.wl-product', el => el.dataset.ready), 'true');
    await page.waitForFunction(() => document.querySelector('.wl-product-balance strong')?.textContent === '14');
    assert.match(await page.$eval('#pm-storage-balances', el => el.textContent), /رصيد الصنف حسب المخزن/);
    await page.select('#pm-storage-rack', 'ffffffffffffffffffffffff');
    await page.select('#pm-storage-level', '999999999999999999999999');
    assert.equal(await page.$eval('#pm-storage-level', el => el.value), '999999999999999999999999');
    await page.evaluate(async () => {
      const selected = document.querySelector('#pm-storage-level').value;
      await api('/products/p1', { method: 'PUT', body: JSON.stringify({ storageLocationId: selected }) });
      const product = await api('/products/p1');
      document.querySelector('#modal-content').innerHTML = SouliaWarehouseLayout.productFields(product);
      await SouliaWarehouseLayout.mountProduct(product);
    });
    assert.equal(await page.$eval('#pm-storage-rack', el => el.value), 'ffffffffffffffffffffffff');
    assert.equal(await page.$eval('#pm-storage-level', el => el.value), '999999999999999999999999', 'saved location must survive reopening the product');
    await page.evaluate(async () => {
      products[0].editRequest = { status: 'معلق', changes: [{ field: 'storageLocationId', newValue: 'cccccccccccccccccccccccc' }] };
      document.querySelector('#modal-content').innerHTML = SouliaWarehouseLayout.productFields(products[0]);
      await SouliaWarehouseLayout.mountProduct(products[0]);
    });
    assert.equal(await page.$eval('#pm-storage-level', el => el.value), 'cccccccccccccccccccccccc', 'pending location must remain visible');
    assert.match(await page.$eval('.wl-product-note', el => el.textContent), /بانتظار موافقة المدير/);
    const appSource = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
    const saveProductSource = appSource.match(/async function saveProduct\(id\) \{[\s\S]*?\n\}\s*(?=async function _doRequestProductEdit)/)?.[0];
    assert.ok(saveProductSource, 'product save handler must be present');
    await page.addScriptTag({ content: saveProductSource });
    await page.evaluate(async () => {
      window.qs = selector => document.querySelector(selector);
      window.toasts = [];
      window.toast = message => toasts.push(message);
      document.querySelector('#pm-storage-level').value = '';
      await saveProduct('p1');
    });
    assert.match((await page.evaluate(() => toasts.join(' '))), /حدد منطقة التخزين والرف ومستوى الرف/);
    assert.equal(await page.$eval('#pm-storage-warehouse', el => el.value), 'MAIN', 'incomplete selection remains available to finish');
    const directSaveSource = appSource.match(/let _saveProductInProgress = false;[\s\S]*?\n\}\s*(?=async function deleteProduct)/)?.[0];
    assert.ok(directSaveSource, 'product write handler must be present');
    await page.addScriptTag({ content: directSaveSource });
    await page.evaluate(async () => {
      window.t = key => key;
      window.withButtonLoading = async (_button, task) => task();
      window.closeModal = () => {};
      window.renderProducts = () => {};
      const originalApi = window.api;
      window.api = (url, options) => url === '/products'
        ? Promise.resolve([{ ...products[0], storageLocationId: '' }])
        : originalApi(url, options);
      await _doSaveProduct('p1', { storageLocationId: '999999999999999999999999' });
      window.api = originalApi;
    });
    assert.equal(await page.evaluate(() => products[0].storageLocationId), '999999999999999999999999', 'confirmed save must survive a stale list refresh');
    await page.evaluate(() => {
      window.printed = '';
      window.open = () => ({ document: { open() {}, write(value) { window.printed += value; }, close() {} }, focus() {}, print() {} });
      document.querySelector('#wl-print').click();
    });
    const printed = await page.evaluate(() => window.printed);
    assert.match(printed, /ZONE A/); assert.match(printed, /R1/); assert.match(printed, /S02/);
    assert.match(printed, /size:80mm 40mm/);
    assert.match(printed, /data-target-kind="level"/);
    const labelPage = await browser.newPage();
    await labelPage.setViewport({ width: 480, height: 300 });
    await labelPage.setContent(printed);
    assert.equal(await labelPage.$eval('.target', el => el.textContent), 'S02');
    assert.equal(await labelPage.$eval('.context', el => el.textContent.includes('ZONE A / R1')), true);
    assert.equal(await labelPage.$eval('.target', el => el.scrollWidth <= el.clientWidth), true);
    assert.equal(await labelPage.$eval('.target', el => parseFloat(getComputedStyle(el).fontSize) > parseFloat(getComputedStyle(document.querySelector('.context')).fontSize) * 2), true);
    await labelPage.screenshot({ path: path.resolve(__dirname, '../../../artifacts/warehouse-layout/label-80x40.png') });
    await labelPage.close();
    await page.$eval('#wl-size', el => { el.value = '50x25'; el.dispatchEvent(new Event('change')); });
    await page.evaluate(() => { window.printed = ''; document.querySelector('#wl-print').click(); });
    const compact = await page.evaluate(() => window.printed);
    assert.match(compact, /size:50mm 25mm/);
    const compactPage = await browser.newPage();
    await compactPage.setViewport({ width: 320, height: 200 });
    await compactPage.setContent(compact);
    assert.equal(await compactPage.$eval('.target', el => el.textContent), 'S02');
    assert.equal(await compactPage.$eval('.target', el => el.scrollWidth <= el.clientWidth), true);
    await compactPage.screenshot({ path: path.resolve(__dirname, '../../../artifacts/warehouse-layout/label-50x25.png') });
    await compactPage.close();
    for (const [nodeId, kind, target, context] of [
      ['aaaaaaaaaaaaaaaaaaaaaaaa', 'zone', 'ZONE A', ''],
      ['bbbbbbbbbbbbbbbbbbbbbbbb', 'rack', 'R1', 'ZONE A'],
    ]) {
      await page.evaluate(value => { window.printed = ''; document.querySelector(`[data-label="${value}"]`).click(); }, nodeId);
      const html = await page.evaluate(() => window.printed);
      const label = await browser.newPage();
      await label.setViewport({ width: 320, height: 200 });
      await label.setContent(html);
      assert.equal(await label.$eval('.sign', el => el.dataset.targetKind), kind);
      assert.equal(await label.$eval('.target', el => el.textContent), target);
      await label.screenshot({ path: path.resolve(__dirname, `../../../artifacts/warehouse-layout/label-${kind}-50x25.png`) });
      assert.equal(await label.$eval('.target', el => el.scrollWidth <= el.clientWidth), true);
      if (context) assert.match(await label.$eval('.context', el => el.textContent), new RegExp(context));
      await label.close();
    }
    await page.$eval('form[data-add="zone"]', form => { form.elements.code.value = 'B'; form.requestSubmit(); });
    await page.waitForFunction(() => document.querySelectorAll('.wl-panel:first-child .wl-row').length === 2);
    await page.click('[data-rename="dddddddddddddddddddddddd"]');
    assert.equal(await page.$eval('#wl-edit-dialog', el => el.open), true);
    await page.screenshot({ path: path.resolve(__dirname, '../../../artifacts/warehouse-layout/rename-dialog.png') });
    await page.$eval('#wl-dialog-code', input => { input.value = 'C'; input.dispatchEvent(new Event('input')); });
    await page.click('.wl-dialog-submit');
    await page.waitForFunction(() => document.querySelector('[data-select="dddddddddddddddddddddddd"] .wl-code')?.textContent === 'ZONE C');
    assert.equal(await page.$eval('#wl-edit-dialog', el => el.open), false);
    await page.click('[data-delete="aaaaaaaaaaaaaaaaaaaaaaaa"]');
    await page.click('.wl-dialog-submit');
    await page.waitForSelector('#wl-dialog-error:not([hidden])');
    assert.match(await page.$eval('#wl-dialog-error', el => el.textContent), /المواقع الفرعية/);
    await page.click('.wl-dialog-cancel');
    await page.click('[data-delete="dddddddddddddddddddddddd"]');
    await page.click('.wl-dialog-submit');
    await page.waitForFunction(() => document.querySelectorAll('.wl-panel:first-child .wl-row').length === 1);
    assert.deepEqual(nativeDialogs, [], 'warehouse editing should not open browser prompts or confirms');
    assert.deepEqual(errors, []);
    const tabPage = await browser.newPage();
    const tabErrors = []; tabPage.on('pageerror', error => tabErrors.push(error.message));
    await tabPage.setViewport({ width: 1280, height: 900 });
    await tabPage.setContent('<!doctype html><html lang="ar"><head><meta charset="utf-8"></head><body><main class="page active" id="page-barcodes"></main></body></html>');
    await tabPage.addStyleTag({ path: path.resolve(__dirname, '../../../frontend/public/inventory-units.css') });
    await tabPage.addStyleTag({ path: path.resolve(__dirname, '../../../frontend/public/warehouse-layout.css') });
    await tabPage.addStyleTag({ path: path.resolve(__dirname, '../../../frontend/public/warehouse-workspace.css') });
    await tabPage.evaluate(() => {
      location.hash = '#warehouse-management/supplier-labels';
      window.currentLang = 'ar'; window.currentPage = 'barcodes'; window.currentUser = { _id: 'warehouse-test' };
      window.hasPerm = () => true; window.isAdmin = () => true;
      window.SupplierLabels = { isBusy: () => false, render: async () => {} };
      window.api = async url => {
        if (url === '/warehouse-layout') return { warehouses: [{ code: 'MAIN', name: 'المخزن الرئيسي' }], locations: [
          { _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', warehouseCode: 'MAIN', parentId: null, kind: 'zone', code: 'A' },
          { _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', warehouseCode: 'MAIN', parentId: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'rack', code: 'R1' },
          { _id: 'cccccccccccccccccccccccc', warehouseCode: 'MAIN', parentId: 'bbbbbbbbbbbbbbbbbbbbbbbb', kind: 'level', code: 'S02' },
          { _id: 'dddddddddddddddddddddddd', warehouseCode: 'MAIN', parentId: 'bbbbbbbbbbbbbbbbbbbbbbbb', kind: 'level', code: 'S03' },
        ], labelSizes: [{ id: '80x40', widthMm: 80, heightMm: 40 }] };
        throw new Error('Unexpected API call: ' + url);
      };
    });
    await tabPage.addScriptTag({ path: path.resolve(__dirname, '../../../frontend/public/warehouse-layout.js') });
    await tabPage.addScriptTag({ path: path.resolve(__dirname, '../../../frontend/public/inventory-units.js') });
    await tabPage.waitForSelector('#iu-tab-layout');
    await tabPage.click('#iu-tab-layout');
    await tabPage.waitForSelector('#page-barcodes #page-warehouse-layout .wl-grid');
    assert.equal(await tabPage.$eval('#iu-tab-layout', el => el.getAttribute('aria-selected')), 'true');
    assert.equal(await tabPage.$eval('.iu-breadcrumb strong', el => el.textContent), 'مواقع التخزين');
    assert.equal(await tabPage.$$eval('#page-barcodes h1', headings => headings.length), 1);
    assert.equal(await tabPage.$eval('.wl-header h2', el => el.textContent), 'مواقع التخزين');
    assert.equal(await tabPage.$eval('#page-warehouse-layout', el => el.getAttribute('aria-labelledby')), 'iu-tab-layout');
    assert.equal(await tabPage.evaluate(() => location.hash), '#warehouse-management/layout');
    await tabPage.click('.wl-bay-slot[data-select="dddddddddddddddddddddddd"]');
    assert.equal(await tabPage.$eval('.wl-print h2', el => el.textContent), 'ZONE A / R1 / S03');
    await tabPage.screenshot({ path: path.resolve(__dirname, '../../../artifacts/warehouse-layout/in-barcode-tab.png'), fullPage: true });
    await tabPage.setViewport({ width: 390, height: 844 });
    assert.equal(await tabPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'barcode layout tab must fit mobile width');
    await tabPage.screenshot({ path: path.resolve(__dirname, '../../../artifacts/warehouse-layout/in-barcode-tab-mobile.png'), fullPage: true });
    await tabPage.evaluate(async () => {
      window.hasPerm = permission => permission === 'products'; window.isAdmin = () => false;
      await window.renderBarcodeManagement();
    });
    assert.equal(await tabPage.$eval('#iu-tab-layout', el => el.getAttribute('aria-selected')), 'true');
    assert.equal(await tabPage.$$eval('#page-barcodes [data-iu-tab]:not([hidden])', tabs => tabs.length), 1);
    assert.deepEqual(tabErrors, []);
    await tabPage.close();
    console.log('Warehouse layout browser check passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
