// Expense receipt photo upload (real app at 8080, API answered here). Screenshots: artifacts/invoice-image-upload/.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const output = path.resolve(__dirname, '../../../artifacts/invoice-image-upload');
const ID = 'e'.repeat(64);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; console.log('  ✓', msg); };

async function open(browser, { lang = 'ar', width = 1440, dark = false, fail = false, delay = 0, expenses = [] } = {}) {
  const page = await browser.newPage(), errors = [], uploads = [], saves = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({ width, height: 1000 });
  await page.evaluateOnNewDocument((lang, dark) => {
    localStorage.setItem('token', 'expimg-test');
    localStorage.setItem('user', JSON.stringify({ _id: 'u1', name: 'Owner', role: 'admin', perms: [] }));
    localStorage.setItem('soulia_lang_pref', lang);
    if (dark) localStorage.setItem('darkMode', 'true');
  }, lang, dark);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const p = new URL(request.url()).pathname;
    if (!p.startsWith('/api/')) return request.continue();
    const respond = (data, status = 200) => request.respond({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (p === '/api/invoice-images' && request.method() === 'POST') {
      uploads.push(request.postData() || (request.fetchPostData ? (await request.fetchPostData().catch(() => '')) || '' : ''));
      if (delay) await new Promise(r => setTimeout(r, delay));
      if (fail) return respond({ message: 'تعذّر حفظ الصورة على التخزين السحابي؛ أعد المحاولة' }, 503);
      return respond({ id: ID, url: `/api/invoice-images/${ID}.jpg`, bytes: 98 * 1024, storage: 'r2' });
    }
    if (p.startsWith('/api/invoice-images/')) return request.respond({ status: 200, contentType: 'image/png', body: PNG });
    if (p === '/api/expenses' && request.method() === 'POST') { saves.push(JSON.parse(request.postData() || '{}')); return respond({ _id: 'x1', ...saves.at(-1) }); }
    if (p === '/api/expenses') return respond(expenses);
    if (p === '/api/auth/me') return respond({ _id: 'u1', name: 'Owner', role: 'admin', perms: [] });
    if (p === '/api/settings') return respond({ lang, darkMode: dark });
    if (p === '/api/transactions/startup-overview') return respond({ rows: [], activeCount: 0 });
    if (p === '/api/notifications' || p === '/api/notifications/preferences') return respond({ preferences: { enabled: false }, subscriptions: [] });
    return respond([]);
  });
  await page.goto(origin + '/#expenses', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof openExpenseModal === 'function' && !document.querySelector('#splash-screen'), { timeout: 30000 });
  return { page, errors, uploads, saves };
}

