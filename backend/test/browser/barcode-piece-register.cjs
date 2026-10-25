const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const output = path.join(root, 'artifacts/barcode-piece-register');
    fs.mkdirSync(output, { recursive: true });
    for (const [width, lang] of [[1440, 'en'], [1024, 'en'], [390, 'en'], [390, 'ar'], [320, 'ar']]) {
      await page.setViewport({ width, height: 950 });
      await page.setContent('<html><head><style>body{margin:0;background:#f5f7f6;font-family:Arial,sans-serif}button,input,select{font:inherit}</style></head><body><main id="page-barcodes"></main></body></html>');
      await page.addStyleTag({ path: path.join(root, 'frontend/public/inventory-units.css') });
      await page.evaluate(lang => {
        window.currentLang = lang; window.currentPage = 'fixture'; window.currentUser = { _id: 'test' };
        document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        window.hasPerm = permission => permission !== 'purchase-view';
        window.SouliaWarehouses = { name: () => lang === 'en' ? 'Main warehouse' : 'المخزن الرئيسي', options: () => '<option value="MAIN">Main warehouse</option>' };
        window.calls = [];
        window.units = ['prepared', 'available', 'inspection-required', 'shipped', 'delivered', 'damaged'].map((status, i) => {
          const id = String(i + 1).padStart(24, '0');
          return { _id: id, __v: 0, barcode: 'SU-' + id, manualCode: 'U-0000-0028-' + i, status,
            product: { name: i === 1 ? 'Loop runner' : 'Infinity runner', code: 'Code 40' }, invoiceRef: '900016',
            warehouseCode: 'MAIN', createdAt: '2026-10-20T01:10:00Z', printCount: 1, origin: { kind: 'purchase' } };
        });
        window.api = async url => {
          calls.push(url);
          if (url.endsWith('/config')) return { statuses: units.map(unit => unit.status), labelSizes: [{ id: '50x25', widthMm: 50, heightMm: 25 }] };
          if (url.includes('/action-options')) return { actions: [] };
          if (/\/inventory-units\/\d+$/.test(url)) return { unit: units.find(unit => url.endsWith(unit._id)), events: [{ action: 'registered', toStatus: 'available', createdAt: '2026-10-20T01:10:00Z', by: 'Admin' }] };
          const params = new URL(url, 'http://fixture.test').searchParams;
          const rows = units.filter(unit => (!params.get('status') || unit.status === params.get('status')) && (!params.get('q') || unit.product.name.includes(params.get('q'))));
          return { units: rows, total: rows.length, limit: 30, products: [] };
        };
      }, lang);
      await page.addScriptTag({ path: path.join(root, 'frontend/public/inventory-units.js') });
      await page.evaluate(() => window.renderBarcodeManagement());
      await page.waitForSelector('#iu-units [data-log-unit]');
      assert.equal(await page.$$eval('#iu-units [data-log-unit]', rows => rows.length), 6);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `page overflow ${width}/${lang}`);
      await page.screenshot({ path: path.join(output, `${lang}-${width}.png`), fullPage: true });
      await page.click('[data-quick-status="prepared"]');
      await page.waitForFunction(() => document.querySelectorAll('#iu-units [data-log-unit]').length === 1);
      assert.equal(await page.$eval('[data-quick-status="prepared"]', el => el.getAttribute('aria-pressed')), 'true');
      await page.click('#iu-reset-search');
      await page.waitForFunction(() => document.querySelectorAll('#iu-units [data-log-unit]').length === 6);
      await page.type('#iu-query', 'Loop');
      await page.waitForFunction(() => document.querySelectorAll('#iu-units [data-log-unit]').length === 1);
      await page.click('#iu-reset-search');
      await page.waitForFunction(() => document.querySelectorAll('#iu-units [data-log-unit]').length === 6);
      await page.click('.iu-column-picker summary');
      await page.click('[data-iu-column="invoice"]');
      assert.equal(await page.$eval('#iu-units .iu-log-invoice', el => getComputedStyle(el).display), 'none');
      await page.click('.iu-column-picker summary');
      await page.click('#iu-units .iu-product-open');
      await page.waitForFunction(() => document.querySelector('#iu-action-dialog').open && document.querySelector('#iu-action-events').textContent.length > 0);
      assert.equal(await page.$eval('#iu-action-piece .iu-status-pill', el => el.textContent.trim()), lang === 'en' ? 'Prepared' : 'مجهزة');
      assert.equal(await page.$eval('#iu-action-dialog', el => el.scrollWidth > el.clientWidth), false);
      await page.click('#iu-action-dialog [data-iu-close]');
      await page.click('#iu-units button.iu-status-pill');
      await page.waitForFunction(() => document.querySelector('#iu-action-dialog').open);
      await page.keyboard.press('Escape');
      await page.click('#iu-units [data-unit-id]');
      assert.equal(await page.evaluate(() => InventoryUnitLabels.selection().ids.length), 1);
    }
    assert.deepEqual(errors, []);
    console.log('PASS: search, status shortcuts, reset, columns, product/status opening, history, selection, Arabic and English at 1440/1024/390/320px; no page overflow or browser errors.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
