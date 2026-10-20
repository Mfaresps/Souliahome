const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),puppeteer=require('../backend/node_modules/puppeteer');
const {calculateAuditMarketing,marketingRowScope}=require('../backend/dist/shopify/order-audit-marketing.service');
const root=path.resolve(__dirname,'../frontend/public'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const fn=name=>{const start=html.indexOf('function '+name+'(');return html.slice(start,html.indexOf('\n}',start)+2)};
(async()=>{
 const browser=await puppeteer.launch({headless:true,pipe:true});
 try {
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const invoice={_id:'111111111111111111111111',desc:'Meta',amount:500,date:'2026-10-01',status:'معتمد'};
  const rows=[{registered:true,syncStatus:'synced',orderTotal:1500,productCost:900,shippingCost:100,netProfit:500,hasProfit:true},
   {registered:false,syncStatus:'pending',depositPending:100,orderTotal:1000,productCost:600,shippingCost:100},
   {registered:false,syncStatus:'pending',shipWithoutDeposit:true,orderTotal:800,productCost:400,shippingCost:100}];
  await page.exposeFunction('fixtureApi',async(url,options)=>{
   if(url.includes('advertising-expenses'))return{items:[invoice],page:1,hasMore:false};
   const body=JSON.parse(options.body),selected=rows.filter(row=>body.scopes.includes(marketingRowScope(row)));
   return{invoices:[invoice],metrics:calculateAuditMarketing(selected,[invoice])};
  });
  await page.setViewport({width:390,height:1000});
  await page.setContent('<html dir="rtl"><body><details id="oa-fin-scope"><summary id="oa-fin-scope-label"></summary><div id="oa-fin-scope-options"></div></details><div id="oa-fin-selected"></div><div id="oa-financials"></div><section class="oa-marketing" id="oa-marketing"></section></body></html>');
  await page.addStyleTag({path:path.join(root,'order-audit-marketing.css')});
  await page.addScriptTag({content:`var currentAuditData=${JSON.stringify({from:1,to:3,rows})};function qs(s){return document.querySelector(s)}function fmtNum(n){return String(n)}function fmtJ(n){return String(n)}function api(u,o){return fixtureApi(u,o)}`});
  await page.addScriptTag({path:path.join(root,'order-audit-financials.js')});
  await page.addScriptTag({content:fn('auditFinScopeRows')+'\n'+fn('renderAuditFinancials')});
  await page.addScriptTag({path:path.join(root,'order-audit-marketing.js')});
  await page.evaluate(()=>renderAuditFinancials(currentAuditData));
  await page.click('[data-oam=open]');await page.waitForSelector('.oam-row');await page.click('[data-select]');await page.click('[data-apply]');await page.waitForFunction(()=>!document.querySelector('dialog').open);
  const kpi=async index=>page.$$eval('.oam-kpi strong',(els,i)=>els[i].textContent,index);
  assert((await kpi(1)).includes('3'));assert((await kpi(4)).includes('0'));
  await page.click('[data-oam=scopes]');assert(await page.$eval('#oa-fin-scope',el=>el.open));
  await page.click('#oa-fin-scope-options input[value="pending-deposit"]');
  await page.waitForFunction(()=>document.querySelector('.oam-kpi.profit')?.textContent.includes('300 EGP'));
  assert((await kpi(1)).includes('5'));assert((await kpi(2)).includes('250'));assert((await kpi(4)).includes('300'));
  assert((await page.$eval('.oam-scope',el=>el.textContent)).includes('بديبوزت'));
  await page.evaluate(()=>setAuditFinScopes(['pending-deposit']));
  await page.waitForFunction(()=>document.querySelector('.oam-kpi.profit')?.textContent.includes('-200 EGP'));
  assert((await kpi(1)).includes('2'));assert((await kpi(4)).includes('-200'));
  assert((await page.$eval('.oam-kpi.profit',el=>el.textContent)).includes('التقديري'));
  await page.evaluate(()=>setAuditFinScopes(['synced']));
  await page.waitForFunction(()=>document.querySelector('.oam-kpi.profit')?.textContent.includes('0 EGP'));
  assert.equal(await page.$$eval('.oam-chip',els=>els.length),1,'Selected expense survives financial filter changes');
  assert.deepEqual(errors,[]);console.log('PASS: actual financial picker drives synced, deposit and combined advertising metrics and profit labels; selected expense is retained.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
