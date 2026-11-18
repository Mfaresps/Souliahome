// New purchase form layout over the shipped page (real app at 8080, API answered here).
// Screenshots: artifacts/purchase-form-layout/<name>.png. Usage: node purchase-form-layout.cjs [label]
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const output = path.resolve(__dirname, '../../../artifacts/purchase-form-layout');
const label = process.argv[2] || 'after';
const products = [
  { _id: 'p1', code: 'Code 10', name: 'Boho Charm Basket L', buyPrice: 500, sellPrice: 900, isActive: true, current: 7 },
  { _id: 'p2', code: 'Code 09', name: 'Bohème Basket', buyPrice: 500, sellPrice: 900, isActive: true, current: 7 },
];

async function open(browser, { lang = 'ar', width = 1440, dark = false } = {}) {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width, height: 1000 });
  await page.evaluateOnNewDocument((lang, dark) => {
    localStorage.setItem('token', 'purchase-form-test');
    localStorage.setItem('user', JSON.stringify({ _id: 'u1', name: 'Owner', role: 'admin', perms: [] }));
    localStorage.setItem('soulia_lang_pref', lang);
    if (dark) localStorage.setItem('darkMode', 'true');
  }, lang, dark);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) return request.continue();
    const respond = data => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (pathname === '/api/auth/me') return respond({ _id: 'u1', name: 'Owner', role: 'admin', perms: [] });
    if (pathname === '/api/settings') return respond({ lang, darkMode: dark });
    if (pathname === '/api/products' || pathname === '/api/transactions/inventory') return respond(products);
    if (pathname === '/api/suppliers') return respond([{ _id: 's1', name: 'Talla Home', phone: '01000000000' }]);
    if (pathname === '/api/warehouses') return respond([{ code: 'MAIN', name: 'المخزن الرئيسي', active: true, isDefault: true }]);
    if (pathname === '/api/transactions/startup-overview') return respond({ rows: [], activeCount: 0 });
    if (pathname === '/api/notifications' || pathname === '/api/notifications/preferences') return respond({ preferences: { enabled: false }, subscriptions: [] });
    if (pathname.startsWith('/api/inventory-units/prelabels/lookup')) return respond({ unitId: 'a'.repeat(24), productId: 'p1', sku: 'Code 10', state: 'unused', printCount: 1, manualCode: 'U-0000-1416-7', batchId: 'b'.repeat(24) });
    return respond([]);
  });
  await page.goto(origin + '/#transaction', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof currentPage !== 'undefined' && currentPage === 'transaction' && !document.querySelector('#splash-screen'), { timeout: 30000 });
  await page.evaluate(() => setTxType('مشتريات'));
  await page.waitForSelector('#tx-scan-receive');
  return { page, errors };
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  try {
    for (const view of [{ lang: 'ar', width: 1440 }, { lang: 'en', width: 1440, dark: true }, { lang: 'ar', width: 390 }]) {
      const { page, errors } = await open(browser, view);
      await page.evaluate(() => document.getElementById('tx-scan-receive').click());
      await page.evaluate(() => { PurchaseScanReceive.submit('U-0000-1416-7'); });
      await page.waitForFunction(() => txItems.length === 1);
      await page.evaluate(() => PurchaseScanReceive.addManual('p1'));
      await new Promise(r => setTimeout(r, 400));
      const name = `${label}-${view.lang}-${view.width}${view.dark ? '-dark' : ''}`;
      const box = await page.evaluate(() => { const a = document.querySelector('#tx-fields') || document.querySelector('#page-transaction'); const r = a.getBoundingClientRect(); return { y: r.top + scrollY }; });
      await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      console.log(name, 'overflow', overflow, 'errors', errors.length ? errors : 0);
      if (label === 'after') { assert.ok(overflow <= 0, name + ' no horizontal overflow'); assert.deepEqual(errors, [], name + ' no page errors'); }
      if (label === 'after' && view.width === 1440 && !view.dark) {
        // The sales form shares the items section: no receiving method there and no purchase grid.
        await page.evaluate(() => setTxType('مبيعات'));
        const sale = await page.evaluate(() => ({ mode: document.getElementById('tx-receive-mode').innerHTML.trim(), grid: document.getElementById('tx-fields').classList.contains('is-purchase') }));
        assert.deepEqual(sale, { mode: '', grid: false }, 'sales form: no receiving method, no purchase grid');
        await page.screenshot({ path: path.join(output, 'after-sales-ar-1440.png'), fullPage: true });
        console.log('sales form clean');
      }
      await page.close();
    }
    console.log('PASS purchase-form-layout ' + label);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
