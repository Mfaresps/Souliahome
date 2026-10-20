const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),puppeteer=require('../backend/node_modules/puppeteer');
const root=path.resolve(__dirname,'../frontend/public'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const css=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m=>m[1]).join('\n');
const control=html.slice(html.indexOf('<details id="oa-fin-scope"'),html.indexOf('<!-- 3b. Top 5 Products -->'));
const functions=html.slice(html.indexOf('function auditFinScopeRows('),html.indexOf('function renderAuditShipping('));
(async()=>{
  const browser=await puppeteer.launch({headless:true,pipe:true});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    for(const width of [390,1280]){
      await page.goto('about:blank');
      await page.setViewport({width,height:900});
      await page.setContent('<html dir="rtl"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body><main style="margin:24px auto;padding:12px;max-width:900px"><div class="card"><div style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap"><h3>التحليل المالي</h3>'+control+'</main></body></html>');
      await page.addStyleTag({path:path.join(root,'order-audit-financials.css')});
      await page.addScriptTag({content:`var currentAuditData={rows:[
        {registered:true,syncStatus:'synced',orderTotal:1000,netProfit:200},
        {syncStatus:'pending',depositApproved:100,orderTotal:2000},
        {syncStatus:'pending',depositPending:200,orderTotal:3000},
        {syncStatus:'pending',shipWithoutDeposit:true,orderTotal:4000},
        {syncStatus:'pending',orderTotal:5000},{syncStatus:'cancelled',orderTotal:6000}]};
        function qs(s){return document.querySelector(s)}function fmtNum(n){return String(n)}function fmtJ(n){return 'EGP '+n}
      `+fs.readFileSync(path.join(root,'order-audit-financials.js'),'utf8')+'\n'+functions+';renderAuditFinancials(currentAuditData);'});
      assert.deepEqual(errors,[]);
      assert(await page.$('input[value="pending-deposit"]'),await page.$eval('#oa-fin-scope',el=>el.outerHTML));
      await page.click('#oa-fin-scope summary');
      await page.click('input[value="pending-deposit"]');
      await page.click('input[value="pending-without-deposit"]');
      assert.equal(await page.$eval('.oa-fin-result-count strong',e=>e.textContent),'4');
      assert((await page.$eval('#oa-financials',e=>e.textContent)).includes('EGP 10000'));
      assert.equal(await page.$$eval('#oa-fin-scope input:checked',els=>els.length),3);
      assert(await page.$eval('.oa-fin-picker-panel',el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}),'Picker fits viewport');
      assert.equal(await page.$eval('#oa-fin-scope',e=>e.open),true,'Checkbox selection keeps picker open');
      await page.screenshot({path:path.join(__dirname,'audit-financials-'+width+'.png')});
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#oa-fin-scope',e=>e.open),false);
      assert.equal(await page.evaluate(()=>document.activeElement.tagName),'SUMMARY');
      await page.evaluate(()=>setAuditFinScopes([]));
      assert.equal(await page.$eval('.oa-fin-result-count strong',e=>e.textContent),'0');
      await page.evaluate(()=>setAuditFinScopes('all'));
      assert.equal(await page.$eval('.oa-fin-result-count strong',e=>e.textContent),'6');
    }
    assert.deepEqual(errors,[]);console.log('PASS: mobile/desktop multi-select, live aggregate totals, category counts, empty/all states, keyboard dismissal and focus.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
