const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const puppeteer=require('../backend/node_modules/puppeteer');
const root=path.resolve(__dirname,'../frontend/public');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const start=html.indexOf('<div class="sp-subnav-shell"'),end=html.indexOf('<!-- Search + Filters',start);
const functions=html.slice(html.indexOf('function _spVisibleSubnavTabs()'),html.indexOf('function _perfAvatarHtml('));
(async()=>{
  const browser=await puppeteer.launch({headless:true,pipe:true});
  try{
    const page=await browser.newPage();
    for(const width of [390,1280]){
      await page.setViewport({width,height:844});
      await page.setContent('<style>.page{display:none}.page.active{display:block}:root{--accent:#2c7a50;--border:#d5e3dc;--surface:#f7faf8;--text:#12352b;--text-muted:#68877b}body{margin:12px}</style><main id="main"><div class="page active" id="page-shopify-orders">'+html.slice(start,end)+['sp-orders-tab-content','sp-deposits-tab-content','sp-deposit-log-content','sp-perf-dashboard-content','shopify-filters-bar'].map(id=>'<div id="'+id+'" style="min-height:200px">'+id+'</div>').join('')+'</div><div class="page" id="page-inventory">Inventory</div></main>');
      for(const file of ['shopify-tabs.css','shopify-responsive.css','interface-motion.css'])await page.addStyleTag({path:path.join(root,file)});
      await page.addScriptTag({content:'window.qs=s=>document.querySelector(s);window.isAdmin=()=>true;window.renderPerformanceDashboard=()=>{};window.renderSpDepositReview=()=>{};window.renderSpDepositHistory=()=>{};window._depLogUrl=()=>"#shopify-orders/deposit-log";'+functions+';_initShopifySubnav();switchShopifySubnav("orders",true);'});
      await page.evaluate(()=>switchShopifySubnav('deposits'));
      const entered=await page.$eval('#sp-deposits-tab-content',el=>({name:getComputedStyle(el).animationName,transform:getComputedStyle(el).transform,duration:getComputedStyle(el).animationDuration}));
      assert.equal(entered.name,width<=820?'none':'uiPanelReveal');assert.equal(entered.transform,'none');assert.equal(entered.duration,width<=820?'0s':'0.22s');
      await page.evaluate(()=>{switchShopifySubnav('perf');switchShopifySubnav('orders');switchShopifySubnav('deposit-log');});
      assert.equal(await page.$eval('#sp-subnav-deposit-log',el=>el.getAttribute('aria-selected')),'true');
      assert.equal(await page.$eval('#sp-orders-tab-content',el=>getComputedStyle(el).display),'none');
      assert.equal(await page.$eval('#sp-subnav-orders',el=>getComputedStyle(el).transitionDuration.split(',')[0]),width<=820?'0s':'0.22s');
      await page.evaluate(()=>{document.getElementById('page-shopify-orders').classList.remove('active');document.getElementById('page-inventory').classList.add('active');});
      assert.equal(await page.$eval('#page-inventory',el=>getComputedStyle(el).animationName),width<=820?'none':'uiPageReveal');
      assert.equal(await page.$eval('#page-inventory',el=>getComputedStyle(el).transform),'none');
      await page.$eval('#page-inventory',el=>Promise.all(el.getAnimations().map(animation=>animation.finished)));
      assert.equal(await page.$eval('#page-inventory',el=>getComputedStyle(el).opacity),'1');
      await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
      assert.equal(await page.$eval('#page-inventory',el=>getComputedStyle(el).animationName),'none');
      assert.equal(await page.$eval('#sp-subnav-orders',el=>getComputedStyle(el).transitionDuration),'0s');
      await page.emulateMediaFeatures([]);
    }
    console.log('PASS: page/panel opacity entries, tab color transitions, rapid switching and final route, mobile/desktop, reduced motion.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
