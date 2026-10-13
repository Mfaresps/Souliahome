const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const source = fs.readFileSync(path.join(root, 'announcements.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'announcements.css'), 'utf8');
const rows = Array.from({ length: 50 }, (_, i) => ({
  id: String(i), category: 'work-update', message: `${i}: First line\n${'Long message '.repeat(100)}`,
  audience: 'all', createdByName: 'Fares', createdAt: '2026-10-14T10:00:00Z',
  recipientCount: 2, ackCount: 1, recipients: [{ name: 'Hassan', ackAt: null }, { name: 'Fatma', ackAt: '2026-10-14T11:00:00Z' }],
}));
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const width of [1440, 390, 320]) for (const lang of ['en', 'ar']) {
      await page.setViewport({ width, height: 800 });
      await page.setContent(`<html dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><style>
        :root{--text:#18251d;--muted:#708378;--border:#d4ded8;--surface:#fff;--bg-alt:#f6f8f7;--accent:#287a50;--primary-pale:#e5f2ea}
        *{box-sizing:border-box}body{margin:0;padding:16px;font-family:Arial}
        ${css}</style></head><body><div id="an-hist-body"></div></body></html>`);
      await page.evaluate(language => { window.currentLang = language; window.api = async () => window.testRows; }, lang);
      // Expose the shipped renderer inside its closure without running the account polling loop.
      await page.addScriptTag({ content: source.replace('setInterval(tick, 1500);', `
        window.setHistory = rows => { history = rows; renderHistory(); };
        window.refreshHistory = loadHistory;
      `) });
      await page.evaluate(items => { window.testRows = items; window.setHistory(items); }, rows);
      const ids = () => page.$$eval('.an-hist-item', els => els.map(e => e.dataset.id));
      assert.deepEqual(await ids(), ['0', '1', '2', '3', '4']);
      assert(await page.$eval('[data-history-page="0"]', e => e.disabled));
      await page.click('[data-history-page="2"]');
      assert.deepEqual(await ids(), ['5', '6', '7', '8', '9']);
      await page.evaluate(() => { window.testRows[5].ackCount = 2; return window.refreshHistory(); });
      assert.deepEqual(await ids(), ['5', '6', '7', '8', '9']);
      assert.equal(await page.$eval('.an-hist-read b', e => e.textContent), '2 / 2');
      await page.click('.an-hist-item summary');
      assert.equal(await page.$eval('.an-hist-item .an-hist-message', e => e.textContent), rows[5].message);
      assert.equal(await page.$$eval('.an-hist-item[open] .an-rcp', els => els.length), 2);
      const metrics = await page.evaluate(() => {
        const list = document.querySelector('.an-hist-list');
        return { height: list.getBoundingClientRect().height, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert(metrics.height <= 420); assert.equal(metrics.overflow, false);
      for (let target = 3; target <= 10; target++) await page.click(`[data-history-page="${target}"]`);
      assert.deepEqual(await ids(), ['45', '46', '47', '48', '49']);
      assert(await page.$eval('[data-history-page="11"]', e => e.disabled));
      await page.evaluate(() => window.setHistory(window.testRows.slice(0, 2)));
      assert.deepEqual(await ids(), ['0', '1']);
      await page.evaluate(() => window.setHistory([]));
      assert.equal(await page.$$('.an-hist-item').then(els => els.length), 0);
      assert(await page.$('.an-empty'));
      console.log(`PASS announcement history: pagination, refresh, full message, recipients, ${width}px ${lang}`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
