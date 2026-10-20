const assert=require('node:assert/strict'),path=require('node:path'),puppeteer=require('../backend/node_modules/puppeteer');
const product={_id:'aaaaaaaaaaaaaaaaaaaaaaaa',code:'38',name:'Lovely Basket',sellPrice:150,buyPrice:80,openingBalance:20},second={_id:'bbbbbbbbbbbbbbbbbbbbbbbb',code:'40',name:'Coaster',sellPrice:200,openingBalance:20};
const user={_id:'preview-user',name:'Preview',username:'preview',role:'staff',perms:['transaction','movements','inventory','inventory-units-view','inventory-units-allocate']};
const identities={
 'SU-FA1111111111111111111111':{_id:'111111111111111111111111',productId:product._id,warehouseCode:'MAIN',status:'available',manualCode:'123456789'},
 '123456789':{_id:'111111111111111111111111',productId:product._id,warehouseCode:'MAIN',status:'available',manualCode:'123456789'},
 '234567891':{_id:'222222222222222222222222',productId:second._id,warehouseCode:'MAIN',status:'available',manualCode:'234567891'},
 'PK-333333333333333333333333':{_id:'333333333333333333333333',productId:second._id,warehouseCode:'MAIN',status:'available',isPack:true,quantity:2,manualCode:'PK-123456-7'},
 '999999999':{_id:'999999999999999999999999',productId:product._id,warehouseCode:'OTHER',status:'available'},
};
(async()=>{
 const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:path.join(__dirname,'sales-search-routing-browser')});
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

   await send('SU-FA1111111111111111111111');
   await page.waitForFunction(()=>txItems.length===1&&txItems[0].qty===1);
   assert.equal(await page.$eval('#global-unit-scan-dialog',el=>el.open),false,'F in a physical code must not open global scanner');
   for(const inputId of ['global-search','tx-picker-q']){
    await page.evaluate(()=>resetTx());
    if(inputId==='global-search' && width<769)await page.evaluate(()=>toggleMobileSearch());
    if(inputId==='tx-picker-q')await page.evaluate(()=>openProductPicker());
    await page.waitForFunction(id=>document.getElementById(id)?.getClientRects().length,{},inputId);
    await page.focus('#'+inputId);
    if(lang==='ar')await page.evaluate(()=>{
     for(const char of 'SU-FA1111111111111111111111'){
      const letter=/[A-Z]/.test(char);
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:letter?'ش':char,code:letter?'Key'+char:/[0-9]/.test(char)?'Digit'+char:'Minus',shiftKey:letter,bubbles:true,cancelable:true}));
     }
     document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    });else await send('123456789');
    await page.waitForFunction(()=>txItems.length===1&&txItems[0].qty===1);
    assert.equal(await page.$eval('#'+inputId,el=>el.value),'','scan must not leak into '+inputId);
    assert.equal(await page.$eval('#global-unit-scan-dialog',el=>el.open),false);
    await page.focus('#'+inputId);
    await page.keyboard.type(lang==='ar'?'سلة':'basket',{delay:90});
    await page.waitForFunction((id,value)=>document.getElementById(id).value===value,{},inputId,lang==='ar'?'سلة':'basket');
    assert.equal(await page.evaluate(()=>txItems[0].qty),1,'manual search must not add a product');
    if(inputId==='tx-picker-q')await page.evaluate(()=>closeProductPicker());
    else await page.evaluate(()=>{document.getElementById('global-search').value='';closeSearchDropdown();if(innerWidth<769)closeMobileSearch();});
   }
   await page.evaluate(()=>resetTx());
   await page.focus('#tx-client');await page.keyboard.type('123456789');
   assert.equal(await page.$eval('#tx-client',el=>el.value),'123456789','customer fields keep their normal input');
   assert.equal(await page.evaluate(()=>txItems.length),0);
   await page.evaluate(()=>document.activeElement.blur());
   await page.keyboard.down('Shift');await page.keyboard.type('SU');await page.keyboard.up('Shift');
   await page.keyboard.type('-FA1111111111111111111111');await page.keyboard.press('Tab');
   await page.waitForFunction(()=>txItems.length===1);
   assert.deepEqual(errors,[]);
   console.log(lang+': F shortcut priority, scanner in global/product search, normal typing, customer fields and Shift handling passed');
   await page.close();
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
