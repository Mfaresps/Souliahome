const assert=require('node:assert/strict'),path=require('node:path'),puppeteer=require('../backend/node_modules/puppeteer');
(async()=>{
  const browser=await puppeteer.launch({headless:true,pipe:true});
  try{
    const page=await browser.newPage();await page.setViewport({width:430,height:956,isMobile:true,hasTouch:true});
    const user={_id:'preview',name:'Preview',username:'preview',role:'admin',perms:['dashboard','transaction','movements','inventory','products','categories-view','complaints','csp-view','clients','approvals','suppliers','expenses','reports','vault','users','settings','shopify-orders']};
    const product={_id:'sample-1',name:'Sample product',code:'TEST',sellPrice:100,buyPrice:65,current:12,openingBalance:12,warehouseBalances:{MAIN:12}};
    await page.evaluateOnNewDocument(user=>{localStorage.clear();localStorage.setItem('soulia_lang_pref','en');localStorage.setItem('token','preview-only');localStorage.setItem('user',JSON.stringify(user));},user);
    await page.setRequestInterception(true);
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.origin!=='http://localhost:8080')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:url.hostname==='cdn.socket.io'?'window.io=function(){return {on:function(){},emit:function(){},disconnect:function(){}}}':''});
      if(url.pathname.startsWith('/api/')){
        const data=url.pathname==='/api/auth/me'?user:url.pathname==='/api/settings'?{lang:'en'}:url.pathname==='/api/products'||url.pathname==='/api/transactions/inventory'?[product]:[];
        return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
      }
      request.continue();
    });
    await page.goto('http://localhost:8080/#inventory',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>!document.querySelector('#splash-screen')&&document.querySelector('#page-inventory.active'));
    await page.waitForSelector('#inv-summary-cards .kpi');
    await page.evaluate(()=>{if(typeof closeAdminBriefing==='function')closeAdminBriefing();});
    await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important}'});
    // Enough actual cards to verify the dock against inventory content while scrolling.
    await page.evaluate(()=>{const list=document.getElementById('inv-mobile-list');const card=list.firstElementChild;if(card)for(let i=0;i<15;i++)list.appendChild(card.cloneNode(true));});
    for(const width of [320,390,430,768]){
      await page.setViewport({width,height:956,isMobile:true,hasTouch:true});
      for(const dir of ['ltr','rtl']){
        await page.evaluate(dir=>{document.documentElement.dir=dir;scrollTo(0,0);},dir);
        const inspect=()=>page.evaluate(()=>{
          const dock=document.getElementById('mobile-bottom-nav'),r=dock.getBoundingClientRect();
          const button=document.getElementById('mnav-inventory'),b=button.getBoundingClientRect();
          const top=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
          const grid=document.getElementById('inv-summary-cards'),g=grid.getBoundingClientRect();
          return {dockY:r.y,dockVisible:getComputedStyle(dock).display!=='none'&&getComputedStyle(dock).visibility!=='hidden',clickable:!!top&&button.contains(top),top:top?.outerHTML.slice(0,200),dockParent:dock.parentElement.id,overflow:document.documentElement.scrollWidth>innerWidth+1,gridOverflow:grid.scrollWidth>grid.clientWidth+1,gridLeft:g.left,gridRight:g.right,sticky:getComputedStyle(document.querySelector('.inv-sticky-head')).position,headerTop:document.querySelector('.inv-page-header').getBoundingClientRect().top};
        });
        const before=await inspect();
        assert(before.dockVisible&&before.clickable,JSON.stringify({width,dir,before}));
        assert(!before.overflow&&!before.gridOverflow,JSON.stringify({width,dir,before}));
        assert.equal(before.sticky,'static');
        assert(before.headerTop<160,'No large blank space above inventory header');
        await page.evaluate(()=>scrollTo(0,700));
        const after=await inspect();assert.equal(after.dockY,before.dockY);assert(after.clickable&&after.dockVisible);
        if(width===430&&dir==='ltr'){
          await page.screenshot({path:path.join(__dirname,'inventory-mobile-scrolled.png')});
          await page.evaluate(()=>scrollTo(0,0));
          await page.screenshot({path:path.join(__dirname,'inventory-mobile.png')});
        }
      }
    }
    await page.click('#mnav-inventory');
    assert.equal(await page.$eval('#mnav-inventory',el=>el.classList.contains('active')),true);
    console.log('PASS: real inventory page, dock visible and clickable above content, scroll stability, no horizontal overflow or top gap, 320–768px, LTR/RTL.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
