const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const puppeteer=require('../backend/node_modules/puppeteer'),express=require('../frontend/node_modules/express');
for(const m of fs.readFileSync('frontend/public/index.html','utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!m[1].includes('src=')&&!m[1].includes('application/'))new vm.Script(m[2]);
(async()=>{
 const app=express();app.get('/config.js',(req,res)=>res.type('js').send('window.__ENV__={API_BASE_URL:""};'));app.use(express.static(path.resolve('frontend/public')));const server=app.listen(8090);let browser;
 try{
  browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));await page.setViewport({width:390,height:844,hasTouch:true});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>{document.startViewTransition=undefined;localStorage.setItem('token','peek-preview');localStorage.setItem('soulia-push-prompt:preview','dismissed');localStorage.setItem('user',JSON.stringify({_id:'preview',name:'Preview',role:'admin',perms:[]}));});
  await page.setRequestInterception(true);page.on('request',request=>{
   const url=new URL(request.url());if(url.origin!=='http://localhost:8090')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:''});
   if(url.pathname.endsWith('/receipt-ui/image'))return request.respond({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="100"><rect width="80" height="100" fill="#f1f5f2"/><path d="M20 20h40v60H20zM28 32h24M28 43h24M28 54h14" fill="none" stroke="#739582" stroke-width="3"/></svg>'});
   if(url.pathname.startsWith('/api/')){const data=url.pathname==='/api/auth/me'?{_id:'preview',name:'Preview',role:'admin',perms:[]}:url.pathname==='/api/settings'?{lang:'en'}:url.pathname==='/api/notifications'||url.pathname==='/api/notifications/preferences'?{preferences:{enabled:false},devices:0,configured:false,language:'en'}:url.pathname.includes('branding')?{logos:[],selection:{}}:[];return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});}request.continue();
  });
  await page.goto('http://localhost:8090/#shopify-orders',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.spCompactHeader&&!document.querySelector('#splash-screen'));
  await page.evaluate(()=>{
   _shopifyOrders=[{_id:'peek-ui',ref:'2883',shopifyOrderId:'8800',status:'pending',client:'Menna ElGabbas منة الجباس',phone:'01006694321',createdAt:'2026-10-19T20:11:00Z',total:1950,shipCost:120,discount:120,shippingAddress:'304, C5, Parcel 21 (Parkside 2), Emaar Mivida Compound — العنوان بالتفصيل',notes:'Confirmed — يرجى الاتصال قبل الوصول',items:[{name:'Boho Charm Basket L سلة قطنية يدوية',code:'101',qty:1,price:1950}],comments:[],depositReceipts:[{id:'receipt-ui',status:'معلق',amount:500,method:'Instapay',submittedAt:'2026-10-19T20:17:00Z',submittedByName:'Gannh'}]}];followUps=[];_spFuFetchedAt=Date.now();_spPeekLoadFu=()=>{};
  });
  for(const width of [320,390,430,640,768,884,1024,1440])for(const lang of ['en','ar'])for(const dark of [false,true]){
   await page.setViewport({width,height:844,hasTouch:true});await page.evaluate(({lang,dark})=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',dark);openSpOrderPeek('peek-ui');},{lang,dark});
   await page.waitForSelector('#sp-peek.is-open');
   const result=await page.evaluate(()=>{const p=document.querySelector('#sp-peek .sp-peek'),r=p.getBoundingClientRect(),body=p.querySelector('.sp-pk-body'),foot=p.querySelector('.sp-pk-foot');return {width:r.width,left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:p.scrollWidth>p.clientWidth+1,bodyOverflow:body.scrollWidth>body.clientWidth+1,footerAbsent:!foot,grip:getComputedStyle(p.querySelector('.sp-pk-grip')).display,columns:getComputedStyle(body).gridTemplateColumns.split(' ').length,remaining:p.querySelector('.is-due>b').textContent,afterApproval:p.querySelector('.is-due small').textContent};});
   assert(!result.overflow&&!result.bodyOverflow&&result.footerAbsent,JSON.stringify({width,lang,dark,result}));assert(result.left>=0&&result.right<=width&&result.top>=0&&result.bottom<=844);
   assert(result.remaining.includes('1,950'));assert(result.afterApproval.includes('1,450'));
   assert.equal(result.columns,width>600?2:1);assert.equal(result.grip,width>600?'none':'flex');if(width>600)assert(Math.abs((result.top+result.bottom)/2-422)<1,'Desktop dialog centered vertically');
   await page.$eval('[data-pk-section="delivery"]>summary',e=>e.click());assert.equal(await page.$eval('[data-pk-section="delivery"]',e=>e.open),true);
   await page.$eval('[data-pk-section="items"]>summary',e=>e.click());assert.equal(await page.$eval('[data-pk-section="items"]',e=>e.open),false);
   await page.evaluate(()=>_spPeekRender());assert.equal(await page.$eval('[data-pk-section="delivery"]',e=>e.open),true);assert.equal(await page.$eval('[data-pk-section="items"]',e=>e.open),false);
   await page.$eval('[data-pk-section="items"]>summary',e=>e.click());await page.$eval('[data-pk-section="delivery"]>summary',e=>e.click());
   if(!dark&&((width===390&&lang==='en')||(width===1440&&lang==='en')||(width===390&&lang==='ar')))await page.screenshot({path:`artifacts/order-peek-compact-${width}-${lang}.png`});
   await page.evaluate(()=>closeSpOrderPeek());await page.waitForSelector('#sp-peek',{hidden:true});
  }

  await page.setViewport({width:1440,height:900,hasTouch:true});await page.evaluate(()=>{followUps=[{_id:'peek-followup',orderRef:'2883',status:'open',reason:'Order confirmation',comments:Array.from({length:20},(_,i)=>({authorName:'Fares',text:'Please follow up on the delivery details.',createdAt:new Date().toISOString()}))}];openSpOrderPeek('peek-ui');});await page.waitForSelector('#sp-peek.is-open');
  assert(await page.evaluate(()=>{const body=document.querySelector('#sp-peek .sp-pk-body'),cols=body.querySelectorAll('.sp-pk-column');return cols.length===2&&[...cols].every(col=>[...col.children].every((el,i,a)=>!i||el.getBoundingClientRect().top>=a[i-1].getBoundingClientRect().bottom+5));}),'Each column stacks its cards without row-height gaps');

  assert(await page.$eval('#sp-pk-trail',e=>!e.parentElement.querySelector('.sp-pk-history-more').hidden));
  await page.$eval('#sp-pk-trail',e=>e.parentElement.querySelector('.sp-pk-history-more').click());
  assert(await page.$eval('#sp-pk-trail',e=>e.parentElement.classList.contains('is-expanded')&&e.clientHeight>180));
  await page.$eval('#sp-pk-trail',e=>{e.scrollTop=17;});await page.evaluate(()=>_spPeekRefreshFu());
  assert(await page.$eval('#sp-pk-trail',e=>e.parentElement.classList.contains('is-expanded')&&Math.abs(e.scrollTop-17)<=1));
  await page.evaluate(()=>{_shopifyOrders[0].comments=Array.from({length:15},(_,i)=>({employee:'Preview',text:'Review this order please. '+i,createdAt:new Date().toISOString()}));_spPeekRender();});
  await page.$eval('#sp-pk-cmts',e=>e.parentElement.querySelector('.sp-pk-history-more').click());
  await page.$eval('#sp-pk-cmts',e=>{e.scrollTop=23;});await page.evaluate(()=>{_spPeekRefreshFu();_spPeekRender();});
  assert(await page.$eval('#sp-pk-cmts',e=>e.parentElement.classList.contains('is-expanded')&&Math.abs(e.scrollTop-23)<=1));
  await page.$eval('#sp-pk-cmts',e=>e.parentElement.querySelector('.sp-pk-history-more').click());assert.equal(await page.$eval('#sp-pk-cmts',e=>e.parentElement.querySelector('button').getAttribute('aria-expanded')),'false');
  await page.screenshot({path:'artifacts/order-peek-desktop-organized.png'});await page.evaluate(()=>{followUps=[];closeSpOrderPeek();});await page.waitForSelector('#sp-peek',{hidden:true});
  await page.setViewport({width:390,height:480,hasTouch:true});await page.evaluate(()=>{currentLang='en';document.documentElement.dir='ltr';document.body.classList.remove('dark-mode');_shopifyOrders[0].comments=Array.from({length:20},(_,i)=>({employee:'Preview',text:'Please review the customer delivery notes. تعليق متابعة الطلب',createdAt:new Date().toISOString()}));openSpOrderPeek('peek-ui');});await page.waitForSelector('#sp-peek.is-open');
  assert(await page.$eval('.sp-pk-body',e=>e.scrollHeight>e.clientHeight));const top=await page.$eval('.sp-pk-head',e=>e.getBoundingClientRect().top);await page.$eval('.sp-pk-body',e=>{e.scrollTop=e.scrollHeight;});assert.equal(await page.$eval('.sp-pk-head',e=>e.getBoundingClientRect().top),top);
  await page.focus('[data-pk-section="items"]>summary');await page.keyboard.press('Enter');assert.equal(await page.$eval('[data-pk-section="items"]',e=>e.open),false);
  const actions=await page.evaluate(()=>({receipt:!!document.querySelector('#sp-peek [onclick*="openSpReceiptForm"]'),comments:!!document.querySelector('#sp-peek [onclick*="openShopifyCommentsModal"]'),followup:!!document.querySelector('#sp-peek [onclick*="convertShopifyOrderToFollowUp"]'),print:!!document.querySelector('#sp-peek [onclick*="printSpPeekPreview"]'),prepare:!!document.querySelector('#sp-peek .sp-pk-foot-go[onclick*="approveShopifyOrder"]'),links:document.querySelectorAll('#sp-peek .sp-pk-contact a').length}));assert.deepEqual(actions,{receipt:true,comments:true,followup:true,print:true,prepare:false,links:3});
  await page.keyboard.press('Escape');await page.waitForSelector('#sp-peek',{hidden:true});
  await page.setViewport({width:390,height:844,hasTouch:true});
  await page.evaluate(()=>openSpOrderPeek('peek-ui'));await page.waitForSelector('#sp-peek.is-open');
  const client=await page.createCDPSession();
  const touch=async(type,x,y)=>client.send('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{x,y}]});
  const grip=await page.$eval('.sp-pk-grip',e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});
  await touch('touchStart',grip.x,grip.y);await touch('touchMove',grip.x,grip.y+22);
  assert.equal(await page.$eval('#sp-peek .sp-peek',e=>getComputedStyle(e).transform),'matrix(1, 0, 0, 1, 0, 22)');
  await touch('touchEnd');assert(await page.$('#sp-peek.is-open'));
  assert.equal(await page.$eval('#sp-peek .sp-peek',e=>getComputedStyle(e).transform),'matrix(1, 0, 0, 1, 0, 0)');
  await touch('touchStart',grip.x,grip.y);await touch('touchMove',grip.x,grip.y+150);await touch('touchCancel');
  assert(await page.$('#sp-peek.is-open'));assert.equal(await page.$eval('#sp-peek .sp-peek',e=>e.style.getPropertyValue('--sp-pk-drag-y')),'');
  const bodyPoint=await page.$eval('#sp-peek .sp-pk-body',e=>{e.scrollTop=0;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height-25};});
  await touch('touchStart',bodyPoint.x,bodyPoint.y);await touch('touchMove',bodyPoint.x,bodyPoint.y-100);await touch('touchEnd');
  assert(await page.$('#sp-peek.is-open'));
  await touch('touchStart',grip.x,grip.y);await touch('touchMove',grip.x,grip.y+150);await touch('touchEnd');await page.waitForSelector('#sp-peek',{hidden:true});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
  await page.setViewport({width:1024,height:844,hasTouch:true});
  await page.evaluate(()=>{document.documentElement.dir='rtl';openSpOrderPeek('peek-ui');});
  assert.equal(await page.$eval('#sp-peek .sp-peek',e=>new DOMMatrix(getComputedStyle(e).transform).m41),0);
  await page.waitForSelector('#sp-peek.is-open');
  await page.evaluate(()=>{closeSpOrderPeek();openSpOrderPeek('peek-ui');});
  await new Promise(resolve=>setTimeout(resolve,360));assert(await page.$('#sp-peek.is-open'));
  await page.keyboard.press('Escape');await page.waitForSelector('#sp-peek',{hidden:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: 8 widths, RTL/LTR, light/dark; bottom sheet without shipping CTA; real touch drag, snap-back, cancellation and body scroll; vertical entry and reopen/Escape; unchanged pending-deposit calculations; accessible delivery/items disclosures retain state on refresh; receipts, comments, follow-up, print and contact actions.');
 }finally{await browser?.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
