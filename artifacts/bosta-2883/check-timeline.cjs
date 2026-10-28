const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const root = path.resolve(__dirname, '../..'), pub = path.join(root, 'frontend/public');
const puppeteer = require(path.join(root, 'backend/node_modules/puppeteer'));
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 1100, deviceScaleFactor: 1 });
    await page.emulateTimezone('Africa/Cairo');
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url()), file = path.resolve(pub, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(pub + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return request.respond({ status: 200, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream', body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentLang = 'ar'; currentUser = { role: 'admin', perms: [] };
      const tx = { type: 'مبيعات', ref: '2883', bostaOrderId: 'b1', bostaStatus: 'IN_TRANSIT', pickupStatus: 'Shipped',
        createdAt: '2026-10-27T12:00:00Z', shippedAt: '2026-10-28T06:00:00Z', items: [],
        bostaDeliveryException: { code: 3, at: '2026-10-28T08:46:38.320Z', scheduledAt: '2026-10-29T03:00:00.000Z' } };
      document.body.innerHTML = '<main style="padding:12px">' + buildOrderTimelineSection(tx) + '</main>';
      document.documentElement.dir = 'rtl';
      document.querySelector('.ord-timeline-header').classList.add('expanded');
      document.querySelector('.ord-timeline-header').nextElementSibling.classList.add('open');
    });
    await page.waitForSelector('.ord-tl-postponement', { visible: true });
    const result = await page.$eval('.ord-tl-postponement', element => ({
      text: element.closest('.ord-tl-step').innerText, overflow: element.scrollWidth > element.clientWidth + 1,
    }));
    assert.equal(result.overflow, false);
    assert.match(result.text, /تأجيل الاستلام بطلب العميل/);
    await page.screenshot({ path: path.join(__dirname, 'postponement-timeline-mobile.png'), fullPage: true });
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
