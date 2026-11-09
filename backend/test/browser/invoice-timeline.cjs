const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');
const base = { _id: 'invoice-1', ref: '3010', type: 'مبيعات', client: 'عميل تجريبي',
  createdAt: '2026-11-01T09:00:00+02:00', date: '2026-11-01', total: 1500, remaining: 1000,
  items: [{ name: 'منتج', qty: 1, price: 1500, total: 1500 }] };
let transaction = base;

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Cairo');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/transactions/invoice-1') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(transaction) });
      if (url.pathname === '/config.js') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.BACKEND_URL="http://soulia.test/api";' });
      const file = path.join(publicDir, url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && fs.existsSync(file) && fs.statSync(file).isFile())
        return request.respond({ status: 200, contentType: url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html', body: fs.readFileSync(file) });
      return request.respond({ status: 200, contentType: 'text/plain', body: '' });
    });
    async function openInvoice(width) {
      await page.setViewport({ width, height: 900 });
      await page.goto('http://soulia.test/invoice.html?tx=invoice-1', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.invoice-timeline-item');
      return page.evaluate(() => ({
        labels: [...document.querySelectorAll('.invoice-timeline-title')].map(el => el.textContent.trim()),
        dates: [...document.querySelectorAll('.invoice-timeline-time')].map(el => el.dateTime),
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        hasTimeline: !!document.querySelector('ol[data-slot="timeline"]'),
      }));
    }

    transaction = { ...base, pickupStatus: 'Ready', bostaOrderId: 'b1', bostaStatus: 'CREATED',
      pickupHistory: [{ action: 'preparing', date: '2026-11-02T10:00:00+02:00' }, { action: 'ready', date: '2026-11-02T13:00:00+02:00' }],
      shipmentEvents: [{ type: 'sent', at: '2026-11-03T08:00:00+02:00' }] };
    const ready = await openInvoice(390);
    assert.equal(ready.hasTimeline, true);
    assert.equal(ready.overflow, false);
    assert.deepEqual(ready.labels, ['تم تسجيل الطلب', 'بدأ تجهيز الطلب', 'جاهز للشحن', 'تم إنشاء الشحنة', 'بانتظار استلام شركة الشحنالحالة الحالية']);
    assert.equal(ready.dates.length, 4, 'only recorded events receive timestamps');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(os.tmpdir(), 'soulia-invoice-timeline-390.png'), fullPage: true });

    transaction = { ...base, pickupStatus: 'Shipped', bostaOrderId: 'b1', bostaStatus: 'DELIVERED',
      shippedAt: '2026-11-03T08:00:00+02:00', deliveredAt: '2026-11-05T17:00:00+02:00' };
    const delivered = await openInvoice(320);
    assert.equal(delivered.overflow, false);
    assert.deepEqual(delivered.labels, ['تم تسجيل الطلب', 'تم إنشاء الشحنة', 'تم تسليم الطلب']);
    assert.deepEqual(errors, []);

    transaction = { ...base, cancelled: true, pickupStatus: 'Pending' };
    const cancelled = await openInvoice(390);
    assert.ok(cancelled.labels.at(-1).includes('ملغي'));
    assert.equal(cancelled.dates.length, 1, 'undated cancellation has no invented timestamp');

    transaction = { ...base, type: 'مشتريات' };
    await page.goto('http://soulia.test/invoice.html?tx=invoice-1', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.inv-card');
    assert.equal(await page.$('.invoice-timeline'), null, 'purchase invoices do not show order delivery stages');
    console.log('invoice timeline: passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
