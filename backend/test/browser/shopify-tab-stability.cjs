/* Sample every rendered frame while returning to the populated Orders tab. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const out=path.resolve(__dirname,'../../../artifacts/shopify-tab-stability');fs.mkdirSync(out,{recursive:true});
const baseline=process.argv.includes('--baseline');
const user={_id:'tab-stability',name:'Tab stability',role:'admin',perms:[]};
const orders=Array.from({length:30},(_,i)=>({_id:String(i+1).padStart(24,'0'),ref:String(3082-i),client:i%2?'منى محمد':'Mohamed Soliman',phone:'01000000000',shopifyCreatedAt:new Date(Date.UTC(2026,10,7-Math.floor(i/5),12,i)).toISOString(),createdAt:new Date(Date.UTC(2026,10,7,12,i)).toISOString(),status:'pending',cancelled:false,shopifyId:String(123456+i),total:2200+i*5,itemsTotal:2055+i*5,shipCost:145,tags:'confirmed',items:[{code:'SH-101',name:'Cotton basket',qty:2,price:450,total:900}],depositReceipts:[],assignedToName:'Malak',comments:[],shipWithoutDeposit:i%3===0}));
(async()=>{const browser=await puppeteer.launch({headless:true});try{
  const page=await browser.newPage(),errors=[],report=[];page.on('pageerror',error=>errors.push(error.stack));
  await page.evaluateOnNewDocument(user=>{
    localStorage.setItem('token','tab-stability-fixture');localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('soulia-push-prompt:tab-stability','dismissed');
  },user);
  await page.setRequestInterception(true);page.on('request',request=>{
    const url=new URL(request.url());if(!url.pathname.startsWith('/api/'))return request.continue();
    let data=[];
    if(url.pathname==='/api/auth/me')data=user;
    if(url.pathname==='/api/settings')data={};
    if(url.pathname==='/api/notifications'||url.pathname==='/api/notifications/preferences')data={preferences:{enabled:false},subscriptions:[],language:'en'};
    if(url.pathname==='/api/shopify/orders/summary-page')data={rows:[],page:1,limit:30,total:0,allCount:0,pendingCount:0,tabCount:0,filterCounts:{},baseCount:0,starredCount:0,filteredIds:[],selectionRows:[],depositSummary:{instapay:0,vodafone:0,paidCount:0,unpaidCount:0},panelFacets:{status:{},staff:{},tags:{},comments:0,stock:{}},pendingCancelCount:0,pendingEditCount:0,kpiStats:null};
    return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  for(const direction of ['ltr','rtl'])for(const [width,height]of [[1440,900],[1440,768],[1920,1080]]){
    await page.setViewport({width,height});
    await page.goto('http://127.0.0.1:8080/#shopify-orders',{waitUntil:'networkidle2'});
    await page.waitForFunction(()=>!document.querySelector('#splash-screen')&&typeof renderShopifyOrders==='function');
    await page.evaluate(async({orders,direction})=>{
      currentLang=direction==='rtl'?'ar':'en';document.documentElement.dir=direction;applyLang();
      onPageEnter=()=>{};_spServerEnabled=false;_shopifyOrders=orders;shopifyPage=1;
      if(!_spkHidden())_spkToggle();renderShopifyOrders();closeModal();
      renderPerformanceDashboard=()=>{qs('#sp-perf-dashboard-content').innerHTML='<div style="height:1500px">Performance</div>';};
      renderSpDepositHistory=()=>{};renderSpDepositReview=()=>{};
      await document.fonts.ready;
    },{orders,direction});
    await page.waitForSelector('#shopify-orders-table-body tr.sp-order-row');
    await new Promise(resolve=>setTimeout(resolve,250));
    for(const tab of ['perf','deposit-log','deposits']){
      const result=await page.evaluate(async tab=>{
        const box=document.querySelector('#shopify-orders-table-wrap .sp-table-scroll');
        box.scrollTop=170;box.scrollLeft=getComputedStyle(box).direction==='rtl'?-50:50;
        const saved={top:box.scrollTop,left:box.scrollLeft};
        switchShopifySubnav(tab);
        await new Promise(resolve=>setTimeout(resolve,80));
        switchShopifySubnav('orders');
        const frames=[],started=performance.now();
        const sample=()=>{
          const r=box.getBoundingClientRect(),table=box.querySelector('table'),t=table.getBoundingClientRect();
          frames.push({time:Math.round(performance.now()-started),x:r.x,y:r.y,width:r.width,height:r.height,tableX:t.x,tableWidth:t.width,scrollTop:box.scrollTop,scrollLeft:box.scrollLeft,transform:getComputedStyle(qs('#sp-orders-tab-content')).transform});
        };
        sample();
        await new Promise(resolve=>{function tick(){sample();if(performance.now()-started<320)requestAnimationFrame(tick);else resolve();}requestAnimationFrame(tick);});
        const spread=key=>Math.max(...frames.map(f=>f[key]))-Math.min(...frames.map(f=>f[key]));
        return {tab,saved,spread:Object.fromEntries(['x','y','width','height','tableX','tableWidth'].map(key=>[key,spread(key)])),first:frames[0],last:frames.at(-1),frames};
      },tab);
      report.push({direction,width,height,...result});
      if(!baseline){
        for(const [key,value]of Object.entries(result.spread))assert.ok(value<=1,`${direction}/${width}/${tab}: ${key} moves ${value}px`);
        assert.equal(result.last.scrollTop,result.saved.top,'vertical scroll preserved');
        assert.equal(result.last.scrollLeft,result.saved.left,'horizontal scroll preserved');
      }
    }
  }
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,baseline?'before.json':'after.json'),JSON.stringify(report,null,2));
  const movement=Math.max(...report.flatMap(item=>Object.values(item.spread)));
  console.log(`${baseline?'BASELINE':'PASS'} Shopify tab stability: ${report.length} cases; maximum frame-to-frame geometry spread ${movement}px; scroll positions preserved.`);
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
