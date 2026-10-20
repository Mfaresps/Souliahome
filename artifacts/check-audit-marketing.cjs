const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),puppeteer=require('../backend/node_modules/puppeteer');
const root=path.resolve(__dirname,'../frontend/public');
(async()=>{
 const browser=await puppeteer.launch({headless:true,pipe:true});
 try {
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const width of [390,1440]) {
   await page.goto('about:blank');await page.setViewport({width,height:1000});
   await page.setContent('<html dir="rtl"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{margin:0}</style><body style="font-family:Arial;margin:12px;background:#f1f5f3;color:#18382b"><section id="oa-marketing" class="oa-marketing"></section></body></html>');
   await page.addStyleTag({path:path.join(root,'order-audit-marketing.css')});
   await page.addScriptTag({content:`var requests=[],fail=false;var invoices=[{_id:'111111111111111111111111',desc:'Meta — October',amount:200,date:'2026-10-02',status:'معتمد'},{_id:'222222222222222222222222',desc:'<img src=x onerror=alert(1)>',amount:300,date:'2026-10-10',status:'معتمد'},{_id:'333333333333333333333333',desc:'Unapproved',amount:400,date:'2026-10-20',status:'معلق'}];var data={period:{fromDate:'2026-10-01',toDate:'2026-10-21'},rows:[]};async function api(url,opts){requests.push({url,opts});if(url.includes('advertising-expenses'))return{items:invoices,page:1,hasMore:false};if(fail)throw Error('Server rejected invoice');var b=JSON.parse(opts.body),selected=invoices.filter(i=>b.expenseIds.includes(i._id));var spend=selected.reduce((s,i)=>s+i.amount,0);return{invoices:selected,metrics:{spend,expenseCount:selected.length,orders:2,registeredOrders:2,pendingOrders:0,excludedOrders:0,roas:3000/spend,costPerOrder:spend/2,salesAfterAdvertising:3000-spend,profitAfterAdvertising:1000-spend,netMargin:(1000-spend)/30,advertisingPercent:spend/30,profitPerRegisteredOrder:(1000-spend)/2,breakEvenRoas:3}};}`});
   await page.addScriptTag({path:path.join(root,'order-audit-marketing.js')});
   await page.evaluate(()=>renderAuditMarketing(data,['synced']));
   await page.click('[data-oam=open]');await page.waitForSelector('.oam-row');
   await page.evaluate(()=>Promise.all(document.querySelector('dialog').getAnimations({subtree:true}).map(animation=>animation.finished.catch(()=>{}))));
   await page.$eval('.oam-row',row=>row.click());
   assert.equal(await page.$eval('.oam-row input',el=>el.checked),true,'Clicking card padding selects invoice');
   await page.click('.oam-invoice-name');
   assert.equal(await page.$eval('.oam-row input',el=>el.checked),false,'Clicking label toggles exactly once');
   await page.focus('.oam-row input');await page.keyboard.press('Space');
   assert.equal(await page.$eval('.oam-row input',el=>el.checked),true,'Keyboard selection works');
   assert((await page.$eval('.oam-invoice-meta time',el=>el.textContent)).includes('أكتوبر'),'Readable month name');
   const centered=()=>{const r=document.querySelector('dialog').getBoundingClientRect();return Math.abs(r.x+r.width/2-innerWidth/2)<2&&Math.abs(r.y+r.height/2-innerHeight/2)<2&&r.top>=0&&r.bottom<=innerHeight;};
   assert(await page.evaluate(centered),'Dialog stays centered despite global margin reset');
   await page.setViewport({width,height:480});
   assert(await page.evaluate(centered),'Dialog remains centered on short screens');
   assert(await page.$eval('.oam-list',el=>el.scrollHeight>el.clientHeight),'Only invoice list scrolls on short screens');
   assert(await page.$eval('[data-apply]',el=>{const r=el.getBoundingClientRect();return r.bottom<=innerHeight&&r.top>=0;}),'Apply stays visible');
   await page.setViewport({width,height:1000});
   assert.equal(await page.$$eval('.oam-row input:disabled',els=>els.length),1);
   assert.equal(await page.$$eval('.oam-row img',els=>els.length),0,'Escape invoice descriptions');
   await page.click('[data-select]');assert((await page.$eval('[data-total]',el=>el.textContent)).includes('500'));
   await page.screenshot({path:path.join(__dirname,'audit-advertising-picker-'+width+'.png')});
   await page.click('[data-apply]');await page.waitForFunction(()=>!document.querySelector('dialog').open);
   assert.equal(await page.$$eval('.oam-kpi',els=>els.length),6);assert((await page.$eval('.oam-kpi.profit',el=>el.textContent)).includes('500'));
   await page.screenshot({path:path.join(__dirname,'audit-advertising-'+width+'.png')});
   await page.click('[data-oam=open]');await page.waitForSelector('.oam-row');await page.click('[data-clear]');await page.click('footer [data-close]');await page.waitForFunction(()=>!document.querySelector('dialog').open);
   assert.equal(await page.$$eval('.oam-chip',els=>els.length),2,'Cancel preserves applied invoices');
   await page.evaluate(()=>renderAuditMarketing(data,['pending-deposit']));await page.waitForFunction(()=>!document.querySelector('#oa-marketing .oam-status'));
   assert.deepEqual(await page.evaluate(()=>JSON.parse(requests.at(-1).opts.body).scopes),['pending-deposit']);
   await page.evaluate(()=>{fail=true});await page.click('[data-oam=open]');await page.waitForSelector('.oam-row');await page.click('[data-clear]');await page.click('[data-apply]');await page.waitForFunction(()=>document.querySelector('[data-dialog-error]').textContent.includes('rejected'));
   assert.equal(await page.$eval('dialog',el=>el.open),true,'Failed validation keeps selection review open');
   await page.click('footer [data-close]');
   await page.waitForFunction(()=>!document.querySelector('dialog').open);
   await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
   await page.click('[data-oam=open]');await page.waitForSelector('.oam-row');
   assert.equal(await page.$eval('dialog',el=>el.getAnimations({subtree:true}).length),0,'Reduced motion is respected');
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog').open);
   await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
   await page.evaluate(()=>{fail=false;renderAuditMarketing({from:1,to:10},['synced'])});
   assert.equal(await page.$$eval('.oam-kpi',els=>els.length),0,'New report resets old spend');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   assert((await page.evaluate(()=>requests)).every(r=>r.url.startsWith('/order-audit/')),'No broad expenses API access');
  }
  assert.deepEqual(errors,[]);console.log('PASS: desktop/mobile invoice selection, totals, approved-only choices, escaped labels, cancellation, scope updates, server failure, context reset and advertising-only requests.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