async function chooseFile(page) {
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.click('#em-attach-section .inv-up-btn')]);
  ok(!chooser.isMultiple(), 'the picker takes one photo (one attachment per expense)');
  const file = path.join(output, '_expense.png');
  fs.writeFileSync(file, PNG);
  await chooser.accept([file]);
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await puppeteer.launch({ headless: true });
  try {
    const a = await open(browser, { delay: 700 });
    await a.page.evaluate(() => openExpenseModal());
    await a.page.waitForSelector('#em-attach-section .inv-up-btn');
    ok((await a.page.$eval('#em-attach-section .inv-up-btn', b => b.textContent.trim())) === 'رفع صورة', 'button reads «رفع صورة»');
    await chooseFile(a.page);
    await a.page.waitForSelector('#em-attach-section.inv-up-busy');
    const blocked = await a.page.evaluate(async () => { let m = ''; const o = window.toast; window.toast = x => { m = m || x; }; window.validateRequired = () => ({ ok: true }); try { await saveExpense(); } finally { window.toast = o; } return m; });
    ok(/انتظر حتى يكتمل رفع/.test(blocked), 'saving while the photo uploads is refused (' + blocked + ')');
    await a.page.waitForFunction(() => !document.querySelector('#em-attach-section.inv-up-busy'), { timeout: 10000 });
    ok(a.uploads.length === 1 && /name="purpose"\r?\n\r?\nexpense/.test(a.uploads[0]), 'upload sent with purpose=expense');
    const field = await a.page.$eval('#em-attachment-path', i => ({ v: i.value, shown: getComputedStyle(i).display !== 'none' }));
    ok(field.v === `${origin}/api/invoice-images/${ID}.jpg` && !field.shown, 'the attachment holds the photo URL, link field hidden');
    await a.page.waitForFunction(() => { const i = document.querySelector('#em-attach-preview .inv-up-card img'); return i && i.complete && i.naturalWidth > 0; });
    ok(await a.page.$eval('#em-attach-preview .inv-up-meta', m => m.textContent.includes('98 KB')), 'thumbnail + size shown');
    await a.page.screenshot({ path: path.join(output, 'expense-ar-1440.png') });
    await a.page.click('#em-attach-preview .inv-up-clear');
    const cleared = await a.page.$eval('#em-attachment-path', i => ({ v: i.value, shown: getComputedStyle(i).display !== 'none' }));
    ok(cleared.v === '' && cleared.shown, 'remove clears the photo and shows the link field again');
    ok(a.errors.length === 0, 'no page errors (ar)');
    await a.page.close();

    // A failed upload keeps the field as it was.
    const b = await open(browser, { fail: true });
    await b.page.evaluate(() => openExpenseModal());
    await b.page.waitForSelector('#em-attach-section .inv-up-btn');
    await b.page.type('#em-attachment-path', 'https://example.com/r.jpg');
    await chooseFile(b.page);
    await b.page.waitForFunction(() => !document.querySelector('#em-attach-section.inv-up-busy') && !document.querySelector('#em-attach-preview .inv-up-meta'), { timeout: 10000 });
    ok((await b.page.$eval('#em-attachment-path', i => i.value)) === 'https://example.com/r.jpg', 'a failed upload keeps the typed link');
    await b.page.close();

    // An existing uploaded attachment can be removed; English + phone fit.
    const c = await open(browser, { lang: 'en', width: 390, dark: true, expenses: [{ _id: 'e1', expenseNo: 'EXP-1', date: '2026-11-16', desc: 'Tape', category: 'Packaging', amount: 50, account: 'كاش', status: 'معلق', attachment: `${origin}/api/invoice-images/${ID}.jpg` }] });
    await c.page.waitForFunction(() => Array.isArray(window.expenses) ? expenses.length === 1 : typeof expenses !== 'undefined' && expenses.length === 1, { timeout: 15000 }).catch(() => {});
    await c.page.evaluate(() => { if (!expenses.length) expenses.push({ _id: 'e1', expenseNo: 'EXP-1', date: '2026-11-16', desc: 'Tape', category: 'Packaging', amount: 50, account: 'كاش', status: 'معلق', attachment: location.origin + '/api/invoice-images/' + 'e'.repeat(64) + '.jpg' }); openExpenseModal('e1'); });
    await c.page.waitForSelector('#em-attach-section .inv-up-clear.is-text');
    ok((await c.page.$eval('#em-attach-section .inv-up-btn', b => b.textContent.trim())) === 'Upload photo', 'English label');
    await (await c.page.$('#em-attach-section')).screenshot({ path: path.join(output, 'expense-en-390-dark.png') });
    ok((await c.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0, 'no horizontal overflow at 390');
    await c.page.click('#em-attach-section .inv-up-clear.is-text');
    ok((await c.page.$eval('#em-attachment-path', i => i.value)) === '' && !(await c.page.$('#em-attach-preview img')), 'saved photo can be removed');
    ok(c.errors.length === 0, 'no page errors (en)');
    await c.page.close();
    fs.rmSync(path.join(output, '_expense.png'), { force: true });
    console.log(`PASS expense-image-upload (${checks} checks)`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
