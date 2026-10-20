const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),puppeteer=require('../backend/node_modules/puppeteer');
const {OrderAuditService}=require('../backend/dist/shopify/order-audit.service');
const root=path.resolve(__dirname,'../frontend/public'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const styles=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m=>m[1]).join('\n');
const start=html.indexOf('function renderAuditShipping('),renderer=html.slice(start,html.indexOf('\n}',start)+2);
(async()=>{
 const service=Object.create(OrderAuditService.prototype),model=rows=>({find:()=>({lean:async()=>rows})});
 service.txModel=model([1,2,3].map(i=>({_id:String(i),ref:String(i),type:'مبيعات',carrierCode:'bosta',bostaOrderId:'b'+i,bostaTrackingNumber:'tracking-'+i,shipCost:i===1?9999:100,items:[],client:'عميل '+i})));
 service.shopifyOrderModel=model([]);service.productModel=model([]);service.loadReviews=async()=>new Map();
 service.carrierDetails={bostaDetails:async id=>({fetchedAt:'2026-10-21T10:00:00Z',wallet:{bostaFees:id==='1'?114.57:id==='2'?130.22:null}})};
 const report=await service.runAudit(1,3,{persist:false,shippingLive:true});
 const browser=await puppeteer.launch({headless:true,pipe:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  for(const width of [390,1440]){
   await page.goto('about:blank');await page.setViewport({width,height:900});
   await page.setContent(`<html dir="rtl"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style><body><main style="padding:16px;max-width:1100px;margin:auto"><div id="rep-panel-orderaudit"><section class="card"><h3>تحليل الشحن</h3><div id="oa-shipping"></div></section></div></main></body></html>`);
   await page.addScriptTag({content:'function qs(s){return document.querySelector(s)}function esc(s){return String(s).replace(/[<>]/g,c=>c==="<"?"&lt;":"&gt;")}function fmtJ(n){return Number(n).toLocaleString("en-US",{maximumFractionDigits:2})+" EGP"}function fmtNum(n){return String(n)}'+renderer});
   await page.evaluate(data=>renderAuditShipping(data),report);
   const text=await page.$eval('#oa-shipping',el=>el.textContent);assert(text.includes('244.79'));assert(text.includes('#2'));assert(text.includes('130.22'));assert(text.includes('tracking-2'));assert(!text.includes('9,999'));assert(text.includes('1 بدون تكلفة مؤكدة'));
   await page.screenshot({path:path.join(__dirname,'audit-actual-shipping-'+width+'.png')});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
   await page.evaluate(()=>renderAuditShipping({shipping:{source:'carrier-actual-v1',measuredCount:0,unconfirmedCount:3,totalShippingCost:0,avgShippingCost:0,highestOrder:null,companies:[]},rows:[]}));
   assert.equal(await page.$$eval('#oa-shipping .oa-fin-v',els=>els.every(el=>el.textContent==='—')),true,'Unknown charges are not displayed as real zero');
  }
  assert.deepEqual(errors,[]);console.log('PASS: actual Bosta total/highest charge, decimal precision, coverage, tracking/source, unavailable charges and responsive shipping view.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
