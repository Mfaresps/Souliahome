const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'../../..');
const html=fs.readFileSync(path.join(root,'frontend/public/index.html'),'utf8').replace(/\r\n/g,'\n');
for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!match[1].includes('src=')&&!match[1].includes('application/'))new vm.Script(match[2]);
const fn=name=>{const start=html.indexOf(`function ${name}(`);return html.slice(start,html.indexOf('\n}',start)+2);};
const output=path.join(root,'artifacts/deposit-decision');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await puppeteer.launch({headless:true});
 const deadline=setTimeout(()=>{console.error('Browser verification exceeded 45 seconds');void browser.close();},45000);
 try{
  const page=await browser.newPage();
  page.setDefaultTimeout(10000);
  const appStyles=[...html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map(m=>m[0]).join('\n');
  await page.setContent(`<html dir="rtl"><head>${appStyles}</head><body><button id="toggle" onclick="_spToggleShipWithoutDeposit('o1')">شحن بدون عربون</button><div id="host"></div></body></html>`);
  await page.addStyleTag({path:path.join(root,'frontend/public/deposit-decision.css')});
  await page.addScriptTag({content:`
   let currentLang='ar';let order={_id:'o1',ref:'100',status:'pending',depositDecisionRevision:0};
   let _shopifyOrders=[order],transactions=[],currentAuditData=null;const _spShippingSwitchBusy=new Set();
   const _spOrderById=()=>order,_spCanChooseShipping=()=>true,_spRefreshOrderRow=()=>{},renderAuditTable=()=>{},hasPerm=()=>true;
   const showConfirm=async()=>true,t=x=>x,esc=String;window.messages=[];const toast=(...args)=>messages.push(args);window.requests=[];
   const options={reasons:[{code:'no-payment-method',ar:'لا تتوفر للعميل وسيلة دفع أو تحويل',en:'No payment method'},{code:'first-order-trust',ar:'أول تعامل ويحتاج الاطمئنان قبل الدفع',en:'First-order concern'},{code:'prefers-cod',ar:'يفضل الدفع عند الاستلام',en:'Prefers COD'},{code:'transfer-problem',ar:'مشكلة مؤقتة في التحويل أو حد التحويل',en:'Transfer problem'},{code:'not-requested',ar:'لم يُطلب مقدم من العميل — استثناء من المتجر',en:'Store exception'},{code:'other',ar:'سبب آخر',en:'Other'}],exceptions:[{code:'staff-discretion',ar:'استثناء ضمن صلاحياتي',en:'Within my authority'},{code:'manager-exception',ar:'بتوجيه الإدارة',en:'Management direction'}]};
   const api=async(url,init)=>{
    if(url.endsWith('deposit-decision-options'))return options;
    if(url.includes('deposit-decision-report'))return {month:'2026-11',asOf:new Date().toISOString(),totalOrders:2,recordedReasons:1,noObjectionRecorded:1,groups:[{label:'يفضل الدفع عند الاستلام',orders:1,enabled:1,confirmedWithoutDeposit:1,shipped:1,delivered:1,returned:0,cancelled:0,inProgress:0,pending:0,paidLater:0,deliveryRate:100}],rows:[{ref:'100',reasonCode:'prefers-cod',reason:'يفضل الدفع عند الاستلام',note:'<img src=x onerror=alert(1)>',exception:'استثناء',delivered:true}]};
    const payload=JSON.parse(init.body);requests.push(payload);
    if(window.failSave)throw Error('Simulated server failure');
    return {orderId:'o1',ref:'100',shipWithoutDeposit:payload.enabled??order.shipWithoutDeposit??false,shipWithoutDepositAt:new Date().toISOString(),depositDecisionRevision:order.depositDecisionRevision+1,depositDecision:{reasonCode:payload.reasonCode,note:payload.note,exceptionCode:payload.exceptionCode},depositDecisionHistory:[]};
   };
   ${fn('_spApplyShippingChoice')}
   async ${fn('_spToggleShipWithoutDeposit')}
  `});
  await page.addScriptTag({path:path.join(root,'frontend/public/deposit-decision.js')});
  await page.addScriptTag({content:html.slice(html.indexOf('function _fieldValue('),html.indexOf('// Initial draft load from server'))});
  console.log('Checking required fields and cancellation');
  await page.click('#toggle');await page.waitForSelector('dialog[open]');
  assert.equal(await page.$eval('#dd-reason',e=>e.value),'');assert.equal(await page.$eval('#dd-exception',e=>e.value),'');
  assert.equal(await page.$$eval('.dd-editor .is-invalid',els=>els.length),0);
  assert.equal(await page.evaluate(()=>document.activeElement.tagName),'H3');
  await page.focus('#dd-reason-trigger');await page.keyboard.press('Tab');
  assert.equal(await page.$$eval('.dd-editor .is-invalid',els=>els.length),0,'no red validation before submitting');
  await page.click('[type=submit]');assert.equal(await page.evaluate(()=>requests.length),0);
  assert.equal(await page.$eval('#dd-reason-trigger',e=>e.getAttribute('aria-invalid')),'true');
  await page.click('#dd-reason-trigger');await page.waitForSelector('#dd-reason-list:popover-open');
  assert.equal(await page.$$eval('#dd-reason-list [role=option]',els=>els.length),6);
  await page.keyboard.press('Escape');assert.equal(await page.$eval('dialog',e=>e.open),true);assert.equal(await page.$eval('#dd-reason-trigger',e=>e.getAttribute('aria-expanded')),'false');
  await page.keyboard.press('ArrowDown');await page.keyboard.press('End');await page.keyboard.press('Enter');
  assert.equal(await page.$eval('#dd-reason',e=>e.value),'other');
  assert.equal(await page.$eval('#dd-reason-trigger',e=>e.hasAttribute('aria-invalid')),false);
  await page.select('#dd-reason','other');await page.select('#dd-exception','staff-discretion');await page.click('[type=submit]');assert.equal(await page.evaluate(()=>requests.length),0);
  await page.click('[data-close]');assert.equal(await page.evaluate(()=>!!order.shipWithoutDeposit),false);
  console.log('Checking responsive dialogs');
  for(const [width,height] of [[1440,900],[390,844],[320,568],[844,390]]){
   await page.setViewport({width,height});await page.click('#toggle');await page.waitForSelector('dialog[open]');
   const bounds=await page.$eval('dialog',e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,overflow:e.scrollWidth>e.clientWidth+1};});assert(bounds.left>=0&&bounds.right<=width);assert.equal(bounds.overflow,false);
   assert(Math.abs((bounds.left+bounds.right)/2-width/2)<=1,'horizontal centering under application reset');
   assert(Math.abs((bounds.top+bounds.bottom)/2-height/2)<=1,'vertical centering under application reset');
   assert(bounds.top>=10&&bounds.bottom<=height-10,'dialog fits short screens');
   assert.equal(await page.$$eval('.dd-editor .is-invalid',els=>els.length),0);
   await page.screenshot({path:path.join(output,`dialog-empty-${width}.png`)});
   await page.click('#dd-reason-trigger');await page.waitForSelector('#dd-reason-list:popover-open');
   const popup=await page.$eval('#dd-reason-list',e=>{const r=e.getBoundingClientRect(),trigger=document.querySelector('#dd-reason-trigger').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,triggerBottom:trigger.bottom,triggerRight:trigger.right};});
   assert(popup.left>=10&&popup.right<=width-10&&popup.top>=10&&popup.bottom<=height-10,'custom dropdown stays inside viewport');
   if(height>=800){assert(popup.top>=popup.triggerBottom+5,'dropdown opens below the field when there is room');assert(popup.right-popup.left<=480,'dropdown stays compact');assert(Math.abs(popup.right-popup.triggerRight)<=1,'RTL dropdown aligns with the field end');}
   await page.screenshot({path:path.join(output,`dropdown-${width}.png`)});
   await page.click('#dd-reason-list [data-value="prefers-cod"]');
   assert.equal(await page.$eval('#dd-reason',e=>e.value),'prefers-cod');
   await page.click('#dd-reason-trigger');assert.equal(await page.$eval('#dd-reason-list [data-value="prefers-cod"]',e=>e.getAttribute('aria-selected')),'true');
   await page.keyboard.press('Escape');
   await page.select('#dd-reason','prefers-cod');await page.select('#dd-exception','manager-exception');await page.type('#dd-exception-note','Manager approved after reviewing history');
   const frame=await page.$eval('dialog',e=>{const r=e.getBoundingClientRect(),footer=e.querySelector('.dd-actions').getBoundingClientRect();return {top:r.top,bottom:r.bottom,footerTop:footer.top,footerBottom:footer.bottom,scroll:e.querySelector('.dd-form-scroll').scrollHeight>e.querySelector('.dd-form-scroll').clientHeight};});
   assert(Math.abs((frame.top+frame.bottom)/2-height/2)<=1,'expanded form remains centered');
   assert(frame.footerTop>=frame.top&&frame.footerBottom<=height-10,'actions stay visible');
   if(height<500)assert(frame.scroll,'only form body scrolls in landscape');
   await page.screenshot({path:path.join(output,`dialog-${width}.png`)});await page.click('[data-close]');
  }
  await page.setViewport({width:390,height:844});
  await page.click('#toggle');await page.waitForSelector('dialog[open]');
  await page.select('#dd-reason','other');await page.select('#dd-exception','manager-exception');
  await page.setViewport({width:320,height:480});
  assert.equal(await page.$$eval('.dd-note-wrap[open]',els=>els.length),2);
  const fullForm=await page.$eval('dialog[open]',e=>{const r=e.getBoundingClientRect(),f=e.querySelector('.dd-actions').getBoundingClientRect();return {center:(r.top+r.bottom)/2,footer:f.bottom,scroll:e.querySelector('.dd-form-scroll').scrollHeight>e.querySelector('.dd-form-scroll').clientHeight};});
  assert(Math.abs(fullForm.center-240)<=1);assert(fullForm.footer<=468);assert(fullForm.scroll);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog'));
  assert.equal(await page.evaluate(()=>document.body.style.overflow),'','restores background scrolling on Escape');
  await page.setViewport({width:390,height:844});
  console.log('Checking saves and server failure');
  await page.click('#toggle');await page.waitForSelector('dialog[open]');await page.select('#dd-reason','prefers-cod');await page.select('#dd-exception','staff-discretion');
  await page.click('[type=submit]');await page.waitForFunction(()=>order.shipWithoutDeposit===true);
  assert.equal(await page.evaluate(()=>requests.at(-1).reasonCode),'prefers-cod');assert.equal(await page.evaluate(()=>order.depositDecisionRevision),1);
  await page.click('#toggle');await page.waitForFunction(()=>order.shipWithoutDeposit===false);
  await page.evaluate(()=>{window.failSave=true;});await page.click('#toggle');await page.waitForSelector('dialog[open]');await page.select('#dd-reason','prefers-cod');await page.select('#dd-exception','staff-discretion');await page.click('[type=submit]');
  await page.waitForFunction(()=>messages.some(m=>m[0].includes('Simulated')));assert.equal(await page.evaluate(()=>order.shipWithoutDeposit),false);
  await page.evaluate(()=>{window.failSave=false;});
  console.log('Checking objection-only dialog');
  await page.evaluate(()=>{void openDepositObjectionForRef('100');});await page.waitForSelector('dialog[open]');
  await page.waitForFunction(()=>document.querySelector('dialog[open] form')&&!document.querySelector('dialog[open] #dd-exception'));
  assert.equal(await page.$('dialog[open] #dd-exception'),null);await page.select('dialog[open] #dd-reason','prefers-cod');await page.click('dialog[open] [type=submit]');await page.waitForFunction(()=>order.depositDecisionRevision===3);assert.equal(await page.evaluate(()=>order.shipWithoutDeposit),false);
  await page.waitForFunction(()=>!document.querySelector('dialog'));
  // A newer socket decision cannot silently change the revision of an already open form.
  console.log('Checking stale form revision');
  await page.evaluate(()=>{window.pendingDecision=_spAskDepositDecision(order);});await page.waitForSelector('dialog[open]');
  await page.evaluate(()=>{order.depositDecisionRevision=99;});await page.select('dialog[open] #dd-reason','prefers-cod');await page.select('dialog[open] #dd-exception','staff-discretion');await page.click('dialog[open] [type=submit]');
  assert.equal(await page.evaluate(async()=> (await pendingDecision).revision),3);
  console.log('Checking report');
  await page.setViewport({width:1440,height:1000});await page.evaluate(()=>openDepositDecisionReport());await page.waitForSelector('.dd-report table');
  assert.equal(await page.$('.dd-report img'),null);await page.screenshot({path:path.join(output,'monthly-report.png')});
  await page.setViewport({width:390,height:900});assert(await page.$eval('.dd-report',e=>e.getBoundingClientRect().width<=390));
  await page.addStyleTag({path:path.join(root,'frontend/public/window-system.css')});
  assert.equal(await page.evaluate(()=>{const card=document.createElement('div');card.id='sp-peek';card.innerHTML=`<div class="sp-pk-decision-card">${depositDecisionSummaryHtml({...order,depositDecision:{reasonCode:'prefers-cod'}},true)}</div>`;document.body.appendChild(card);const size=getComputedStyle(card.querySelector('.dd-info-button--quiet')).fontSize;card.remove();return size;}),'11px','decision history label uses the smaller size');
  console.log('PASS: custom dropdown click/keyboard/selection/validation and viewport bounds; centered responsive dialogs, sticky actions, Escape/scroll restoration, saving and error recovery.');
 }finally{clearTimeout(deadline);await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
