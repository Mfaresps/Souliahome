// Supplier invoice photo upload on the new purchase form (real app at 8080, API answered here).
// Screenshots: artifacts/invoice-image-upload/. Usage: node invoice-image-upload.cjs
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const output = path.resolve(__dirname, '../../../artifacts/invoice-image-upload');
const ID = 'c'.repeat(64);
// 1×1 PNG, enough for an <img> to load.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log('  ✓', msg); };

async function open(browser, { lang = 'ar', width = 1440, dark = false, delayUpload = 0 } = {}) {
  const page = await browser.newPage(), errors = [], uploads = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({ width, height: 1000 });
  await page.evaluateOnNewDocument((lang, dark) => {
    localStorage.setItem('token', 'invimg-test');
    localStorage.setItem('user', JSON.stringify({ _id: 'u1', name: 'Owner', role: 'admin', perms: [] }));
    localStorage.setItem('soulia_lang_pref', lang);
    if (dark) localStorage.setItem('darkMode', 'true');
  }, lang, dark);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url()), p = url.pathname;
    if (!p.startsWith('/api/')) return request.continue();
    const respond = data => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    if (p === '/api/invoice-images' && request.method() === 'POST') {
      uploads.push({ type: request.headers()['content-type'] || '', auth: request.headers().authorization || '' });
      if (delayUpload) await new Promise(r => setTimeout(r, delayUpload));
      return respond({ id: ID, url: `/api/invoice-images/${ID}.jpg`, bytes: 143 * 1024, storage: 'r2' });
    }
    if (p.startsWith('/api/invoice-images/')) return request.respond({ status: 200, contentType: 'image/png', body: PNG });
    if (p === '/api/auth/me') return respond({ _id: 'u1', name: 'Owner', role: 'admin', perms: [] });
    if (p === '/api/settings') return respond({ lang, darkMode: dark });
    if (p === '/api/suppliers') return respond([{ _id: 's1', name: 'Talla Home', phone: '01000000000' }]);
    if (p === '/api/warehouses') return respond([{ code: 'MAIN', name: 'المخزن الرئيسي', active: true, isDefault: true }]);
    if (p === '/api/transactions/startup-overview') return respond({ rows: [], activeCount: 0 });
    if (p === '/api/notifications' || p === '/api/notifications/preferences') return respond({ preferences: { enabled: false }, subscriptions: [] });
    return respond([]);
  });
  await page.goto(origin + '/#transaction', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof currentPage !== 'undefined' && currentPage === 'transaction' && !document.querySelector('#splash-screen'), { timeout: 30000 });
  await page.evaluate(() => setTxType('مشتريات'));
  await page.waitForSelector('#tx-fields .pf-imgs-btn');
  return { page, errors, uploads };
}

