const assert=require('node:assert/strict'),path=require('node:path'),puppeteer=require('../backend/node_modules/puppeteer');
const user={_id:'preview-user',name:'Preview',username:'preview',role:'staff',perms:['pickup-orders','movements','inventory']};
const product={_id:'aaaaaaaaaaaaaaaaaaaaaaaa',code:'SKU-1',name:'Basket',openingBalance:500,price:100};
const row=(i,status,ref)=>({_id:String(i).padStart(24,'0'),type:'مبيعات',ref:String(3000+i),client:'Customer '+i,phone:'01000000000',date:'2026-10-20',createdAt:'2026-10-20T10:00:00.000Z',
  total:100,remaining:100,shipCo:'Manual',pickupStatus:status,pickupRef:ref,pickupDate:'2026-10-20',prepCreatedAt:'2026-10-20T10:00:00.000Z',prepCreatedBy:'Preview',prepChecked:false,
  items:[{lineId:'line-'+i,productId:product._id,code:product.code,name:product.name,qty:1,price:100,total:100}],payments:[],pickupHistory:[]});
const orders=[row(1,'Pending'),row(2,'Preparing','PREP-A'),row(3,'Preparing','PREP-A'),row(4,'Preparing','PREP-B'),row(5,'Ready','RUN-A'),...Array.from({length:14},(_,i)=>row(i+6,'Shipped','SHIP-'+i))];
(async()=>{
 const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:path.join(__dirname,'pickup-workspace-browser')});
 try{
  for(const [lang,width] of [['en',1920],['ar',390]]){
   const page=await browser.newPage();await page.setViewport({width,height:1000});const errors=[];let requests=0,releasePreview;
   page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR '+e.message);});
   await page.evaluateOnNewDocument((user,lang)=>{localStorage.clear();localStorage.setItem('token','preview-only');localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('soulia_lang_pref',lang);},user,lang);
   await page.setRequestInterception(true);
   page.on('request',request=>{
    const url=new URL(request.url());
    if(url.origin!=='http://localhost:8080')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:url.hostname==='cdn.socket.io'?"window.__previewHandlers={};window.io=function(){return {on:function(event,fn){(__previewHandlers[event]||=[]).push(fn)},emit:function(){},disconnect:function(){}}}":''});
    if(url.pathname.startsWith('/api/')){
     if(url.pathname==='/api/shipping/pickup-preview'){releasePreview=()=>request.respond({status:200,contentType:'application/json',body:JSON.stringify({requests:[]})});return;}
     let data=url.pathname==='/api/auth/me'?user:url.pathname==='/api/settings'?{lang}:url.pathname==='/api/products'?[product]:url.pathname==='/api/transactions/inventory'?[{...product,current:500}]:url.pathname==='/api/transactions'?orders:url.pathname==='/api/transactions/pickup-orders'?orders:[];
     if(url.pathname==='/api/transactions/pickup-orders')requests++;
     return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
    }
    request.continue();
   });
   await page.goto('http://localhost:8080/#pickup-orders',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>document.querySelectorAll('#pu-prep-col .pu-group').length===2,{timeout:20000});
   assert.equal(requests,1,'single initial pickup request');assert(releasePreview,'secondary request started');
   assert.equal(await page.$eval('#pu-load-state',el=>el.hidden),true,'board visible before shipping preview finishes');
   const size=await page.$eval('.pu-bkpi',el=>el.getBoundingClientRect().height);assert(size<75,'compact KPI '+size);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no document overflow');
   if(width===1920){
    for(const testWidth of [320,768,1280,1920]){
     await page.setViewport({width:testWidth,height:1000});
     const layout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,prepHeight:document.querySelector('#pu-prep-col').clientHeight}));
     assert(!layout.overflow,`${testWidth}px document overflow`);
     assert(layout.prepHeight>100,`${testWidth}px collapsed preparation body`);
    }
   }else assert(await page.$eval('#pu-prep-col',el=>el.clientHeight)>100,'mobile preparation body must remain usable');
   await page.screenshot({path:path.join(__dirname,`pickup-workspace-${lang}.png`)});
   await releasePreview();
   await page.evaluate(()=>openPuCardOrdersModal('PREP-A','prep'));
   await page.waitForFunction(()=>document.querySelectorAll('#puco-orders-list .pw-ocard').length===2);
   const selection=await page.evaluate(()=>_pwSelId);
   const updated={...orders[1],client:'Live customer name',total:250};
   await page.evaluate(tx=>(__previewHandlers['tx:updated']||[]).forEach(fn=>fn({tx})),updated);
   await page.waitForFunction(()=>document.querySelector('#puco-orders-list')?.textContent.includes('Live customer name'));
   assert.equal(await page.evaluate(()=>_pwSelId),selection,'selection retained');
   await page.evaluate(()=>{const input=document.querySelector('#puco-search-input');input.focus();input.value='Customer';});
   await page.evaluate(tx=>(__previewHandlers['tx:updated']||[]).forEach(fn=>fn({tx})),{...updated,client:'Changed customer while typing'});
   await new Promise(r=>setTimeout(r,160));
   assert.equal(await page.$eval('#puco-search-input',el=>el.value),'Customer');
   await page.evaluate(()=>document.querySelector('#puco-search-input').blur());
   await page.waitForFunction(()=>document.querySelector('#puco-orders-list')?.textContent.includes('Changed customer while typing'));
   await page.evaluate(()=>{closePuCardOrdersModal();(__previewHandlers['pickup:updated']||[]).forEach(fn=>fn({ids:['000000000000000000000002'],action:'prepCheck',prepChecked:true}));});
   await page.waitForFunction(()=>_pickupOrders.find(o=>o._id==='000000000000000000000002').prepChecked===true);
   await page.evaluate(()=>{(__previewHandlers['pickup:updated']||[]).forEach(fn=>fn({ids:['000000000000000000000002'],action:'ready',pickupRef:'RUN-LIVE'}));});
   await page.waitForFunction(()=>!!document.querySelector('#pu-ready-col .pu-group[data-group-key="RUN-LIVE"]'));
   assert.equal(requests,1,'socket update must not fetch the whole page');
   await page.evaluate(()=>puSwitchView('table'));
   await page.evaluate(()=>{(__previewHandlers['pickup:updated']||[]).forEach(fn=>fn({ids:['000000000000000000000001'],action:'preparing',pickupRef:'PREP-LIVE'}));});
   await page.waitForFunction(()=>_pickupOrders.find(o=>o._id==='000000000000000000000001').pickupStatus==='Preparing');
   await page.evaluate(()=>puSwitchView('ready'));
   await page.evaluate(()=>{(__previewHandlers['pickup:updated']||[]).forEach(fn=>fn({ids:['000000000000000000000002'],action:'undo'}));});
   await page.waitForFunction(()=>_pickupOrders.find(o=>o._id==='000000000000000000000002').pickupStatus==='Pending');
   await new Promise(r=>setTimeout(r,160));
   assert.deepEqual(errors,[]);console.log(`${lang}: board before shipping, compact KPIs (${size}px), no overflow, live transaction/modal/stage sync and input preservation passed.`);
   await page.close();
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
