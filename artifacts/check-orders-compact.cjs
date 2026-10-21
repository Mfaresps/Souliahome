const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const puppeteer = require('../backend/node_modules/puppeteer');
const express = require('../frontend/node_modules/express');
const html = fs.readFileSync('frontend/public/index.html', 'utf8');
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].includes('src=') && !match[1].includes('application/')) new vm.Script(match[2]);
}
(async () => {
  const app=express();
  app.get('/config.js',(req,res)=>res.type('js').send('window.__ENV__={API_BASE_URL:""};'));
  app.use(express.static(require('node:path').resolve('frontend/public')));
  const server=app.listen(8087);
  const browser = await puppeteer.launch({headless:true, executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try {
    const page = await browser.newPage();
    const click = selector => page.$eval(selector,el=>el.click());
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    const errors = [];
    page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR',e.message); });
    await page.setViewport({width:390,height:844,hasTouch:true});
    await page.evaluateOnNewDocument(() => {
      document.startViewTransition=undefined;
      localStorage.setItem('token','compact-preview');
      localStorage.setItem('user',JSON.stringify({_id:'preview',name:'Preview',username:'preview',role:'admin',perms:[]}));
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== 'http://localhost:8087') return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:''});
      if (url.pathname.startsWith('/api/')) {
        const data = url.pathname === '/api/auth/me' ? {_id:'preview',name:'Preview',username:'preview',role:'admin',perms:[]}
          : url.pathname === '/api/settings' ? {lang:'en'}
          : url.pathname.includes('branding') ? {logos:[],selection:{}} : [];
        return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
      }
      request.continue();
    });
    await page.goto('http://localhost:8087/#shopify-orders',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => !document.querySelector('#splash-screen') && document.querySelector('#page-shopify-orders').classList.contains('active'));
    await page.waitForFunction(() => window.spCompactHeader && document.querySelector('#sp-kpi').hidden);
    await page.evaluate(() => {
      window.actionCalls = [];
      openImportOldOrdersModal = () => actionCalls.push('import');
      openArchiveExport = () => actionCalls.push('export');
      _spkOpenReport = () => actionCalls.push('report');
    });
    for (const width of [320,390,430,1440]) {
      await page.setViewport({width,height:900,hasTouch:true});
      for (const lang of ['ar','en']) {
        await page.evaluate(lang => { currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr'; applyLang(); },lang);
        const measure = await page.evaluate(() => {
          const header = document.querySelector('#shopify-page-header').getBoundingClientRect();
          return {height:header.height,overflow:document.documentElement.scrollWidth>innerWidth,refresh:getComputedStyle(document.querySelector('.sp-refresh-btn')).display};
        });
        assert(measure.height<=56,JSON.stringify({width,lang,...measure}));
        assert(!measure.overflow);
        if (width<768) assert.equal(measure.refresh,'none');
        await click('#sp-subnav-shell summary');
        await page.waitForFunction(()=>document.querySelector('#sp-subnav-shell').open,{timeout:2000});
        assert(await page.$eval('#sp-subnav-orders',el=>el.getBoundingClientRect().height>=40));
        const panel = await page.$eval('#sp-subnav',el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right};});
        assert(panel.left>=0 && panel.right<=width,JSON.stringify(panel));
        await click('#sp-subnav-deposits');
        assert.equal(await page.evaluate(()=>_spSubnavTab),'deposits');
        assert.equal(await page.$eval('#sp-subnav-shell',el=>el.open),false);
        await click('#sp-subnav-shell summary');
        await page.waitForFunction(()=>document.querySelector('#sp-subnav-shell').open,{timeout:2000});
        await click('#sp-subnav-orders');
        await click('#sp-tools-menu summary');
        await page.focus('#sp-tools-menu summary');
        await page.keyboard.press('Escape');
        assert.equal(await page.$eval('#sp-tools-menu',el=>el.open),false);
        console.log(JSON.stringify({width,lang,...measure}));
      }
    }
    await page.setViewport({width:390,height:844,hasTouch:true});
    await page.evaluate(()=>{const badge=document.querySelector('#sp-subnav-deposits-n');badge.hidden=false;badge.textContent='12';});
    await page.waitForFunction(()=>document.querySelector('#sp-section-count').textContent==='12');
    assert.equal(await page.$eval('#sp-section-count',el=>el.hidden),false);
    for (const handler of ['openImportOldOrdersModal()',"openArchiveExport('shopify')",'_spkOpenReport()']) {
      await click('#sp-tools-menu summary');
      await click(`#sp-tools-menu button[onclick="${handler}"]`);
    }
    assert.deepEqual(await page.evaluate(()=>actionCalls),['import','export','report']);
    await click('#sp-tools-menu summary');
    await click('#sp-kpi-toggle');
    assert.equal(await page.$eval('#sp-kpi',el=>el.hidden),false);
    await click('#sp-tools-menu summary');
    await click('#sp-kpi-toggle');
    assert.equal(await page.$eval('#sp-kpi',el=>el.hidden),true);
    await page.evaluate(() => {
      window.refreshCount=0;
      loadShopifyOrders=()=>{refreshCount++;return new Promise(resolve=>window.finishRefresh=resolve);};
      window.sendTouch=(name,x,y)=>{
        const point=new Touch({identifier:1,target:document.querySelector('#sp-mobile-list'),clientX:x,clientY:y});
        document.querySelector('#sp-mobile-list').dispatchEvent(new TouchEvent(name,{bubbles:true,cancelable:true,touches:name==='touchend'||name==='touchcancel'?[]:[point],changedTouches:[point]}));
      };
      window.scrollTo(0,0);
      sendTouch('touchstart',180,250);sendTouch('touchmove',180,290);sendTouch('touchend',180,290);
    });
    assert.equal(await page.evaluate(()=>refreshCount),0,'Short pull does not refresh');
    await page.evaluate(()=>{sendTouch('touchstart',180,250);sendTouch('touchmove',180,400);sendTouch('touchcancel',180,400);});
    assert.equal(await page.evaluate(()=>refreshCount),0,'Cancelled pull does not refresh');
    await page.evaluate(()=>{sendTouch('touchstart',180,250);sendTouch('touchmove',180,400);sendTouch('touchend',180,400);});
    await page.waitForFunction(()=>refreshCount===1);
    assert(await page.$eval('.sp-pull-indicator',el=>el.classList.contains('is-loading')));
    await page.evaluate(()=>{sendTouch('touchstart',180,250);sendTouch('touchmove',180,400);sendTouch('touchend',180,400);finishRefresh();});
    await page.waitForFunction(()=>!document.querySelector('.sp-pull-indicator').classList.contains('is-visible'));
    assert.equal(await page.evaluate(()=>refreshCount),1,'Concurrent pulls coalesce');
    await page.screenshot({path:'artifacts/orders-compact-mobile.png',fullPage:false});
    await page.click('#sp-tools-menu summary');
    assert.equal(await page.$eval('#sp-tools-menu',el=>el.open),true,'Menu opens with a pointer');
    await page.click('#shopify-page-header h2');
    assert.equal(await page.$eval('#sp-tools-menu',el=>el.open),false,'Outside click closes the menu');
    await page.evaluate(()=>{currentUser.role='staff';_initShopifySubnav();spCompactHeader.sync();});
    assert.equal(await page.$eval('#sp-section-count',el=>el.hidden),true);
    assert.equal(await page.evaluate(()=>_spVisibleSubnavTabs().length),1,'Staff only see permitted sections');
    assert.deepEqual(errors,[]);
    console.log('PASS: compact header, RTL/LTR, menu actions, summary toggle, pull threshold/cancel/loading/concurrency, inline JavaScript syntax.');
  } finally { await browser.close(); server.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});

