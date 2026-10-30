const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const puppeteer = require('../../backend/node_modules/puppeteer');
const publicDir = path.resolve(__dirname, '../../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
for (const [, attrs, script] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc=|application\/ld\+json|application\/json/i.test(attrs) && script.trim()) new vm.Script(script);
}
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== 'http://soulia.test') return request.abort();
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }[path.extname(file)];
        return request.respond({ contentType: type || 'application/octet-stream', body: fs.readFileSync(file) });
      }
      return request.respond({ contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ path: path.join(publicDir, 'vendor/chart-4.4.0.min.js') });
    await page.evaluate(() => {
      currentLang = 'ar'; currentPage = 'reports'; activeReportTab = 'charts';
      const card = document.querySelector('#chart-trend').closest('section').outerHTML;
      document.querySelectorAll('link[rel=stylesheet]').forEach(link => document.head.appendChild(link));
      document.body.innerHTML = `<main style="padding:12px;max-width:1440px;margin:auto">${card}</main>`;
      currentReportData = {
        series: Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(i + 10).padStart(2, '0')}`, sales: i === 10 ? 2300 : 0, purchases: 0, orders: i === 10 ? 1 : 0 })),
        orderActivity: { series: Array.from({ length: 14 }, (_, i) => ({ date: `2026-10-${String(i + 10).padStart(2, '0')}`, receivedOrders: i === 10 ? 3 : 0, confirmedOrders: i === 10 ? 1 : 0 })), undatedOrders: 0 },
      };
      renderTrendChart(currentReportData);
    });
    await page.setViewport({ width: 1440, height: 850 });
    await page.click('#rv-trend-toggle');
    assert.equal(await page.$$eval('#rv-trend-table th', cells => cells.length), 4);
    assert.deepEqual(await page.$$eval('#rv-trend-table tr:nth-child(11) td', cells => cells.map(cell => cell.textContent)), ['2026-10-20', 'EGP 2,300', '3', '1']);
    await page.screenshot({ path: path.join(__dirname, 'table-desktop.png') });
    await page.click('[data-trend=confirmedOrders]');
    assert.equal(await page.$eval('#rv-trend-table', el => el.hidden), false, 'metric switch preserves table view');
    assert.equal(await page.$$eval('#rv-trend-table th', cells => cells.length), 3);
    assert.equal(await page.evaluate(() => reportCharts.trend.data.datasets[0].data[10]), 1);
    assert.equal(await page.evaluate(() => reportCharts.trend.data.datasets[0].data[13]), 0, 'registration day stays zero');
    await page.click('#rv-trend-toggle');
    await page.click('[data-trend=receivedOrders]');
    assert.equal(await page.evaluate(() => reportCharts.trend.data.datasets[0].data[10]), 3);
    await page.screenshot({ path: path.join(__dirname, 'chart-desktop.png') });
    await page.setViewport({ width: 390, height: 850 });
    await page.click('#rv-trend-toggle');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal page overflow');
    await page.screenshot({ path: path.join(__dirname, 'table-mobile.png') });
    await page.evaluate(() => {
      currentReportData = { series: [], orderActivity: { series: [{ date: '2026-10-20', receivedOrders: 2, confirmedOrders: 0 }] } };
      setTrendMetric('receivedOrders', document.querySelector('[data-trend=receivedOrders]'));
    });
    assert.equal(await page.$$eval('#rv-trend-table tbody tr', rows => rows.length), 1, 'received-only period remains visible');
    console.log('PASS: inline JavaScript syntax, real Chart.js, counts and dates, table switching, pending-only period, desktop and mobile layout.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
