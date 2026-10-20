const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const puppeteer=require('puppeteer');
const QRCode=require('qrcode');
const publicDir=path.resolve(__dirname,'../../../frontend/public');
const sizes=[{id:'50x25',widthMm:50,heightMm:25,qrMm:17,marginMm:1},{id:'60x40',widthMm:60,heightMm:40,qrMm:25,marginMm:2}];
const units=Array.from({length:24},(_,i)=>{const _id=(1000+i).toString(16).padStart(24,'0');return {_id,barcode:'SU-'+_id.toUpperCase(),productId:'a'.repeat(24),product:{code:'CUSHION-6',name:'Fringe Cushion'},status:'available',warehouseCode:'MAIN',invoiceRef:'88',origin:{kind:'purchase',purchaseTransactionId:'c'.repeat(24)}};});
let packs=[],calls=[];
const previousPack={_id:'9'.repeat(24),barcode:'PK-'+ '9'.repeat(24),quantity:6,state:'sealed',availabilityStatus:'available',product:{name:'Previous pack',code:'CUSHION-6'}};
const html=`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/inventory-units.css"><link rel="stylesheet" href="/inventory-packs.css"><style>body{font:14px Arial;margin:12px}</style></head><body><main id="page-barcodes"></main><script>let currentLang='ar',currentPage='barcodes',currentUser={_id:'${'f'.repeat(24)}'};function hasPerm(){return true}async function api(p,o={}){const r=await fetch('/api'+p,{...o,headers:{'Content-Type':'application/json'}});const d=await r.json();if(!r.ok){let e=new Error(d.message);e.status=r.status;throw e}return d}</script><script src="/inventory-units.js"></script><script src="/inventory-packs.js"></script></body></html>`;
async function main(){
 const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
   if(!url.pathname.startsWith('/api/')){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(publicDir,path.basename(url.pathname))));return;}
   let text='';for await(const chunk of req)text+=chunk;const data=text?JSON.parse(text):null;calls.push({path:url.pathname,data});res.setHeader('Content-Type','application/json');
   if(url.pathname.endsWith('/config'))res.end(JSON.stringify({statuses:['available'],labelSizes:sizes}));
   else if(url.pathname.endsWith('/purchases/receipts'))res.end(JSON.stringify({receipts:[{transactionId:'c'.repeat(24),ref:'88',supplier:'Supplier',date:'2026-10-20',lines:[{lineIndex:0,name:'Fringe Cushion',sku:'CUSHION-6',quantity:24,createdUnits:24,printedUnits:24}]}],total:1}));
   else if(url.pathname==='/api/inventory-units')res.end(JSON.stringify({units,total:units.length,page:1,limit:30,invoiceMatch:url.searchParams.get('q')==='88',products:url.searchParams.get('q')==='88'?[{_id:'a'.repeat(24),name:'Fringe Cushion',code:'CUSHION-6'}]:[]}));
   else if(url.pathname==='/api/inventory-packs'&&req.method==='POST'){
    assert.equal(data.unitIds.length,24);assert.equal(data.piecesPerPack,6);
    packs=Array.from({length:4},(_,i)=>{const _id=(2000+i).toString(16).padStart(24,'0');return {_id,manualCode:'PK-'+String(i+1).padStart(6,'0')+'-'+[8,6,4,2][i],barcode:'PK-'+_id.toUpperCase(),quantity:6,state:'sealed',availabilityStatus:'available',product:{name:'Fringe Cushion',code:'CUSHION-6'}};});res.end(JSON.stringify({packs,singleUnitIds:[]}));
   }else if(url.pathname==='/api/inventory-packs')res.end(JSON.stringify({packs:[previousPack,...packs],total:packs.length+1,page:1}));
   else if(url.pathname.includes('/labels/')){const labels=await Promise.all(packs.filter(p=>data.packIds.includes(p._id)).map(async p=>({unitId:p._id,barcode:p.barcode,isPack:true,quantity:6,invoiceDate:'2026-10-20',manualCode:p.manualCode||p.barcode,productName:p.product.name,sku:p.product.code,printCount:0,svg:await QRCode.toString(p.barcode,{type:'svg',margin:2})})));res.end(JSON.stringify({labels,size:sizes.find(s=>s.id===data.sizeId)}));}
   else{res.statusCode=404;res.end(JSON.stringify({message:'Unknown fixture route'}));}
  }catch(e){res.statusCode=500;res.end(JSON.stringify({message:e.message}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 let browser;
 try{
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage();await page.setViewport({width:1400,height:1000});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.click('#iu-tab-units');
  try{await page.waitForSelector('#iu-units input[data-unit-id]');}catch(error){console.error({errors,calls,body:await page.$eval('body',e=>e.textContent.slice(-3000))});throw error;}
  assert.equal(await page.$eval('.iu-log-invoice',e=>e.textContent),'88');
  assert.equal(await page.$eval('.iu-badge.is-available',e=>getComputedStyle(e,'::before').backgroundColor),'rgb(33, 163, 92)');
  await page.type('#iu-query','88');await page.click('#iu-search');await page.waitForFunction(()=>document.querySelector('.iu-catalog').open);
  assert.match(await page.$eval('#iu-products',e=>e.textContent),/Fringe Cushion/);
  await page.click('#iu-select-page');
  await page.waitForFunction(()=>window.InventoryUnitLabels.selection().ids.length===24);
  assert.equal(await page.$eval('#iu-select-page',e=>e.getAttribute('aria-pressed')),'true');
  await page.click('#iu-select-page');
  await page.waitForFunction(()=>window.InventoryUnitLabels.selection().ids.length===0);
  assert.equal(await page.$$eval('#iu-units [data-unit-id]:checked',els=>els.length),0);
  assert.equal(await page.$eval('#iu-select-page',e=>e.getAttribute('aria-pressed')),'false');
  await page.click('#iu-select-page');await page.waitForFunction(()=>window.InventoryUnitLabels.selection().ids.length===24);
  await page.select('#iu-size','50x25');await page.click('#ip-launch');
  await page.waitForFunction(()=>document.querySelector('#ip-create')&&!document.querySelector('#ip-create').disabled);
  assert.match(await page.$eval('#ip-summary',e=>e.textContent),/24.*4.*6/);
  assert.equal(await page.$eval('#ip-list',e=>e.hidden),true);
  assert.equal(calls.filter(c=>c.path==='/api/inventory-packs'&&!c.data).length,0,'Old packs are not loaded on opening');
  await page.click('#ip-history-toggle');await page.waitForFunction(()=>document.querySelectorAll('#ip-list .ip-row').length===1);
  assert.match(await page.$eval('#ip-list',e=>e.textContent),/Previous pack/);
  await page.click('#ip-history-toggle');await page.waitForFunction(()=>document.querySelector('#ip-list').hidden);
  await page.click('#ip-create');try{await page.waitForFunction(()=>document.querySelectorAll('#ip-preview .iu-label').length===4);}catch(error){console.error(await page.$eval('#ip-message',e=>e.textContent),errors,calls.slice(-4));throw error;}
  await page.waitForFunction(()=>!document.querySelector('#ip-close').disabled);
  const result=await page.evaluate(()=>({error:document.querySelector('#ip-message').dataset.error,text:document.querySelector('#ip-message').textContent,counts:[...document.querySelectorAll('#ip-preview .iu-pack-piece-count')].map(e=>e.textContent),boxes:[...document.querySelectorAll('#ip-preview .iu-label')].map(e=>({w:e.offsetWidth,h:e.offsetHeight,sw:e.scrollWidth,sh:e.scrollHeight})),codes:[...document.querySelectorAll('#ip-preview .iu-label')].map(e=>e.getAttribute('aria-label'))}));
  assert.notEqual(result.error,'true',result.text);assert.equal(new Set(result.codes).size,4);assert.ok(result.counts.every(t=>t.includes('6 PCS')));assert.ok(result.boxes.every(b=>b.sw<=b.w+1&&b.sh<=b.h+1));
  assert.equal(await page.$$eval('#ip-list .ip-row',els=>els.length),4,'Only newly created packs appear after creation');
  assert.doesNotMatch(await page.$eval('#ip-list',e=>e.textContent),/Previous pack/);
  assert.match(await page.$eval('#ip-list',e=>e.textContent),/PK-000001-8/);
  assert.match(await page.$eval('#ip-preview',e=>e.textContent),/PK-000001-8/);
  assert.equal(await page.$eval('#ip-preview .iu-label-invoice-date',e=>e.textContent),'Inv: 20/10/2026');
  assert.equal(await page.$eval('#ip-preview .iu-label-invoice-date',e=>getComputedStyle(e).display),'block');
  assert.equal(await page.$eval('#ip-preview .iu-label-invoice-date',e=>e.previousElementSibling.className),'iu-label-sku');
  await page.click('#ip-history-toggle');await page.waitForFunction(()=>document.querySelectorAll('#ip-list .ip-row').length===5);
  await page.evaluate(()=>{document.querySelector('#ip-list').scrollTop=60;});
  assert.ok(await page.$eval('#ip-list',e=>e.scrollTop>0));
  await page.click('#ip-search-btn');await page.waitForFunction(()=>!document.querySelector('#ip-search-btn').disabled);
  assert.equal(await page.$eval('#ip-list',e=>e.scrollTop),0,'Refreshed pack list starts with a complete first card');
  assert.ok(await page.$eval('#ip-list',e=>e.firstElementChild.getBoundingClientRect().top>=e.getBoundingClientRect().top));
  await page.click('#ip-history-toggle');await page.waitForFunction(()=>document.querySelectorAll('#ip-list .ip-row').length===4);
  await page.evaluate(()=>{document.querySelectorAll('#ip-list [data-pack-id]').forEach(e=>e.checked=true);document.querySelector('#ip-list [data-pack-id]').dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>document.querySelectorAll('#ip-preview .iu-label').length===4&&!document.querySelector('#ip-close').disabled);
  fs.mkdirSync(path.resolve(__dirname,'../../../artifacts'),{recursive:true});await page.screenshot({path:path.resolve(__dirname,'../../../artifacts/inventory-packs-ar.png'),fullPage:true});
  await page.evaluate(()=>{window.printedPackPages=0;const open=window.open.bind(window);window.open=(...args)=>{const popup=open(...args);popup.print=()=>{window.printedPackPages=popup.document.querySelectorAll('.iu-print-sheet').length;};return popup;};});
  await page.evaluate(()=>{currentLang='en';});
  await page.click('#ip-print');await page.waitForFunction(()=>window.printedPackPages===4);
  assert.equal(await page.$eval('#ip-message strong',e=>e.textContent),'All labels sent to print');
  assert.match(await page.$eval('#ip-message',e=>e.textContent),/4/);
  assert.equal(await page.$eval('#ip-message',e=>getComputedStyle(e).color),'rgb(24, 116, 64)');
  assert.ok(await page.$('#ip-message.iu-print-success > svg'));
  assert.equal(calls.filter(c=>c.path==='/api/inventory-packs/labels/requests').length,1);
  await page.setViewport({width:390,height:844});await page.screenshot({path:path.resolve(__dirname,'../../../artifacts/inventory-packs-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.querySelector('.ip-dialog').scrollWidth<=document.querySelector('.ip-dialog').clientWidth+1),true);
  await page.waitForFunction(()=>!document.querySelector('#ip-close').disabled);await page.click('#ip-close');
  await page.evaluate(()=>{document.querySelector('[data-invoice-id]').click();});
  assert.ok(await page.$('.iu-product-status .iu-badge.is-printed > svg'));
  assert.equal(await page.$eval('.iu-product-status .iu-badge.is-printed',e=>getComputedStyle(e).color),'rgb(24, 116, 64)');
  assert.deepEqual(errors,[]);assert.equal(calls.filter(c=>c.path==='/api/inventory-packs'&&c.data).length,1);
  console.log('PASS: real Arabic pack UI, 24 -> 4 x 6, distinct codes, visible quantities, 50x25 labels and mobile layout');
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
