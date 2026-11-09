const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const publicDir = path.resolve(__dirname, '../../../frontend/public');

(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const contentType = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript';
        return request.respond({ status: 200, contentType, body: fs.readFileSync(file) });
      }
      return request.respond({ status: 200, contentType: request.resourceType() === 'script' ? 'text/javascript' : 'application/json', body: request.resourceType() === 'script' ? '' : '{}' });
    });
    for (const [width, lang, dir] of [[390, 'en', 'ltr'], [320, 'ar', 'rtl']]) {
      await page.setViewport({ width, height: 700 });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      const result = await page.evaluate(({ lang, dir }) => {
        currentLang = lang;
        currentUser = { _id: 'admin-1', role: 'admin', perms: ['shopify-orders', 'shopify-deposit-upload'] };
        _spScheduleReceiptThumbs = () => {};
        document.documentElement.lang = lang;
        document.documentElement.dir = dir;
        const receipt = {
          id: 'receipt-1', status: 'معتمد', amount: 500, method: 'Instapay', vaultEntryId: 'entry-1',
          ocr: { amount: 500, method: 'Instapay' }, senderName: 'C', senderHandle: 'cilabxinstapay@instapay', transferReference: '955386166910',
          transferDateText: '07 Nov 2026 11:07 AM', submittedBy: 'Malak Abbas',
          submittedAt: '2026-11-07T09:08:00Z', reviewedBy: 'Fares', vaultTxNo: 'SAL-1221',
        };
        const order = { _id: 'order-1', status: 'pending', cancelled: false, depositReceipts: [receipt] };
        const host = document.createElement('main');
        host.style.cssText = 'width:min(100%,390px);box-sizing:border-box;padding:12px;background:var(--bg);';
        host.innerHTML = _spPeekReceiptsHtml(order, false, false, false);
        for (const child of document.body.children) child.style.display = 'none';
        document.body.append(host);
        const image = host.querySelector('.spdep-thumb');
        image.querySelector('img').src = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="90" height="130"><rect width="90" height="130" fill="white"/><path d="M12 20h66M12 35h46M12 64h66M12 80h60" stroke="#b6c0ba" stroke-width="5"/><text x="12" y="110" font-size="14" fill="#287b4b">500 EGP</text></svg>'], { type: 'image/svg+xml' }));
        image.classList.add('is-ready');
        const row = host.querySelector('.spdep-peek-row');
        const detail = row.querySelector('details');
        return {
          height: row.getBoundingClientRect().height,
          thumb: image.getBoundingClientRect().width,
          overflow: host.scrollWidth > host.clientWidth + 1,
          hasAmount: row.querySelector('.spdep-peek-amount')?.textContent.includes('500'),
          hasMethod: row.querySelector('.spdep-method-label')?.textContent.includes('Instapay'),
          hasAdd: !!host.querySelector('.spdep-add'),
          hasRefund: !!row.querySelector('[onclick*="refund"]'),
          detailsClosed: !detail.open,
        };
      }, { lang, dir });
      assert.ok(result.height < 150, `${width}px ${lang}: receipt stays compact: ${JSON.stringify(result)}`);
      assert.ok(result.thumb <= 54 && result.thumb >= 48, 'receipt thumbnail remains visible');
      assert.equal(result.overflow, false, `${width}px ${lang}: no horizontal overflow`);
      assert.ok(result.hasAmount && result.hasMethod && result.hasAdd && result.hasRefund && result.detailsClosed);
      await page.waitForFunction(() => document.querySelector('.spdep-thumb img')?.naturalWidth > 0);
      await page.screenshot({ path: path.join(os.tmpdir(), `soulia-shopify-receipt-peek-${width}-${lang}.png`) });
      await page.click('.spdep-peek-details>summary');
      assert.equal(await page.$eval('.spdep-peek-details', el => el.open), true);
      assert.ok((await page.$eval('.spdep-peek-details', el => el.textContent)).includes('955386166910'));
      assert.deepEqual(errors, []);
    }
    console.log('shopify receipt peek: passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
