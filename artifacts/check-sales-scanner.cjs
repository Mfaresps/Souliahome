const assert=require('node:assert/strict'),path=require('node:path'),puppeteer=require('../backend/node_modules/puppeteer');
const product={_id:'aaaaaaaaaaaaaaaaaaaaaaaa',code:'38',name:'Lovely Basket',sellPrice:150,buyPrice:80,openingBalance:20},second={_id:'bbbbbbbbbbbbbbbbbbbbbbbb',code:'40',name:'Coaster',sellPrice:200,openingBalance:20};
const user={_id:'preview-user',name:'Preview',username:'preview',role:'staff',perms:['transaction','movements','inventory','inventory-units-view','inventory-units-allocate']};
const identities={
 '123456789':{_id:'111111111111111111111111',productId:product._id,warehouseCode:'MAIN',status:'available',manualCode:'123456789'},
 '234567891':{_id:'222222222222222222222222',productId:second._id,warehouseCode:'MAIN',status:'available',manualCode:'234567891'},
 'PK-333333333333333333333333':{_id:'333333333333333333333333',productId:second._id,warehouseCode:'MAIN',status:'available',isPack:true,quantity:2,manualCode:'PK-123456-7'},
 '999999999':{_id:'999999999999999999999999',productId:product._id,warehouseCode:'OTHER',status:'available'},
};
(async()=>{
 const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:path.join(__dirname,'sales-scanner-browser')});
 try{
  for(const [lang,width] of [['en',1500],['ar',390]]){
   const page=await browser.newPage();await page.setViewport({width,height:1000});const errors=[],saves=[];
   page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR '+e.message);});
   await page.evaluateOnNewDocument((user,lang)=>{localStorage.clear();sessionStorage.clear();localStorage.setItem('token','preview-only');localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('soulia_lang_pref',lang);localStorage.setItem('soulia-push-prompt:'+user._id,'dismissed');},user,lang);
   await page.setRequestInterception(true);
   page.on('request',async request=>{
    const url=new URL(request.url()),respond=(data,status=200)=>request.respond({status,contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
    if(url.origin!=='http://localhost:8080')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:url.hostname==='cdn.socket.io'?"window.io=function(){return {on:function(){},emit:function(){},disconnect:function(){}}}":''});
    if(url.pathname.startsWith('/api/')){
     if(url.pathname==='/api/inventory-units/sales'){
      const body=JSON.parse(request.postData());saves.push(body);return respond({transaction:{_id:'ffffffffffffffffffffffff',...body.invoice}});
     }
     if(url.pathname.startsWith('/api/inventory-units/')){
      await new Promise(r=>setTimeout(r,70));const unit=identities[decodeURIComponent(url.pathname.split('/').pop())];return unit?respond({unit}):respond({message:'Barcode not found'},404);
     }
     return respond(url.pathname==='/api/auth/me'?user:url.pathname==='/api/settings'?{lang,otpEnabled:false,shipCos:[{name:'Manual',cairo:0,gov:0}]}:url.pathname==='/api/products'?[product,second]:url.pathname==='/api/transactions/inventory'?[product,second].map(p=>({...p,current:20,warehouseBalances:{MAIN:20}})):url.pathname==='/api/warehouses'?[{code:'MAIN',name:'Main',active:true},{code:'OTHER',name:'Other',active:true}]:[]);
    }
    request.continue();
   });
   await page.goto('http://localhost:8080/#transaction',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>window.SalesScanner&&currentPage==='transaction'&&products.length===2);
   assert.equal(await page.$eval('#tx-sale-scanner',el=>el.hidden),false);
   assert.equal(await page.$('#sale-scan-code'),null);
   await page.evaluate(()=>document.activeElement.blur());
   const send=async code=>{await page.keyboard.type(code);await page.keyboard.press('Enter');};
   await send('38');await page.waitForFunction(()=>txItems.length===1&&txItems[0].qty===1);
   await send('123456789');await page.waitForFunction(()=>txItems[0].qty===2);
   await send('123456789');await page.waitForSelector('.sale-reader-feedback.is-error');assert.equal(await page.evaluate(()=>txItems[0].qty),2);
   await send('234567891');await send('PK-333333333333333333333333');await page.waitForFunction(()=>txItems.length===2&&txItems[1].qty===3);
   assert.equal(await page.evaluate(()=>txItems.reduce((sum,line)=>sum+line.qty*line.price,0)),900);
   await send('999999999');await page.waitForFunction(()=>document.querySelector('.sale-reader-feedback')?.textContent.includes('999999999'));
   assert.equal(await page.evaluate(()=>txItems[0].qty),2);
   await page.click('[data-sale-manual]');await page.type('#sale-scan-code',lang==='ar'?'٣٨':'38');await page.keyboard.press('Enter');
   try{await page.waitForFunction(()=>txItems[0].qty===3,{timeout:5000});}catch(error){console.log(await page.evaluate(()=>({items:txItems,scan:document.querySelector('#tx-sale-scanner').outerHTML,focus:document.activeElement?.id})));throw error;}assert.equal(await page.$eval('#sale-scan-code',el=>el.value),'');
   await page.click('[data-sale-manual]');
   const retry=await page.evaluate(()=>{
    const invoice={type:txType,date:'2026-10-20T10:00:00Z',transactionDate:'2026-10-20',warehouseCode:'MAIN',ref:'3100',client:'Preview',items:txItems.map(item=>({...item,code:products.find(p=>p._id===item.productId).code})),total:1050};
    SalesScanner.attach(invoice);const first=invoice._saleBinding;
    const later={...invoice,date:'2026-10-20T10:01:00Z'};delete later._saleBinding;SalesScanner.attach(later);
    window.testSale=invoice;return {first:first.operationKey,second:later._saleBinding.operationKey,firstDate:first.invoice.date,secondDate:later._saleBinding.invoice.date,bindings:first.bindings};
   });
   assert.equal(retry.first,retry.second);assert.equal(retry.firstDate,retry.secondDate);
   assert.equal(retry.bindings[0].unitIds.length,1);assert.equal(retry.bindings[1].packIds.length,1);
   await page.evaluate(()=>SalesScanner.save(testSale));assert.equal(saves.length,1);assert.equal(saves[0].bindings.length,2);assert(!saves[0].invoice._saleBinding);
   await page.screenshot({path:path.join(__dirname,`sales-scanner-${lang}.png`),fullPage:true});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.evaluate(()=>{
    for(const [id,value] of Object.entries({'tx-client':'Preview','tx-phone':'01000000000','tx-city':'Cairo','tx-address':'Preview street','tx-ref':'3100'}))document.getElementById(id).value=value;
    const company=document.getElementById('tx-shipco');company.add(new Option('Manual','Manual'));company.value='Manual';
    sessionStorage.setItem('_txDateConfirmedToday',todayLocalISO());
   });
   await page.evaluate(()=>saveTx());
   assert.equal(await page.evaluate(()=>!!pendingTxData?._saleBinding),true,'Save Transaction attaches physical bindings');
   assert.equal(await page.$eval('#tx-confirm-modal',el=>el.classList.contains('active')),true);
   await page.evaluate(()=>confirmTxSave());assert.equal(saves.length,2);assert.equal(saves[1].bindings.length,2);
   assert.equal(await page.evaluate(()=>txItems.length),0,'successful financial save resets the form');
   await page.evaluate(()=>{SalesScanner.submit('123456789');SalesScanner.submit('38');SalesScanner.submit('38');});
   await page.waitForFunction(()=>txItems.length===1&&txItems[0].qty===3);
   assert.equal(await page.evaluate(()=>txItems[0]._saleScans.length),1,'repeated product-code scans increment quantity, while physical identities stay unique');
   await page.evaluate(()=>resetTx());
   await page.evaluate(()=>SalesScanner.reset(true));await page.evaluate(()=>{txItems=[];renderTxItems();SalesScanner.submit('123456789');resetTx();});
   await new Promise(r=>setTimeout(r,180));assert.equal(await page.evaluate(()=>txItems.length),0,'an in-flight scan must not modify a reset form');
   assert.deepEqual(errors,[]);console.log(lang+': hands-free product/piece/pack scans, pricing and totals, duplicate and warehouse checks, manual entry, stable save retries and reset race passed.');
   await page.close();
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
