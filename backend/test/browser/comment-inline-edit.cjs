/* Inline comment editing: validation, cancel, async failure/retry, keyboard and motion. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
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
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'image/webp';
        return request.respond({ status: 200, contentType: type, body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: '' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentUser = { name: 'Editor', username: 'Editor', role: 'admin' };
      qs('#tx-comments-list')?.setAttribute('id', 'tx-comments-list-original');
      qs('#tx-cmt-count')?.setAttribute('id', 'tx-cmt-count-original');
      document.body.insertAdjacentHTML('beforeend', '<div id="inline-edit-fixture" style="position:fixed;z-index:2147483647;inset:10px auto auto 10px;width:650px;padding:16px;background:white"><span id="tx-cmt-count"></span><div id="tx-comments-list"></div><div id="inv-cmt-7" class="inv-cmt-item"><div class="tx-cmt-body"><div class="tx-cmt-text">Original invoice</div></div><div class="tx-cmt-actions"><button class="tx-cmt-btn">Edit</button></div></div></div>');
      txComments = [{ id: 1, text: 'Original transaction', employee: 'Editor', timestamp: Date.now() }];
      renderTxComments();
      transactions = [{ _id: 'invoice-1', comments: [{ id: 7, text: 'Original invoice', employee: 'Editor' }] }];
      window.inlineApiFails = true;
      api = async () => { if (window.inlineApiFails) throw new Error('network failed'); return {}; };
      refreshInvoiceView = () => { qs('#inv-cmt-7 .tx-cmt-text').textContent = transactions[0].comments[0].text; };
    });

    await page.evaluate(() => startEditTxComment(1));
    assert.equal(await page.$eval('#tx-cmt-edit-1', el => el.value), 'Original transaction');
    await page.$eval('#tx-cmt-edit-1', el => { el.value = '   '; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#tx-cmt-1 .cie-save');
    assert.equal(await page.$eval('#tx-cmt-1 .cie-error', el => el.hidden), false, 'blank edits show validation');
    assert.equal(await page.$eval('#tx-cmt-edit-1', el => el.getAttribute('aria-invalid')), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await page.$('#tx-cmt-edit-1'), null, 'Escape restores preview');
    assert.equal(await page.$eval('#tx-cmt-1 .tx-cmt-text', el => el.textContent), 'Original transaction');

    await page.evaluate(() => startEditTxComment(1));
    await page.$eval('#tx-cmt-edit-1', el => { el.value = 'Updated transaction'; el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); });
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelector('#tx-cmt-1 .tx-cmt-text')?.textContent === 'Updated transaction');

    await page.evaluate(() => startEditInvComment('invoice-1', 7));
    await page.$eval('#inv-cmt-edit-7', el => { el.value = 'Updated invoice'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.click('#inv-cmt-7 .cie-save');
    await page.waitForFunction(() => document.querySelector('#inv-cmt-7 .cie-error')?.hidden === false);
    assert.equal(await page.$eval('#inv-cmt-edit-7', el => el.value), 'Updated invoice', 'failed save retains draft');
    assert.equal(await page.evaluate(() => transactions[0].comments[0].text), 'Original invoice', 'failed save leaves data intact');
    await page.evaluate(() => { window.inlineApiFails = false; });
    await page.click('#inv-cmt-7 .cie-save');
    await page.waitForFunction(() => transactions[0].comments[0].text === 'Updated invoice');

    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.evaluate(() => startEditTxComment(1));
    assert.equal(await page.$eval('#tx-cmt-1 .tx-cmt-text', el => getComputedStyle(el).animationName), 'none');
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, [], 'no browser errors');
    console.log('comment inline edit: passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
