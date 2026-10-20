const assert=require('node:assert/strict'),path=require('node:path'),puppeteer=require('../backend/node_modules/puppeteer');
const id='000000000000000000000001',other='000000000000000000000002',unitId='aaaaaaaaaaaaaaaaaaaaaaaa',code='123456789';
const product={_id:'bbbbbbbbbbbbbbbbbbbbbbbb',code:'BASKET',name:'Lovely Basket',price:100};
const user={_id:'preview-user',name:'Preview',username:'preview',role:'staff',perms:['pickup-orders','movements','inventory','inventory-units-view','inventory-units-allocate']};
const order=orderId=>({_id:orderId,type:'مبيعات',ref:orderId===id?'3100':'3101',client:'Preview',date:'2026-10-20',total:100,remaining:100,pickupStatus:'Preparing',pickupRef:'PREP-RESCAN',shipCo:'Manual',
 items:[{lineId:'line',productId:product._id,code:product.code,name:product.name,qty:1,price:100}]});
(async()=>{
 const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:path.join(__dirname,'pickup-rescan-browser')});
 try{
  for(const lang of ['ar','en']){
   const page=await browser.newPage();await page.setViewport({width:1400,height:1000});const errors=[],keys=[],receipts=new Map();let status='available',version=0,prepared=false;
   page.on('pageerror',error=>errors.push(error.message));
   await page.evaluateOnNewDocument((user,lang)=>{localStorage.clear();localStorage.setItem('token','preview-only');localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('soulia_lang_pref',lang);},user,lang);
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
   await page.goto('http://localhost:8080/#pickup-orders',{waitUntil:'domcontentloaded'});
   await page.waitForFunction(()=>document.querySelectorAll('#pu-prep-col .pu-group').length===1);
   await page.evaluate(()=>{window.__confirmMessages=[];showConfirm=async(message,options)=>{__confirmMessages.push({message,options});return true;};openPuCardOrdersModal('PREP-RESCAN','prep');});
   await page.waitForFunction(()=>!!_pwPickState('000000000000000000000001').summary);
   await page.evaluate(()=>_pwSubmitScan('000000000000000000000001','123456789'));
   assert(prepared,'first scan is actually approved through the existing preparation flow');
   await page.evaluate(()=>pwSelectOrder('000000000000000000000001'));
   await page.waitForFunction(()=>!!_pwPickState('000000000000000000000001').summary);
   await page.evaluate(()=>pwUndoLastPick('000000000000000000000001'));
   assert.equal(status,'available');assert.equal(prepared,false);
   assert.equal(await page.evaluate(()=>_pwPickState('000000000000000000000001').feedback),null);
   assert.equal(await page.$('.pw-scan-feedback.is-success'),null,'old success message is removed');
   await page.evaluate(()=>_pwSubmitScan('000000000000000000000001','123456789'));
   assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);assert.equal(status,'prepared');assert(prepared,'second scan must persist and pass fresh preparation verification');
   const warnings=await page.evaluate(()=>__confirmMessages.filter(entry=>entry.options?.rows));assert.equal(warnings.length,0,'no incomplete preparation warning');
   assert.deepEqual(errors,[]);console.log(lang+': real preparation flow: scan, approve, undo, clear feedback, rescan with a new key, approve again — passed.');
   await page.close();
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
