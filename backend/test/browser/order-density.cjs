/* Compare the same populated order table with and without the shared density styles. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const out=path.resolve(__dirname,'../../../artifacts/order-density');fs.mkdirSync(out,{recursive:true});
const user={_id:'density-admin',name:'Layout review',role:'admin',perms:[]};
const product={_id:'aaaaaaaaaaaaaaaaaaaaaaaa',code:'SH-101',name:'Cotton basket',price:450,openingBalance:500};
const orders=Array.from({length:30},(_,i)=>({
  _id:String(i+1).padStart(24,'0'),ref:String(3082-i),client:i%2?'منى محمد':'Mohamed Soliman',phone:'01000000000',
  shopifyCreatedAt:new Date(Date.UTC(2026,10,7-Math.floor(i/5),12,i)).toISOString(),createdAt:new Date(Date.UTC(2026,10,7,12,i)).toISOString(),
  status:'pending',cancelled:false,shopifyId:String(123456+i),total:2200+i*5,itemsTotal:2055+i*5,shipCost:145,tags:'confirmed',
  items:[{productId:product._id,code:product.code,name:product.name,qty:2,price:450,total:900}],
  depositReceipts:[],assignedToName:'Malak',shippingAddress:'Cairo',shippingCity:'Cairo',comments:[],shipWithoutDeposit:i%3===0
}));
(async()=>{const browser=await puppeteer.launch({headless:true});try{
  const page=await browser.newPage(),errors=[],report=[];page.on('pageerror',e=>errors.push(e.stack));
  await page.evaluateOnNewDocument(user=>{
    localStorage.setItem('token','density-fixture');localStorage.setItem('user',JSON.stringify(user));localStorage.setItem('soulia-push-prompt:density-admin','dismissed');
  },user);
  await page.setRequestInterception(true);page.on('request',req=>{
    const url=new URL(req.url());if(!url.pathname.startsWith('/api/'))return req.continue();
    let data=[];
    if(url.pathname==='/api/auth/me')data=user;
    if(url.pathname==='/api/settings')data={};
    if(url.pathname==='/api/products')data=[product];
    if(url.pathname==='/api/shopify/orders')data=orders;
    if(url.pathname==='/api/transactions/inventory')data=[{...product,current:500,warehouseBalances:{MAIN:500}}];
    if(url.pathname==='/api/notifications'||url.pathname==='/api/notifications/preferences')data={preferences:{enabled:false},language:'en',subscriptions:[]};
    if(url.pathname==='/api/shopify/orders/summary-page')data={rows:[],page:1,limit:30,total:0,allCount:0,pendingCount:0,tabCount:0,filterCounts:{},baseCount:0,starredCount:0,filteredIds:[],selectionRows:[],depositSummary:{instapay:0,vodafone:0,paidCount:0,unpaidCount:0},panelFacets:{status:{},staff:{},tags:{},comments:0,stock:{}},pendingCancelCount:0,pendingEditCount:0,kpiStats:null};
    return req.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  for(const [width,height]of [[1440,900],[1440,768],[1920,1080]]){
    await page.setViewport({width,height});
    await page.goto('http://127.0.0.1:8080/#shopify-orders',{waitUntil:'networkidle2'});
    await page.waitForFunction(()=>!document.querySelector('#splash-screen')&&typeof renderShopifyOrders==='function');
    await page.evaluate(async orders=>{
      onPageEnter=()=>{};_spServerEnabled=false;_shopifyOrders=orders;shopifyPage=1;
      if(!_spkHidden())_spkToggle();
      renderShopifyOrders();closeModal();await document.fonts.ready;
    },orders);
    await page.waitForSelector('#shopify-orders-table-body tr.sp-order-row');
    const measure=async compact=>{
      await page.evaluate(compact=>{
        for(const name of ['workspace-tabs.css','order-density.css'])document.querySelector('link[href*="/'+name+'"]').sheet.disabled=!compact;
        SouliaTabs.refresh();
      },compact);
      await new Promise(r=>setTimeout(r,100));
      await page.evaluate(()=>SouliaTableViewport.fit());
      await new Promise(r=>setTimeout(r,100));
      return page.evaluate(()=>{
        const box=document.querySelector('#shopify-orders-table-wrap .sp-table-scroll'),rect=box.getBoundingClientRect();
        const th=box.querySelector('th').getBoundingClientRect();
        const rows=[...box.querySelectorAll('tr.sp-order-row')].map(el=>el.getBoundingClientRect());
        const pagination=document.querySelector('#shopify-pagination').getBoundingClientRect();
        const client=box.querySelector('.sp-client-name');
        const day=box.querySelector('.sp-day-sep');
        return {visibleOrders:rows.filter(r=>r.top>=th.bottom-1&&r.bottom<=rect.bottom+1).length,rows:rows.length,rowHeight:rows[0].height,dayHeight:day.getBoundingClientRect().height,dayFont:getComputedStyle(day.querySelector('.sp-day-sep-label')).fontSize,dateFont:getComputedStyle(day.querySelector('.sp-day-sep-date')).fontSize,tableTop:rect.top,tableBottom:rect.bottom,footerBottom:pagination.bottom,viewport:innerHeight,locked:document.documentElement.classList.contains('ui-table-locked'),font:getComputedStyle(client).fontSize,overflow:document.documentElement.scrollWidth>innerWidth+1};
      });
    };
    const before=await measure(false),after=await measure(true);
    await page.screenshot({path:path.join(out,`orders-${width}x${height}.png`)});
    assert.equal(after.rows,30,'all orders retained');
    assert.ok(after.visibleOrders>=before.visibleOrders+2,`${width}x${height}: at least two more complete orders ${JSON.stringify({before,after})}`);
    assert.equal(after.font,'14px','customer text stays readable');
    assert.equal(after.dayHeight,20,'compact date separator');
    assert.ok(after.dayHeight<before.dayHeight,'date separators save height');
    assert.equal(after.dayFont,'10px');assert.equal(after.dateFont,'10px');
    assert.ok(after.rowHeight>=38&&after.rowHeight<=42,'comfortable compact rows '+JSON.stringify({before,after}));
    assert.ok(after.locked&&after.footerBottom<=height+1&&after.tableBottom<=height+1,'table and pagination fit the window');
    assert.equal(after.overflow,false);
    report.push({width,height,before,after});
  }
  await page.setViewport({width:1440,height:360});await new Promise(r=>setTimeout(r,100));
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('ui-table-locked')),false,'short windows can scroll to all controls');
  await page.setViewport({width:390,height:900});await new Promise(r=>setTimeout(r,150));
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('ui-table-locked')),false,'mobile retains natural page scrolling');
  assert.equal(await page.$eval('#sp-subnav-orders',el=>el.getBoundingClientRect().height),44,'mobile touch target');
  assert.equal(await page.$eval('#sp-mobile-list .sp-card-day-header',el=>el.getBoundingClientRect().height),20,'mobile date separators stay compact');
  assert.equal(await page.$eval('#sp-mobile-list .sp-card-day-header',el=>getComputedStyle(el).fontSize),'10px');
  await page.evaluate(()=>{navigateTo('users',false);});await new Promise(r=>setTimeout(r,100));
  assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('ui-table-locked')),false,'leaving orders restores page scrolling');
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(out,'measurements.json'),JSON.stringify(report,null,2));
  console.log('PASS order density: '+JSON.stringify(report));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
