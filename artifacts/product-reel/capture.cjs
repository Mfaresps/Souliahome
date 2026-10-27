const fs=require('fs'),path=require('path');
const puppeteer=require('../../backend/node_modules/puppeteer');
const OUT=__dirname,PUB=path.resolve(__dirname,'../../frontend/public');
fs.mkdirSync(path.join(OUT,'assets'),{recursive:true});
(async()=>{
 const browser=await puppeteer.launch({headless:true,pipe:true});
 const page=await browser.newPage();
 const audit={blocked:0,local:0,errors:[],shots:[]};
 await page.setViewport({width:520,height:900,deviceScaleFactor:2});
 page.on('pageerror',e=>audit.errors.push(e.message));
 await page.setRequestInterception(true);
 page.on('request',r=>{
  const u=new URL(r.url()),f=path.resolve(PUB,u.pathname==='/'?'index.html':u.pathname.slice(1));
  if(u.origin==='http://reel.test'&&f.startsWith(PUB+path.sep)&&fs.existsSync(f)&&fs.statSync(f).isFile()){
   audit.local++; const ext=path.extname(f);return r.respond({status:200,contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2'})[ext]||'application/octet-stream',body:fs.readFileSync(f)});
  }
  audit.blocked++;
  if(r.resourceType()==='script')return r.respond({status:200,contentType:'text/javascript',body:'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});'});
  return r.respond({status:200,contentType:'application/json',body:'[]'});
 });
 await page.goto('http://reel.test/',{waitUntil:'networkidle0'});
 await page.evaluate(()=>{
  currentUser={_id:'demo-admin',name:'Demo workspace',username:'demo',role:'admin',perms:[]};currentLang='en';document.documentElement.lang='en';document.documentElement.dir='ltr';
  qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();onPageEnter=()=>{};
  const date=new Date().toISOString(), names=['Woven tissue box','Riva dining bowl','Glass serving tray','Cotton basket'];
  products=names.map((name,i)=>({_id:'demo-product-'+i,name,code:'DEMO-0'+(i+1),supplier:'Demo supplier',sellPrice:150,buyPrice:100,openingBalance:12-i*3,minStock:4,isActive:true}));
  inventoryCache=products.map(p=>({...p,current:p.openingBalance,totalIn:p.openingBalance,totalOut:0}));
  users=[{_id:'demo-admin',name:'Demo administrator',username:'demo-admin',role:'admin',perms:[],isActive:true},{_id:'demo-agent',name:'Demo specialist',username:'demo-agent',role:'staff',perms:['shopify-orders','complaints'],isActive:true}];
  suppliers=[{_id:'demo-supplier',name:'Demo supplier',phone:'',balance:0}];
  window.demoOrder={_id:'demo-order',ref:'DEMO-1001',client:'Demo customer',phone:'',address:'Demo address',type:'مبيعات',date:date.slice(0,10),createdAt:date,shopifyCreatedAt:date,total:300,deposit:0,remaining:300,payStatus:'معلق',status:'pending',employee:'Demo specialist',assignedTo:'demo-agent',assignedToName:'Demo specialist',shipCo:'Bosta',pickupStatus:'Preparing',pickupRef:'DEMO-PREP',prepCreatedAt:date,prepCreatedBy:'Demo specialist',items:products.slice(0,2).map((p,i)=>({lineId:'demo-line-'+i,productId:p._id,name:p.name,code:p.code,qty:1,price:150,total:150})),notes:'Protect fragile items.',comments:[]};
  transactions=[structuredClone(demoOrder)];_shopifyOrders=[structuredClone(demoOrder)];
  followUps=[{_id:'demo-followup',ticketNo:'DEMO-FU-01',orderRef:'DEMO-1001',clientName:'Demo customer',status:'في انتظار العميل',reason:'عملية تأكيد الطلب',responsibleName:'Demo specialist',createdAt:date,updatedAt:date}];
  expenses=[{_id:'demo-expense',date:date.slice(0,10),description:'Demo packing materials',category:'Packaging',amount:20,status:'معتمد',employee:'Demo specialist',paymentMethod:'Cash'}];
  settings={}; api=async(url)=>{if(url.endsWith('/picking'))return {lines:demoOrder.items.map(i=>({...i,units:[],skippedCount:0}))};if(url==='/transactions/pickup-orders')return _pickupOrders;return [];};
  applyLang();buildSidebar();initMobileNav(); localStorage.setItem(_colsPrefKey(SPK_HIDDEN_KEY),'0'); window.hideAdminTeamWorkspace?.();
  window.reelShow=(id)=>{document.querySelectorAll('.modal-overlay').forEach(e=>e.classList.remove('show'));qsa('.page').forEach(e=>e.classList.toggle('active',e.id==='page-'+id));currentPage=id;window.scrollTo(0,0);qs('#main')?.scrollTo(0,0);};
 });
 await page.addStyleTag({content:'#splash-screen,#toast-container,.version-update-banner{display:none!important}'});
 async function shot(name,fn,selector){
  if(fn)await page.evaluate(fn);await new Promise(r=>setTimeout(r,650));
  let el=selector?await page.$(selector):null;
  if(el){await el.screenshot({path:path.join(OUT,'assets',name+'.png')});}else await page.screenshot({path:path.join(OUT,'assets',name+'.png')});
  const text=await page.evaluate(()=>document.querySelector('.page.active')?.innerText||'');
  audit.shots.push({name,selector,text:text.slice(0,15000)});console.log('Captured '+name);
 }
 await shot('dashboard',()=>{reelShow('dashboard');renderDashWelcome(false);buildDashKpis({}).forEach(k=>revealedStats[k.id]=false);renderDashKpis({});},'#dash-stats');
 await shot('overview',()=>{reelShow('shopify-orders');renderShopifyOrders();},'#sp-kpi');
 await shot('orders',null,'#page-shopify-orders');
 await page.type('#shopify-search','DEMO-1001',{delay:90});
 await shot('order-search',()=>renderShopifyOrders(),'#page-shopify-orders');
 await shot('followup',()=>{reelShow('complaints');renderFollowUps();},'#page-complaints');
 await shot('products',()=>{reelShow('products');renderProducts();},'#page-products');
 await shot('inventory',()=>{reelShow('inventory');renderInventory();},'#page-inventory');
 await shot('preparation',()=>{reelShow('pickup-orders');_pickupOrders=[structuredClone(demoOrder)];_puOrdersLoaded=true;_puLoadPrepGroups(_pickupOrders);openPuCardOrdersModal('DEMO-PREP','prep');},'#pu-card-orders-modal');
 await shot('picking',()=>{if(typeof pwSelectOrder==='function')pwSelectOrder('demo-order');},'#pu-card-orders-modal');
 await shot('shipping',()=>{qs('#pu-card-orders-modal')?.classList.remove('show');qs('#pu-card-orders-modal')?.style.setProperty('display','none');reelShow('movements');transactions=[{...demoOrder,pickupStatus:'Shipped',bostaOrderId:'demo-shipment',bostaTrackingNumber:'DEMO-TRACK',bostaStatus:'OUT_FOR_DELIVERY'}];renderMovements();},'#page-movements');
 await shot('expenses',()=>{reelShow('expenses');renderExpenses();},'#page-expenses');
 await shot('suppliers',()=>{reelShow('suppliers');renderSuppliers();},'#page-suppliers');
 await shot('team',()=>{reelShow('users');renderUsers();},'#page-users');
 await shot('reports',async()=>{reelShow('shopify-orders');qs('#shopify-search').value='';renderShopifyOrders();await _spkOpenReport();},'#spk-rep-prev'); await page.evaluate(()=>closeModal());
 await shot('history',()=>{reelShow('movements');renderMovements();},'#page-movements');
 await shot('closing',()=>{reelShow('dashboard');renderDashWelcome(false);buildDashKpis({}).forEach(k=>revealedStats[k.id]=false);renderDashKpis({});},'#dash-stats');
 fs.copyFileSync(path.join(PUB,'soulia-logo.svg'),path.join(OUT,'assets/logo.svg'));
 fs.writeFileSync(path.join(OUT,'capture-audit.json'),JSON.stringify(audit,null,2));await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
