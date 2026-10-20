const assert=require('node:assert/strict'),path=require('node:path'),puppeteer=require('../backend/node_modules/puppeteer');
const user={_id:'preview-user',name:'Preview',username:'preview',role:'staff',perms:['shopify-orders','movements','inventory','shopify-deposit-upload']};
const product={_id:'aaaaaaaaaaaaaaaaaaaaaaaa',code:'SKU-1',name:'Handwoven basket',openingBalance:500,price:450};
const orders=Array.from({length:12},(_,i)=>({
  _id:String(i+1).padStart(24,'0'),ref:String(2859+i),client:i%2?'منى محمد عبد الرحمن':'A customer with a long full name',phone:'01000000000',
  shopifyCreatedAt:new Date(Date.now()-i*60*60*1000).toISOString(),createdAt:new Date().toISOString(),status:'pending',cancelled:false,
  shopifyId:String(123456+i),total:1600+i*275,itemsTotal:1600+i*275,shipCost:50,notes:i%2?'confirmed':'Customer requested delivery after 5 pm',tags:'confirmed',
  items:[{productId:product._id,code:product.code,name:product.name,qty:i%3+1,price:450,total:450*(i%3+1)}],
  depositReceipts:[],assignedToName:i%2?'Gannh':'',shipWithoutDeposit:i%3===0,shippingAddress:'Cairo, Egypt',shippingCity:'Cairo',comments:[],
}));
(async()=>{
  const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:path.join(__dirname,'shopify-responsive-browser')});
  try{
    for(const [lang,width] of [['en',1920],['ar',390]]){
      const page=await browser.newPage();await page.setViewport({width,height:1000});
      await page.evaluateOnNewDocument((user,lang)=>{localStorage.clear();localStorage.setItem('soulia_lang_pref',lang);localStorage.setItem('token','preview-only');localStorage.setItem('user',JSON.stringify(user));},user,lang);
      let orderRequests=0,releaseInitial=null;const errors=[];
      page.on('pageerror',e=>{errors.push(e.message);console.log('PAGE ERROR: '+e.message);});
      page.on('console',message=>{if(message.type()==='error')console.log('BROWSER: '+message.text());});
      await page.setRequestInterception(true);
      page.on('request',request=>{
        const url=new URL(request.url());
        if(url.origin!=='http://localhost:8080')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:url.hostname==='cdn.socket.io'?'window.io=function(){return {on:function(){},emit:function(){},disconnect:function(){}}}':''});
        if(url.pathname.startsWith('/api/')){
          const data=url.pathname==='/api/auth/me'?user:url.pathname==='/api/settings'?{lang}:url.pathname==='/api/products'?[product]:url.pathname==='/api/transactions/inventory'?[{...product,current:500,warehouseBalances:{MAIN:500}}]:url.pathname==='/api/shopify/orders'?orders:[];
          if(url.pathname==='/api/shopify/orders'){orderRequests++;const respond=()=>request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)}).catch(()=>{});if(orderRequests===1){releaseInitial=respond;return;}return setTimeout(respond,700);}
          return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
        }
        request.continue();
      });
      await page.goto('http://localhost:8080/#shopify-orders',{waitUntil:'domcontentloaded'});
      try{await page.waitForSelector('#sp-orders-loading:not([hidden])',{timeout:10000});}catch(error){console.log(await page.evaluate(()=>({page:typeof currentPage!=='undefined'?currentPage:null,app:document.querySelector('#app')?.style.display,loading:document.querySelector('#sp-orders-loading')?.outerHTML})));throw error;}
      await page.screenshot({path:path.join(__dirname,`shopify-loading-${lang}.png`)});
      await releaseInitial();
      await page.waitForFunction(()=>document.querySelector('#sp-orders-loading').hidden && document.querySelectorAll('.sp-row-check,.sp-card').length>0);
      assert.equal(orderRequests,1);
      const measure=()=>page.evaluate(()=>{
        const host=document.querySelector('#sp-orders-tab-content'),table=document.querySelector('#shopify-orders-table-body .data-table'),scroll=document.querySelector('.sp-table-scroll');
        return {mode:host.dataset.layout,space:host.clientWidth,cards:document.querySelectorAll('#sp-mobile-list .sp-card').length,table:!!table,tableWidth:table?.getBoundingClientRect().width||0,viewportOverflow:document.documentElement.scrollWidth>innerWidth,scale:table?getComputedStyle(table).getPropertyValue('--sp-cw'):null,scroll:scroll?scroll.scrollWidth>scroll.clientWidth:false};
      });
      const initial=await measure();
      assert(!initial.viewportOverflow);
      assert.equal(initial.mode,width===1920?'table':'cards');
      if(initial.table){
        assert.equal(initial.cards,0);assert.equal(initial.scale,'1');assert(initial.tableWidth>initial.space);
        const integrity=await page.evaluate(()=>{
          const action=document.querySelector('td[data-col="action"]').getBoundingClientRect(), scroll=document.querySelector('.sp-table-scroll').getBoundingClientRect();
          return {actionVisible:action.left>=scroll.left-1&&action.right<=scroll.right+1,totalsFit:[...document.querySelectorAll('td[data-col="total"]')].every(el=>el.scrollWidth<=el.clientWidth+1)};
        });
        assert(integrity.actionVisible,'Primary actions should stay visible while the table scrolls');
        assert(integrity.totalsFit,'Order amounts must not be clipped');
      }
      else {assert.equal(initial.cards,12);assert(!initial.table);}
      await page.screenshot({path:path.join(__dirname,`shopify-ready-${lang}.png`)});
      await page.evaluate(()=>{window.refreshOne=loadShopifyOrders();window.refreshTwo=loadShopifyOrders();});
      assert.equal(await page.$eval('#sp-orders-loading',el=>el.hidden),true);
      assert.equal((await measure()).table,initial.table);
      await page.evaluate(()=>Promise.all([refreshOne,refreshTwo]));
      assert.equal(orderRequests,2);
      if(width===1920){
        for(const viewport of [1440,1100,768,390,320,1920]){
          await page.setViewport({width:viewport,height:1000});
          await new Promise(r=>setTimeout(r,220));
          const result=await measure();
          assert(!result.viewportOverflow,JSON.stringify(result));
          assert(result.mode==='cards'?result.cards===12&&!result.table:result.table&&result.cards===0);
          console.log(viewport+'px: '+JSON.stringify(result));
          if(viewport===1100)await page.screenshot({path:path.join(__dirname,'shopify-ready-medium.png')});
        }
      }
      assert.deepEqual(errors,[]);
      console.log(lang+': initial loading, preserved data, single-flight refresh and adaptive rendering passed.');
      await page.close();
    }
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
