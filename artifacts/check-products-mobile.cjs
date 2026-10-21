const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const puppeteer=require('../backend/node_modules/puppeteer'),express=require('../frontend/node_modules/express');
const html=fs.readFileSync('frontend/public/index.html','utf8');
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!m[1].includes('src=')&&!m[1].includes('application/'))new vm.Script(m[2]);
(async()=>{
 const app=express();app.get('/config.js',(req,res)=>res.type('js').send('window.__ENV__={API_BASE_URL:""};'));app.use(express.static(path.resolve('frontend/public')));
 const server=app.listen(8089);let browser;
 try{
  browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewport({width:390,height:844,hasTouch:true});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>{document.startViewTransition=undefined;localStorage.setItem('token','trail-preview');localStorage.setItem('soulia-push-prompt:preview','dismissed');localStorage.setItem('user',JSON.stringify({_id:'preview',name:'Fares',username:'preview',role:'admin',perms:[]}));});
  await page.setRequestInterception(true);page.on('request',request=>{
   const url=new URL(request.url());
   if(url.origin!=='http://localhost:8089')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:''});
   if(url.pathname.startsWith('/api/')){
    const data=url.pathname==='/api/auth/me'?{_id:'preview',name:'Fares',username:'preview',role:'admin',perms:[]}:url.pathname==='/api/settings'?{lang:'en'}:url.pathname==='/api/notifications'||url.pathname==='/api/notifications/preferences'?{preferences:{enabled:false},devices:0,configured:false,language:'en',categories:[]}:url.pathname.includes('branding')?{logos:[],selection:{}}:[];
    return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
   }request.continue();
  });
  await page.goto('http://localhost:8089/#shopify-orders',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.spCompactHeader&&!document.querySelector('#splash-screen'));

  await page.evaluate(()=>{products=Array.from({length:18},(_,i)=>({_id:'mobile-product-'+i,name:i%2?'????? ????? ???? ???? ???? ????? ????':'Alba Soft cushions Mint green extra large',code:'CUS-45-MINT-'+i,sellPrice:180+i,openingBalance:i%3===0?0:i%3===1?2:84,minStock:5,category:'Cushions',collection:'Summer',material:'Cotton',isActive:true}));inventoryCache=[];document.querySelectorAll('.page.active').forEach(e=>e.classList.remove('active'));document.querySelector('#page-products').classList.add('active');currentPage='products';setProdViewMode('grid');renderProducts();});
  for(const width of [320,390,500,768,1440])for(const lang of ['en','ar'])for(const dark of [false,true]){
   await page.setViewport({width,height:844,hasTouch:true});await page.evaluate(({lang,dark})=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',dark);applyLang();setProdViewMode(window.innerWidth>768?'table':'grid');window.scrollTo(0,0);renderProducts();},{lang,dark});
   const r=await page.evaluate(()=>{const p=document.querySelector('#page-products'),h=p.querySelector('.prod-sticky-head'),t=p.querySelector('#prod-toolbar'),g=p.querySelector('#prod-grid-view'),first=g.querySelector('.prod-grid-card');return {overflow:document.documentElement.scrollWidth>innerWidth||p.scrollWidth>p.clientWidth+1,position:getComputedStyle(h).position,titleTop:p.querySelector('.page-title').getBoundingClientRect().top,pageTop:p.getBoundingClientRect().top,columns:getComputedStyle(g).gridTemplateColumns.split(' ').length,gridTop:g.getBoundingClientRect().top,filterBottom:t.getBoundingClientRect().bottom,cardOverflow:first.scrollWidth>first.clientWidth+1};});
   if(r.overflow){console.log(await page.evaluate(()=>[...document.querySelectorAll('#page-products *')].filter(e=>{const r=e.getBoundingClientRect();return r.width&& (r.right>innerWidth||r.left<0)}).slice(0,18).map(e=>({tag:e.tagName,id:e.id,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right,display:getComputedStyle(e).display}))));await page.screenshot({path:'artifacts/products-mobile-debug.png'});}assert(!r.overflow,JSON.stringify({width,lang,dark,r}));
   if(width<=768){assert.equal(r.position,'static');assert(r.titleTop-r.pageTop<45,JSON.stringify(r));assert.equal(r.columns,2);assert(r.gridTop>=r.filterBottom-1);assert(!r.cardOverflow);await page.evaluate(()=>window.scrollTo(0,400));assert(await page.$eval('.prod-sticky-head',e=>e.getBoundingClientRect().bottom<400),'Filters scroll away without covering products');}
   if(width===390&&!dark){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'artifacts/products-mobile-'+lang+'.png'});}
  }
  await page.setViewport({width:390,height:844,hasTouch:true});await page.evaluate(()=>{document.body.classList.remove('dark-mode');window.scrollTo(0,0);setProdViewMode('grid');});
  await page.$eval('#prod-toolbar [data-status="ok"]',e=>e.click());assert.equal(await page.$$eval('#prod-grid-view .prod-grid-card',els=>els.length),6,'Available filter remains functional');
  await page.$eval('#prod-toolbar [data-status="all"]',e=>e.click());
  await page.type('#prod-search','CUS-45-MINT-17');await page.waitForFunction(()=>document.querySelectorAll('#prod-grid-view .prod-grid-card').length===1);await page.$eval('.pgc-check input',e=>e.click());assert(await page.$eval('#prod-bulk-bar',e=>getComputedStyle(e).display!=='none'));
  await page.$eval('#prod-sort-btn',e=>e.click());assert(await page.$eval('#prod-sort-menu',e=>e.classList.contains('show')&&e.getBoundingClientRect().right<=innerWidth&&e.getBoundingClientRect().left>=0));await page.evaluate(()=>_closeAllFxSortMenus());
  await page.$eval('#prod-quick-category-btn',e=>e.click());assert(await page.$eval('#prod-quick-category-menu',e=>e.classList.contains('show')&&e.getBoundingClientRect().width>0));await page.evaluate(()=>_closeAllFxSortMenus());
  await page.$eval('#prod-filter-btn',e=>e.click());assert(await page.$eval('#fx-drawer',e=>e.classList.contains('show')));
  assert.deepEqual(errors,[]);console.log('PASS: Products at 5 widths, RTL/LTR, light/dark; no page/card overflow; mobile filters do not cover cards; title spacing; two-column cards; availability/search/bulk selection/filter actions.');
 }finally{await browser?.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
