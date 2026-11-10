const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const out=path.resolve(__dirname,'../../../artifacts/workspace-tabs');fs.mkdirSync(out,{recursive:true});
const groups=[
  ['movements','#page-movements .ui-tabs',['#mov-tab-list','#mov-tab-archive','#mov-tab-collections']],
  ['inventory','#page-inventory .ui-tabs',['#inv-tab-list','#inv-tab-log']],
  ['products','#page-products .prod-tabs',['#prod-tab-items','#prod-tab-drafts']],
  ['suppliers','#sup-tabs',['#sup-tab-cards','#sup-tab-payments']],
  ['complaints','#page-complaints .cs-main-tabs',['#main-tab-fu','#main-tab-cmp']],
  ['approvals','#page-approvals .ui-tabs',['#appr-tab-approvals-btn','#appr-tab-hub-btn','#appr-tab-otp-btn']],
  ['users','.users-workspace-tabs',['#users-tab-accounts','#users-tab-roles']],
  ['csp','.csp-header-actions',['#csp-tab-browse-btn','#csp-tab-manage-btn']]
];
(async()=>{const browser=await puppeteer.launch({headless:true});try{
  const page=await browser.newPage(),errors=[];let context='startup';page.on('pageerror',e=>{errors.push(e.stack);console.log(context,e.stack);});
  await page.setRequestInterception(true);page.on('request',req=>{
    const url=new URL(req.url());if(!url.pathname.startsWith('/api/'))return req.continue();
    let data=[];
    if(url.pathname==='/api/settings')data={};
    if(url.pathname==='/api/notifications'||url.pathname==='/api/notifications/preferences')data={preferences:{enabled:false},language:'en',subscriptions:[]};
    return req.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle2'});
  await page.evaluate(()=>{
    currentUser={_id:'tabs-admin',name:'Tabs review',role:'admin',perms:[]};_transactionSummariesComplete=true;
    qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();
    onPageEnter=()=>{};buildSidebar();updateHeader();
    // Isolate the navigation contract from network-dependent data painting.
    loadArchivedMovements=async()=>{};renderCollectionsTable=()=>{};loadInventoryLog=async()=>{};
    loadSpecDrafts=async()=>{};renderSpecDrafts=()=>{};loadFollowUps=async()=>{};renderComplaints=()=>{};
    renderHubLogs=()=>{};renderOtpAudit=()=>{};
    qs('#csp-tab-manage-btn').style.display='';
  });
  let checks=0;
  assert.equal(await page.$eval('#vault-tabs',el=>el.hidden),true);
  assert.equal(await page.$eval('#vault-tabs',el=>getComputedStyle(el.parentElement).display),'none','locked vault sections stay hidden');
  for(const lang of ['en','ar'])for(const width of [320,390,768,1440]){
    await page.setViewport({width,height:900});
    await page.evaluate(lang=>{currentLang=lang;document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';applyLang();},lang);
    for(const [route,barSelector,tabs]of groups){
      context=`${route}/${lang}/${width}`;
      await page.evaluate(route=>navigateTo(route,false),route);
      await page.waitForSelector(barSelector+'.ui-tabs');
      await page.evaluate(selector=>document.querySelector(selector).click(),tabs[0]);
      await new Promise(r=>setTimeout(r,100));
      const before=await page.evaluate(()=>location.hash);
      await page.focus(tabs[0]);await page.keyboard.press(lang==='ar'?'ArrowLeft':'ArrowRight');
      assert.equal(await page.evaluate(()=>document.activeElement.id),tabs[1].slice(1));
      assert.equal(await page.evaluate(()=>location.hash),before,'arrows only move focus');
      await page.keyboard.press('Enter');await new Promise(r=>setTimeout(r,280));
      assert.equal(await page.$eval(tabs[1],el=>el.getAttribute('aria-selected')),'true',`${route}: selected`);
      const geometry=await page.$eval(tabs[1],el=>{
        const a=el.getBoundingClientRect(),bar=el.parentElement,b=bar.getBoundingClientRect(),style=getComputedStyle(bar,'::before');
        const x=new DOMMatrixReadOnly(style.transform).m41+b.left+bar.clientLeft-bar.scrollLeft;
        return {height:a.height,visible:a.left>=b.left-1&&a.right<=b.right+1,aligned:Math.abs(x-a.left)<2,width:parseFloat(style.width),tabWidth:a.width,font:getComputedStyle(el).fontSize,overflow:document.documentElement.scrollWidth>innerWidth+1};
      });
      assert.equal(geometry.height,width<=768?44:32,`${route}: uniform height`);
      assert.ok(geometry.visible&&geometry.aligned,`${route}/${lang}/${width}: selected tab and indicator visible ${JSON.stringify(geometry)}`);
      assert.ok(Math.abs(geometry.width-geometry.tabWidth)<2);
      assert.equal(geometry.overflow,false);
      if(route==='suppliers') {
        const supplierHeader=await page.evaluate(()=>{
          const root=document.querySelector('#page-suppliers'),bar=root.querySelector('.ui-tabs-shell').getBoundingClientRect();
          const actions=root.querySelector('.page-header-actions').getBoundingClientRect();
          const buttons=[...root.querySelectorAll('.page-header-actions>.btn,.page-header-actions>.ui-export-menu>.ui-export-trigger')].map(el=>el.getBoundingClientRect());
          return {paymentsVisible:root.querySelector('#sup-panel-payments').getBoundingClientRect().height>0,cardsHidden:root.querySelector('#sup-panel-cards').style.display==='none',
            aligned:Math.abs((bar.top+bar.bottom-actions.top-actions.bottom)/2)<2,
            oneActionRow:buttons.every(r=>Math.abs(r.top-buttons[0].top)<1),buttonCount:buttons.length};
        });
        assert.ok(supplierHeader.paymentsVisible&&supplierHeader.cardsHidden,'supplier panel follows tab activation');
        assert.ok(supplierHeader.oneActionRow&&supplierHeader.buttonCount===2,'supplier actions remain on one row');
        if(width>768)assert.ok(supplierHeader.aligned,'supplier tabs and actions share the header row');
      }
      await page.keyboard.press('Home');assert.equal(await page.evaluate(()=>document.activeElement.id),tabs[0].slice(1));
      await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.id),tabs.at(-1).slice(1));
      for(const tab of tabs)await page.evaluate(selector=>document.querySelector(selector).click(),tab);
      await new Promise(r=>setTimeout(r,220));
      assert.equal(await page.$eval(tabs.at(-1),el=>el.getAttribute('aria-selected')),'true');
      if([390,1440].includes(width))await page.screenshot({path:path.join(out,`${route}-${lang}-${width}.png`)});
      checks++;
    }
  }
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluate(()=>{navigateTo('movements',false);switchMovTab('archive');SouliaTabs.refresh();});
  await new Promise(r=>setTimeout(r,100));
  assert.equal(await page.$eval('#mov-panel-archive',el=>el.getAnimations().length),0);
  assert.ok(await page.$eval('#page-movements .ui-tabs',el=>parseFloat(getComputedStyle(el,'::before').transitionDuration)<.001));
  await page.evaluate(()=>{qs('#mov-tab-collections').hidden=true;SouliaTabs.refresh();});
  await new Promise(r=>setTimeout(r,60));
  await page.focus('#mov-tab-list');await page.keyboard.press('End');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'mov-tab-archive','hidden sections are skipped');
  for (const width of [390,1440]) {
    await page.setViewport({width,height:900});
    await page.evaluate(async()=>{
      currentUser={...currentUser,role:'staff',perms:['shopify-orders']};
      navigateTo('shopify-orders',false);await _initShopifySubnav();
    });
    await new Promise(r=>setTimeout(r,80));
    assert.equal(await page.$eval('#sp-subnav-shell',el=>getComputedStyle(el).display),'none','staff with Orders alone sees no tab strip');
    assert.equal(await page.$eval('#sp-orders-tab-content',el=>getComputedStyle(el).display!=='none'),true,'Orders content stays available');
    assert.ok(await page.$eval('#sp-tools-menu',el=>el.getBoundingClientRect().width>0),'page tools remain available');
    await page.evaluate(async()=>{currentUser={...currentUser,role:'admin',perms:[]};await _initShopifySubnav();});
    await new Promise(r=>setTimeout(r,80));
    assert.equal(await page.$eval('#sp-subnav-shell',el=>el.hidden),false,'admin can navigate all permitted sections');
  }
  assert.deepEqual(errors,[]);
  console.log(`PASS shared tabs: ${checks} route/language/width combinations; uniform sizing, indicator, focus, real handlers, rapid switches and reduced motion.`);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
