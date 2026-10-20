const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),puppeteer=require('../backend/node_modules/puppeteer');
const root=path.resolve(__dirname,'../frontend/public'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const styles=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m=>m[1]).join('\n');
const range=html.slice(html.indexOf('<div class="card oa-range-bar"'),html.indexOf('<!-- Empty state -->',html.indexOf('<div class="card oa-range-bar"')));
const tableStart=html.indexOf('<div class="card oa-audit-table-card"');
const table=html.slice(tableStart,html.indexOf('<!-- Selection summary bar -->',tableStart))+'</div>';
const fnStart=html.indexOf('function setAuditRangeMode('),fn=html.slice(fnStart,html.indexOf('\n}',fnStart)+2);
(async()=>{
  const browser=await puppeteer.launch({headless:true,pipe:true});
  try{
    const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
    for(const width of [320,390,768,1440]){
      await page.goto('about:blank');await page.setViewport({width,height:1100});
      await page.setContent('<html dir="rtl"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+styles+'</style></head><body><main id="page-reports" style="padding:12px"><div class="rep-filter" style="display:flex">اليوم · الأسبوع · الشهر</div><div id="rep-panel-kpis" class="rep-tab-panel"></div><div id="rep-panel-orderaudit" class="rep-tab-panel active">'+range+'<div class="oa-kpi-grid grid" id="oa-kpis"></div><div class="card" id="oa-missing-card"><div>الأوردرات المفقودة</div><div id="oa-missing-count"></div><div id="oa-missing-body"></div></div>'+table+'</div></main></body></html>');
      await page.addStyleTag({path:path.join(root,'order-audit-layout.css')});
      const extraFn=name=>{const start=html.indexOf('function '+name+'(');return html.slice(start,html.indexOf('\n}',start)+2)};
      await page.addScriptTag({content:'var auditRangeMode="number",auditPage=1,calls=[],activeReportTab="orderaudit",currentAuditData=null,currentReportData=null;function qs(s){return document.querySelector(s)}function qsa(s){return [...document.querySelectorAll(s)]}function fmtNum(n){return String(n)}function esc(s){return String(s)}function canViewReportTab(){return true}function _syncReportSubnav(){}function runOrderAudit(){calls.push("number")}function runOrderAuditByDate(){calls.push("date")}function renderAuditTable(){calls.push("table")}function setAuditFilter(){}function fillLatestShopifyOrder(){document.getElementById("oa-to").value=2279}'+fn+'\n'+['renderAuditKpis','renderAuditMissing','switchReportTab'].map(extraFn).join('\n')});
      await page.evaluate(()=>{document.querySelector('.oa-range-bar').appendChild(document.querySelector('.oa-export-btns'));setAuditRangeMode('number');renderAuditKpis({from:2603,to:2885,sequence:{expectedCount:227,registeredCount:130,missingCount:0,pendingCount:76,cancelledCount:22,syncRate:57.3}});renderAuditMissing({missingOrders:[]});});
      assert.equal(await page.$eval('.rep-filter',el=>getComputedStyle(el).display),'none','General report presets hidden only for audit');
      await page.evaluate(()=>switchReportTab('kpis',null,true));assert.notEqual(await page.$eval('.rep-filter',el=>getComputedStyle(el).display),'none','General report presets return on KPI tab');
      await page.evaluate(()=>switchReportTab('orderaudit',null,true));
      assert(await page.$$eval('#oa-kpis .oa-kpi',els=>els.every(el=>el.getBoundingClientRect().height<105)),'Compact audit KPIs');
      if(width<460)assert.equal(await page.$eval('#oa-kpis',el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2,'Two compact KPI columns on mobile');
      const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
      assert.equal(await overflow(),false,'No overflow at '+width);
      await page.type('#oa-from','2231');await page.click('.oa-fill-latest');
      assert.equal(await page.$eval('#oa-to',el=>el.value),'2279');
      await page.focus('#oa-from');await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>calls.at(-1)),'number');
      await page.click('#oa-mode-date');
      assert.equal(await page.$eval('#oa-inputs-number',el=>getComputedStyle(el).display),'none');
      assert.equal(await page.$eval('#oa-mode-date',el=>el.getAttribute('aria-pressed')),'true');
      await page.$eval('#oa-date-from',el=>el.value='2026-10-01');await page.$eval('#oa-date-to',el=>el.value='2026-10-20');
      assert.equal(await overflow(),false,'Date fields fit at '+width);
      assert(await page.$$eval('#oa-inputs-date input',els=>els.every(el=>el.getBoundingClientRect().height>=38)));
      if(width===1440)assert(await page.$eval('.oa-range-bar',el=>el.getBoundingClientRect().height<210),'Compact desktop period controls');
      await page.click('#oa-run-btn-date');assert.equal(await page.evaluate(()=>calls.at(-1)),'date');
      await page.select('#oa-payment-filter','pending-review');
      await page.type('#oa-search','2745');assert.equal(await page.evaluate(()=>calls.at(-1)),'table');
      if(width===390||width===1440)await page.screenshot({path:path.join(__dirname,'audit-header-'+width+'.png')});
      await page.click('#oa-mode-num');
      assert.equal(await page.$eval('#oa-from',el=>el.value),'2231','Switching keeps entered values');
      assert.equal(await page.$eval('#oa-inputs-date',el=>getComputedStyle(el).display),'none');
      if(width===390)await page.screenshot({path:path.join(__dirname,'audit-number-mobile.png')});
    }
    assert.deepEqual(errors,[]);console.log('PASS: audit headers at 320/390/768/1440px, date/number switching, retained input, Enter and run buttons, search/payment filters, no overflow.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
