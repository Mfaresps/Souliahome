const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');

const html = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8').replace(/\r\n/g, '\n');
const start = html.indexOf('let _pmSelOpen = null;');
const end = html.indexOf('/** Renders the extra-images gallery', start);
const supplierStart = html.indexOf('function _onNewSupplierChange(');
const supplierFn = html.slice(supplierStart, html.indexOf('\n}', supplierStart) + 2);
const cssStart = html.indexOf('.pm-sel{');
const cssEnd = html.indexOf('.pm-sel-btn .pm-mat-ic', cssStart);

(async () => {
  console.log('Launching dropdown browser checks');
  const browser = await puppeteer.launch({ headless: true, pipe: true, timeout: 15000 });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>:root{--surface:white;--bg:white;--border:#d6e4df;--text:#17352a;--muted:#64776f;--primary:#16854d;--primary-pale:#e5f4ed}body{font:16px Arial}#tx-fields{width:360px}${html.slice(cssStart, cssEnd)}</style>
      <div id="tx-fields"><label>Supplier</label><select id="tx-supplier" data-searchable="true" onchange="_onNewSupplierChange(this)"><option value="">Select supplier</option><option value="Laser" data-phone="01111111111">Laser Ray</option><option value="Blocked" disabled>Disabled supplier</option><option value="Talla" data-phone="01222222222">Talla Home</option><option value="NoPhone">No phone supplier</option></select><input id="tx-phone"><div id="err-supplier"></div><select id="tx-account"><option>Cash</option><option>Instapay</option></select><select id="custom-hidden" style="display:none"><option>Hidden state</option></select></div>`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: `const qs=(s,r=document)=>r.querySelector(s),qsa=(s,r=document)=>Array.from(r.querySelectorAll(s));const t=k=>k;const _refreshTxSupplierCredit=()=>{};${html.slice(start, end)}${supplierFn};_pmEnhanceSelects(qs('#tx-fields'));` });
    assert.equal(await page.$$eval('.pm-sel', nodes => nodes.length), 2);
    assert.equal(await page.$eval('#tx-supplier', el => el.tabIndex), -1);
    await page.click('#tx-supplier + .pm-sel-btn');
    await page.type('.pm-sel-search', 'Talla');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.$eval('#tx-supplier', el => el.value), 'Talla');
    assert.equal(await page.$eval('#tx-phone', el => el.value), '01222222222');
    await page.click('#tx-supplier + .pm-sel-btn');
    await page.type('.pm-sel-search', 'No phone');
    await page.keyboard.press('Enter');
    assert.equal(await page.$eval('#tx-phone', el => el.value), '');
    await page.evaluate(() => { document.querySelector('#tx-supplier').value = 'Laser'; });
    assert.equal(await page.$eval('#tx-supplier + .pm-sel-btn .pm-sel-txt', el => el.textContent), 'Laser Ray');
    await page.click('#tx-supplier + .pm-sel-btn');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.$eval('#tx-supplier', el => el.value), 'Talla');
    await page.click('#tx-account + .pm-sel-btn');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#tx-account + .pm-sel-btn', el => el.getAttribute('aria-expanded')), 'false');
    await page.click('#tx-account + .pm-sel-btn');
    await page.keyboard.press('Tab');
    assert.equal(await page.$eval('#tx-account + .pm-sel-btn', el => el.getAttribute('aria-expanded')), 'false');
    console.log('Passed: styled supplier/payment lists, search, keyboard choice, disabled options, phone updates, programmatic value, Escape and Tab.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
