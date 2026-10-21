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

  await page.evaluate(()=>{_shopifyOrders=[{_id:'deposit-ui',ref:'2885',status:'pending',client:'Omnya Beram',total:925,depositReceipts:[{id:'receipt-ui',status:String.fromCharCode(1605,1587,1608,1583,1577),submittedBy:'Fares',amount:500,ocr:{amount:500,method:'Instapay'},warnings:[]}]}];});
  for(const [width,height] of [[320,640],[390,844],[500,944],[1440,900],[390,480]])for(const lang of ['en','ar'])for(const dark of [false,true]){
   await page.setViewport({width,height,hasTouch:true});await page.evaluate(({lang,dark})=>{closeModal();currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',dark);openSpReceiptForm('deposit-ui','receipt-ui');},{lang,dark});
   await page.waitForSelector('#spdep-amount');
   const layout=await page.evaluate(()=>{const p=document.querySelector('#modal-content'),r=p.getBoundingClientRect(),body=p.querySelector('.spdep-form-body'),footer=p.querySelector('.spdep-form-footer').getBoundingClientRect(),vault=p.querySelector('.spdep-vault-field').getBoundingClientRect(),confirm=p.querySelector('#spdep-confirm-check').closest('label').getBoundingClientRect();return {width:r.width,top:r.top,bottom:r.bottom,height:r.height,footer:footer.bottom<=innerHeight,overflow:p.scrollWidth>p.clientWidth+1,allVisible:vault.bottom<=footer.top&&confirm.bottom<=footer.top,optional:p.querySelector('.spdep-optional').open,bodyScroll:body.scrollHeight>body.clientHeight+1};});
   assert(!layout.overflow&&layout.footer&&layout.top>=0&&layout.bottom<=height+1,JSON.stringify({width,height,lang,layout}));
   assert.equal(layout.optional,false);if(height>=640){assert(layout.allVisible,JSON.stringify({width,height,lang,layout}));assert(layout.height<590);}
   assert.equal(await page.$$eval('.spdep-vault-option',e=>e.length),4);assert(await page.$eval('#spdep-submit-btn',e=>e.disabled));
   await page.$eval('.spdep-vault-option:first-child input',e=>e.click());await page.$eval('#spdep-confirm-check',e=>e.click());assert.equal(await page.$eval('#spdep-submit-btn',e=>e.disabled),false);
   await page.$eval('#spdep-amount',e=>{e.value='0';e.dispatchEvent(new Event('input',{bubbles:true}));});assert(await page.$eval('#spdep-submit-btn',e=>e.disabled));
   await page.$eval('#spdep-amount',e=>{e.value='500';e.dispatchEvent(new Event('input',{bubbles:true}));});assert.equal(await page.$eval('#spdep-submit-btn',e=>e.disabled),false);
   await page.$eval('.spdep-optional>summary',e=>e.click());assert(await page.$eval('.spdep-optional',e=>e.open));assert(await page.$eval('#spdep-sender-name',e=>e.getClientRects().length>0));await page.$eval('.spdep-optional>summary',e=>e.click());
   if(width===390&&height===844&&!dark)await page.screenshot({path:'artifacts/deposit-entry-compact-'+lang+'.png'});
  }
  await page.evaluate(()=>{closeModal();_shopifyOrders[0].depositReceipts[0].warnings=[{code:'not-transfer'}];openSpReceiptForm('deposit-ui','receipt-ui');});
  assert(await page.$eval('#spdep-warning-ack',e=>e.getClientRects().length>0));await page.$eval('#spdep-confirm-check',e=>e.click());assert(await page.$eval('#spdep-submit-btn',e=>e.disabled));await page.$eval('#spdep-warning-ack',e=>e.click());assert.equal(await page.$eval('#spdep-submit-btn',e=>e.disabled),false);
  assert.deepEqual(errors,[]);console.log('PASS: compact deposit entry across 5 viewports, RTL/LTR and dark mode; vault/confirmation visible on normal screens; pinned footer on short screens; optional fields preserved; amount/vault/acknowledgement validation unchanged.');
 }finally{await browser?.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
