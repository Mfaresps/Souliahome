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
          warnings: [{ code: 'awaiting-send' }], warningAcknowledgedAt: '2026-11-07T09:08:00Z',
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
          hasWarning: !!row.querySelector('.spdep-notice'),
        };
      }, { lang, dir });
      assert.ok(result.height < 150, `${width}px ${lang}: receipt stays compact: ${JSON.stringify(result)}`);
      assert.ok(result.thumb <= 54 && result.thumb >= 48, 'receipt thumbnail remains visible');
      assert.equal(result.overflow, false, `${width}px ${lang}: no horizontal overflow`);
      assert.ok(result.hasAmount && result.hasMethod && result.hasAdd && result.hasRefund && result.detailsClosed);
      assert.equal(result.hasWarning, false, 'approved receipts do not keep showing review notices');
      await page.waitForFunction(() => document.querySelector('.spdep-thumb img')?.naturalWidth > 0);
      await page.screenshot({ path: path.join(os.tmpdir(), `soulia-shopify-receipt-peek-${width}-${lang}.png`) });
      const summaryBefore = await page.$eval('.spdep-peek-details>summary', el => el.getBoundingClientRect().top);
      const actionBefore = await page.$eval('.spdep-peek-footer .spdep-actions', el => el.getBoundingClientRect().top);
      await page.click('.spdep-peek-details>summary');
      assert.equal(await page.$eval('.spdep-peek-details', el => el.open), true);
      assert.ok((await page.$eval('.spdep-peek-details', el => el.textContent)).includes('955386166910'));
      assert.ok(Math.abs(await page.$eval('.spdep-peek-details>summary', el => el.getBoundingClientRect().top) - summaryBefore) < 1, 'opening does not move the summary');
      assert.ok(Math.abs(await page.$eval('.spdep-peek-footer .spdep-actions', el => el.getBoundingClientRect().top) - actionBefore) < 1, 'opening does not move refund');
      assert.equal(await page.$('.spdep-details-arrow') !== null, true);
      assert.equal(await page.$eval('.spdep-receipt-fields', el => el.textContent.includes('SAL-1221')), true);
      assert.equal(await page.$eval('main', el => el.scrollWidth > el.clientWidth + 1), false, 'expanded details fit the phone');
      const dataRules = await page.evaluate(() => ({
        vaultOnly: _spPeekReceiptDataHtml({ vaultTxNo: 'SAL-9000' }).includes('SAL-9000'),
        empty: _spPeekReceiptDataHtml({ submittedAt: 'bad-date', screenshotTime: '29:99' }),
        edited: _spPeekReceiptDataHtml({ senderHandle: '', transferReference: '', ocr: { senderHandle: 'old@instapay', reference: 'old-reference' } }),
        pendingWarning: _spReceiptNoticeHtml({ status: 'معلق', warnings: [{ code: 'awaiting-send' }], ocr: { amount: 500 } }).includes('spdep-notice'),
      }));
      assert.equal(dataRules.vaultOnly, true); assert.equal(dataRules.empty, ''); assert.equal(dataRules.edited, '');
      assert.equal(dataRules.pendingWarning, true, 'warnings remain visible until approval');
      const noticeRules=await page.evaluate(()=>{
        const recognized={status:'معلق',amount:300,method:'فودافون كاش',needsReview:false,ocr:{amount:300,method:'فودافون كاش'},warnings:[]};
        // The order summary deliberately omits OCR; its detail response follows later.
        const summary={status:recognized.status,amount:recognized.amount,method:recognized.method,needsReview:false};
        const notice=receipt=>_spReceiptNoticeHtml(receipt);
        return {
          summary:notice(summary),recognized:notice(recognized),
          amountOnly:notice({...recognized,ocr:{amount:300}}),
          vaultOnly:notice({...recognized,ocr:{method:'فودافون كاش'}}),
          manual:notice({...recognized,ocr:{amount:null,method:''}}),
          changedAmount:notice({...recognized,amount:400}),
          changedVault:notice({...recognized,method:'Instapay'}),
          review:notice({...summary,needsReview:true}),
          duplicate:notice({...summary,warnings:[{code:'same-image',orderRef:'2719'}]}),
          manualAmountLabel:t('spDepManualAmount'),manualVaultLabel:t('spDepManualVault'),
        };
      });
      assert.equal(noticeRules.summary,'','summary data must not flash an invented amount/vault warning while details load');
      assert.equal(noticeRules.recognized,'','matching recognized values need no warning');
      assert.equal(noticeRules.amountOnly,'','omitted vault recognition is unknown, not manual entry');
      assert.equal(noticeRules.vaultOnly,'','omitted amount recognition is unknown, not a scan failure');
      assert(noticeRules.manual.includes('spdep-notice'),'confirmed manual entry remains visible');
      assert(noticeRules.changedAmount.includes('spdep-notice'),'a real amount change remains visible');
      assert(noticeRules.changedVault.includes('spdep-notice'),'a real vault change remains visible');
      assert(noticeRules.review.includes('is-review'),'an explicit review flag still shows its notice');
      assert(noticeRules.duplicate.includes('is-duplicate')&&noticeRules.duplicate.includes('2719'),'duplicate evidence remains visible without OCR');
      assert(!noticeRules.duplicate.includes(noticeRules.manualAmountLabel)&&!noticeRules.duplicate.includes(noticeRules.manualVaultLabel),'missing OCR must not add invented manual-entry claims to real warnings');
      await page.focus('.spdep-peek-details>summary'); await page.keyboard.press('Enter');
      assert.equal(await page.$eval('.spdep-peek-details', el => el.open), false, 'keyboard collapses details');
      assert.deepEqual(errors, []);
    }
    console.log('shopify receipt peek: passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
