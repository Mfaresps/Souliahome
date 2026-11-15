const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
// Bulk piece actions: select several pieces → one action → the per-piece endpoint runs once per eligible piece.
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  let checks = 0; const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const output = path.join(root, 'artifacts/barcode-bulk-actions');
    fs.mkdirSync(output, { recursive: true });
    for (const [width, lang, dark] of [[1440, 'ar', false], [390, 'en', true]]) {
      await page.setViewport({ width, height: 950 });
      await page.setContent(`<html><head><style>body{margin:0;background:#f5f7f6;font-family:Arial,sans-serif}button,input,select{font:inherit}</style></head><body class="${dark ? 'dark-mode' : ''}"><main id="page-barcodes"></main></body></html>`);
      await page.addStyleTag({ path: path.join(root, 'frontend/public/inventory-units.css') });
      await page.evaluate(lang => {
        window.currentLang = lang; window.currentPage = 'fixture'; window.currentUser = { _id: 'test' };
        document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        window.hasPerm = permission => permission !== 'purchase-view';
        window.SouliaWarehouses = { name: () => 'Main', options: () => '<option value="MAIN">Main</option>' };
        window.posts = []; let seq = 0;
        if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => 'key-' + (++seq) });
        window.units = ['inspection-required', 'inspection-required', 'inspection-required', 'available', 'shipped'].map((status, i) => {
          const id = String(i + 1).padStart(24, '0');
          return { _id: id, __v: i, barcode: 'SU-' + id, manualCode: 'U-0000-1581-' + i, status, product: { name: 'CURLA CUSHION -Sandy' },
            warehouseCode: 'MAIN', createdAt: '2026-11-13T01:10:00Z', printCount: 1, origin: { kind: 'purchase' } };
        });
        const actionsFor = unit => unit.status === 'inspection-required' ? ['inspect', 'damage', 'lost'] : unit.status === 'available' ? ['reserve', 'damage', 'lost'] : unit.status === 'shipped' ? ['deliver', 'return'] : [];
        window.api = async (url, opts = {}) => {
          if (opts.method === 'POST') {
            const id = url.split('/')[2], body = JSON.parse(opts.body), unit = units.find(u => u._id === id);
            posts.push({ id, body });
            if (id.endsWith('3')) throw new Error('Stale unit version');
            unit.status = body.action === 'inspect' ? 'available' : body.action === 'damage' ? 'damaged' : unit.status; unit.__v++;
            return { unit: { ...unit } };
          }
          if (url.endsWith('/config')) return { statuses: ['available', 'inspection-required', 'shipped', 'damaged'], labelSizes: [{ id: '50x25', widthMm: 50, heightMm: 25 }] };
          if (url.includes('/action-options')) return { actions: actionsFor(units.find(u => url.includes(u._id))) };
          if (/\/inventory-units\/\d+$/.test(url)) return { unit: { ...units.find(unit => url.endsWith(unit._id)) }, events: [] };
          return { units: units.map(u => ({ ...u })), total: units.length, limit: 30, products: [] };
        };
      }, lang);
      await page.addScriptTag({ path: path.join(root, 'frontend/public/inventory-units.js') });
      await page.evaluate(() => window.renderBarcodeManagement());
      await page.waitForSelector('#iu-units [data-log-unit]');
      ok(await page.$eval('#iu-bulk-action', el => !el.hidden && el.disabled), 'bulk button visible, disabled with nothing selected');
      await page.click('#iu-select-page');
      ok(await page.$eval('#iu-bulk-action', el => !el.disabled && /5/.test(el.textContent)), 'bulk button names the selection count');
      await page.click('#iu-bulk-action');
      await page.waitForFunction(() => document.querySelector('#iu-bulk-dialog').open && !document.querySelector('#iu-bulk-fields').hidden);
      const options = await page.$$eval('#iu-bulk-kind option', els => els.map(o => o.value));
      ok(options.includes('inspect') && options.includes('damage') && options.includes('deliver'), 'offers actions allowed for some pieces');
      ok(!options.includes('reserve'), 'reserve is single-piece only');
      ok(await page.$eval('#iu-bulk-kind option[value="inspect"]', o => /3/.test(o.textContent) && /5/.test(o.textContent)), 'option states 3 of 5');
      ok(await page.$eval('#iu-bulk-summary', el => el.querySelectorAll('.iu-status-pill').length === 3), 'summary groups by status');
      await page.select('#iu-bulk-kind', 'lost');
      ok(await page.$eval('#iu-bulk-submit', el => el.disabled), 'lost needs the count confirmation');
      await page.click('#iu-bulk-confirm');
      ok(await page.$eval('#iu-bulk-submit', el => !el.disabled), 'confirmation enables lost');
      await page.select('#iu-bulk-kind', 'inspect');
      ok(await page.$eval('#iu-bulk-confirm-field', el => el.hidden), 'confirmation hidden for inspect');
      ok(await page.$eval('#iu-bulk-scope', el => /2/.test(el.textContent)), 'scope states the skipped count');
      ok(await page.$eval('#iu-bulk-dialog', el => el.scrollWidth <= el.clientWidth), 'no sideways overflow');
      await page.screenshot({ path: path.join(output, `${lang}-${width}-dialog.png`) });
      await page.click('#iu-bulk-submit');
      await page.waitForFunction(() => !document.querySelector('#iu-bulk-results').hidden);
      const sent = await page.evaluate(() => posts);
      ok(sent.length === 3 && sent.every(p => p.body.action === 'inspect' && p.body.inspectionPassed === true), 'one inspect request per eligible piece');
      ok(sent.every((p, i) => p.body.expectedVersion === i), 'each request carries its own piece version');
      ok(new Set(sent.map(p => p.body.operationKey)).size === 3, 'distinct operation keys');
      ok(await page.$$eval('#iu-bulk-results li', els => els.length === 1 && /1581-2/.test(els[0].textContent)), 'the failed piece is named');
      ok(await page.$eval('#iu-bulk-dialog [data-dialog-message]', el => /2/.test(el.textContent)), 'summary counts updated pieces');
      await page.screenshot({ path: path.join(output, `${lang}-${width}-result.png`) });
      await page.click('#iu-bulk-dialog [data-iu-close]');
      ok(await page.$eval('#iu-bulk-dialog', el => !el.open), 'closes');
    }
    assert.deepEqual(errors, []); checks++;
    console.log(`PASS ${checks} checks: bulk action dialog, eligibility, lost confirmation, per-piece requests, failure listing (ar 1440 / en 390 dark).`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
