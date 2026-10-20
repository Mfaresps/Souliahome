const assert=require('node:assert/strict'),path=require('node:path'),puppeteer=require('../backend/node_modules/puppeteer');
const id='000000000000000000000001',other='000000000000000000000002',unitId='aaaaaaaaaaaaaaaaaaaaaaaa',code='123456789';
const product={_id:'bbbbbbbbbbbbbbbbbbbbbbbb',code:'BASKET',name:'Lovely Basket',price:100};
const user={_id:'preview-user',name:'Preview',username:'preview',role:'staff',perms:['pickup-orders','movements','inventory','inventory-units-view','inventory-units-allocate']};
const order=orderId=>({_id:orderId,type:'مبيعات',ref:orderId===id?'3100':'3101',client:'Preview',date:'2026-10-20',total:100,remaining:100,pickupStatus:'Preparing',pickupRef:'PREP-RESCAN',shipCo:'Manual',
 items:[{lineId:'line',productId:product._id,code:product.code,name:product.name,qty:1,price:100}]});
(async()=>{
 const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:path.join(__dirname,'prep-shipping-browser-visual')});
 try{
  for(const lang of ['ar','en']){
   const page=await browser.newPage();await page.setViewport({width:lang==='ar'?390:1400,height:1000});const errors=[],keys=[],receipts=new Map();let status='available',version=0,prepared=false;
   page.on('pageerror',error=>errors.push(error.message));
   await page.evaluateOnNewDocument((user,lang)=>{localStorage.clear();localStorage.setItem('token','preview-only');localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('soulia_lang_pref',lang);localStorage.setItem('soulia-push-prompt:'+user._id,'dismissed');},user,lang);
   const unit=()=>({unitId,barcode:'SU-'+unitId.toUpperCase(),manualCode:code,productId:product._id,status,version});
   await page.setRequestInterception(true);
   page.on('request',request=>{
    const url=new URL(request.url());const respond=(data,statusCode=200)=>request.respond({status:statusCode,contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});
    if(url.origin!=='http://localhost:8080')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:url.hostname==='cdn.socket.io'?"window.io=function(){return {on:function(){},emit:function(){},disconnect:function(){}}}":''});
    if(url.pathname.startsWith('/api/')){
     if(url.pathname.endsWith('/picking')){const isTarget=url.pathname.includes(id);return respond({prepChecked:isTarget&&prepared,lines:[{lineId:'line',productId:product._id,qty:1,availableCount:1,units:isTarget&&status!=='available'?[unit()]:[],skippedCount:0}]});}
     if(url.pathname.endsWith('/picking/scans')){
      const body=JSON.parse(request.postData());keys.push(body.operationKey);
      // Preserve backend receipt replay semantics: reusing a key does not execute another scan.
      if(receipts.has(body.operationKey))return respond(receipts.get(body.operationKey));
      status='picking';version++;const result={outcome:'accepted',unit:unit(),lineId:'line',transactionId:id};receipts.set(body.operationKey,result);return respond(result);
     }
     if(url.pathname.endsWith('/actions')){const body=JSON.parse(request.postData());status=body.action==='undo-picking'?'available':'prepared';version++;if(status==='available')prepared=false;return respond({unit:unit()});}
     if(url.pathname.endsWith('/prep-check')){prepared=JSON.parse(request.postData()).prepChecked;return respond({ok:true,updated:1});}
     if(url.pathname.startsWith('/api/inventory-units/'))return respond({unit:{...unit(),__v:version,assignment:status!=='available'?{transactionId:id,lineId:'line'}:null}});
     return respond(url.pathname==='/api/auth/me'?user:url.pathname==='/api/settings'?{lang}:url.pathname==='/api/products'?[product]:url.pathname==='/api/transactions/inventory'?[{...product,current:100}]:url.pathname==='/api/transactions'||url.pathname==='/api/transactions/pickup-orders'?[order(id),order(other)]:url.pathname==='/api/shipping/pickup-preview'?{requests:[]}:[]);
    }
    request.continue();
   });
   console.log(lang+': opening');
   await page.goto('http://localhost:8080/#pickup-orders',{waitUntil:'domcontentloaded'});
   console.log(lang+': waiting board');
   await page.waitForFunction(()=>document.querySelectorAll('#pu-prep-col .pu-group').length===1);
   await page.evaluate(()=>{window.__confirmMessages=[];showConfirm=async(message,options)=>{__confirmMessages.push({message,options});return true;};openPuCardOrdersModal('PREP-RESCAN','prep');});
   await page.waitForFunction(()=>!!_pwPickState('000000000000000000000001').summary);
   console.log(lang+': scanning');
   await page.evaluate(()=>_pwSubmitScan('000000000000000000000001','123456789'));

   assert(prepared);
   await page.evaluate(id=>{
    window.__shippingDone=false;
    const realApi=api;
    api=(url,options)=>url.startsWith('/shipping/create-order/')?new Promise(resolve=>{window.__finishShip=()=>{__shippingDone=true;resolve({bostaOrderId:'ship-first',trackingNumber:'TR-3100'});};}):realApi(url,options);
    carrierIntegration=()=>'bosta';
    const o=_pickupOrders.find(o=>o._id===id);o.carrierCode='Bosta';o.shippingAddress='Cairo';o.shippingGov='Cairo';o.phone='01000000000';_awbOrderCopies(id).forEach(copy=>Object.assign(copy,{carrierCode:'Bosta',shippingAddress:'Cairo',shippingGov:'Cairo',phone:'01000000000'}));
    _bsfMaybeOffer(o);
   },id);
   console.log(lang+': waiting success');
   await page.waitForSelector('#bsf-overlay.is-on');
   const title=await page.$eval('.bsf-title',el=>el.textContent);
   assert(title.includes('#3100'));
   assert.equal(await page.$eval('.bsf-sub',el=>el.textContent),'Preview');
   await page.click('[data-bsf="send"]');
   await page.waitForSelector('#bsf-overlay.is-docked');
   assert.equal(await page.evaluate(()=>__shippingDone),false);
   assert.equal(await page.evaluate(()=>_pwSelId),other,'next order selected before carrier or printing completes');
   assert.equal(await page.$eval('#bsf-overlay',el=>getComputedStyle(el).backdropFilter),'none');
   await page.evaluate(()=>{window.__captured=[];_pwSubmitScan=async(id,code)=>__captured.push({id,code});});
   await page.keyboard.type('987654321');await page.keyboard.press('Enter');
   assert.deepEqual(await page.evaluate(()=>__captured),[{id:other,code:'987654321'}]);
   await page.evaluate(()=>__finishShip());
   await page.waitForSelector('[data-bsf="print"]');
   await page.evaluate(()=>{printBostaAwb=()=>new Promise(resolve=>{window.__finishPrint=resolve;});});
   await page.click('[data-bsf="print"]');
   await page.waitForFunction(()=>_bsfState.stage==='printing');
   assert.equal(await page.evaluate(()=>_pwSelId),other);
   await page.screenshot({path:path.join(__dirname,'prep-shipping-'+lang+'.png')});
   await page.keyboard.type('876543219');await page.keyboard.press('Enter');
   assert.equal((await page.evaluate(()=>__captured)).length,2,'scanner remains ready while label is printing');
   await page.evaluate(()=>__finishPrint(true));
   await page.waitForFunction(()=>!document.getElementById('bsf-overlay'));
   assert.deepEqual(errors,[]);
   console.log(lang+': combined success, next order before shipment, scanner during sending and printing passed');
   await page.close();
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
