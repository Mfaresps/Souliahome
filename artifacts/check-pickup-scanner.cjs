const assert=require('node:assert/strict'),path=require('node:path'),puppeteer=require('../backend/node_modules/puppeteer');
const user={_id:'preview-user',name:'Preview',username:'preview',role:'staff',perms:['pickup-orders','movements','inventory','inventory-units-view','inventory-units-allocate']};
const product={_id:'aaaaaaaaaaaaaaaaaaaaaaaa',code:'SKU-A',name:'Cotton basket',price:100},productB={_id:'bbbbbbbbbbbbbbbbbbbbbbbb',code:'SKU-B',name:'White coaster',price:100};
const order={_id:'000000000000000000000001',type:'مبيعات',ref:'3100',client:'Preview customer',date:'2026-10-20',total:500,remaining:500,pickupStatus:'Preparing',pickupRef:'PREP-SCAN',prepCreatedAt:'2026-10-20',shipCo:'Manual',
 items:[{lineId:'a',productId:product._id,code:product.code,name:product.name,qty:4,price:100},{lineId:'b',productId:productB._id,code:productB.code,name:productB.name,qty:1,price:100}]};
const letterCode='SU-ABCDEF123456789012345678';
(async()=>{
 const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:path.join(__dirname,'pickup-scanner-browser')});
 try{
  for(const [lang,width] of [['en',1500],['ar',390]]){
   const page=await browser.newPage();await page.setViewport({width,height:1000});const errors=[],writes=[];let summaries=0,inflight=0,peak=0;
   const lines=[{lineId:'a',productId:product._id,qty:4,units:[],availableCount:4,skippedCount:0},{lineId:'b',productId:productB._id,qty:1,units:[],availableCount:1,skippedCount:0}];
   page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR '+e.message);});
   await page.evaluateOnNewDocument((user,lang)=>{localStorage.clear();localStorage.setItem('token','preview-only');localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('soulia_lang_pref',lang);},user,lang);
   await page.setRequestInterception(true);
   page.on('request',async request=>{
    const url=new URL(request.url()),respond=(data,status=200)=>request.respond({status,contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
    if(url.origin!=='http://localhost:8080')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:url.hostname==='cdn.socket.io'?"window.io=function(){return {on:function(){},emit:function(){},disconnect:function(){}}}":''});
    if(url.pathname.startsWith('/api/')){
     if(url.pathname.endsWith('/picking')){summaries++;return respond({transactionId:order._id,lines});}
     if(url.pathname.endsWith('/picking/scans')){
      const body=JSON.parse(request.postData());writes.push(body);inflight++;peak=Math.max(peak,inflight);
      await new Promise(r=>setTimeout(r,90));
      const line=lines.find(l=>l.lineId===body.lineId),unit={unitId:body.identifier,barcode:body.identifier,manualCode:body.identifier,status:'picking',version:1};line.units.push(unit);inflight--;
      return respond({outcome:'accepted',unit,lineId:line.lineId,transactionId:order._id});
     }
     if(url.pathname.startsWith('/api/inventory-units/')){
      const code=decodeURIComponent(url.pathname.split('/').pop());await new Promise(r=>setTimeout(r,50));
      if(code==='999999999')return respond({message:'Barcode is not registered'},404);
      const found=lines.flatMap(l=>l.units).find(u=>u.barcode===code);
      return respond({unit:{barcode:code,productId:code==='876543219'?productB._id:product._id,status:found?'picking':'available',assignment:found?{transactionId:order._id,lineId:'a'}:null}});
     }
     return respond(url.pathname==='/api/auth/me'?user:url.pathname==='/api/settings'?{lang}:url.pathname==='/api/products'?[product,productB]:url.pathname==='/api/transactions/inventory'?[{...product,current:100}]:url.pathname==='/api/transactions'||url.pathname==='/api/transactions/pickup-orders'?[order]:url.pathname==='/api/shipping/pickup-preview'?{requests:[]}:[]);
    }
    request.continue();
   });
   await page.goto('http://localhost:8080/#pickup-orders',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>document.querySelectorAll('#pu-prep-col .pu-group').length===1);
   await page.evaluate(()=>{_pwAutoPrepareScannedOrder=async()=>{};openPuCardOrdersModal('PREP-SCAN','prep');});
   await page.waitForSelector('.pw-reader-bar');await page.waitForFunction(()=>!!_pwPickState(_pwSelId).summary);
   if(width<700)await page.evaluate(()=>pwSelectOrder(_pwSelId));
   assert.equal(await page.$('#pw-order-scan'),null);assert.equal(await page.$('.pw-unit-scan-row input'),null);
   const send=async(code,suffix='Enter')=>{await page.keyboard.type(code);await page.keyboard.press(suffix);};
   await page.evaluate(()=>document.querySelector('#pw-work').focus());
   await send('123456789');
   await page.evaluate(code=>{
    const target=document.activeElement;
    for(const ch of code){const letter=/[A-Z]/.test(ch);target.dispatchEvent(new KeyboardEvent('keydown',{key:letter?'ش':ch,code:letter?'Key'+ch:/\d/.test(ch)?'Digit'+ch:'Minus',shiftKey:letter,bubbles:true,cancelable:true}));}
    target.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
   },letterCode);
   await send('234567891');
   await page.waitForFunction(()=>document.querySelectorAll('.pw-piece-dots .matched').length===3);
   assert.equal(writes.length,3);assert.equal(peak,1,'serial writes');assert.equal(summaries,1,'no extra summary request per scan');
   assert.equal(writes[1].identifier,letterCode,'Arabic keyboard converted using physical key codes');
   assert(await page.$eval('.pw-scanned-codes',el=>el.textContent.includes('123456789')));
   assert.equal(await page.$('#pw-order-scan'),null,'scanner remains ready with no field');
   await send('999999999');await page.waitForSelector('.pw-scan-feedback.is-error');
   const errorText=await page.$eval('.pw-scan-feedback',el=>el.textContent);
   assert(errorText.includes(lang==='en'?'Barcode not found':'الباركود غير مسجل'));assert(await page.$('.pw-scan-feedback small'));
   assert.equal(writes.length,3,'error never saves a piece');
   await page.click('.pw-manual-toggle');await page.type('#pw-order-scan',lang==='ar'?'٣٤٥٦٧٨٩١٢':'345678912');await page.keyboard.press('Enter');
   await page.waitForFunction(()=>document.querySelectorAll('.pw-piece-dots .matched').length===4);
   assert.equal(writes[3].identifier,'345678912');
   await page.click('.pw-manual-toggle');assert.equal(await page.$('#pw-order-scan'),null);
   await send('345678912');await page.waitForSelector('.pw-scan-feedback.is-error');assert.equal(writes.length,4,'duplicate does not save twice');
   await send('876543219');await page.waitForFunction(()=>document.querySelectorAll('.pw-piece-dots .matched').length===5);
   await page.waitForSelector('.pw-scan-feedback.is-success');assert.equal(writes.length,5);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:path.join(__dirname,`pickup-scanner-${lang}.png`)});
   assert.deepEqual(errors,[]);console.log(`${lang}: hands-free scans, Arabic/English physical keys, queued writes, immediate receipt UI, manual entry, actionable errors and duplicate prevention passed.`);
   await page.close();
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
