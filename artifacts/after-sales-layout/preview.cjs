const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const puppeteer = require(path.join(root, 'backend/node_modules/puppeteer'));
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const html = fs.readFileSync(path.join(root, 'frontend/public/index.html'), 'utf8');
    const documentHtml = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    const styles = [...documentHtml.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[0]).join('');
    await page.setContent(`<!doctype html><html><head>${styles}<style>body{margin:0!important;padding:0!important;min-width:0!important}#preview{box-sizing:border-box;width:100%}</style></head><body><div id="preview" style="padding:16px;max-width:1180px;margin:auto"></div></body></html>`);
    await page.addStyleTag({ path: path.join(root, 'frontend/public/after-sales.css') });
    await page.addScriptTag({ path: path.join(root, 'frontend/public/after-sales.js') });
    for (const lang of ['en', 'ar']) for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewport({ width, height: 950 });
      await page.evaluate(({ lang }) => {
        window.currentLang = lang;
        window.isAdmin = () => true;
        document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.body.style.direction = lang === 'ar' ? 'rtl' : 'ltr';
        const tx = { _id: 'sample', type: 'مبيعات', deliveredAt: '2026-10-24', afterSalesEvents: [
          { caseId: 'sample-case', caseRef: 'AS-2026-000004', originalRef: '2845', replacementRef: '2026800002', action: 'requested', stage: 'requested', at: '2026-10-24T11:34:00Z', by: 'System Manager' },
          { caseId: 'sample-case', caseRef: 'AS-2026-000004', originalRef: '2845', replacementRef: '2026800002', action: 'approved', stage: 'approved', at: '2026-10-24T11:35:00Z', by: 'System Manager' },
        ] };
        document.getElementById('preview').innerHTML = `<div class="inv2-grid"><div><div class="inv2-card"><div class="inv2-card-head">${lang === 'ar' ? 'المنتجات' : 'Items'}</div><div class="inv2-card-body">Loop Runner · 2 × 750.00 EGP</div>${AfterSales.invoiceActions(tx)}</div><div class="inv2-card" style="margin-top:12px"><div class="inv2-card-head">${lang === 'ar' ? 'ملخص الطلب' : 'Order Summary'}</div><div class="inv2-card-body">3,400.00 EGP</div></div></div><aside class="inv2-card"><div class="inv2-card-head">Bosta</div><div class="inv2-card-body">Shipping details</div></aside></div>`;
      }, { lang });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth || document.querySelector('.as-invoice-section').getBoundingClientRect().right > innerWidth,
        escaped: [...document.querySelectorAll('.as-invoice-section button,.as-case-path-head bdi')].some(e => { const r = e.getBoundingClientRect(), p = e.closest('.as-invoice-section').getBoundingClientRect(); return r.left < p.left - 1 || r.right > p.right + 1; }),
      }));
      assert.deepEqual(layout, { overflow: false, escaped: false }, `${lang}/${width}`);
      await page.screenshot({ path: path.join(__dirname, `${lang}-${width}.png`), captureBeyondViewport: false });
    }
    console.log('PASS invoice after-sales layout: Arabic/English at 1440, 1024, 768, 390 and 320px; all controls and references stay within the card.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
