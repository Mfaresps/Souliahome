const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('node:assert/strict'),puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'../../../frontend/public');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!m[1].includes('src=')&&!m[1].includes('application/'))new vm.Script(m[2]);
const script=fs.readFileSync(path.join(root,'deposit-history.js'),'utf8');new vm.Script(script);
const actualFmtJ=html.match(/function fmtJ\(n\) \{[\s\S]*?\r?\n\}/)[0];
(async()=>{
 const browser=await puppeteer.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.goto('http://localhost:8080/config.js'); // Same-origin URL allows history state changes.
  await page.setContent('<html lang="ar" dir="rtl"><body><div id="sp-deposit-log-content"></div></body></html>');
  await page.addStyleTag({content:html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1]});
  await page.addStyleTag({content:fs.readFileSync(path.join(root,'deposit-history.css'),'utf8')});
  await page.addStyleTag({content:fs.readFileSync(path.join(root,'deposit-transfer.css'),'utf8')});
  await page.addScriptTag({content:`
    const qs=s=>document.querySelector(s), isAdmin=()=>true;let currentLang='ar',_spSubnavTab='deposit-log';
    const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const fmtN=n=>Number(n).toLocaleString('en-US'),fmtMoneyN=fmtN,_payMethodLabel=String,_spReceiptStatus=String,t=String,payMethodIcon=()=>'';
    ${actualFmtJ}
    const openModal=html=>{document.querySelector('#test-modal')?.remove();const m=document.createElement('div');m.id='test-modal';m.innerHTML=html;document.body.appendChild(m);},closeModal=()=>document.querySelector('#test-modal')?.remove();
    window.requests=[];window.waiting=[];window.api=async url=>{requests.push(url);return new Promise((resolve,reject)=>waiting.push({resolve,reject}));};
    const switchShopifySubnav=()=>{},openSpOrderPeek=()=>{},openOrderView=()=>{},_spViewReceipt=()=>{};
    const _shopifyOrders=[],transactions=[];
    const historyApi=window.api;window.imageRequests=0;
    window.api=async(url,options)=>{if(url.endsWith('/image')){imageRequests++;const canvas=document.createElement('canvas');canvas.width=canvas.height=2;canvas.getContext('2d').fillRect(0,0,2,2);return new Promise(resolve=>canvas.toBlob(resolve));}return historyApi(url,options);};
    ${script}
  `});
  const result=(name='Customer')=>({page:1,pages:2,total:26,summary:{totalAmount:1250,pending:1,approved:25},rows:[{id:'r1',source:'shopify',orderId:'o1',orderNumber:'2771',client:name,status:'معتمد',amount:500,method:'فودافون كاش',submittedAt:'2026-10-11T22:00:00Z',submittedBy:'Employee',reviewedBy:'Manager',senderPhone:'01021646494',senderHandle:'sender@instapay',imageDeleted:false}]});
  await page.evaluate(()=>renderSpDepositHistory());
  const initial=result('<img src=x onerror=alert(1)>');initial.rows[0].screenshotTime='09:06';initial.rows[0].screenshotTimeSource='screen-status-bar';
  initial.rows[0].id='deposit:6ac6c24f3d012e5b41a1fd3b:dep-1791410764603';initial.summary.totalAmount=490678;
  await page.evaluate(data=>waiting.shift().resolve(data),initial);
  await page.waitForSelector('.dep-log-table tbody tr');
  assert((await page.$eval('#dep-log-summary',e=>e.textContent)).includes('490,678'));
  assert(!(await page.$eval('#dep-log-summary',e=>e.textContent)).includes('<span'),'KPI does not show HTML markup');
  assert((await page.$eval('.dep-log-reference',e=>e.textContent)).length<20,'Compact transfer ID');
  assert.equal(await page.$eval('.dep-log-money',e=>(e.textContent.match(/EGP/g)||[]).length),1,'One currency label');
  for(const width of [1440,1024]){
    await page.setViewport({width,height:900});
    assert(await page.$eval('#dep-log-summary',e=>e.getBoundingClientRect().height<110),'Compact KPI height');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No desktop page overflow');
  }
  await page.click('.dep-log-reference');await page.waitForSelector('.dep-transfer');
  await page.waitForFunction(()=>document.querySelector('.dep-transfer-image img')?.naturalWidth>0);
  assert.equal(await page.evaluate(()=>imageRequests),1,'View details loads the receipt image directly');
  assert((await page.$eval('.dep-transfer',e=>e.textContent)).includes('sender@instapay'));
  assert((await page.$eval('.dep-transfer',e=>e.textContent)).includes('01021646494'));
  assert((await page.$eval('.dep-screen-time-panel',e=>e.textContent)).includes('09:06'));
  assert((await page.$eval('.dep-transfer-fields',e=>e.textContent)).includes(initial.rows[0].id),'Full transfer ID remains available');
  assert.equal(await page.$eval('.dep-log-table thead tr',e=>e.children.length),9);
  await page.evaluate(()=>closeModal());
  await page.evaluate(()=>{window.originalRow=document.querySelector('.dep-log-table tbody tr');for(let i=0;i<50;i++)_depLogBackgroundRefresh();});
  await page.waitForFunction(()=>waiting.length===1);
  assert.equal(await page.evaluate(()=>waiting.length),1,'Background notifications coalesce into one request');
  assert.equal(await page.$eval('#dep-log-progress',e=>e.hidden),true,'Background refresh is silent');
  await page.evaluate(data=>waiting.shift().resolve(data),initial);
  await page.waitForFunction(()=>_depLogRequests.size===0);
  assert(await page.evaluate(()=>originalRow===document.querySelector('.dep-log-table tbody tr')),'Unchanged data keeps existing table DOM');
  assert.equal(await page.$eval('.dep-log-table tbody',e=>e.querySelectorAll('img').length),0,'Escape stored customer data');
  await page.click('[data-period="yesterday"]');
  assert((await page.evaluate(()=>requests.at(-1))).includes('period=yesterday'));
  await page.evaluate(data=>waiting.shift().resolve(data),result());
  await page.evaluate(()=>{_depLogFilter('sender','sender@instapay',true);_depLogFilter('min','500',true);});
  await page.waitForFunction(()=>waiting.length===1);
  const url=await page.evaluate(()=>requests.at(-1));assert(url.includes('sender=sender%40instapay')&&url.includes('min=500'));
  // An old request cannot overwrite the newly selected filter result.
  await page.evaluate(()=>_depLogFilter('status','معلق'));
  await page.evaluate(data=>waiting[1].resolve(data),result('Latest'));
  await page.evaluate(data=>waiting[0].resolve(data),result('Old'));
  await page.waitForFunction(()=>document.querySelector('#dep-log-results').textContent.includes('Latest'));
  assert(!(await page.$eval('#dep-log-results',e=>e.textContent)).includes('Old'));
  await page.setViewport({width:390,height:844});
  assert.equal(await page.$eval('.dep-log-table thead',e=>getComputedStyle(e).display),'none');
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal mobile page overflow');
  await page.click('.dep-log-reference');
  assert(await page.$eval('.dep-transfer',e=>e.scrollWidth<=e.clientWidth),'No horizontal transfer detail overflow');
  await page.evaluate(()=>closeModal());
  await page.evaluate(()=>{history.replaceState(null,'','#shopify-orders/deposits/log?period=custom&from=2026-10-01&to=2026-10-11&method=Instapay');renderSpDepositHistory(true);});
  assert.equal(await page.$eval('#dep-log-from',e=>e.value),'2026-10-01');
  assert.equal(await page.$eval('#dep-log-method',e=>e.value),'Instapay');
  console.log('PASS: history rendering, filters, permalink, stale requests, escaped data and mobile layout');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
