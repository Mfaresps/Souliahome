const path = require('node:path');
const puppeteer = require('../backend/node_modules/puppeteer');

(async () => {
  const browser = await puppeteer.launch({headless: true});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://localhost:8080/', {waitUntil: 'domcontentloaded'});
    for (const [width, stateName, lang] of [[1100, 'ready', 'en'], [390, 'error', 'en'], [390, 'error', 'ar']]) {
      await page.setViewport({width, height: 850, deviceScaleFactor: 1});
      await page.evaluate(({stateName, lang}) => {
        currentLang = lang;
        document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        const order = {
          _id: 'review-order',
          items: [
            {lineId: 'a', name: 'Oriva Dining Set (15 pieces)', code: '33', qty: 1, price: 2180},
            {lineId: 'b', name: 'Riva Tissue', code: 'RIVA-TISSUE', qty: 1, price: 479},
          ],
        };
        const state = {
          summary: {lines: [
            {lineId: 'a', qty: 1, units: [], skippedCount: 0},
            {lineId: 'b', qty: 1, units: [], skippedCount: 0},
          ]},
          feedback: stateName === 'error' ? {error: true, text: lang === 'ar' ? 'القطعة غير مطابقة لأصناف الطلب.' : 'This piece does not match the order.', hint: lang === 'ar' ? 'راجع الصنف المعروض وامسح قطعة مطابقة.' : 'Check the product shown and scan a matching piece.', identifier: 'SU-89837410'} : null,
        };
        const intro = _pwScanIntroHtml(order, state);
        document.querySelector('#scan-review-shell')?.remove();
        document.body.insertAdjacentHTML('beforeend', `<div id="scan-review-shell" style="position:fixed;inset:0;z-index:2147483647;overflow:auto;background:#f1f4f7"><div id="pu-card-orders-modal" data-workspace="prep"><div class="pw-work" id="pw-work"><div class="pw-work-head"><div class="pw-cust"><div class="pw-cust-refno">#3015</div><div class="pw-cust-name">Maha Salah</div></div></div><div class="pw-items-wrap"><div class="pw-items-bar"><span class="pw-items-title">Items</span></div><div class="pw-barcode-tools">${intro}</div><div class="pw-grid"><div class="pw-item pw-item-scannable is-next-pick"><div class="pw-item-pic"><div class="product-thumb" style="background:#edf1f5;display:grid;place-items:center;font-size:36px;color:#9ca3af">◻</div><div class="pw-mult"><span class="pw-mult-n">1</span><span class="pw-mult-x">×</span></div></div><div class="pw-item-body"><div class="pw-item-id"><span class="pw-next-label">Scan next</span><div class="pw-item-name">Oriva Dining Set (15 pieces)</div><div class="pw-item-code">SKU Code 33</div></div><div class="pw-item-foot"><div class="pw-item-money"><span>Unit price EGP 2,180</span></div></div><div class="pw-unit-scan-row"><div class="pw-piece-status"><span>Awaiting scan</span><bdi>0 / 1</bdi></div><div class="pw-skip-actions"><button>Prepare without scan</button></div></div></div></div></div></div></div></div></div>`);
      }, {stateName, lang});
      await page.screenshot({path: path.join(__dirname, `scan-station-${lang}-${width}.png`)});
      const bounds = await page.evaluate(() => ({scrollWidth: document.documentElement.scrollWidth, width: innerWidth, target: document.querySelector('.pw-station-target')?.getBoundingClientRect().width, photoWidth: document.querySelector('#scan-review-shell .product-thumb')?.getBoundingClientRect().width}));
      if (bounds.scrollWidth > bounds.width) throw new Error(`Horizontal overflow at ${width}: ${JSON.stringify(bounds)}`);
      if (bounds.photoWidth > 128) throw new Error(`Single-product photo too large at ${width}: ${JSON.stringify(bounds)}`);
    }
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Scan station reviewed at 1100px and 390px without horizontal overflow or page errors.');
  } finally {
    await browser.close();
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
