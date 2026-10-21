const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const puppeteer=require('../backend/node_modules/puppeteer'),express=require('../frontend/node_modules/express');
const html=fs.readFileSync('frontend/public/index.html','utf8');
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!m[1].includes('src=')&&!m[1].includes('application/'))new vm.Script(m[2]);
(async()=>{
 const app=express();app.get('/config.js',(req,res)=>res.type('js').send('window.__ENV__={API_BASE_URL:""};'));app.use(express.static(path.resolve('frontend/public')));
 const server=app.listen(8089);let browser;
 try{
  browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewport({width:390,height:844,hasTouch:true});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>{document.startViewTransition=undefined;localStorage.setItem('token','trail-preview');localStorage.setItem('soulia-push-prompt:preview','dismissed');localStorage.setItem('user',JSON.stringify({_id:'preview',name:'Fares',username:'preview',role:'admin',perms:[]}));});
  await page.setRequestInterception(true);page.on('request',request=>{
   const url=new URL(request.url());
   if(url.origin!=='http://localhost:8089')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:''});
   if(url.pathname.startsWith('/api/')){
    const data=url.pathname==='/api/auth/me'?{_id:'preview',name:'Fares',username:'preview',role:'admin',perms:[]}:url.pathname==='/api/settings'?{lang:'en'}:url.pathname==='/api/notifications'||url.pathname==='/api/notifications/preferences'?{preferences:{enabled:false},devices:0,configured:false,language:'en',categories:[]}:url.pathname.includes('branding')?{logos:[],selection:{}}:[];
    return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
   }request.continue();
  });
  await page.goto('http://localhost:8089/#shopify-orders',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.spCompactHeader&&!document.querySelector('#splash-screen'));

  await page.evaluate(()=>{_pickupOrders=[{_id:'a',ref:'1001',client:'First client',pickupRef:'SH-2026-10-20',pickupDate:'2026-10-20',pickupStatus:'Delivered',total:100,shipCo:'Bosta'},{_id:'b',ref:'1002',client:'Second client',pickupRef:'SH-2026-10-21',pickupDate:'2026-10-21',pickupStatus:'Delivered',total:200,shipCo:'Bosta'}];_puFilterRuns=()=>_pickupRuns;document.querySelector('#page-shopify-orders').classList.remove('active');document.querySelector('#page-pickup-orders').classList.add('active');document.querySelector('#pu-table-view').style.display='block';renderPickupRuns();});
  for(const lang of ['en','ar']){
   await page.evaluate(lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';_pickupOrders=_pickupOrders.filter(x=>x._id!=='c');_puExpandedRunRef=null;renderPickupRuns();},lang);
   await page.$eval('#expand-icon-run-0',e=>e.click());assert.equal(await page.$eval('#run-0',e=>getComputedStyle(e).display),'table-row');
   assert.equal(await page.$eval('#expand-icon-run-0',e=>e.getAttribute('aria-expanded')),'true');
   const key=await page.$eval('#run-header-run-0',e=>e.dataset.runRef);
   await page.evaluate(()=>{_pickupOrders.push({_id:'c',ref:'1003',client:'New run',pickupRef:'SH-2026-10-22',pickupDate:'2026-10-22',pickupStatus:'Delivered',total:300});renderPickupRuns();});
   assert.equal(await page.$eval('.pu-run-open',e=>e.dataset.runRef),key,'Open group follows its identity when rows move');
   assert.equal(await page.$eval('.pu-run-open',e=>e.nextElementSibling.querySelectorAll('.pu-orders-table tbody tr').length),1);
   await page.$eval('#run-header-run-0',e=>e.click());assert.equal(await page.$$eval('.pu-run-open',els=>els.length),1);
   await page.focus('#expand-icon-run-0');await page.keyboard.press('Enter');assert.equal(await page.$$eval('.pu-run-open',els=>els.length),0);
   await page.keyboard.press('Space');assert.equal(await page.$$eval('.pu-run-open',els=>els.length),1);
   await page.evaluate(()=>renderPickupRuns());assert.equal(await page.$$eval('.pu-run-open',els=>els.length),1);
   await page.$eval('.pu-run-open .pu-chevron',e=>e.click());assert.equal(await page.$$eval('.pu-run-open',els=>els.length),0);
   await page.evaluate(()=>renderPickupRuns());assert.equal(await page.$$eval('.pu-run-open',els=>els.length),0);
  }
  assert.deepEqual(errors,[]);console.log('PASS: pickup groups open/close by arrow and row; keyboard Enter/Space; one group open; correct orders and stable expansion across live refresh/reordering; RTL/LTR.');
 }finally{await browser?.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
