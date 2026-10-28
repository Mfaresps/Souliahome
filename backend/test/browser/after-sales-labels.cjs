/* Real receipt/label UI against isolated fixtures; no live stock or print requests. */
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), puppeteer = require('puppeteer'), QRCode = require('qrcode');
const pub = path.resolve(__dirname, '../../../frontend/public');
(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/inventory-units.css' || req.url === '/after-sales.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return res.end(fs.readFileSync(path.join(pub, req.url.slice(1))));
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><link rel="stylesheet" href="/after-sales.css"></head><body></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, pipe: true });
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const unitId = '6adfb70e1d065ae4aa5eed60';
    await page.evaluate(({ unitId, svg }) => {
      window.currentLang = 'en'; window.currentPage = 'complaints'; window.isAdmin = () => true;
      window.currentUser = { _id: 'test-operator', role: 'admin' };
      window.hasPerm = () => true; window.calls = []; window.mode = ''; window.printCalls = 0;
      window.fixture = {
        _id: 'case-labels', originalRef: '2934', client: 'Test customer', requestKind: 'return', reason: 'defect',
        items: [{ name: 'Luma Organize Set', code: '17', qty: 1 }],
        workflow: { ref: 'AS-2026-000006', stage: 'approved', approvedAt: new Date().toISOString(), history: [],
          selectedUnits: [unitId], selectedLines: [{ lineIndex: 0, name: 'Luma Organize Set', code: '17', qty: 1, unitIds: [unitId] }],
          quote: { credit: 500, replacement: 0, customerFee: 0, refundDue: 500, collectDue: 0 } },
      };
      window.sizes = [
        { id: '50x30', widthMm: 50, heightMm: 30, qrMm: 18, marginMm: 1.5 },
        { id: '60x40', widthMm: 60, heightMm: 40, qrMm: 23, marginMm: 2 },
      ];
      window.api = async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, body });
        if (url === '/inventory-units/config') {
          if (mode === 'offline') throw new Error('Configuration unavailable');
          if (mode === 'missing-config') return null;
          return { symbology: 'QR', labelSizes: sizes };
        }
        if (url === '/inventory-units/labels/requests') {
          const size = { ...sizes.find(size => size.id === body.sizeId) };
          if (mode === 'bad-size') size.widthMm++;
          const label = { unitId, barcode: 'SU-' + unitId.toUpperCase(), productName: 'Luma Organize Set', sku: '17', sellPrice: 500, svg };
          if (mode === 'bad-identity') label.barcode = 'SU-' + '0'.repeat(24);
          return { size, labels: mode === 'duplicates' ? [label, label] : [label] };
        }
        return fixture;
      };
      const open = window.open.bind(window);
      window.open = (...args) => {
        window.printPopup = open(...args);
        printPopup.print = () => printCalls++;
        return printPopup;
      };
    }, { unitId, svg: await QRCode.toString('SU-' + unitId.toUpperCase(), { type: 'svg' }) });
    await page.addScriptTag({ path: path.join(pub, 'inventory-units.js') });
    await page.addScriptTag({ path: path.join(pub, 'after-sales.js') });
    assert.equal(await page.evaluate(() => InventoryUnitLabels.selection().config), null);
    await page.evaluate(() => AfterSales.open(fixture._id));
    await page.click('[data-as-action=receive]');
    await page.select('[data-as-label-state]', 'reprinted');

    for (const size of ['50x30', '60x40']) {
      await page.select('[name=sizeId]', size);
      const before = await page.evaluate(() => printCalls);
      await page.click('[data-as-print-label]');
      await page.waitForFunction(before => printCalls === before + 1, {}, before);
      assert.equal(await page.evaluate(() => printPopup.document.querySelector('.iu-label').getAttribute('aria-label')), 'SU-' + unitId.toUpperCase());
      assert.equal(await page.$eval('[data-as-attached]', input => input.checked), false, 'physical attachment still requires operator confirmation');
      assert.equal(await page.evaluate(() => InventoryUnitLabels.selection().config), null, 'printing does not initialize or alter the barcode workspace');
      await page.evaluate(() => printPopup.close());
    }
    for (const mode of ['offline', 'missing-config', 'bad-size', 'bad-identity', 'duplicates']) {
      const before = await page.evaluate(mode => { window.mode = mode; return { prints: printCalls, requests: calls.filter(c => c.url.endsWith('/labels/requests')).length }; }, mode);
      await page.click('[data-as-print-label]');
      await page.waitForFunction(() => printPopup.closed && !document.querySelector('[data-as-print-label]').disabled);
      assert.equal(await page.evaluate(() => printCalls), before.prints, `invalid ${mode} must not print`);
      const message = await page.$eval('.as-body', el => el.textContent);
      assert(!message.includes('Cannot read properties'), 'failures have a readable error');
      if (mode === 'offline' || mode === 'missing-config') assert.equal(await page.evaluate(() => calls.filter(c => c.url.endsWith('/labels/requests')).length), before.requests, 'configuration failure must not record a print request');
    }
    const previousKey = await page.evaluate(() => calls.filter(c => c.url.endsWith('/labels/requests')).at(-1).body.operationKey);
    await page.evaluate(() => { mode = ''; currentLang = 'ar'; });
    await page.click('[data-as-print-label]');
    await page.waitForFunction(() => printCalls === 3);
    assert.equal(await page.evaluate(() => calls.filter(c => c.url.endsWith('/labels/requests')).at(-1).body.operationKey), previousKey, 'retry reuses the print operation');
    assert.deepEqual(errors, []);
    console.log('PASS: receipt label printing before opening barcodes, both sizes, config failures, invalid dimensions/identities, duplicates and safe retry.');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
