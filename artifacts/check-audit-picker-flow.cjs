const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),puppeteer=require('../backend/node_modules/puppeteer');
const root=path.resolve(__dirname,'../frontend/public'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const css=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m=>m[1]).join('\n');
(async()=>{
 const browser=await puppeteer.launch({headless:true,pipe:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  for(const width of [1440,390]){
   await page.goto('about:blank');await page.setViewport({width,height:900});
   await page.setContent(`<html dir="rtl"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><main style="padding:16px"><section class="oa-marketing" id="oa-marketing"></section></main></body></html>`);
   for(const file of ['order-audit-marketing.css','order-audit-insights.css'])await page.addStyleTag({path:path.join(root,file)});
   await page.addScriptTag({content:`var hold=true,fail=false,posted=0,finish;var invoices=[{_id:'111111111111111111111111',desc:'Meta · حملة أكتوبر',amount:200,date:'2026-09-02',status:'معتمد'},{_id:'222222222222222222222222',desc:'Google · البحث',amount:300,date:'2026-09-10',status:'معتمد'}];var data={period:{fromDate:'2026-10-01',toDate:'2026-10-21'},rows:[{registered:true,orderTotal:1500,netProfit:500}]};async function api(url,opts){if(url.includes('advertising-expenses'))return {items:url.includes('fromDate')?[]:invoices,page:1,hasMore:false};var b=JSON.parse(opts.body);if(b.expenseIds.length){posted++;if(hold)await new Promise(r=>finish=r);if(fail)throw Error('تعذر تطبيق الفواتير');}var selected=invoices.filter(i=>b.expenseIds.includes(i._id)),spend=selected.reduce((s,i)=>s+i.amount,0);return{invoices:selected,comparison:null,metrics:{spend,expenseCount:selected.length,revenue:1500,orders:1,registeredOrders:1,pendingOrders:0,roas:spend?1500/spend:null,costPerOrder:spend,salesAfterAdvertising:1500-spend,profitBeforeAdvertising:500,profitAfterAdvertising:500-spend,netMargin:(500-spend)/15,advertisingPercent:spend/15}};}`});
   for(const file of ['order-audit-insights.js','order-audit-marketing.js'])await page.addScriptTag({path:path.join(root,file)});
   await page.evaluate(()=>renderAuditMarketing(data,['synced']));await page.waitForFunction(()=>!document.querySelector('#oa-marketing .oam-status'));
   await page.click('[data-oam=open]');await page.waitForSelector('[data-show-all]');
   await page.evaluate(()=>Promise.all(document.querySelector('dialog').getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{}))));
   assert(await page.$eval('[data-apply]',el=>el.disabled),'Empty initial selection cannot apply');
   assert(await page.$eval('[data-period]',el=>{const r=el.getBoundingClientRect();return r.width===20&&r.height===20;}),'Global input sizing does not stretch checkbox');
   assert(await page.$eval('.oam-period',el=>el.getBoundingClientRect().height<45),'Period label stays readable');
   await page.screenshot({path:path.join(__dirname,'audit-picker-empty-'+width+'.png')});
   await page.click('[data-show-all]');await page.waitForSelector('.oam-row');await page.click('[data-select]');
   assert((await page.$eval('[data-apply]',el=>el.textContent)).includes('(2)'));
   await page.screenshot({path:path.join(__dirname,'audit-picker-ready-'+width+'.png')});
   await page.click('[data-apply]');await page.waitForFunction(()=>posted===1);
   assert(await page.$eval('[data-apply]',el=>el.disabled));assert((await page.$eval('[data-apply]',el=>el.textContent)).includes('جارٍ'));
   assert(await page.$$eval('.oam-row input',els=>els.every(el=>el.disabled)));
   await page.$eval('[data-apply]',el=>{el.click();el.click();});assert.equal(await page.evaluate(()=>posted),1,'No duplicate submissions');
   await page.click('footer [data-close]');await page.waitForFunction(()=>!document.querySelector('dialog').open);await page.evaluate(()=>finish());
   await page.waitForFunction(()=>!document.querySelector('#oa-marketing .oam-status'));
   assert.equal(await page.$$eval('#oa-marketing .oam-kpi',els=>els.length),0,'Cancelled pending application never commits later');
   await page.evaluate(()=>{hold=false});await page.click('[data-oam=open]');await page.waitForSelector('[data-show-all]');await page.click('[data-show-all]');await page.waitForSelector('.oam-row');await page.click('[data-select]');await page.click('[data-apply]');await page.waitForFunction(()=>!document.querySelector('dialog').open);
   assert((await page.$eval('.oam-success',el=>el.textContent)).includes('تم تطبيق 2'));
   assert((await page.$eval('[data-metric=spend] strong',el=>el.textContent)).includes('500'));
   await page.evaluate(()=>{fail=true});await page.click('[data-oam=open]');await page.waitForSelector('[data-show-all]');await page.click('[data-show-all]');await page.waitForSelector('.oam-row');await page.click('.oam-row input');await page.click('[data-apply]');
   await page.waitForFunction(()=>document.querySelector('[data-dialog-error]').textContent.includes('تعذر'));
   assert(await page.$eval('dialog',el=>el.open));assert.equal(await page.$$eval('#oa-marketing .oam-chip',els=>els.length),2,'Failed application retains old selection');
   await page.click('footer [data-close]');await page.waitForFunction(()=>!document.querySelector('dialog').open);
  }
  assert.deepEqual(errors,[]);console.log('PASS: actual global CSS, empty-period recovery, checkbox sizing, invoice selection, apply progress, duplicate prevention, cancellation, success and failure retention on mobile/desktop.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
