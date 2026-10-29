const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const puppeteer=require('../backend/node_modules/puppeteer');
const root=path.resolve(__dirname,'../frontend/public'),out=path.join(__dirname,'shared-order-interactions');
fs.mkdirSync(out,{recursive:true});
const user={_id:'preview-user',name:'Preview',role:'admin',perms:[]};
const product={_id:'aaaaaaaaaaaaaaaaaaaaaaaa',code:'SKU-1',name:'Cotton basket',openingBalance:500,price:450};
const orders=Array.from({length:8},(_,i)=>({_id:String(i+1).padStart(24,'0'),ref:String(2983-i),client:i%2?'منى محمد عبد الرحمن':'Reem wael Wael',phone:'01000000000',shopifyCreatedAt:new Date(Date.now()-i*3600000).toISOString(),createdAt:new Date().toISOString(),status:'pending',cancelled:false,shopifyId:String(123456+i),total:i===0?123456.75:2200+i*275,itemsTotal:2200+i*275,shipCost:145,tags:'confirmed',items:[{productId:product._id,code:product.code,name:product.name,qty:2,price:450,total:900}],depositReceipts:[],assignedToName:'Malak Abbas',shipWithoutDeposit:i%3===0,shippingAddress:'Cairo, Egypt',shippingCity:'Cairo',comments:[]}));
const transactions=orders.map((o,i)=>({...o,tags:['confirmed'],type:'مبيعات',date:o.createdAt,employee:'Malak Abbas',payStatus:i%2?'معلق':'مكتمل',deposit:500,remaining:i%2?o.total-500:0,pickupStatus:'Pending',payments:[],deposits:[],total:o.total}));
const before=process.argv.includes('--before'),report=[];
(async()=>{const browser=await puppeteer.launch({headless:true,pipe:true});try{
for(const [lang,width,dark] of (before?[['en',1920,false]]:[['en',1920,false],['ar',1440,false],['ar',390,false]])){
 const page=await browser.newPage();await page.setViewport({width,height:1080});
 await page.evaluateOnNewDocument((user,lang)=>{localStorage.setItem('token','preview-only');localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('soulia_lang_system',lang);localStorage.setItem('soulia_lang_pref',lang);},user,lang);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setRequestInterception(true);
 page.on('request',request=>{
  const url=new URL(request.url());
  if(['fonts.googleapis.com','fonts.gstatic.com'].includes(url.hostname))return request.continue();
  if(url.origin!=='http://localhost:8080'||url.pathname.startsWith('/socket.io/'))return request.abort();
  if(url.pathname.startsWith('/api/')){
   const datasets={'/api/auth/me':user,'/api/settings':{lang},'/api/products':[product],'/api/transactions':transactions,'/api/transactions/inventory':[{...product,current:500,warehouseBalances:{MAIN:500}}],'/api/shopify/orders':orders,'/api/notifications/history':{items:[],unread:0,next:''}};
   return request.respond({contentType:'application/json',body:JSON.stringify(datasets[url.pathname]??[])});
  }
  if(url.pathname==='/config.js')return request.respond({contentType:'text/javascript',body:'window.__ENV__={API_BASE_URL:""};'});
  const relative=url.pathname==='/'?'index.html':url.pathname.slice(1),file=path.resolve(root,relative);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return request.respond({status:404,body:''});
  const body=before&&['index.html','design-system.css'].includes(relative)?execFileSync('git',['show','HEAD:frontend/public/'+relative],{maxBuffer:16*1024*1024}):fs.readFileSync(file);
  return request.respond({contentType:({'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png'}[path.extname(file)]||'application/octet-stream'),body});
 });
 for(const section of ['movements','shopify-orders']){
  await page.goto('http://localhost:8080/#'+section,{waitUntil:'networkidle2'});
  await page.waitForFunction(()=>!document.querySelector('#splash-screen'));
  await page.evaluate(dark=>document.body.classList.toggle('dark-mode',dark),dark);
  await page.evaluate(()=>document.fonts.ready);
  try { await page.waitForFunction(section=>document.querySelector(section==='movements'?'#mov-table tbody tr, #mov-mobile-list > *, #mov-grid-list > *':'#shopify-orders-table-body tbody tr, #sp-mobile-list .sp-card'),{timeout:12000},section); }
  catch(e){console.log({section,errors,state:await page.evaluate(()=>({page:typeof currentPage!=='undefined'?currentPage:null,text:document.body.innerText.slice(-5000)}))});throw e;}
  await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})));});

  if(section==='shopify-orders'){
    await page.evaluate(()=>{if(_spkHidden())_spkToggle();});
    const check=await page.evaluate(()=>{
      const s=_spkStats(_spkPeriod),bins=_spkTrends(s);
      const sum=key=>bins.reduce((n,b)=>n+b[key],0);
      const tile=document.querySelector('.spk-tile');
      return {sums:['received','confirmed','followup','cancelled'].every(k=>sum(k)===s[k]),charts:document.querySelectorAll('.spk-trend').length,radius:getComputedStyle(tile).borderRadius,scroll:document.documentElement.scrollWidth>innerWidth};
    });
    assert(check.sums,'Sparkline buckets must sum to the existing KPI values');assert(check.charts>=4);assert.equal(check.radius,'0px');assert(!check.scroll);
    await page.click('.spk-tile.is-confirmed');
    assert(await page.$eval('.spk-tile.is-confirmed',el=>el.getAttribute('aria-pressed')==='true'));
    await page.click('.spk-tile.is-confirmed');
    await page.evaluate(()=>_spkSetPeriod('week'));
    assert(await page.evaluate(()=>{const s=_spkStats('week');return _spkTrends(s).reduce((n,b)=>n+b.received,0)===s.received}));
    await page.evaluate(()=>_spkSetPeriod('today'));
    await page.click('#spk-period-btn');await page.keyboard.press('Escape');
    assert.equal(await page.$('#spk-period-menu'),null);
  } else if(width>768) {
    assert(await page.$eval('.mov-kpi-stat-val',el=>getComputedStyle(el).display!=='none'),'Totals shown by default');
    await page.click('#mov-kpi-reveal');assert(await page.$eval('.mov-kpi-stat-val',el=>getComputedStyle(el).display==='none'));
    await page.click('#mov-kpi-reveal');
    await page.evaluate(()=>document.body.classList.add('privacy-on'));
    assert(await page.$eval('.mov-kpi-stat-val .amt-num',el=>getComputedStyle(el).color==='rgba(0, 0, 0, 0)'));
    await page.evaluate(()=>document.body.classList.remove('privacy-on'));
  }
  if(section==='shopify-orders' && width>768){
    await page.click('.sp-row-check');assert(await page.$('.sp-row-selected'));
    await page.click('.sp-row-check');assert.equal(await page.$('.sp-row-selected'),null);
    const fit=await page.evaluate(()=>{window.__savedSpCols=[..._getHiddenSpCols()];_setHiddenSpCols(new Set(SP_COLS.map(c=>c.id).filter(c=>!['ref','client','total'].includes(c))));applyShopifyColsVisibility();const table=document.querySelector('#shopify-orders-table-wrap .data-table');return {width:table.getBoundingClientRect().width,available:table.closest('.sp-table-scroll').clientWidth};});
    assert(Math.abs(fit.width-fit.available)<2,JSON.stringify(fit));
    await page.evaluate(()=>{_setHiddenSpCols(new Set(window.__savedSpCols));applyShopifyColsVisibility();});
    await page.click('.sp-items-btn');assert(await page.$('.mov-items-popover'));await page.keyboard.press('Escape');
    await page.click('.sp-ref-link');await page.waitForSelector('.sp-peek-overlay');await page.keyboard.press('Escape');await page.waitForSelector('.sp-peek-overlay',{hidden:true});
    await page.click('#shopify-orders-table-body .dd-toggle');await page.waitForSelector('.dd-menu-portal.show');await page.keyboard.press('Escape');
    const sticky=await page.evaluate(()=>{const sc=document.querySelector('.sp-table-scroll');sc.style.maxHeight='220px';sc.style.minHeight='0';sc.scrollTop=120;return {top:sc.querySelector('th').getBoundingClientRect().top,edge:sc.getBoundingClientRect().top,scroll:sc.scrollTop};});
    assert(sticky.scroll>0);assert(Math.abs(sticky.top-sticky.edge)<2,JSON.stringify(sticky));
    await page.evaluate(()=>{const sc=document.querySelector('.sp-table-scroll');sc.style.maxHeight='';sc.style.minHeight='';sc.scrollTop=0;sc.scrollLeft=0;});
    console.log('Selection, column fitting, items, order details, actions, sticky header passed:',lang,width);
  }
  const metrics=await page.evaluate(section=>{
   const scope=section==='movements'?'#mov-table':'#shopify-orders-table-wrap';
   const read=s=>{const el=document.querySelector(scope+' '+s);if(!el)return null;const c=getComputedStyle(el);return {size:c.fontSize,weight:c.fontWeight,color:c.color,font:c.fontFamily}};
   const money=[...document.querySelectorAll(scope+' td:is([data-col="invoice"],[data-col="paid"],[data-col="remaining"],[data-col="total"],[data-col="ship"])')].filter(el=>el.offsetWidth);
   const faded=[];for(let el=document.querySelector(scope+' td[data-col="client"]');el;el=el.parentElement){if(getComputedStyle(el).opacity!=='1')faded.push({id:el.id,cls:el.className,opacity:getComputedStyle(el).opacity});}
   return {faded,pickup:read('.pu-badge'),overflow:document.documentElement.scrollWidth>innerWidth,body:read('td[data-col="client"]'),name:read('.mov-client-name,.sp-client-name'),header:read('th[data-col="client"]'),date:read('.ds-time,.sp-ref-time'),badge:read('.badge,.sp-tag'),amount:read('.amt-num'),moneyClipped:money.filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>({col:el.dataset.col,text:el.textContent,width:el.clientWidth,scroll:el.scrollWidth})),rows:document.querySelectorAll(scope+' tbody tr').length,inter:document.fonts.check('14px Inter')};
  },section);
  const name=`${before?'before':'after'}-${section}-${lang}-${width}${dark?'-dark':''}`;
  report.push({label:name,...metrics});await page.screenshot({path:path.join(out,name+'.png')});
  if(!before){assert(!metrics.overflow,name+' page overflow');assert.deepEqual(metrics.moneyClipped,[],name+' clipped money');if(width===1920){assert.equal(metrics.name?.size,'14px',name+' name size');assert.equal(metrics.header?.size,'13px',name+' header size');}}
  if(section==='movements' && width===1920){
   const sparse=await page.evaluate(()=>{_setHiddenMovCols(new Set(['type','items','status','discount','tag']));applyMovColsVisibility();const client=document.querySelector('#mov-table th[data-col="client"]');return {clientWidth:client.getBoundingClientRect().width,tableWidth:document.querySelector('#mov-table').getBoundingClientRect().width};});
   report.push({label:name+'-hidden-columns',...sparse});
   
   await page.screenshot({path:path.join(out,name+'-hidden-columns.png')});
  }
 }
 assert.deepEqual(errors,[]);await page.close();
}
fs.writeFileSync(path.join(out,(before?'before':'after')+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
