/* Shipped page markup with delayed/failed fixture APIs; no live requests or writes. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const assert=require('node:assert/strict'),puppeteer=require('puppeteer');
const pub=path.resolve(__dirname,'../../../frontend/public');
const html=fs.readFileSync(path.join(pub,'index.html'),'utf8');
const out=process.env.LOADING_SCREENSHOT_DIR||path.join(os.tmpdir(),'soulia-content-loading');
fs.mkdirSync(out,{recursive:true});
for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi))if(match[1].trim())new vm.Script(match[1]);
(async()=>{
 const browser=await puppeteer.launch({headless:true,pipe:true});
 try{
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request',req=>{
   const u=new URL(req.url()),local=path.join(pub,u.pathname.slice(1));
   if(u.origin==='http://soulia.test'&&u.pathname==='/')return req.respond({status:200,contentType:'text/html',body:html});
   if(u.origin==='http://soulia.test'&&(u.pathname.endsWith('.css')||['/admin-team-home.js','/sales-overview.js','/shopify-kpis.js','/shopify-edit-approvals.js','/navigation-shell.js','/order-status.js','/designme/date-range-picker/soulia-range.js'].includes(u.pathname))&&fs.existsSync(local))return req.respond({status:200,contentType:u.pathname.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(local)});
   if(req.resourceType()==='script')return req.respond({status:200,contentType:'text/javascript',body:'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});'});
   return req.respond({status:200,contentType:'application/json',body:'[]'});
  });
  await page.goto('http://soulia.test/',{waitUntil:'domcontentloaded'});
  await page.evaluate(()=>{
   currentUser={_id:'loading-admin',name:'Admin',role:'admin',perms:[]};currentPage='dashboard';
   localStorage.setItem(_colsPrefKey(SPK_HIDDEN_KEY),'0');
   qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();
   buildSidebar=()=>{};buildNotifications=()=>{};loadDashboardTreasury=()=>{};_renderStaffDashboard=()=>{};
   window.pending={};window.hold=true;window.fail=false;
   window.dashboardStatsRequests=0;window.overviewRequests=0;window.teamRequests=0;
   const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
   const month=day.slice(0,7),daysInMonth=new Date(Number(month.slice(0,4)),Number(month.slice(5,7)),0).getDate();
   window.overviewData={month,timeZone:'Africa/Cairo',totalOrders:21,totalRevenue:4200,confirmedOrders:18,averageOrderValue:233,today:day,
    days:Array.from({length:daysInMonth},(_,i)=>({date:month+'-'+String(i+1).padStart(2,'0'),orders:i<Number(day.slice(8))?i%5+1:0,confirmedOrders:0,revenue:i<Number(day.slice(8))?500:0}))};
   window.teamData={periodLabel:'October 2026',totals:{pending:14,followUps:17,issues:3},employees:[{id:'employee-a',name:'Malak Abbas',active:true,pending:14,followUps:17,issues:3,points:104,delivered:0}]};
   window.detailData={orders:[{id:'order-a',ref:'2929',client:'Mona',status:'pending',assignedAt:new Date().toISOString()}],followUps:[]};
   window.orderData=[{_id:'order-a',ref:'2929',client:'Mona',phone:'01000000000',status:'pending',total:500,items:[{name:'Product',qty:1,price:500}],createdAt:new Date().toISOString()}];
   api=async url=>{
    const key=url.split('?')[0];let value;
    if(key==='/transactions/dashboard'){dashboardStatsRequests++;throw new Error('duplicate dashboard summary requested');}
    if(key==='/transactions/sales-overview'){
     overviewRequests++;
     const params=new URLSearchParams(url.split('?')[1]||'');
     const selected=`${params.get('year')}-${String(params.get('month')).padStart(2,'0')}`;
     const length=new Date(Number(selected.slice(0,4)),Number(selected.slice(5,7)),0).getDate();
     value=selected===overviewData.month?overviewData:{...overviewData,month:selected,today:null,totalOrders:length,confirmedOrders:length,totalRevenue:length*100,averageOrderValue:100,days:Array.from({length},(_,i)=>({date:selected+'-'+String(i+1).padStart(2,'0'),orders:1,confirmedOrders:1,revenue:100}))};
    }
    else if(key==='/employee-performance/team-workspace'){teamRequests++;value=teamData;}
    else if(key.startsWith('/employee-performance/team-workspace/'))value=detailData;
    else if(key==='/shopify/orders')value=orderData;
    else return [];
    if(fail)throw new Error('Fixture network unavailable');
    return hold?new Promise((resolve,reject)=>{(pending[key]||=[]).push({resolve:()=>resolve(structuredClone(value)),reject});}):structuredClone(value);
   };
   window.release=key=>{(pending[key]||[]).splice(0).forEach(p=>p.resolve());};
   window.showPage=name=>{currentPage=name;qsa('.page').forEach(e=>e.classList.toggle('active',e.id==='page-'+name));};
  });
  for(const lang of ['ar','en'])for(const width of [1980,1440,390,320]){
   await page.setViewport({width,height:1000});
   await new Promise(resolve=>setTimeout(resolve,300));
   const first=lang==='ar'&&width===1980;
   await page.evaluate(({lang,first,width})=>{
    currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',width===320);
    showPage('dashboard');hold=first;fail=false;window.dashboardTask=loadDashboard();
   },{lang,first,width});
   assert.equal(await page.$('#dash-stats'),null,'old KPI grid is absent');
   assert.equal(await page.$eval('#dash-sales-overview',el=>getComputedStyle(el).display!=='none'),true,'sales overview is visible');
   assert.equal(await page.$eval('#dash-admin-team',el=>getComputedStyle(el).display!=='none'),true,'team oversight is restored below sales');
   if(first){
    assert.equal(await page.$$eval('#so-metrics .so-skeleton',els=>els.length),4,'initial loading reserves four metric positions');
    await page.screenshot({path:path.join(out,'home-sales-loading-ar-1980.png')});
    await page.evaluate(()=>release('/transactions/sales-overview'));
   }
   await page.evaluate(async()=>await dashboardTask);
   assert.equal(await page.$$eval('#so-metrics .so-metric',els=>els.length),4);
   assert(await page.$eval('#so-chart-canvas',el=>el.querySelectorAll('.so-point').length>0),'daily chart has points');
   assert(await page.$eval('#page-dashboard',e=>e.scrollWidth<=e.clientWidth+1),`home overflow ${lang}/${width}`);
   if(width===1440||width===390)await page.screenshot({path:path.join(out,`home-sales-ready-${lang}-${width}.png`)});
   assert.equal(await page.evaluate(()=>teamRequests),1,'team oversight loads once without blocking sales');
   await page.evaluate(()=>{hold=true;window.dashboardTask=loadDashboard();});
   await page.evaluate(async()=>await dashboardTask);
   assert.equal(await page.evaluate(()=>overviewRequests),1,'recent month is reused without another request');
   await page.evaluate(()=>{showPage('shopify-orders');_shopifyOrders=[];_spOrdersLoaded=false;_spkState='ready';_spkFilter='';window.shopTask=loadShopifyOrders();});
   await page.waitForSelector('#sp-orders-loading:not([hidden])');
   assert(await page.$eval('#sp-orders-loading',e=>e.getBoundingClientRect().top>=document.getElementById('sp-kpi').getBoundingClientRect().bottom),'summary stays above orders while loading');
   assert.equal(await page.$$eval('#sp-kpi .spk-lbl',els=>els.length),5);
   assert.equal(await page.$$eval('#sp-kpi .spk-tile:disabled',els=>els.length),5,'unknown metrics cannot apply filters');
   assert(await page.$eval('#page-shopify-orders',e=>e.scrollWidth<=e.clientWidth+1),`Shopify overflow ${lang}/${width}`);
   const loadingTop=await page.$eval('#sp-orders-loading',e=>e.getBoundingClientRect().top);
  const loadingColumns=await page.evaluate(()=>qs('#sp-orders-tab-content').dataset.layout==='table'
    ? [...document.querySelectorAll('.sp-orders-loading-table thead th')].map(el=>({id:el.dataset.col||'check',left:el.getBoundingClientRect().left,width:el.getBoundingClientRect().width}))
    : null);
  const loadingRows=loadingColumns?await page.evaluate(()=>({
   header:document.querySelector('.sp-orders-loading-table thead tr').getBoundingClientRect().height,
   day:document.querySelector('.sp-orders-loading-table .sp-loading-day').getBoundingClientRect().height,
   order:document.querySelector('.sp-orders-loading-table tbody tr:not(.sp-loading-day)').getBoundingClientRect().height,
  })):null;
   await page.screenshot({path:path.join(out,`shopify-loading-${lang}-${width}.png`)});
   await page.evaluate(async()=>{release('/shopify/orders');await shopTask;});
   assert.equal(await page.$eval('#sp-orders-loading',e=>e.hidden),true);
   const realTop=await page.evaluate(()=>{const table=qs('#sp-orders-tab-content').dataset.layout==='table';return qs(table?'#shopify-orders-table-wrap':'#sp-mobile-list').getBoundingClientRect().top;});
   assert(Math.abs(realTop-loadingTop)<=12,`orders stay below summary ${lang}/${width}: ${loadingTop}/${realTop}`);
  if(loadingColumns){
   const realColumns=await page.evaluate(()=>[...document.querySelectorAll('#shopify-orders-table-wrap .data-table thead th')].filter(el=>getComputedStyle(el).display!=='none').map(el=>({id:el.dataset.col||'check',left:el.getBoundingClientRect().left,width:el.getBoundingClientRect().width})));
   const realRows=await page.evaluate(()=>({
    header:document.querySelector('#shopify-orders-table-wrap .data-table thead tr').getBoundingClientRect().height,
    day:document.querySelector('#shopify-orders-table-wrap .sp-day-sep').getBoundingClientRect().height,
    order:document.querySelector('#shopify-orders-table-wrap .data-table tbody tr:not(.sp-day-sep)').getBoundingClientRect().height,
   }));
   assert.deepEqual(realColumns.map(col=>col.id),loadingColumns.map(col=>col.id),`same visible columns ${lang}/${width}`);
   for(let i=0;i<realColumns.length;i++){
    assert(Math.abs(realColumns[i].left-loadingColumns[i].left)<=2,`column ${realColumns[i].id} moves ${lang}/${width}: ${loadingColumns[i].left} -> ${realColumns[i].left}`);
    assert(Math.abs(realColumns[i].width-loadingColumns[i].width)<=2,`column ${realColumns[i].id} changes width ${lang}/${width}: ${loadingColumns[i].width} -> ${realColumns[i].width}`);
   }
   for(const row of ['header','day','order'])assert(Math.abs(realRows[row]-loadingRows[row])<=2,`${row} changes height ${lang}/${width}: ${loadingRows[row]} -> ${realRows[row]}`);
  }
   await page.evaluate(()=>{window.shopTask=loadShopifyOrders();});
   assert.equal(await page.$eval('#sp-orders-loading',e=>e.hidden),true,'Shopify refresh retains loaded orders');
   await page.evaluate(async()=>{release('/shopify/orders');await shopTask;});
  }
  await page.evaluate(async()=>{showPage('shopify-orders');_shopifyOrders=[];_spOrdersLoaded=false;hold=false;fail=true;await loadShopifyOrders();});
  assert(await page.$('#sp-orders-loading[data-state=error] button'),'first-load failure offers retry');
  await page.evaluate(async()=>{fail=false;await loadShopifyOrders();});
  assert.equal(await page.$eval('#sp-orders-loading',e=>e.hidden),true);
  await page.setViewport({width:1440,height:1000});
  await page.evaluate(()=>{_spEnsureOrdersLayout();renderShopifyOrders();});
  await page.evaluate(()=>{_setHiddenSpCols(new Set(['client','items']));_spShowOrdersLoading();});
  assert.equal(await page.$('.sp-orders-loading-table th[data-col=client]'),null,'loading follows hidden columns');
  await page.evaluate(()=>toggleSpCol('client'));
  assert(await page.$('.sp-orders-loading-table th[data-col=client]'),'column changes also update an in-flight placeholder');
  assert(await page.evaluate(()=>{
   const expected=_spVisibleMinWidth()+'px';
   return document.querySelector('.sp-orders-loading-table table').style.minWidth===expected
    && document.querySelector('#shopify-orders-table-wrap .data-table').style.minWidth===expected;
  }),'loaded and loading widths follow the same visible-column total');
  await page.evaluate(()=>{localStorage.setItem(_colsPrefKey(SPK_HIDDEN_KEY),'1');_spkRender('loading');});
  assert.equal(await page.$eval('#sp-kpi',e=>e.hidden),true,'loading respects hidden summary preference');
  await page.evaluate(()=>{
   currentLang='en';document.documentElement.dir='ltr';document.body.classList.remove('dark-mode');showPage('shopify-orders');
   _shopifyOrders=[{...orderData[0],client:'Alexandria Customer With Several Family Names',phone:'01000000000',
    items:Array.from({length:9},(_,i)=>({name:`Product ${i+1}`,qty:1,price:50})),
    notes:'Call before delivery. Use the side entrance if the main gate is closed.',tags:'priority, repeat customer, delivery'}];
   renderShopifyOrders();
  });
  assert(await page.$eval('#shopify-orders-table-wrap td[data-col="action"]',cell=>{
   const r=cell.getBoundingClientRect(),buttons=[...cell.querySelectorAll('.sp-act-row button')];
   return buttons.length>0&&buttons.every(button=>{const b=button.getBoundingClientRect();return b.left>=r.left-1&&b.right<=r.right+1;});
  }),'action buttons fit the fixed column with richer order content');
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  assert.equal(await page.$eval('.sp-loading-bar',e=>getComputedStyle(e).animationName),'none');
  await page.evaluate(async()=>{showPage('dashboard');currentUser={_id:'staff',role:'staff',perms:['dashboard']};renderDashWelcome(false);window.salesOverview.hide();hideAdminTeamWorkspace();});
  assert.equal(await page.$eval('#dash-sales-overview',el=>getComputedStyle(el).display),'none','staff keeps the operational dashboard');
  assert.equal(await page.evaluate(()=>dashboardStatsRequests),0,'dashboard never loads duplicate financial summary');
  assert.deepEqual(errors,[],'no runtime errors');
  console.log('PASS loading pages: Arabic/English, 1980/1440/390/320px, dark mode, stable Shopify columns and rows, four metric sales overview, rich actions, retained refresh content, failures/retry, hidden columns and reduced motion.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1);});
