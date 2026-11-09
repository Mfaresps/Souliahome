/* Hirael-style copy feedback in Soulia's existing copy controls. */
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
      window.copiedText = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedText = text; } } });
      document.body.insertAdjacentHTML('beforeend', `<div id="copy-test" style="position:fixed;z-index:2147483647;inset:10px auto auto 10px;background:#183b30;padding:20px">${copyBtn('SO-42')}<button id="pickup-copy-test" type="button" class="pw-copy" data-hcb data-copy-label="Copy reference" data-copied-label="Copied" data-error-label="Copy failed" data-copy-timeout="50" aria-label="Copy reference" onclick="pwCopyRef(this,'P-4')">${SouliaCopyButton.icons}</button></div>`);
    });
    await page.click('#copy-test .hcb-hero');
    await page.waitForFunction(() => document.querySelector('#copy-test .hcb-hero')?.dataset.state === 'copied');
    assert.equal(await page.evaluate(() => window.copiedText), 'SO-42');
    assert.equal(await page.$eval('#copy-test .hcb-hero', el => el.getAttribute('aria-label')), 'تم النسخ');

    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => { throw new Error('denied'); };
      document.execCommand = command => {
        if (command === 'copy') { window.copiedText = document.activeElement.value; return true; }
        return false;
      };
    });
    await page.click('#pickup-copy-test');
    await page.waitForFunction(() => document.querySelector('#pickup-copy-test')?.dataset.state === 'copied');
    assert.equal(await page.evaluate(() => window.copiedText), 'P-4', 'fallback copies reference');
    assert.equal(await page.$eval('#pickup-copy-test', el => document.activeElement === el), true, 'fallback restores focus');
    await page.waitForFunction(() => document.querySelector('#pickup-copy-test')?.dataset.state === 'idle');

    await page.evaluate(() => { document.execCommand = () => false; });
    await page.click('#pickup-copy-test');
    await page.waitForFunction(() => document.querySelector('#pickup-copy-test')?.dataset.state === 'error');
    assert.equal(await page.$eval('#pickup-copy-test', el => el.getAttribute('aria-label')), 'Copy failed');
    assert.deepEqual(errors, []);
    console.log('copy button: passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
