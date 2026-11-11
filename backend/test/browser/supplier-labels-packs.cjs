const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const QRCode = require('qrcode');

// Pack batches in the QR label generator: 12 pieces in packs of 6 must issue and print 2 pack labels.
const productId = '507f1f77bcf86cd799439011', batchId = '507f1f77bcf86cd799439044';
const packBatch = { batchId, productId, sku: 'Code 53', productName: 'Brown jute coaster', quantity: 12, piecesPerPack: 6,
  printed: 0, linked: 0, unused: 12, firstUnused: 1, firstUnprinted: 1, createdAt: '2026-11-11T08:00:00Z', createdBy: 'System Manager',
  source: 'internal-prepurchase', printRequests: 0, lastPrintRequestedAt: null };
(async () => {
  const browser = await puppeteer.launch({ headless: true, ...(process.platform === 'win32' ? { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } : {}) });
  const page = await browser.newPage(), errors = [], posts = [];
  let failures = 0;
  const check = (name, fn) => { try { fn(); console.log('ok   ' + name); } catch (e) { failures++; console.log('FAIL ' + name + ': ' + e.message); } };
  try {
    page.on('pageerror', e => { if (!String(e.stack || '').includes('at renderMovements ')) errors.push(e.stack || e.message); });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('token', 'isolated-supplier-pack-test');
      localStorage.setItem('soulia-push-prompt:', 'dismissed');
      localStorage.setItem('user', JSON.stringify({ name: 'System Manager', role: 'admin', perms: [] }));
    });
    await page.setRequestInterception(true);
    page.on('request', async req => {
      const url = new URL(req.url()), pathname = url.pathname;
      if (!pathname.startsWith('/api/')) return req.continue();
      if (req.method() === 'POST') posts.push({ pathname, body: JSON.parse(req.postData() || '{}') });
      let data = [];
      if (pathname === '/api/auth/me') data = { name: 'System Manager', role: 'admin', perms: [] };
      if (pathname === '/api/settings' || pathname === '/api/transactions/dashboard') data = {};
      if (pathname === '/api/notifications' || pathname === '/api/notifications/preferences') data = { preferences: { enabled: false }, language: 'en', subscriptions: [] };
      if (pathname === '/api/inventory-units/purchases/receipts') data = { receipts: [], total: 0 };
      if (pathname === '/api/inventory-units') data = { units: [], total: 0, limit: 30, products: [] };
      if (pathname === '/api/products') data = [{ _id: productId, name: packBatch.productName, code: packBatch.sku, isActive: true }];
      if (pathname === '/api/inventory-units/prelabels/batches' && req.method() === 'POST') data = { batchId, productId, quantity: 12, piecesPerPack: 6, packs: 2 };
      if (pathname === '/api/inventory-units/prelabels/batches/page') data = { batches: [packBatch], page: 1, totalPages: 1, total: 1 };
      if (pathname === '/api/inventory-units/prelabels/batches/' + batchId) data = { batch: packBatch, linkedPurchases: [], linkedPurchaseTotal: 0, linkedPurchaseLimit: 20 };
      if (pathname === '/api/inventory-units/config') data = { statuses: ['available'], symbology: 'QR', labelSizes: [{ id: '50x25', widthMm: 50, heightMm: 25 }] };
      if (pathname === '/api/warehouse-layout') data = { warehouses: [{ code: 'MAIN', name: 'Main warehouse' }], locations: [], labelSizes: [{ id: '50x25', widthMm: 50, heightMm: 25 }] };
      if (pathname === '/api/inventory-units/prelabels/batches/' + batchId + '/preview') {
        const body = JSON.parse(req.postData());
        data = { size: { id: '50x25', widthMm: 50, heightMm: 25, qrMm: 17, marginMm: 1.5 }, selectionHash: 'a'.repeat(64),
          labels: await Promise.all(Array.from({ length: body.quantity / 6 }, async (_, i) => {
            const unitId = (5000 + i).toString(16).padStart(24, '0'), barcode = 'PK-' + unitId.toUpperCase();
            return { unitId, packId: unitId, isPack: true, quantity: 6, barcode, manualCode: 'PK-00000' + (i + 1) + '-' + i, batchId, ordinal: i + 1,
              productName: packBatch.productName, sku: packBatch.sku, printCount: 0, svg: await QRCode.toString(barcode, { type: 'svg', margin: 4 }) };
          })) };
      }
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.setViewport({ width: 1440, height: 900 });
    for (const lang of ['ar', 'en']) {
      await page.evaluateOnNewDocument(l => localStorage.setItem('soulia_lang_pref', l), lang);
      await page.goto('http://127.0.0.1:8080/#warehouse-management/supplier-labels/new', { waitUntil: 'domcontentloaded' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#sl-pack-mode', { timeout: 20000 });
      await page.waitForSelector('[data-product]', { timeout: 20000 });
      const hiddenAtStart = await page.$eval('#sl-pack-size-field', el => el.hidden);
      check(`${lang}: pack size hidden until the toggle is on`, () => assert.equal(hiddenAtStart, true));
      await page.click('[data-product]');
      await page.$eval('#sl-quantity', el => { el.value = '12'; el.dispatchEvent(new Event('input')); });
      await page.click('#sl-pack-mode');
      const plan = await page.$eval('#sl-pack-plan', el => ({ text: el.textContent, error: el.dataset.error, hidden: el.hidden }));
      check(`${lang}: 12 pieces / 6 per pack → 2 labels`, () => { assert.equal(plan.hidden, false); assert.equal(plan.error, 'false'); assert.match(plan.text, /2/); assert.match(plan.text, lang === 'ar' ? /ملصق فقط/ : /2 labels/); });
      const label = await page.$eval('#sl-issue span', el => el.textContent);
      check(`${lang}: create button names the packs`, () => assert.match(label, lang === 'ar' ? /إنشاء 2 باك/ : /Create 2 packs/));
      await page.$eval('#sl-pack-size', el => { el.value = '5'; el.dispatchEvent(new Event('input')); });
      const bad = await page.$eval('#sl-pack-plan', el => ({ text: el.textContent, error: el.dataset.error }));
      check(`${lang}: a remainder is refused with the nearest valid totals`, () => { assert.equal(bad.error, 'true'); assert.match(bad.text, /10/); assert.match(bad.text, /15/); });
      const layout = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - innerWidth,
        option: (() => { const r = document.querySelector('.sl-pack-option').getBoundingClientRect(), p = document.querySelector('.sl-create-summary').getBoundingClientRect(); return r.left >= p.left - 1 && r.right <= p.right + 1; })() }));
      check(`${lang}: no overflow`, () => { assert.ok(layout.doc <= 1); assert.ok(layout.option); });
    }
    // Issue: the payload carries piecesPerPack.
    await page.$eval('#sl-pack-size', el => { el.value = '6'; el.dispatchEvent(new Event('input')); });
    await page.click('#sl-issue');
    await page.waitForSelector('.iu-cover-choice [data-include-covers="no"]', { timeout: 5000 });
    await page.click('.iu-cover-choice [data-include-covers="no"]');
    await page.waitForFunction(() => location.hash.includes('/batch/'), { timeout: 10000 });
    const issue = posts.find(p => p.pathname === '/api/inventory-units/prelabels/batches');
    check('issue sends quantity 12 and piecesPerPack 6', () => { assert.equal(issue.body.quantity, 12); assert.equal(issue.body.piecesPerPack, 6); });
    // Detail: counted and printed in packs.
    await page.waitForSelector('#sl-print-quantity', { timeout: 10000 });
    const detail = await page.evaluate(() => ({ count: document.querySelector('#sl-print-quantity').value, start: document.querySelector('#sl-start').value,
      labels: document.querySelector('.sl-counts strong').textContent, note: document.querySelector('#sl-range-note').textContent,
      badge: !!document.querySelector('.sl-batch-heading .sl-pack-badge') }));
    check('detail shows 2 pack labels, a pack range and the badge', () => { assert.equal(detail.count, '2'); assert.equal(detail.start, '1'); assert.equal(detail.labels, '2'); assert.ok(detail.badge); assert.match(detail.note, /PK/); });
    await page.click('#sl-print');
    await page.waitForFunction(() => document.querySelector('#slp-summary')?.textContent.includes('12') || document.querySelector('#slp-status')?.dataset.error === 'true', { timeout: 15000 });
    const preview = await page.evaluate(() => ({ summary: document.querySelector('#slp-summary').textContent, error: document.querySelector('#slp-status').dataset.error,
      status: document.querySelector('#slp-status').textContent, sheets: document.querySelector('#slp-frame').contentDocument.querySelectorAll('.iu-label-pack').length }));
    const previewPost = posts.find(p => p.pathname.endsWith('/preview'));
    check('preview requests pieces 1–12 and renders 2 pack labels', () => { assert.equal(previewPost.body.start, 1); assert.equal(previewPost.body.quantity, 12);
      assert.notEqual(preview.error, 'true', preview.status); assert.equal(preview.sheets, 2); assert.match(preview.summary, /12/); });
    check('no page errors', () => assert.deepEqual(errors, []));
  } catch (e) { failures++; console.log('FAIL run: ' + (e.stack || e.message)); }
  finally { await browser.close(); }
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
})();
