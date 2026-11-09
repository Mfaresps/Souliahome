const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const css = fs.readFileSync(path.join(publicDir, 'order-status.css'), 'utf8');
    const js = fs.readFileSync(path.join(publicDir, 'order-status.js'), 'utf8');
    for (const width of [320, 390, 1440]) for (const lang of ['ar', 'en']) {
      await page.setViewport({ width, height: 200 });
      await page.setContent(`<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><style>${css}</style></head><body style="margin:0;padding:12px;font-family:Arial,sans-serif"><div id="row" style="display:flex;align-items:center;flex-wrap:wrap;width:100%;box-sizing:border-box"></div></body></html>`);
      await page.addScriptTag({ content: js });
      const result = await page.evaluate(lang => {
        const row = { bostaOrderId: 'b1', bostaStatus: 'IN_TRANSIT', bostaIsDelayed: true };
        document.querySelector('#row').innerHTML = SouliaOrderStatus.badge(SouliaOrderStatus.resolve(row, 'transaction', lang));
        const state = document.querySelector('.order-state');
        const delay = document.querySelector('.order-delay-badge');
        return { state: state.textContent, delay: delay?.textContent,
          overflow: document.documentElement.scrollWidth > innerWidth,
          delayVisible: !!delay && delay.getBoundingClientRect().width > 0 };
      }, lang);
      assert.equal(result.delay, lang === 'ar' ? 'متأخر' : 'Delayed');
      assert.equal(result.delayVisible, true);
      assert.equal(result.overflow, false, `${lang}/${width} overflows`);
      assert.ok(result.state.includes(lang === 'ar' ? 'في الطريق' : 'In Transit'));
      if (width === 390 && lang === 'ar') await page.screenshot({ path: path.join(os.tmpdir(), 'soulia-bosta-delay-badge.png') });
    }
    process.stdout.write('Bosta delay badge renders at 320, 390 and 1440px in Arabic and English.\n');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
