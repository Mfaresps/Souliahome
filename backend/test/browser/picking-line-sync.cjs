const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),puppeteer=require('puppeteer');
const html=fs.readFileSync(path.resolve(__dirname,'../../../frontend/public/index.html'),'utf8');
const setup=html.slice(html.indexOf('const _pwBarcodePickStates ='),html.indexOf('function _pwScanFocus('));
const intro=html.slice(html.indexOf('function _pwScanIntroHtml('),html.indexOf('function _pwScanGuidanceHtml('));
const indicators=html.slice(html.indexOf('function _pwPieceIndicatorsHtml('),html.indexOf('function _pwNormalizePickBarcode('));
const row=html.slice(html.indexOf('function _pwUnitScanHtml('),html.indexOf('async function pwSkipDamagedLabel('));
const select=html.slice(html.indexOf('function pwSelectOrder('),html.indexOf('/** Back to the list',html.indexOf('function pwSelectOrder(')));
(async()=>{const browser=await puppeteer.launch({headless:true});try{
 const page=await browser.newPage();await page.setRequestInterception(true);page.on('request',request=>request.respond({status:200,contentType:'text/html',body:'<div id="pw-work"></div>'}));await page.goto('http://localhost/picking-line-sync-test');
 await page.addScriptTag({content:`
 window.currentLang='en';window._pwSelId='order-1';window._pucoColType='prep';window.esc=v=>String(v);window.fmtN=String;
 window.qs=s=>document.querySelector(s);window.qsa=s=>[...document.querySelectorAll(s)];
 window.requests=[];window.fail=false;window.saved=0;window.renderCount=0;
 const old={_id:'order-1',items:[{code:'A',qty:6},{code:'B',qty:1}]};
 window._pickupOrders=[structuredClone(old)];window.transactions=[structuredClone(old)];window._puPrepGroups=[{orders:[structuredClone(old)]}];
 window._pucoGetGroup=()=>_puPrepGroups[0];window._puSavePrepGroups=()=>saved++;
 window.api=async(url,options)=>{requests.push({url,body:options?JSON.parse(options.body):null});await new Promise(resolve=>setTimeout(resolve,10));
 if(options){if(fail)throw Error('Temporary identification failure');return {items:[{code:'A',qty:6,lineId:'line-a'},{code:'B',qty:1,lineId:'line-b'}]};}
 return {prepChecked:false,lines:[{lineId:'line-a',productId:'a',qty:6,units:Array.from({length:window.checkedByOrder?.[url.split('/')[3]]||0},(_,i)=>({status:'picking',barcode:'SU-DEMO-'+i}))},{lineId:'line-b',productId:'b',qty:1,units:[]}]};};
 ${setup}${intro}${indicators}${row}${select}
 window.stateFor=id=>_pwPickState(id);window.identify=order=>_pwEnsurePickLines(order);
 window._pwRenderWork=()=>{renderCount++;if(renderCount>100)throw Error('Identification retry loop');const order=_pucoGetGroup().orders.find(order=>order._id===_pwSelId),state=_pwPickState(order._id);
 if(order.items.some(item=>!item.lineId))_pwEnsurePickLines(order);else if(!state.summary&&!state.loading&&!state.identifying)_pwLoadPickSummary(order._id);
 document.querySelector('#pw-work').innerHTML=_pwScanIntroHtml(order,state)+order.items.map(item=>item.lineId?_pwUnitScanHtml(order,item,state):'').join('');};
 _pwRenderWork();
 `});
 await page.waitForFunction(()=>document.querySelectorAll('.pw-unit-scan-row input:not(:disabled)').length===2);
 assert.deepEqual(await page.evaluate(()=>[_pickupOrders[0],transactions[0],_puPrepGroups[0].orders[0]].map(order=>order.items.map(item=>item.lineId))),[['line-a','line-b'],['line-a','line-b'],['line-a','line-b']]);
 assert.equal(await page.evaluate(()=>requests.filter(r=>r.body).length),1);
 const firstKey=await page.evaluate(()=>requests.find(r=>r.body).body.operationKey);
 await page.evaluate(()=>{const state=stateFor('order-1');state.summary=null;_puPrepGroups[0].orders[0].items.forEach(item=>delete item.lineId);_pwRenderWork();});
 await page.waitForFunction(()=>requests.filter(r=>r.body).length===2&&document.querySelectorAll('.pw-unit-scan-row input:not(:disabled)').length===2);
 assert.notEqual(await page.evaluate(()=>requests.filter(r=>r.body).at(-1).body.operationKey),firstKey);
 await page.evaluate(()=>{const state=stateFor('order-1');state.summary=null;state.attempted=false;fail=true;_puPrepGroups[0].orders[0].items.forEach(item=>delete item.lineId);_pwRenderWork();});
 await page.waitForSelector('.pw-scan-feedback button');
 assert.equal(await page.$eval('#pw-order-scan',e=>e.disabled),true);
 assert.equal(await page.evaluate(()=>requests.filter(r=>r.body).length),3);
 await page.evaluate(()=>{fail=false;});await page.click('.pw-scan-feedback button');
 await page.waitForFunction(()=>document.querySelectorAll('.pw-unit-scan-row input:not(:disabled)').length===2);
 assert.equal(await page.$eval('#pw-order-scan',e=>e.disabled),false);
 await page.evaluate(()=>{
   checkedByOrder={'order-1':1};
   for(const id of ['order-2','order-3']){
     const order=structuredClone(_pickupOrders[0]);order._id=id;if(id==='order-2')order.items.forEach(item=>delete item.lineId);
     _pickupOrders.push(structuredClone(order));transactions.push(structuredClone(order));_puPrepGroups[0].orders.push(order);
   }
   Object.assign(stateFor('order-2'),{attempted:true,identifyAttempted:true,summary:null});
   pwSelectOrder('order-2');
 });
 await page.waitForFunction(()=>document.querySelectorAll('.pw-unit-scan-row input:not(:disabled)').length===2&&document.querySelector('[id^="pw-scan-order-2-"]'));
 assert.equal(await page.$$('.pw-piece-dots .matched').then(rows=>rows.length),0);
 assert.ok(await page.evaluate(()=>requests.some(row=>row.url.includes('/orders/order-2/identify-lines'))));
 await page.evaluate(()=>{pwSelectOrder('order-3');pwSelectOrder('order-1');});
 await page.waitForFunction(()=>document.querySelector('[id^="pw-scan-order-1-"]:not(:disabled)'));
 assert.equal(await page.$$('.pw-piece-dots .matched').then(rows=>rows.length),1);
 assert.equal(await page.$$('[id^="pw-scan-order-3-"]').then(rows=>rows.length),0,'Late response cannot render the wrong order');
 for(const id of ['order-3','order-2','order-1']){
   await page.evaluate(id=>pwSelectOrder(id),id);
   await page.waitForFunction(id=>!!document.querySelector('[id^="pw-scan-'+id+'-"]:not(:disabled)'),{},id);
   assert.equal(await page.$$('.pw-unit-scan-row input:not(:disabled)').then(rows=>rows.length),2);
 }
 assert.equal(await page.evaluate(()=>stateFor('order-2').summary.lines[0].units.length),0,'Order progress stays separate');
 console.log('PASS: old order lines sync across all cached copies, scan controls appear, new attempts avoid stale replay, failed initialization can retry.');
 }finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
