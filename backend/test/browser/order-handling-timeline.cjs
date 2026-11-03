const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Cairo');
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/') {
        return request.respond({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8') });
      }
      if (url.origin === 'http://soulia.test' && url.pathname === '/config.js') {
        return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.__ENV__={API_BASE_URL:""};' });
      }
      if (request.resourceType() === 'script') {
        const file = path.join(publicDir, url.pathname.slice(1));
        return request.respond({ status: 200, contentType: 'text/javascript', body: url.origin === 'http://soulia.test' && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' });
      }
      return request.respond({ status: 200, contentType: 'text/plain', body: '' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });

    for (const lang of ['en', 'ar']) {
      const result = await page.evaluate(lang => {
        currentLang = lang;
        currentUser = { _id: 'admin', role: 'admin', perms: [] };
        const tx = {
          _id: 'timeline-order', ref: '2772', type: 'مبيعات', client: 'Customer',
          items: [], total: 1500, deposit: 500, remaining: 1000,
          shopifyOrderId: 'shopify-2772', assignedToName: 'Malak Abbas',
          assignedAt: '2026-11-01T20:54:00+02:00',
          confirmedByName: 'Hassan Ammar', confirmedAt: '2026-11-03T12:32:00+02:00',
          deposits: [{ amount: 500, by: 'Malak Abbas', date: '2026-11-02T21:18:00+02:00' }],
        };
        transactions = [tx];
        followUps = [];
        users = [];
        inventoryCache = [];
        window._invoiceViewTxId = tx._id;
        _ivHydrateFull = () => {};
        _ivLoadBostaDetails = () => {};
        renderInvoiceViewPage();
        const rows = [...document.querySelectorAll('#inv-view-content .inv2-path-step')];
        return rows.map(row => ({
          label: row.querySelector('.inv2-path-k')?.textContent.trim(),
          name: row.querySelector('.inv2-path-n')?.textContent.trim(),
          time: row.querySelector('.inv2-path-d')?.textContent.trim(),
          last: row.classList.contains('is-last'),
        }));
      }, lang);
      assert.equal(result.length, 3, `${lang}: all three steps are shown`);
      assert.equal(result[0].name, 'Malak Abbas');
      assert.equal(result[1].name, 'Malak Abbas');
      assert.equal(result[2].name, 'Hassan Ammar');
      assert.deepEqual(result.map(row => row.last), [false, false, true]);
      assert.ok(result[1].label.includes(lang === 'en' ? 'Deposit' : 'العربون'), `${lang}: deposit comes before Prepare & Ship`);
      assert.ok(result[2].label.includes(lang === 'en' ? 'Prepare & Ship' : 'تحضير وشحن'));
      assert.ok(result.every(row => row.time), `${lang}: each step keeps its own time`);
    }
    console.log('PASS: Order Handling follows event dates in English and Arabic.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
