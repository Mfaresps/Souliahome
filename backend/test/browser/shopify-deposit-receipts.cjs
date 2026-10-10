/* Shipped HTML in Chromium, with every network request intercepted. No live services or payments.
 * Run: node backend/test/browser/shopify-deposit-receipts.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const html = fs.readFileSync(path.resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
let png;
const order = {_id:'order-1',ref:'2719',shopifyId:'s-1',client:'Test customer',phone:'01000000000',
  assignedToName:'Tester',orderStatusUrl:'http://soulia.test/order-status',
  status:'pending',cancelled:false,total:1500,shipCost:50,createdAt:'2026-10-07T12:00:00Z',items:[],depositReceipts:[],notes:'Instapay 999',tags:'paid in full'};
const orders = [order];
const seen = [];
const errors = [];
let failSubmit = false;
let failOrders = false;
let failWithdraw = false;
let failUpload = false;
let releaseUpload;
let checks = 0;
function check(condition, message) { assert.ok(condition,message); checks++; }

(async()=>{
  png = await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="560"><rect width="360" height="560" fill="white"/><rect width="360" height="100" fill="#287b50"/><text x="180" y="58" text-anchor="middle" fill="white" font-family="Arial" font-size="24">TEST RECEIPT</text><text x="180" y="170" text-anchor="middle" fill="#287b50" font-family="Arial" font-size="22">Transfer received</text><text x="180" y="250" text-anchor="middle" fill="#17352a" font-family="Arial" font-size="48">EGP 500</text><text x="180" y="320" text-anchor="middle" fill="#68776f" font-family="Arial" font-size="20">Instapay</text><path d="M35 360h290" stroke="#dde5df"/><text x="180" y="420" text-anchor="middle" fill="#68776f" font-family="Arial" font-size="18">Synthetic test image</text></svg>')).png().toBuffer();
  console.log('Starting isolated Chromium');
  const browser = await puppeteer.launch({headless:true});
  console.log('Chromium ready');
  try {
    const page = await browser.newPage();
    await page.setViewport({width:1440,height:1000});
    await page.setRequestInterception(true);
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',async req=>{
      const url = new URL(req.url());
      const reply = (data,status=200)=>req.respond({status,contentType:'application/json',body:JSON.stringify(data)});
      try {
        if(url.origin==='http://soulia.test' && url.pathname==='/') return req.respond({status:200,contentType:'text/html',body:html});
        if(url.pathname==='/config.js')return req.respond({status:200,contentType:'text/javascript',body:'window.__ENV__={API_BASE_URL:""};'});
        if(url.pathname.startsWith('/api/')) {
          seen.push({path:url.pathname,method:req.method(),headers:req.headers(),body:req.postData()||''});
          if(url.pathname==='/api/shopify/orders')return reply(failOrders?{message:'Refresh failed'}:orders,failOrders?503:200);
          if(url.pathname==='/api/settings/r2-config/test')return reply({success:true,message:'Shared connection verified'});
          if(url.pathname==='/api/settings/r2-config' && req.method()==='POST')return reply({success:true});
          if(url.pathname.endsWith('/deposit-receipts/upload')) {
            check(req.headers()['content-type'].startsWith('multipart/form-data; boundary='),'multipart boundary reaches upload');
            await new Promise(resolve=>{releaseUpload=resolve;});
            if(failUpload)return reply({message:'Image analysis failed'},503);
            const receipt={id:'receipt-1',status:'مسودة',amount:0,method:'',imageDeleted:false,submittedBy:'Tester',submittedById:'staff-1',uploadedAt:new Date().toISOString(),submittedAt:'',warnings:[],needsReview:false,ocr:{amount:500,method:'Instapay',confident:true}};
            order.depositReceipts.push(receipt);return reply({receipt,cap:1500});
          }
          if(url.pathname.endsWith('/deposit-receipts/receipt-1/submit')) {
            if(failSubmit)return reply({message:'Submission failed'},503);
            const body=JSON.parse(req.postData());Object.assign(order.depositReceipts[0],body,{status:'معلق',submittedAt:new Date().toISOString()});return reply({success:true,receipt:order.depositReceipts[0]});
          }
          if(url.pathname.endsWith('/deposit-receipts/receipt-1') && req.method()==='DELETE') {
            if(failWithdraw)return reply({message:'Withdrawal failed'},503);
            order.depositReceipts=order.depositReceipts.filter(r=>r.id!=='receipt-1');
            return reply({success:true});
          }
          if(url.pathname.endsWith('/deposit-receipts/receipt-1/approve')) {
            Object.assign(order.depositReceipts[0],{status:'معتمد',vaultEntryId:'vault-1',vaultTxNo:'SAL-001',reviewedBy:'Admin'});return reply({success:true,vaultTxNo:'SAL-001'});
          }
          if(/^\/api\/shopify\/deposit-receipts\/[^/]+\/image$/.test(url.pathname))return req.respond({status:200,contentType:'image/png',body:png});
          if(url.pathname.endsWith('/orders/order-1/approve')) {
            return reply({success:false,message:'Order changed during confirmation'});
          }
          if(url.pathname==='/api/version.json')return reply({version:'test'});
          return reply([]);
        }
        // No request escapes to a real site, including CDNs, Shopify, or payment providers.
        if(req.resourceType()==='script')return req.respond({status:200,contentType:'text/javascript',body:'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});'});
        if(req.resourceType()==='image') {
          if(['/instapay.svg','/vodafone.svg','/vrobo.svg'].includes(url.pathname)) {
            const asset=path.resolve(__dirname,'../../../frontend/public',url.pathname.slice(1));
            if(fs.existsSync(asset))return req.respond({status:200,contentType:'image/svg+xml',body:fs.readFileSync(asset)});
          }
          return req.respond({status:200,contentType:'image/png',body:png});
        }
        return req.respond({status:200,contentType:'text/plain',body:''});
      } catch(e) { errors.push(e.message); if(!req.isInterceptResolutionHandled())await reply({message:e.message},500); }
    });
    await page.goto('http://soulia.test/',{waitUntil:'domcontentloaded'});
    console.log('Application loaded');
    await page.evaluate(data=>{
      localStorage.setItem('token','test-token');
      currentUser={_id:'staff-1',name:'Tester',username:'tester',role:'staff',perms:['shopify-orders','shopify-deposit-upload']};
      currentLang='en';currentPage='shopify-orders';_shopifyOrders=data;
      transactions=[];inventoryCache=[];
      qs('#login-page').style.display='none';
      qs('#app').style.display='';
      qs('#splash-screen')?.remove();
    },orders);
    await page.evaluate(()=>{
      settings={r2AccountId:'test-account',r2AccessKeyId:'test-access',r2SecretAccessKeySet:true,r2Bucket:'soulia-local-test',r2Enabled:false};
      _syncR2Card();
    });
    check(await page.$eval('#stg-r2-receipts-card',e=>e.textContent.includes('deposit-receipts/') && !e.querySelector('#btn-upload-r2')),'images section has its own folder and no backup upload control');
    check(await page.$eval('#stg-r2-receipts-bucket',e=>e.textContent==='soulia-local-test'),'images section shows the shared configured bucket');
    await page.evaluate(()=>testR2Connection('receipts'));
    const connectionTest=seen.find(r=>r.path==='/api/settings/r2-config/test');
    check(JSON.parse(connectionTest.body).bucket==='soulia-local-test','images connection test targets the configured shared bucket');
    check(!Object.hasOwn(JSON.parse(connectionTest.body),'secretAccessKey'),'masked secret is never submitted as a credential');
    check(await page.$eval('#r2-receipts-status',e=>e.textContent.includes('Shared connection verified')),'connection result appears in the images section');
    if(process.argv.includes('--receipt-settings-only')) {
      await page.evaluate(()=>{_openR2SharedSettings();_syncR2ReceiptsCard();});
      check(await page.$eval('#stg-r2-receipts-max',e=>e.value==='2000'),'retention setting preserves the current default');
      check(await page.$eval('#stg-r2-receipts-estimate',e=>e.textContent.includes('0.37')),'default maximum storage estimate is 0.37 GB');
      for(const language of ['en','ar']) {
        await page.evaluate(language=>{currentLang=language;qs('#stg-r2-receipts-max').value='40000';_updateR2ReceiptEstimate();},language);
        check(await page.$eval('#stg-r2-receipts-estimate',e=>e.textContent.includes('7.37') && e.textContent.includes('73.7')),'40000 images estimate is 7.37 GB / 73.7 percent in '+language);
      }
      const count=seen.filter(r=>r.path==='/api/settings/r2-config').length;
      await page.evaluate(()=>{qs('#stg-r2-receipts-max').value='0';return saveR2ReceiptPolicy();});
      check(seen.filter(r=>r.path==='/api/settings/r2-config').length===count,'invalid limit cannot be saved');
      await page.evaluate(()=>{qs('#stg-r2-receipts-max').value='50';return saveR2ReceiptPolicy();});
      const saved=seen.findLast(r=>r.path==='/api/settings/r2-config');
      check(saved && saved.body==='{"receiptsMax":50}','small limit saves only receipt retention without touching shared credentials');
      check(await page.evaluate(()=>settings.r2ReceiptsMax===50),'saved small retention limit stays in settings');
      await page.evaluate(()=>{currentLang='en';_syncR2ReceiptsCard();});
      check(await page.$eval('#stg-r2-receipts-max',e=>e.value==='50'),'reloading settings preserves the saved small limit');
      check(errors.length===0,'no browser errors: '+errors.join('; '));
      console.log(JSON.stringify({checks,errors,network:'fully mocked',scope:'receipt storage settings'},null,2));
      return;
    }
    await page.evaluate(()=>{stgSearch('deposit');_openR2SharedSettings();});
    check(await page.evaluate(()=>!qs('#stg-search-results') && qs('#stg-panel-data').classList.contains('active')),'shared settings link exits search and opens the data settings tab');
    check(await page.evaluate(()=>_spDepositOf(_shopifyOrders[0]).deposit===0),'notes and paid tags never become recorded deposits');
    check(await page.evaluate(()=>_spDepositCellHtml(_shopifyOrders[0]).includes('No deposit')),'empty order deposit cell says no deposit');
    await page.evaluate(()=>renderShopifyOrders());
    check(!!await page.$('#shopify-orders-table-body .spdep-quick-add'),'desktop no-deposit cell includes a compact add button');
    check(await page.$$eval('#sp-mobile-list .sp-mobile-deposit',els=>els.some(e=>e.textContent.includes('Add deposit'))),'mobile main action adds a deposit');
    check(await page.$$eval('#sp-mobile-list .sp-mobile-confirm',els=>els.length===1 && !!els[0].closest('.dd-menu')),'mobile confirm action is retained inside the overflow menu');
    check(!await page.$('#sp-mobile-list .sp-confirm-btn[onclick^="approveShopifyOrder"]'),'mobile primary button no longer confirms the order');
    await page.setViewport({width:390,height:844});
    await page.evaluate(()=>{
      currentPage='shopify-orders';qsa('.page').forEach(e=>e.classList.toggle('active',e.id==='page-shopify-orders'));
    });
    await new Promise(resolve=>setTimeout(resolve,350));
    await page.waitForFunction(()=>{const e=qs('#sp-mobile-list .sp-card');return e?.clientWidth>0 && e.scrollWidth<=e.clientWidth+1;},{timeout:3000});
    check(await page.$eval('#sp-mobile-list .sp-card',e=>e.clientWidth>0 && e.scrollWidth<=e.clientWidth+1),'mobile add action fits with Shopify link and assignee');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-mobile-card-add.png')});
    await page.setViewport({width:1440,height:1000});
    check(await page.evaluate(()=>{
      const o=_shopifyOrders[0],old=currentUser;currentUser={...currentUser,perms:['shopify-orders']};
      const restricted=!_spDepositCellHtml(o).includes('spdep-quick-add') && !_spMobileDepositActionHtml(o);
      currentUser=old;return restricted && !_spDepositCellHtml({...o,cancelled:true}).includes('spdep-quick-add');
    }),'deposit shortcuts respect upload permission and cancelled orders');
    await page.$eval('#shopify-orders-table-body .spdep-quick-add',e=>e.click());
    check(!!await page.$('#spdep-file'),'desktop shortcut opens the existing receipt workflow');
    await page.evaluate(()=>_spCancelReceiptForm(qs('#sp-receipt-form .btn-outline')));
    await page.$eval('#sp-mobile-list .sp-mobile-deposit',e=>e.click());
    check(!!await page.$('#spdep-file'),'mobile shortcut opens the same existing receipt workflow');
    await page.evaluate(()=>_spCancelReceiptForm(qs('#sp-receipt-form .btn-outline')));
    await page.evaluate(()=>openSpReceiptForm('order-1'));
    failUpload=true;
    await selectReceipt();
    while(!releaseUpload) await new Promise(resolve=>setTimeout(resolve,25));
    releaseUpload();releaseUpload=null;
    await page.waitForFunction(()=>!qs('#spdep-file').disabled && !qs('#spdep-error').hidden);
    check(await page.$eval('#spdep-error',e=>e.textContent)==='Image analysis failed','XHR upload preserves server error messages');
    check(await page.$eval('#spdep-progress-value',e=>e.hidden) && await page.$eval('#spdep-progress-stage',e=>e.textContent.includes('could not be completed')),'failed upload stops the progress indicator and shows failure');
    check(await page.$eval('#spdep-progress',e=>e.value<100),'failed image analysis never displays 100 percent');
    check(order.depositReceipts.length===0,'failed analysis does not register a deposit');
    failUpload=false;
    await page.evaluate(()=>_spCancelReceiptForm(qs('#sp-receipt-form .btn-outline')));
    await page.evaluate(()=>openSpReceiptForm('order-1'));
    check(!!await page.$('#spdep-file'),'staff upload form opens');
    check(await page.$eval('#sp-receipt-form',e=>e.textContent.includes('Test customer') && e.textContent.includes('2719')),'upload form identifies customer and order');
    check(await page.$eval('#spdep-paste-btn',e=>e.textContent==='Paste photo'),'upload picker has a short paste button');
    check(await page.$eval('.spdep-upload-box',e=>!e.textContent.includes('Ctrl+V') && !e.textContent.includes('automatically compressed')),'upload instructions stay concise');
    await page.evaluate(()=>{
      window.originalReceiptClipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:async()=>[]}});
    });
    await page.click('#spdep-paste-btn');
    await page.waitForFunction(()=>!qs('#spdep-paste-btn').disabled && !qs('#spdep-error').hidden);
    check(await page.$eval('#spdep-error',e=>e.textContent==='No photo in clipboard.'),'empty clipboard shows an actionable error without starting upload');
    await page.setViewport({width:390,height:844});
    await new Promise(resolve=>setTimeout(resolve,350));
    check(await page.$eval('#modal-content',e=>{const r=e.getBoundingClientRect();return r.width===390 && r.bottom<=845 && r.height<844*.6;}),'initial phone sheet is compact and fills the phone width');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-mobile-upload.png')});
    await page.setViewport({width:1440,height:1000});
    check(await page.evaluate(()=>{const dt=new DataTransfer();dt.setData('text/plain','Text paste');const e=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});document.dispatchEvent(e);return !e.defaultPrevented;}),'text paste is not intercepted');
    async function selectReceipt() { return page.evaluate(base64=>{
      const input=qs('#spdep-file'),dt=new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],'receipt.png',{type:'image/png'}));
      const event=new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true});document.dispatchEvent(event);window.lastReceiptPasteAccepted=event.defaultPrevented;
    },png.toString('base64')); }
    await selectReceipt();
    await page.waitForFunction(()=>qs('#spdep-file')?.disabled);
    while(!releaseUpload) await new Promise(resolve=>setTimeout(resolve,25));
    await page.evaluate(()=>{window.cancelUploadDone=_spCancelReceiptForm(qs('#sp-receipt-form .btn-outline'));});
    check(await page.$eval('#sp-receipt-form .btn-outline',e=>e.disabled),'cancel waits safely for the in-flight upload');
    releaseUpload();releaseUpload=null;
    await page.evaluate(()=>window.cancelUploadDone);
    check(order.depositReceipts.length===0,'cancelling during upload withdraws only the new draft');
    check(await page.evaluate(()=>!qs('#modal-overlay').classList.contains('active') && _shopifyOrders[0].depositReceipts.length===0),'cancelled upload cannot reopen the form or remain in the order');
    await page.evaluate(()=>openSpReceiptForm('order-1'));
    await page.evaluate(base64=>{
      window.originalReceiptTransport=_apiUploadWithProgress;
      _apiUploadWithProgress=(url,options,headers)=>{window.receiptProgressCallback=options.onUploadProgress;return window.originalReceiptTransport(url,options,headers);};
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{read:async()=>[{types:['image/png'],getType:async()=>new Blob([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],{type:'image/png'})}]}});
      _spPasteReceiptFromClipboard(qs('#spdep-paste-btn'));
    },png.toString('base64'));
    await page.waitForFunction(()=>qs('#spdep-upload-preview')?.classList.contains('is-scanning') && qs('#spdep-upload-preview img').naturalWidth>0);
    check(await page.$eval('#spdep-progress',e=>e.value<100),'progress never claims completion before the server response');
    check(await page.$eval('.spdep-upload-box',e=>getComputedStyle(e).display==='none'),'file picker is hidden while the centered scan is running');
    check(await page.$eval('#spdep-upload-preview',e=>getComputedStyle(e).flexDirection==='column' && getComputedStyle(e).textAlign==='center'),'scan and preview are centered in the dialog');
    await page.evaluate(()=>{_spReceiptProgress(_spReceiptForm,0,'upload');});
    check(await page.$eval('#spdep-progress-value',e=>!e.hidden && e.textContent==='0%'),'starting a new upload resets to zero');
    await page.evaluate(()=>{window.receiptProgressCallback(.42,'upload');});
    check(await page.$eval('#spdep-progress-value',e=>e.textContent==='42%'),'progress percentage updates with upload bytes');
    await page.evaluate(()=>{window.receiptProgressCallback(1,'analysis');_apiUploadWithProgress=window.originalReceiptTransport;});
    check(await page.$eval('#spdep-progress-stage',e=>e.textContent.includes('Analyzing')),'server analysis is labeled separately from upload');
    check(await page.$eval('#spdep-progress-value',e=>e.hidden && e.textContent==='') && await page.$eval('#spdep-progress',e=>!e.hasAttribute('value')),'analysis shows indeterminate activity instead of a fabricated percentage');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-scan-centered.png')});
    check(await page.$eval('#spdep-file',e=>e.disabled),'upload prevents duplicate clicks while scanning');
    await page.evaluate(()=>_spViewLocalReceipt());
    check(!!await page.$('#spdep-image-overlay img'),'local upload preview can be enlarged during scanning');
    await page.keyboard.press('Escape');
    while(!releaseUpload) await new Promise(resolve=>setTimeout(resolve,25));
    releaseUpload();
    await page.waitForSelector('#spdep-amount');
    await page.waitForFunction(()=>!qs('#spdep-amount').readOnly && qs('#spdep-amount').value==='500');
    check(await page.evaluate(()=>_spReceiptForm.progress===100 && _spReceiptForm.progressStage==='complete'),'receipt completion is recorded only after upload and analysis succeed');
    check(await page.$eval('#spdep-amount',e=>e.value)==='500','OCR suggestion populates amount');
    check(await page.$eval('#spdep-method',e=>e.value)==='Instapay','OCR suggestion populates vault');
    check(await page.$$eval('.spdep-vault-option',els=>els.length===4 && els.filter(e=>e.querySelector('input').checked)[0].textContent.includes('Instapay')),'all four vaults are visible and the OCR suggestion is selected');
    check(!await page.$('select#spdep-method'),'vault selection is not a dropdown');
    await page.click('.spdep-vault-option input[value="كاش"]');
    check(await page.$eval('#spdep-method',e=>e.value)==='كاش','vault tile can override the OCR suggestion');
    await page.click('.spdep-vault-option input[value="Instapay"]');
    check(await page.$eval('.spdep-image-saved',e=>e.textContent.includes('Image uploaded') && e.textContent.includes('not submitted')),'completed upload clearly says the receipt is not submitted yet');
    check(await page.$eval('#spdep-amount',e=>e.classList.contains('is-detected') && e.title.includes('detected automatically')),'automatically entered amount is marked in green');
    check(await page.evaluate(()=>window.lastReceiptPasteAccepted===true),'clipboard image starts the standard upload workflow');
    await page.waitForFunction(()=>qs('#sp-receipt-form .spdep-thumb img').naturalWidth>0);
    check(await page.$eval('.spdep-thumb',e=>e.classList.contains('is-ready')),'saved receipt displays an authenticated thumbnail');
    check(await page.$eval('#spdep-amount',e=>e.getBoundingClientRect().width<=205),'amount input stays compact on desktop');
    check(await page.$eval('#spdep-amount',e=>getComputedStyle(e).textAlign==='center'),'deposit amount is centered in its field');
    check(await page.$eval('#spdep-remaining-value',e=>e.textContent.includes('1,000')),'remaining amount previews the current deposit deduction');
    await page.setViewport({width:390,height:844});
    await new Promise(resolve=>setTimeout(resolve,350));
    check(await page.$eval('#modal-content',e=>{const r=e.getBoundingClientRect();return r.width===390 && r.height>740 && r.height<762 && e.scrollWidth<=e.clientWidth;}),'receipt details expand to ninety percent without horizontal clipping');
    check(await page.$eval('#spdep-amount',e=>getComputedStyle(e).fontSize==='24px'),'phone amount is readable without input zoom');
    check(await page.evaluate(()=>{
      const body=qs('.spdep-form-body'),footer=qs('.spdep-form-footer');
      const before=footer.getBoundingClientRect().top;body.scrollTop=body.scrollHeight;
      return Math.abs(footer.getBoundingClientRect().top-before)<1 && footer.getBoundingClientRect().bottom<=window.innerHeight && getComputedStyle(body).overflowY==='auto';
    }),'phone actions remain visible while the details scroll');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-mobile-details.png')});
    await page.setViewport({width:390,height:460});
    await new Promise(resolve=>setTimeout(resolve,350));
    check(await page.$eval('.spdep-form-footer',e=>e.getBoundingClientRect().bottom<=461),'actions fit the reduced viewport when the keyboard opens');
    await page.setViewport({width:1440,height:1000});
    await page.evaluate(()=>{if(window.originalReceiptClipboard)Object.defineProperty(navigator,'clipboard',window.originalReceiptClipboard);else delete navigator.clipboard;});
    await page.focus('#spdep-amount');
    await page.keyboard.press('End');
    await page.keyboard.type('0');
    check(await page.$eval('#spdep-amount',e=>e.value==='500'),'typing a digit that exceeds the order total preserves the previous amount');
    check(await page.$eval('#spdep-error',e=>!e.hidden && e.textContent.includes('1,500')),'blocked amount explains the allowed maximum');
    await page.evaluate(()=>{qs('#spdep-amount').value='13333';qs('#spdep-amount').dispatchEvent(new Event('input',{bubbles:true}));});
    check(await page.$eval('#spdep-amount',e=>e.value==='500'),'pasting an oversized amount cannot leave it in the field');
    await page.evaluate(()=>{qs('#spdep-amount').value='1500';qs('#spdep-amount').dispatchEvent(new Event('input',{bubbles:true}));});
    check(await page.$eval('#spdep-amount',e=>e.value==='1500'),'an amount exactly equal to the allowance is accepted');
    const requestsBeforeOverAmount=seen.filter(r=>r.path.endsWith('/submit')).length;
    await page.evaluate(()=>{qs('#spdep-amount').value='1500.01';return _spSubmitReceipt({disabled:false});});
    check(seen.filter(r=>r.path.endsWith('/submit')).length===requestsBeforeOverAmount,'oversized submission is rejected locally even if the input handler is bypassed');
    await page.evaluate(()=>{
      const o=_shopifyOrders[0],r=o.depositReceipts[0];r.ocr.amount=2000;
      openSpReceiptForm('order-1',r.id);
    });
    check(await page.$eval('#spdep-amount',e=>e.value==='' && !qs('#spdep-error').hidden),'an OCR amount above the allowance requires manual entry');
    check(await page.$eval('.spdep-reading',e=>e.textContent.includes('2,000')),'the original extracted amount remains visible without silently reducing the transfer');
    await page.evaluate(()=>{
      const o=_shopifyOrders[0],r=o.depositReceipts[0];r.ocr.amount=500;
      o.depositReceipts.push({id:'budget-test',status:'معلق',amount:1000});openSpReceiptForm('order-1',r.id);
      qs('#spdep-amount').value='501';qs('#spdep-amount').dispatchEvent(new Event('input',{bubbles:true}));
    });
    check(await page.$eval('#spdep-amount',e=>e.max==='500' && e.value==='500'),'other pending deposits reduce the allowed amount');
    await page.evaluate(()=>{const o=_shopifyOrders[0];o.depositReceipts=o.depositReceipts.filter(r=>r.id!=='budget-test');openSpReceiptForm('order-1','receipt-1');});
    if(process.argv.includes('--upload-policy-only')) {
      check(await page.$eval('#spdep-vault-missing',e=>e.hidden && getComputedStyle(e).display==='none'),'detected vault hides the missing-vault warning visually');
      await page.evaluate(()=>{
        qs('input[name="spdep-vault"]:checked').checked=false;
        _spDepSyncVaultPill();
      });
      check(await page.$eval('#spdep-vault-missing',e=>!e.hidden && getComputedStyle(e).display!=='none'),'missing-vault warning is visible when no vault is selected');
      await page.$eval('input[name="spdep-vault"][value="فودافون كاش"]',e=>e.closest('label').click());
      check(await page.$eval('#spdep-vault-missing',e=>e.hidden && getComputedStyle(e).display==='none'),'selecting Vodafone Cash removes the missing-vault warning');
      check(await page.$eval('#spdep-method',e=>e.value==='فودافون كاش'),'selected vault stays synchronized with the submitted field');
      check(!await page.$('#spdep-warning-ack'),'recognized receipts need no image warning acknowledgement');
      for(const language of ['en','ar']) {
        for(const code of ['not-transfer','ocr-unavailable']) {
          order.depositReceipts[0].warnings=[{code,orderRef:''}];
          await page.evaluate(({language,code})=>{
            currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
            const r=_shopifyOrders[0].depositReceipts[0];r.warnings=[{code,orderRef:''}];
            openSpReceiptForm('order-1','receipt-1');
            qs('#spdep-confirm-check').checked=true;_spDepSyncConfirm();
          },{language,code});
          await page.waitForFunction(()=>!_spReceiptForm.autofilling);
          check(await page.$eval('#spdep-submit-btn',e=>e.disabled),`warning blocks submission ${language}/${code}`);
          check(await page.$eval('#sp-receipt-form [role=alert]',e=>e.textContent.length>20),`warning is visible ${language}/${code}`);
          await page.$eval('#spdep-warning-ack',e=>e.closest('label').click());
          check(await page.$eval('#spdep-submit-btn',e=>!e.disabled),`explicit skip enables submission ${language}/${code}`);
          await page.setViewport({width:390,height:844});
          check(await page.$eval('#modal-content',e=>e.scrollWidth<=e.clientWidth+1),`warning form fits mobile ${language}/${code}`);
        }
      }
      await page.click('#spdep-submit-btn');
      await page.waitForSelector('#spdep-success');
      for (const language of ['en','ar']) {
        await page.evaluate(language=>{
          currentLang=language;_spReceiptSuccess(_shopifyOrders[0],_shopifyOrders[0].depositReceipts[0]);
          Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedReceiptMessage=text;}}});
        },language);
        check(await page.$eval('#spdep-copy-message',e=>e.getBoundingClientRect().left>e.parentElement.querySelector('label').getBoundingClientRect().left),'copy action is on the physical right in '+language);
        await page.click('#spdep-copy-message');
        await page.waitForSelector('a#spdep-copy-message');
        check(await page.evaluate(()=>window.copiedReceiptMessage===qs('#spdep-customer-message').value),'copy finishes before offering customer contact in '+language);
        check(await page.$eval('#spdep-copy-message',e=>e.href==='https://merchant.vrobo.co/inbox?contact=201000000000&channel=whatsapp' && e.target==='_blank'),'copied message action opens the correct customer in Vrobo in '+language);
        check(await page.$eval('#spdep-copy-message',e=>e.textContent.includes(t('spDepSendMessage'))),'copy action becomes send to customer in '+language);
      }
      check(JSON.parse(seen.findLast(r=>r.path.endsWith('/submit')).body).acknowledgeImageWarning===true,'explicit skip reaches the API');
      check(await page.evaluate(()=>{
        const r=_shopifyOrders[0].depositReceipts[0];r.warningAcknowledgedAt=new Date().toISOString();
        const notice=_spReceiptNoticeHtml(r);
        return notice.includes(t('spDepOcrUnavailable')) && notice.includes(t('spDepWarningSkipped'));
      }),'manager notice retains warning and acknowledgement');
      check(errors.length===0,'no browser errors: '+errors.join('; '));
      console.log(JSON.stringify({checks,errors,network:'fully mocked',scope:'upload protection'},null,2));
      return;
    }
    const submitCount=seen.filter(r=>r.path.endsWith('/submit')).length;
    await page.evaluate(()=>{qs('#spdep-amount').value='';qs('#spdep-amount').dispatchEvent(new Event('input'));return _spSubmitReceipt(qs('#sp-receipt-form .btn-primary'));});
    check(await page.$eval('#spdep-error',e=>e.textContent==='Enter the deposit amount to continue.'),'empty amount has a specific understandable error');
    check(await page.$eval('#spdep-amount',e=>e.getAttribute('aria-invalid')==='true'),'invalid amount field is highlighted');
    check(await page.$eval('#spdep-remaining-value',e=>e.textContent.includes('1,500')),'empty amount shows the unchanged current balance');
    await page.evaluate(()=>{qs('#spdep-amount').value='0.001';return _spSubmitReceipt(qs('#sp-receipt-form .btn-primary'));});
    check(await page.$eval('#spdep-error',e=>e.textContent.includes('two decimal places')),'excess precision has a separate amount validation error');
    await page.evaluate(()=>{qs('#spdep-amount').value='500';qs('#spdep-method').value='';return _spSubmitReceipt(qs('#sp-receipt-form .btn-primary'));});
    check(await page.$eval('#spdep-error',e=>e.textContent==='Select the vault that received the deposit.'),'missing vault has its own validation error');
    check(seen.filter(r=>r.path.endsWith('/submit')).length===submitCount,'invalid entries never reach the receipt submission API');
    await page.evaluate(()=>{qs('#spdep-method').value='Instapay';qs('#spdep-amount').dispatchEvent(new Event('input'));});
    check(await page.$eval('#modal-content',e=>e.getBoundingClientRect().width<=545),'deposit form uses a compact desktop width');
    check(await page.$eval('.spdep-analysis .spdep-thumb',e=>e.getBoundingClientRect().width>=155),'analysis preview is enlarged on desktop');
    check(await page.$eval('.spdep-suggestion',e=>!e.textContent.includes('Suggested')),'analysis uses extracted receipt terminology');
    check(await page.evaluate(()=>getComputedStyle(qs('#sp-receipt-form .spdep-status')).marginInlineStart==='0px'),'receipt status stays beside the amount without an empty gap');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-form-compact-desktop.png')});
    await page.evaluate(()=>{
      const r=_shopifyOrders[0].depositReceipts[0];r.ocr.amount=null;r.ocr.method='';openSpReceiptForm('order-1','receipt-1');
    });
    check(await page.$eval('.spdep-reading.is-unread',e=>e.textContent.includes('could not be detected')),'unread analysis has a highlighted instruction');
    check(await page.$eval('.spdep-reading.is-unread',e=>!e.textContent.includes('Extracted amount:')),'unread result does not have a contradictory extracted-amount prefix');
    await page.evaluate(()=>{qs('#spdep-amount').value='400';qs('#spdep-amount').dispatchEvent(new Event('input'));qs('.spdep-vault-option input[value="كاش"]').click();});
    check(await page.$eval('#spdep-entry-note',e=>!e.hidden && e.textContent==='Amount and vault entered manually'),'manual amount and vault selection show an explicit note');
    check(await page.$eval('#sp-receipt-form .spdep-status',e=>!e.textContent.includes('Draft')),'uploaded receipt is not presented as a saved draft');
    failWithdraw=true;
    await page.evaluate(()=>_spCancelReceiptForm(qs('#sp-receipt-form .btn-outline')));
    check(await page.$eval('#spdep-error',e=>e.textContent)==='Withdrawal failed','failed cancellation stays open with a visible error');
    check(order.depositReceipts.length===1,'failed cancellation preserves the draft for a retry');
    failWithdraw=false;
    await page.evaluate(()=>_spCancelReceiptForm(qs('#sp-receipt-form .btn-outline')));
    check(order.depositReceipts.length===0,'cancel after completed upload withdraws the new draft');
    await page.evaluate(()=>openSpReceiptForm('order-1'));
    releaseUpload=null;
    await selectReceipt();
    while(!releaseUpload) await new Promise(resolve=>setTimeout(resolve,25));
    releaseUpload();releaseUpload=null;
    await page.waitForSelector('#spdep-amount');
    await page.setViewport({width:390,height:844});
    await page.evaluate(()=>{currentLang='ar';document.documentElement.dir='rtl';openSpReceiptForm('order-1');});
    await page.waitForFunction(()=>qs('#sp-receipt-form .spdep-thumb img').naturalWidth>0);
    check(await page.$eval('#modal-content',e=>e.scrollWidth<=e.clientWidth+1),'populated amount and vault form fits mobile');
    await new Promise(resolve=>setTimeout(resolve,350));
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-form-mobile.png')});
    await page.setViewport({width:1440,height:1000});
    await page.evaluate(()=>{currentLang='en';document.documentElement.dir='ltr';});
    check(await page.evaluate(()=>_spDepositOf(_shopifyOrders[0]).deposit===0),'upload does not count as payment');
    await page.evaluate(()=>_spViewReceipt('receipt-1'));
    check(!!await page.$('#spdep-image-overlay img'),'authenticated image viewer opens');
    check(seen.find(r=>r.path.endsWith('/image')).headers.authorization==='Bearer test-token','image fetch uses authorization header');
    await page.keyboard.press('Escape');check(!await page.$('#spdep-image-overlay'),'Escape closes the image');
    check(!!await page.$('#sp-receipt-form'),'Escape from image preserves receipt form');
    failSubmit=true;
    await page.evaluate(()=>_spSubmitReceipt(qs('#sp-receipt-form .btn-primary')));
    check(await page.$eval('#spdep-error',e=>e.textContent)==='Submission failed','submission error is visible');
    check(await page.$eval('#spdep-amount',e=>e.value)==='500','failed submission preserves entered amount');
    failSubmit=false;
    await page.evaluate(()=>_spSubmitReceipt(qs('#sp-receipt-form .btn-primary')));
    check(await page.$eval('#spdep-success',e=>e.textContent.includes('500') && e.textContent.includes('Instapay') && e.textContent.includes('Deposit in review')),'successful submission shows amount, vault and pending review');
    check(await page.$eval('#spdep-success p',e=>!e.textContent.includes('<span') && e.textContent.includes('EGP')),'success amount renders currency text without escaped markup');
    check(await page.$eval('#spdep-customer-message',e=>e.value.includes('#2719') && e.value.includes('500') && e.value.includes('1,000') && e.value.includes('1,500')),'customer message uses the actual order number, total, deposit and remaining');
    check(await page.$eval('#spdep-customer-message',e=>e.value.includes('قيد المراجعة') && !e.value.includes('تأكيد طلبك بنجاح')),'message does not claim pending funds or order are confirmed');
    check(await page.$eval('#spdep-customer-message',e=>e.value.includes('💳 المدفوع:') && e.value.includes('💵 المتبقي:') && !e.value.includes('الدفعة قيد المراجعة:') && !e.value.includes('المتبقي بعد اعتماد الدفعة:')),'customer message uses concise paid and remaining labels');
    check(await page.$eval('.spdep-success-check path',e=>getComputedStyle(e).animationDelay==='0s' && parseFloat(getComputedStyle(e).animationDuration)<=.25),'success check appears promptly without an animation delay');
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedReceiptMessage=text;}}}));
    await page.click('#spdep-copy-message');
    await page.waitForSelector('a#spdep-copy-message');
    check(await page.evaluate(()=>window.copiedReceiptMessage===qs('#spdep-customer-message').value),'copy button copies the exact customer message');
    check(await page.evaluate(()=>{
      const o={..._shopifyOrders[0],ref:'2767',total:1103,status:'approved',depositReceipts:[{amount:500,status:'معتمد',method:'Instapay'}]};
      const message=_spReceiptCustomerMessage(o,o.depositReceipts[0]);
      return message.includes('603') && message.includes('#2767') && message.includes('تأكيد طلبك بنجاح') && !message.includes('قيد المراجعة');
    }),'confirmed order message uses approved payment amounts and confirmation wording');
    check(!!await page.$('#spdep-success .spdep-success-check path'),'success dialog includes an animated checkmark');
    await page.setViewport({width:390,height:844});
    await new Promise(resolve=>setTimeout(resolve,750));
    check(await page.$eval('#modal-content',e=>e.scrollWidth<=e.clientWidth+1),'success dialog fits mobile');
    check(await page.$eval('#modal-content',e=>Math.abs((e.getBoundingClientRect().top+e.getBoundingClientRect().bottom)/2-window.innerHeight/2)<5),'mobile success dialog is centered on the screen');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-success-mobile.png')});
    await page.click('#spdep-success > .btn');
    check(await page.evaluate(()=>!qs('#modal-overlay').classList.contains('active')),'success dialog closes using its button');
    await page.setViewport({width:1440,height:1000});
    await page.evaluate(()=>renderShopifyOrders());
    check(await page.$eval('#sp-mobile-list .sp-mobile-deposit',e=>e.textContent.includes('Add another deposit')),'mobile deposit action allows another deposit after submission');
    await page.setViewport({width:390,height:844});
    await new Promise(resolve=>setTimeout(resolve,350));
    check(await page.$eval('#sp-mobile-list .sp-card',e=>e.clientWidth>0 && e.scrollWidth<=e.clientWidth+1),'pending deposit action and amount fit the mobile card');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-mobile-card-review.png')});
    await page.setViewport({width:1440,height:1000});
    check(!await page.$('#shopify-orders-table-body .spdep-quick-add'),'desktop add shortcut is replaced by the submitted deposit details');
    check(await page.evaluate(()=>_spDepositOf(_shopifyOrders[0]).pendingTotal===500),'pending amount is tracked');
    const deleteCount=seen.filter(r=>r.method==='DELETE').length;
    await page.evaluate(()=>approveShopifyOrder('order-1'));
    await page.waitForSelector('#shopify-confirm-modal.is-open');
    check(await page.$eval('#shopify-confirm-modal',e=>e.querySelectorAll('.spdep-order-summary').length===1 && e.querySelectorAll('.spdep-order-money>div').length===3 && !e.querySelector('#spdep-confirm-receipts .spdep-add')),'confirmation combines totals into one summary and has no add-deposit button');
    check(await page.evaluate(()=>{
      const o={..._shopifyOrders[0],discount:100,codesDiscount:25,manualDiscount:50,discountCode:'TEST'};
      const doc=new DOMParser().parseFromString(_spReceiptSummaryHtml(o),'text/html');
      const rows=[...doc.querySelectorAll('.spdep-discount-row')];
      return rows.length===3 && rows.every((row,i)=>row.querySelector('b').textContent.includes(String([100,25,50][i]))) && doc.querySelectorAll('.spdep-order-money>div').length===3;
    }),'unified confirmation retains each discount type and its own amount');
    await new Promise(resolve=>setTimeout(resolve,300));
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-confirm-unified.png')});
    check(await page.$$eval('#spdep-confirm-receipts .spdep-icon-action',els=>els.length===1 && els.every(e=>e.textContent.trim()==='' && !!e.getAttribute('aria-label'))),'confirmation receipt edit uses one accessible icon button; image itself opens the preview');
    await page.$eval('#spdep-confirm-receipts button[onclick^="openSpReceiptForm"]',e=>e.click());
    await new Promise(resolve=>setTimeout(resolve,400));
    check(await page.evaluate(()=>{
      const m=qs('#modal-content'),box=m.getBoundingClientRect();
      return Number(getComputedStyle(qs('#modal-overlay')).zIndex)>Number(getComputedStyle(qs('#shopify-confirm-modal')).zIndex) && m.contains(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2));
    }),'receipt edit opens visibly above order confirmation');
    await page.evaluate(()=>_spCancelReceiptForm(qs('#sp-receipt-form .btn-outline')));
    check(!!await page.$('#shopify-confirm-modal'),'closing receipt edit preserves order confirmation');
    await page.$eval('#spdep-confirm-receipts .spdep-thumb',e=>e.click());
    await page.waitForSelector('#spdep-image-overlay');
    check(await page.evaluate(()=>Number(getComputedStyle(qs('#spdep-image-overlay')).zIndex)>Number(getComputedStyle(qs('#shopify-confirm-modal')).zIndex)),'image preview opens above order confirmation');
    await page.keyboard.press('Escape');
    await page.evaluate(()=>_spReceiptAction('order-1','receipt-1','withdraw'));
    check(await page.evaluate(()=>Number(getComputedStyle(qs('#modal-overlay')).zIndex)>Number(getComputedStyle(qs('#shopify-confirm-modal')).zIndex)),'receipt decision opens above order confirmation');
    await page.click('#spdep-decision .btn-outline:not(.spdep-action)');
    await page.evaluate(()=>_spdHide(qs('#shopify-confirm-modal')));
    await page.waitForFunction(()=>!qs('#shopify-confirm-modal'));
    await page.evaluate(()=>{openSpReceiptForm('order-1','receipt-1');});
    await page.evaluate(()=>_spCancelReceiptForm(qs('#sp-receipt-form .btn-outline')));
    check(seen.filter(r=>r.method==='DELETE').length===deleteCount && order.depositReceipts[0].status==='معلق','cancelling an existing receipt edit preserves that receipt');
    await page.evaluate(()=>_spReceiptAction('order-1','receipt-1','withdraw'));
    check(await page.$eval('#modal-content',e=>e.getBoundingClientRect().width<=435 && e.textContent.includes('moves no money')),'withdrawal dialog is compact and explains its financial effect');
    await page.click('#spdep-decision .btn-outline:not(.spdep-action)');
    check(seen.filter(r=>r.method==='DELETE').length===deleteCount && order.depositReceipts[0].status==='معلق','cancelling withdrawal preserves the submitted receipt');
    check(await page.evaluate(()=>_spDepositOf(_shopifyOrders[0]).deposit===0),'pending receipt is excluded from paid total');
    check(await page.evaluate(()=>!!_spDepositBlockReason(_shopifyOrders[0])),'pending review blocks confirmation');
    check(await page.evaluate(()=>{const doc=new DOMParser().parseFromString(_spDepositCellHtml(_shopifyOrders[0]),'text/html');return !!doc.querySelector('.spdep-pending') && doc.body.textContent.includes('500') && !doc.body.textContent.includes('Pending');}),'table shows pending amount in yellow without the pending word');
    check(await page.evaluate(()=>_spPeekStatePill(_shopifyOrders[0]).includes('In review')),'order header states receipt review is pending');
    await page.evaluate(()=>renderShopifyOrders());
    check(await page.$$eval('#shopify-orders-table-body td[data-col="deposit"]',els=>els.some(e=>e.textContent.includes('500') && !!e.querySelector('.spdep-pending'))),'Shopify table renders the pending deposit column');
    check(await page.evaluate(()=>SP_COL_W.deposit>=124 && SP_COL_W.deposit<180),'single-deposit column fits its contents without the previous wide gutter');
    check(await page.evaluate(()=>!SP_COLS.some(c=>c.id==='status') && !('status' in SP_COL_W) && !qs('#shopify-orders-table-wrap [data-col="status"]') && !qs('#sp-mobile-list .sp-card-status-inline')),'Shopify status column and mobile badge are removed from layout and column preferences');
    check(await page.$$eval('#sp-mobile-list .sp-card',els=>els.every(e=>e.children[1].classList.contains('sp-card-deposit-line'))),'mobile deposit appears in a fixed row on every order card');
    check(await page.$eval('#shopify-orders-table-body .spdep-table-deposit',e=>{
      const row=e.querySelector('.spdep-vault-amount>span');
      const styles={wrap:getComputedStyle(e).flexWrap,display:getComputedStyle(row).display};
      return styles.wrap==='nowrap' && ['flex','inline-flex'].includes(styles.display);
    }),'deposit amount, vault and status are displayed on a single line');
    const oldHidden=await page.evaluate(()=>{const old=[..._getHiddenSpCols()];const hidden=new Set(old);hidden.add('deposit');_setHiddenSpCols(hidden);applyShopifyColsVisibility();return old;});
    check(await page.$$eval('#shopify-orders-table-body [data-col="deposit"]',els=>els.length>0 && els.every(e=>e.style.display==='none')),'deposit column participates in column visibility preferences');
    check(await page.evaluate(()=>[...qs('#shopify-orders-table-body').querySelectorAll('.sp-day-sep td')].every(td=>td.colSpan===_spVisibleColCount())),'day separators keep the correct span when deposit column is hidden');
    await page.evaluate(old=>{_setHiddenSpCols(new Set(old));applyShopifyColsVisibility();},oldHidden);
    check(await page.evaluate(()=>!_spPeekReceiptsHtml(_shopifyOrders[0]).includes('_spReceiptAction(&quot;order-1&quot;,&quot;receipt-1&quot;,&quot;approve&quot;')),'staff has no approval action');
    await page.evaluate(()=>{currentUser={_id:'admin-1',name:'Admin',role:'admin',perms:[]};switchShopifySubnav('deposits',true);});
    check(await page.$eval('#sp-deposits-tab-content',e=>e.textContent.includes('Test customer')),'admin review queue identifies the order');
    await page.evaluate(()=>{
      window.originalReviewOrders=_shopifyOrders;const o=_shopifyOrders[0],r=o.depositReceipts[0];
      const manual={...o,_id:'order-2',ref:'2720',client:'Manual test customer',depositReceipts:[{...r,id:'receipt-2',amount:400,method:'كاش',ocr:{amount:null,method:''},needsReview:true}]};
      _shopifyOrders=[o,manual,...Array.from({length:4},(_,i)=>({...o,_id:`review-${i}`,ref:String(2721+i),client:`Review test ${i+1}`,depositReceipts:[{...r,id:`review-receipt-${i}`,needsReview:i%2===0,warnings:i===0?[{code:'same-image',orderRef:'2719'}]:[]}]}))];renderSpDepositReview();
    });
    check(await page.$$eval('.spdep-review-card',els=>els.length===6),'pending receipt queue uses individual review cards');
    check(await page.$eval('.spdep-review-grid',e=>getComputedStyle(e).display==='grid' && getComputedStyle(e).gridTemplateColumns.split(' ').length>=2),'desktop review cards use multiple columns');
    check(await page.$eval('.spdep-review-card:nth-child(2)',e=>e.textContent.includes('Amount and vault entered manually') && e.querySelectorAll('.spdep-notice').length===1 && !e.querySelector('.spdep-reading') && !e.querySelector('.spdep-review-notice')),'manual entry and verification warnings are merged into one concise notice');
    check(await page.$eval('.spdep-review-card:nth-child(3)',e=>e.querySelectorAll('.spdep-notice').length===1 && e.textContent.includes('2719') && !!e.querySelector('.spdep-notice.is-duplicate')),'duplicate warning is retained inside the single combined notice');
    check(await page.$$eval('.spdep-review-card',els=>{const firstRow=els.filter(e=>Math.abs(e.offsetTop-els[0].offsetTop)<2);return firstRow.length>=2 && Math.max(...firstRow.map(e=>e.querySelector('.spdep-actions').getBoundingClientRect().top))-Math.min(...firstRow.map(e=>e.querySelector('.spdep-actions').getBoundingClientRect().top))<2;}),'review card action rows stay aligned despite different warning lengths');
    await page.setViewport({width:390,height:844});await new Promise(resolve=>setTimeout(resolve,350));
    check(await page.$eval('.spdep-review-grid',e=>e.scrollWidth<=e.clientWidth+1),'review cards fit the mobile viewport');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-review-cards-mobile.png')});
    await page.setViewport({width:1440,height:1000});await new Promise(resolve=>setTimeout(resolve,350));
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-review-cards-desktop.png')});
    await page.evaluate(()=>{_shopifyOrders=window.originalReviewOrders;renderSpDepositReview();});
    await page.evaluate(()=>_spReceiptAction('order-1','receipt-1','approve'));
    check(await page.$eval('#modal-content',e=>e.getBoundingClientRect().width<=435),'receipt decision dialog uses a compact width');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-decision-compact-desktop.png')});
    await page.click('#spdep-decide');
    await page.waitForFunction(()=>_shopifyOrders[0].depositReceipts[0].status==='معتمد').catch(async error=>{
      console.error(JSON.stringify({seen:seen.map(r=>({path:r.path,method:r.method})),errors,state:await page.evaluate(()=>({orders:_shopifyOrders,error:qs('#spdep-error')?.textContent,decision:!!qs('#spdep-decision')}))},null,2));
      throw error;
    });
    check(await page.evaluate(()=>_spDepositOf(_shopifyOrders[0]).deposit===500),'approved deposit is counted');
    await page.evaluate(()=>renderShopifyOrders());
    check(await page.$eval('#sp-mobile-list .sp-mobile-deposit',e=>e.textContent.includes('Add another deposit')),'mobile action allows another deposit after manager approval');
    check(await page.$eval('#sp-mobile-list .sp-card-deposit-line',e=>!!e.querySelector('.spdep-approved') && !e.querySelector('.spdep-pending')),'approved deposit becomes green in the fixed mobile row');
    check(await page.$$eval('#sp-mobile-list .sp-card-subline',els=>els.every(e=>!/(AM|PM)/.test(e.textContent) && /\d{2}:\d{2}/.test(e.textContent))),'mobile order time uses the same 24-hour format as the table');
    check(await page.evaluate(()=>{const html=_spPeekReceiptsHtml(_shopifyOrders[0],false,false,true);return !html.includes('spdep-add') && !html.includes('&quot;refund&quot;') && html.includes('_spViewReceipt');}),'confirmation retains receipt previews while hiding add and refund actions');
    check(await page.evaluate(()=>{const doc=new DOMParser().parseFromString(_spPeekHtml(_shopifyOrders[0]),'text/html');const cell=doc.querySelector('.sp-pk-pay-cell');return cell.querySelectorAll('.spdep-vault-amount bdi').length===1 && !cell.querySelector(':scope>b');}),'order payment summary displays the approved deposit amount once beside its vault icon');
    await page.evaluate(()=>{
      window.cardOrdersBackup=_shopifyOrders;window.cardTabBackup=_shopifyTab;window.cardSubnavBackup=_spSubnavTab;switchShopifySubnav('orders',true);
      const o=_shopifyOrders[0],r=o.depositReceipts[0];
      _shopifyTab='all';_shopifyOrders=[o,
        {...o,_id:'card-review',ref:'2801',depositReceipts:[{...r,status:'معلق'}]},
        {...o,_id:'card-none',ref:'2802',depositReceipts:[]},
        {...o,_id:'card-confirmed',ref:'2803',status:'approved'}];renderShopifyOrders();
    });
    check(await page.$$eval('#sp-mobile-list .sp-card',els=>els.length===4 && els[0].classList.contains('sp-card-deposit-paid') && els[1].classList.contains('sp-card-deposit-paid') && els[2].classList.contains('sp-card-deposit-none') && getComputedStyle(els[0]).backgroundImage===getComputedStyle(els[1]).backgroundImage && getComputedStyle(els[0]).backgroundImage!==getComputedStyle(els[2]).backgroundImage),'approved and pending deposits share green cards; receipt-free orders use yellow cards');
    check(await page.$$eval('#sp-mobile-list .sp-card',els=>!!els[0].querySelector('.sp-order-confirmation.is-paid') && !!els[1].querySelector('.sp-order-confirmation.is-paid') && !!els[2].querySelector('.sp-order-confirmation.is-waiting')),'green cards have check icons for approved or pending deposits; receipt-free cards have waiting icons');
    await page.setViewport({width:390,height:844});
    await page.$eval('#sp-mobile-list .sp-card .dd-toggle',e=>e.click());
    await page.waitForSelector('.dd-menu-portal.show .sp-mobile-confirm');
    check(await page.$eval('.dd-menu-portal.show .sp-mobile-confirm',e=>{const icon=e.querySelector('svg').getBoundingClientRect();return e.tagName==='BUTTON' && icon.width<=19 && icon.height<=19 && e.getBoundingClientRect().height<55;}),'confirmation menu button has a compact fixed-size icon');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-order-confirm-menu-mobile.png')});
    await page.click('#shopify-search');
    await page.$eval('#sp-mobile-list',e=>e.scrollIntoView());
    await page.$('#sp-mobile-list').then(el=>el.screenshot({path:path.join(os.tmpdir(),'soulia-order-card-colors-mobile.png')}));
    await page.setViewport({width:1440,height:1000});
    await page.evaluate(()=>{_shopifyOrders=window.cardOrdersBackup;_shopifyTab=window.cardTabBackup;renderShopifyOrders();switchShopifySubnav(window.cardSubnavBackup,true);});
    await page.evaluate(()=>_spReceiptAction('order-1','receipt-1','refund'));
    check(await page.$eval('#modal-content',e=>e.getBoundingClientRect().width<=435 && !!e.querySelector('#spdep-reason')),'refund dialog is compact and retains the reason field');
    await page.click('#spdep-decision .btn-outline:not(.spdep-action)');
    check(order.depositReceipts[0].status==='معتمد' && !seen.some(r=>r.path.endsWith('/refund')),'cancelling refund does not change an approved receipt or move money');
    check(await page.evaluate(()=>_spReceiptSummaryHtml(_shopifyOrders[0]).includes('1,000')),'remaining equals total minus approved deposit');
    check(await page.evaluate(()=>!_spDepositBlockReason(_shopifyOrders[0])),'completed approval allows confirmation');
    // All new controls must work in each language/theme and fit the mobile viewport.
    for(const language of ['en','ar']) for(const theme of ['light','dark']) {
      await page.setViewport({width:390,height:844});
      await page.evaluate(({language,theme})=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',theme==='dark');openSpReceiptForm('order-1');}, {language,theme});
      check(await page.$eval('#modal-content',e=>e.scrollWidth<=e.clientWidth+1),`receipt modal fits mobile ${language}/${theme}`);
      await page.evaluate(()=>closeModal());
      await page.evaluate(()=>openSpOrderPeek('order-1'));
      check(await page.$eval('#sp-peek .sp-pk-body',e=>e.scrollWidth<=e.clientWidth+1),`order details fit mobile ${language}/${theme}`);
      check(await page.$eval('#sp-peek .sp-pk-contact',e=>e.classList.contains('is-compact') && [...e.querySelectorAll('a')].every(a=>a.getBoundingClientRect().width<=32)),`contact controls are compact ${language}/${theme}`);
      if(language==='ar' && theme==='light') await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-order-mobile.png')});
      await page.evaluate(()=>closeSpOrderPeek());
    }
    await page.setViewport({width:1440,height:1000});
    await page.evaluate(()=>{
      currentLang='ar';document.documentElement.dir='rtl';document.body.classList.remove('dark-mode');
      openSpReceiptForm('order-1');
    });
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-form-desktop.png')});
    await page.evaluate(()=>closeModal());
    check(await page.evaluate(()=>{
      const source=_spPeekHtml({..._shopifyOrders[0],items:[{name:'Test organizer',code:'C1',qty:1}]});
      const doc=new DOMParser().parseFromString(source,'text/html');
      const body=doc.querySelector('.sp-pk-body');
      const customer=body.querySelector('.sp-pk-cust');
      const items=body.querySelector('.sp-pk-items').closest('section');
      const payment=body.querySelector('.spdep-embedded').parentElement;
      return !!(customer.compareDocumentPosition(items)&Node.DOCUMENT_POSITION_FOLLOWING) && !!(items.compareDocumentPosition(payment)&Node.DOCUMENT_POSITION_FOLLOWING);
    }),'order sections are customer then items then payment with embedded receipts');
    await page.evaluate(()=>currentLang='en');
    check(await page.evaluate(()=>_spDepositCellHtml(_shopifyOrders[0]).includes('Instapay') && _spDepositCellHtml(_shopifyOrders[0]).includes('500')),'approved deposit cell shows amount with vault branding');
    await page.evaluate(()=>{currentLang='en';approveShopifyOrder('order-1');});
    check(!await page.$('#shopify-deposit-inp'),'confirmation cannot override an approved receipt');
    check(await page.$eval('#spdep-confirm-summary',e=>e.textContent.includes('1,000')),'confirmation shows the correct remaining amount');
    check(await page.evaluate(()=>_spInvoiceReceiptsHtml({depositReceipts:_shopifyOrders[0].depositReceipts}).includes('_spViewReceipt')),'invoice receipt snapshot has image access');
    // HTTP 200 success:false must never be counted as a recorded sale.
    const successBody=await page.evaluate(()=>{const o=_shopifyOrders[0];return _spValidateBulkSelection([o._id]).sendable.length;});
    check(successBody===1,'approved order is eligible for bulk confirmation');
    await page.evaluate(async()=>{
      qs('#sp-carrier').value='test-carrier';
      await _confirmApproveShopify('order-1');
    });
    const confirm=seen.find(r=>r.path.endsWith('/orders/order-1/approve'));
    check(!!confirm,'confirmation reaches the backend');
    check(Object.keys(JSON.parse(confirm.body)).join(',')==='carrierCode','confirmation never submits a new deposit or vault override');
    check(await page.evaluate(()=>!!qs('#shopify-approve-btn') && !qs('#shopify-approve-btn').disabled),'success:false leaves confirmation open for review');
    check(await page.evaluate(()=>!_spDepositBlockReason({status:'pending',total:1500,depositReceipts:[]})),'receipt-free order follows the existing optional-deposit rule');
    await page.evaluate(()=>{closeModal();_spdHide(qs('#shopify-confirm-modal'));});
    await new Promise(resolve=>setTimeout(resolve,350));
    await page.evaluate(()=>{
      window.splitTx={_id:'split-test',type:'مبيعات',ref:'2738',client:'Split test customer',phone:'01000000000',shippingCity:'Giza',shippingAddress:'Test address',
        total:2450,itemsTotal:2450,deposit:1300,remaining:1150,payStatus:'معلق',payment:'كاش',depMethod:'فودافون كاش',createdAt:'2026-10-10T00:00:00Z',
        items:[{name:'Test organizer',code:'C1',qty:1,price:2450}],
        deposits:[{id:'one',amount:500,method:'Instapay',source:'deposit-receipt'},{id:'two',amount:800,method:'فودافون كاش',source:'deposit-receipt'}],
        depositReceipts:[{id:'one',amount:500,method:'Instapay',ocrAmount:500,ocrMethod:'Instapay',submittedBy:'Tester'},
          {id:'two',amount:800,method:'فودافون كاش',ocrAmount:800,ocrMethod:'فودافون كاش',submittedBy:'Tester'}]};
      transactions.push(splitTx);window._invoiceViewTxId=splitTx._id;navigateTo('invoice-view');
    });
    check(await page.$$eval('#inv-view-content .spdep-payment-details',els=>els.length===1),'invoice has one receipt accordion inside its payment section');
    check(await page.$$eval('#inv-view-content .spdep-payment-methods>span',els=>els.length===2),'payment summary shows both received vault methods');
    check(await page.$eval('#inv-view-content .spdep-payment-details',e=>!e.open),'receipt details begin collapsed');
    await page.click('#inv-view-content .spdep-payment-details>summary');
    await new Promise(resolve=>setTimeout(resolve,400));
    check(await page.$eval('#inv-view-content .spdep-payment-details',e=>e.open),'payment accordion remains expanded after invoice refresh');
    check(await page.$$eval('#inv-view-content .spdep-payment-receipts .spdep-row',els=>els.length===2 && els.every(e=>e.querySelectorAll('[onclick^="_spViewReceipt"]').length===1)),'expanded receipt details contain two payments with one preview control per receipt');
    check(await page.$eval('#inv-view-content .spdep-payment-details',e=>e.textContent.includes('500') && e.textContent.includes('800')),'expanded payment details show each individual amount');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-invoice-combined.png')});
    await page.evaluate(()=>openEditMovement('split-test'));
    await page.waitForSelector('[data-edit-receipt-vault]');
    await page.click('#edit-tx-meta-toggle');
    await new Promise(resolve=>setTimeout(resolve,400));
    check(await page.$eval('.spdep-edit-payments',e=>e.getBoundingClientRect().width>600 && e.scrollWidth<=e.clientWidth+1),'individual payment editor spans the form width without clipping');
    check(await page.$$eval('[data-edit-receipt-vault]',els=>els.length===2 && els[0].value==='Instapay' && els[1].value==='فودافون كاش'),'invoice editor shows each payment with its receiving vault');
    check(await page.$eval('#edit-tx-deposit',e=>e.readOnly && e.value==='1300'),'receipt-backed total cannot be overwritten from the invoice editor');
    check(!await page.$('#edit-tx-dep-method'),'receipt editor does not collapse different vaults into one selector');
    await page.select('[data-edit-receipt-vault="one"]','كاش');
    check(await page.evaluate(()=>JSON.stringify(_spEditVaultCorrections())===JSON.stringify([{id:'one',method:'كاش'}])),'editing one vault submits only that receipt correction');
    await page.screenshot({path:path.join(os.tmpdir(),'soulia-deposit-invoice-edit-split.png')});
    await page.setViewport({width:390,height:844});
    check(await page.$eval('.spdep-edit-payments',e=>e.scrollWidth<=e.clientWidth+1),'individual payment editor fits the phone viewport');
    await page.setViewport({width:1440,height:1000});
    await page.evaluate(()=>{window.splitSave=saveEditMovement('split-test');});
    await page.waitForSelector('#edit-confirm-ok');
    await page.click('#edit-confirm-ok');
    await page.evaluate(()=>window.splitSave);
    const correctionRequest=seen.find(r=>r.path==='/api/transactions/split-test' && r.method==='PUT');
    check(!!correctionRequest,'invoice vault correction reaches the existing transaction update endpoint');
    const correctionBody=JSON.parse(correctionRequest.body);
    check(JSON.stringify(correctionBody.depositVaultCorrections)===JSON.stringify([{id:'one',method:'كاش'}]) && correctionBody.deposit===1300 && correctionBody.remaining===1150 && !correctionBody.depMethod,'invoice update preserves paid totals and submits each vault correction separately');
    failOrders=true;
    await page.evaluate(()=>loadShopifyOrders());
    check(await page.evaluate(()=>_spReceiptLoadError==='Refresh failed'),'refresh failure is retained explicitly');
    failOrders=false;
    check(seen.filter(r=>r.path.includes('deposit-receipts')).every(r=>r.headers.authorization==='Bearer test-token'),'all receipt API calls are authenticated');
    check(errors.length===0,'no browser errors: '+errors.join('; '));
    console.log(JSON.stringify({checks,errors,network:'fully mocked'},null,2));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
