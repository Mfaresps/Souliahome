const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),puppeteer=require('../backend/node_modules/puppeteer');
const root=path.resolve(__dirname,'../frontend/public'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const css=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m=>m[1]).join('\n');
const range=html.slice(html.indexOf('<div class="card oa-range-bar"'),html.indexOf('<!-- Empty state -->',html.indexOf('<div class="card oa-range-bar"')));
const fn=name=>{const i=html.indexOf('function '+name+'(');return html.slice(i,html.indexOf('\n}',i)+2)};
(async()=>{
  const browser=await puppeteer.launch({headless:true,pipe:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.setRequestInterception(true);page.on('request',r=>r.respond({status:200,contentType:'text/html',body:'<html></html>'}));
    for(const width of [390,1440]){
      await page.goto('http://audit-period.test');await page.setViewport({width,height:1000});
      await page.setContent('<html dir="rtl"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+css+'</style></head><body><main style="padding:12px"><div id="rep-panel-orderaudit" style="display:block">'+range+'<div id="oa-empty"></div><div id="oa-loading" style="display:none"></div><div id="oa-results" style="display:none"><div id="test-summary"></div></div></div></main></body></html>');
      await page.addStyleTag({path:path.join(root,'order-audit-layout.css')});
      await page.addScriptTag({content:`
        var NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-10-21T10:00:00Z']))}static now(){return new NativeDate('2026-10-21T10:00:00Z').getTime()}};
        var currentPage='reports',activeReportTab='orderaudit',currentAuditData=null,auditRangeMode='date',auditRequestVersion=0,auditFilter='all',auditPage=1,auditSelected=new Set(),requests=[],messages=[],API_BASE='/api';
        function qs(s){return document.querySelector(s)}function qsa(s){return [...document.querySelectorAll(s)]}function fmtNum(n){return String(n)}function toast(s){messages.push(s)}
        function renderAuditResults(){document.getElementById('test-summary').textContent='عدد الطلبات: '+currentAuditData.rows.length}
        async function api(url){requests.push(url);const q=new URL(url,location.origin).searchParams;const count=q.get('months')==='1,3'?2:4;return {from:100,to:10000,rows:Array.from({length:count},(_,i)=>({orderNumber:String(i)})),sequence:{missingCount:0,expectedCount:count},period:{fromDate:q.get('fromDate'),toDate:q.get('toDate'),...(q.has('months')?{months:q.get('months').split(',').map(Number),year:Number(q.get('year'))}:{})}}}
        window.fetch=async url=>{window.exportUrl=url;return {ok:true,blob:async()=>new Blob(['fixture'])}};HTMLAnchorElement.prototype.click=function(){};
      `+'\n'+['setAuditRangeMode','runOrderAuditByDate','runOrderAudit','exportOrderAudit'].map(name=>(['runOrderAuditByDate','runOrderAudit','exportOrderAudit'].includes(name)?'async ':'')+fn(name)).join('\n')+'\n'+fs.readFileSync(path.join(root,'order-audit-periods.js'),'utf8')});
      await page.waitForFunction(()=>currentAuditData!==null);
      assert.equal(await page.$eval('#oa-date-from',e=>e.value),'2026-10-01');assert.equal(await page.$eval('#oa-date-to',e=>e.value),'2026-10-21');
      assert((await page.evaluate(()=>requests[0])).startsWith('/order-audit/period?'),'Date/month application uses the dedicated date endpoint');
      assert.equal(await page.$eval('#oa-inputs-number',e=>getComputedStyle(e).display),'none');
      await page.evaluate(()=>Promise.all([ensureAuditDefaultPeriod(),ensureAuditDefaultPeriod()]));
      assert.equal(await page.evaluate(()=>requests.length),1,'Tab re-entry uses existing results');
      assert(await page.$eval('.oa-export-btns',e=>e.parentElement.classList.contains('oa-range-bar')),'Exports stay available in date mode');
      await page.click('#oa-month-picker summary');
      assert.equal(await page.$$eval('#oa-month-options label',els=>els.length),12);
      await page.click('#oa-month-options input[value="10"]');await page.click('#oa-month-options input[value="1"]');await page.click('#oa-month-options input[value="3"]');
      assert(await page.$eval('.oa-month-panel',el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth}));
      await page.screenshot({path:path.join(__dirname,'audit-months-'+width+'.png')});
      await page.click('.oa-month-panel>.btn');
      await page.waitForFunction(()=>requests.length===2);
      const last=await page.evaluate(()=>requests.at(-1));assert(last.includes('months=1%2C3'));assert(last.includes('toDate=2026-03-31'));assert.equal(await page.evaluate(()=>currentAuditData.rows.length),2);
      await page.evaluate(()=>exportOrderAudit('excel'));assert((await page.evaluate(()=>exportUrl)).includes('months=1%2C3'));
      await page.$eval('#oa-date-from',el=>{el.value='2026-09-01';el.dispatchEvent(new Event('change',{bubbles:true}))});
      await page.evaluate(()=>runOrderAuditByDate());
      // Keep a valid end date when entering a custom range.
      await page.$eval('#oa-date-to',el=>{el.value='2026-10-21';el.dispatchEvent(new Event('change',{bubbles:true}))});
      await page.evaluate(()=>runOrderAuditByDate());assert(!(await page.evaluate(()=>requests.at(-1))).includes('months='));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    }
    assert.deepEqual(errors,[]);console.log('PASS: automatic Cairo month-to-date loading, no duplicate entry loads, 12 named months, nonconsecutive selections, matching exports, custom dates, mobile/desktop.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
