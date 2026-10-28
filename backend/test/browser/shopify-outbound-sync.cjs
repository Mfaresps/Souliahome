// Browser acceptance uses the real UI files and a mocked API. No store writes.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const artifact = path.resolve(__dirname, '../../../artifacts/shopify-sync');
fs.mkdirSync(artifact, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', req => req.respond({ status: 200, contentType: 'text/html', body: '<html></html>' }));
    await page.goto('http://shopify-sync.test/');
    await page.setContent('<html dir="rtl"><head><style>body{font-family:Arial;margin:20px;background:#f5f8f6}.btn{padding:8px;border:1px solid #cad9d0;background:white;border-radius:8px;cursor:pointer}.btn:disabled{opacity:.5}button,input,select{font:inherit}label{line-height:1.6}#stg-shopify-card{max-width:650px}#invoice{margin:20px 0}</style></head><body><button id="sp-sync-old" hidden onclick="openShopifySync()"></button><div id="stg-shopify-card"></div><div id="invoice"></div></body></html>');
    await page.addStyleTag({ path: path.join(root, 'shopify-sync.css') });
    await page.addScriptTag({ content: `
      window.currentLang='ar'; window.admin=true; window.isAdmin=()=>admin;
      window.esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.toast=()=>{}; window.requests=[]; window.queued=false;
      window.api=async(path,options={})=>{
        const body=options.body?JSON.parse(options.body):null; requests.push({path,body});
        if(path.endsWith('/status'))return {enabled:false,includePayments:false,lastSuccessAt:null};
        if(path.includes('/orders?')) return {rows:[
          {id:'507f1f77bcf86cd799439011',ref:'2882',shipping:'DELIVERED',sync:queued?{id:'507f1f77bcf86cd799439013',status:'pending',log:[]}:null},
          {id:'507f1f77bcf86cd799439012',ref:'2881',shipping:'RETURNED',sync:{id:'507f1f77bcf86cd799439014',status:'review',error:'تحتاج الأصناف مراجعة',log:[]}}
        ],nextCursor:null};
        if(path.endsWith('/preview')) return {domain:'test-store.myshopify.com',results:[
          {token:'token-ready',ref:'2882',actions:['تسجيل الشحن ورقم التتبع','تحديث حالة التسليم'],issues:[],warnings:[]},
          {token:'token-blocked',ref:'2881',actions:[],issues:['الأصناف مختلفة؛ يلزم مراجعة'],warnings:[]}
        ]};
        if(path.endsWith('/execute')){queued=true;return {results:[{status:'pending'}]};}
        if(path.endsWith('/config'))return {enabled:body.enabled};
        if(path.endsWith('/retry'))return {queued:true};
        if(path.includes('/orders/'))return {status:'synced',lastSuccessAt:'2026-10-29T00:00:00Z'};
        throw Error('Unexpected route '+path);
      };` });
    await page.addScriptTag({ path: path.join(root, 'shopify-sync.js') });
    await page.evaluate(() => renderShopifySyncSettings());
    assert.equal(await page.$eval('#ss-auto', el => el.checked), false);
    await page.click('#sp-sync-old');
    await page.waitForSelector('[data-ss-id]');
    await page.click('[data-ss-id="507f1f77bcf86cd799439011"]');
    await page.click('[data-ss-action="preview"]');
    await page.waitForSelector('[data-ss-token="token-ready"]');
    assert.equal(await page.$eval('[data-ss-token="token-blocked"]', el => el.disabled), true, 'blocked preview stays disabled after loading');
    assert.equal(await page.$eval('[data-ss-token="token-ready"]', el => el.checked), false, 'approval is never preselected');
    await page.click('#ss-execute');
    assert.equal(await page.evaluate(() => requests.filter(r => r.path.endsWith('/execute')).length), 0, 'no execution without explicit selection');
    for (const width of [390, 1280]) {
      await page.setViewport({ width, height: 850 });
      await page.waitForFunction(w => window.innerWidth === w, {}, width);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await page.$eval('dialog', el => {const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}));
      assert.ok(await page.$eval('.ss-table-wrap', el => el.scrollWidth <= el.clientWidth + 1), 'table fits available width');
      await page.$eval('dialog', el => { el.scrollTop = 0; });
      await page.screenshot({ path: path.join(artifact, 'preview-' + width + '.png'), fullPage: false });
    }
    await page.click('[data-ss-token="token-ready"]'); await page.click('#ss-execute');
    await page.waitForFunction(() => requests.some(r => r.path.endsWith('/execute')));
    assert.deepEqual(await page.evaluate(() => requests.find(r => r.path.endsWith('/execute')).body.tokens), ['token-ready']);
    await page.waitForFunction(() => document.querySelector('#ss-rows').textContent.includes('في الانتظار'));
    await page.click('[data-ss-action="close"]');
    await page.evaluate(() => mountShopifyOrderSync({_id:'507f1f77bcf86cd799439011',ref:'2882',shopifyOrderId:'1'},document.querySelector('#invoice')));
    assert.ok(await page.$eval('.ss-order', el => el.textContent.includes('تم تأكيد حالة الشحن')));
    await page.click('.ss-order button'); await page.waitForSelector('dialog[open]');
    assert.equal(await page.$eval('#ss-ref', el => el.value), '2882');
    await page.click('[data-ss-action="close"]');
    await page.evaluate(() => { admin=false; });
    await page.waitForFunction(() => document.querySelector('#sp-sync-old').hidden);
    await page.evaluate(() => openShopifySync());
    assert.equal(await page.$('dialog[open]'), null);
    assert.deepEqual(errors, []);
    const report = { passed: true, checks: ['default off','preview only','explicit selection','blocked rows','queue status','per-order entry','admin only','mobile and desktop'], externalWrites: 0 };
    fs.writeFileSync(path.join(artifact, 'browser-check.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