async function chooseFile(page, selector) {
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click(selector)]);
  const file = path.join(output, '_invoice.png');
  fs.writeFileSync(file, PNG);
  await chooser.accept([file]);
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  try {
    // 1. Upload on the new purchase form (Arabic, 1440).
    const { page, errors, uploads } = await open(browser, { delayUpload: 900 });
    const label = await page.$eval('#tx-fields .pf-imgs-btn', b => b.textContent.trim());
    ok(label === 'رفع صورة الفاتورة', 'upload button reads «رفع صورة الفاتورة»');
    ok(!!(await page.$('#tx-fields .pf-imgs-link')), 'a link button sits beside it');
    await chooseFile(page, '#tx-fields .pf-imgs-btn');
    await page.waitForSelector('#tx-invoice-imgs-list .inv-up-busy');
    ok(await page.evaluate(() => InvoiceImageUpload.busy('#tx-invoice-imgs-list')), 'uploading row is marked busy');
    ok(await page.$eval('#tx-invoice-imgs-list .inv-up-meta b', b => b.textContent.includes('جارٍ رفع')), 'progress text shown while uploading');
    await page.screenshot({ path: path.join(output, 'uploading-ar-1440.png') });
    await page.waitForFunction(() => !document.querySelector('#tx-invoice-imgs-list .inv-up-busy'), { timeout: 10000 });
    ok(uploads.length === 1 && uploads[0].type.startsWith('multipart/form-data') && uploads[0].auth === 'Bearer invimg-test', 'one multipart upload with the session token');
    const val = await page.$eval('#tx-invoice-imgs-list .invoice-img-url', i => ({ v: i.value, shown: getComputedStyle(i).display !== 'none' }));
    ok(val.v === `${origin}/api/invoice-images/${ID}.jpg`, 'the row holds the absolute photo URL');
    ok(!val.shown, 'the URL field of an uploaded photo is hidden');
    await page.waitForFunction(() => { const i = document.querySelector('#tx-invoice-imgs-list .inv-up-card img'); return i && i.complete && i.naturalWidth > 0; });
    ok(true, 'the uploaded photo thumbnail loads');
    ok(await page.$eval('#tx-invoice-imgs-list .inv-up-meta', m => m.textContent.includes('143 KB') && m.textContent.includes('R2')), 'size and «Cloudflare R2» shown');
    const saved = await page.evaluate(() => Array.from(qsa('#tx-invoice-imgs-list .invoice-img-url')).map(i => i.value.trim()).filter(Boolean));
    ok(saved.length === 1 && saved[0].endsWith(`${ID}.jpg`), 'the save path reads the photo URL like a link');
    await page.click('#tx-fields .pf-imgs-link');
    ok(await page.evaluate(() => document.activeElement?.classList.contains('invoice-img-url') && getComputedStyle(document.activeElement).display !== 'none'), 'the link button adds a visible, focused link field');
    await page.screenshot({ path: path.join(output, 'done-ar-1440.png') });
    ok(errors.length === 0, 'no page errors (ar)');
    await page.close();

    // 2. Saving while a photo uploads is refused.
    const b = await open(browser, { delayUpload: 4000 });
    await chooseFile(b.page, '#tx-fields .pf-imgs-btn');
    await b.page.waitForSelector('#tx-invoice-imgs-list .inv-up-busy');
    const blocked = await b.page.evaluate(async () => { let msg = ''; const orig = window.toast; window.toast = (m) => { msg = msg || m; }; txItems.splice(0, txItems.length, { productId: 'p1', code: 'C1', name: 'Basket', qty: 1, price: 100 }); window.validateTx = () => true; const sel = qs('#tx-supplier'); if (sel) { sel.value = 'Talla Home'; } const ref = qs('#tx-ref'); if (ref) ref.value = '900500'; try { await saveTx(); } catch (_) {} finally { window.toast = orig; } return msg; });
    ok(/انتظر حتى يكتمل رفع صورة الفاتورة/.test(blocked), 'save attempt during upload is stopped (' + blocked + ')');
    await b.page.close();

    // 3. English dark + phone: no overflow, labels translated.
    for (const view of [{ lang: 'en', width: 1440, dark: true }, { lang: 'ar', width: 390 }]) {
      const v = await open(browser, view);
      await chooseFile(v.page, '#tx-fields .pf-imgs-btn');
      await v.page.waitForFunction(() => document.querySelector('#tx-invoice-imgs-list .inv-up-card.is-done'), { timeout: 10000 });
      const overflow = await v.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      ok(overflow <= 0, `${view.lang} ${view.width} no horizontal overflow`);
      if (view.lang === 'en') ok((await v.page.$eval('#tx-fields .pf-imgs-btn', b => b.textContent.trim())) === 'Upload invoice photo', 'English label');
      const name = `done-${view.lang}-${view.width}${view.dark ? '-dark' : ''}.png`;
      const el = await v.page.$('#tx-fields');
      await el.screenshot({ path: path.join(output, name) });
      ok(v.errors.length === 0, `no page errors (${view.lang} ${view.width})`);
      await v.page.close();
    }
    fs.rmSync(path.join(output, '_invoice.png'), { force: true });
    console.log(`PASS invoice-image-upload (${checks} checks)`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
