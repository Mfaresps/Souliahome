const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),puppeteer=require('puppeteer');
(async()=>{const browser=await puppeteer.launch({headless:true});try{
 const page=await browser.newPage(),errors=[],out=path.resolve(__dirname,'../../../artifacts/export-menu');fs.mkdirSync(out,{recursive:true});
 page.on('pageerror',e=>errors.push(e.stack));
 await page.setRequestInterception(true);page.on('request',req=>{
  const u=new URL(req.url());if(!u.pathname.startsWith('/api/'))return req.continue();let data=[];
  if(u.pathname==='/api/settings')data={};
  if(u.pathname==='/api/notifications'||u.pathname==='/api/notifications/preferences')data={preferences:{enabled:false},language:'en',subscriptions:[]};
  return req.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle2'});
 await page.evaluate(()=>{
  currentUser={_id:'exports-admin',name:'Export review',role:'admin',perms:[]};_transactionSummariesComplete=true;
  qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();onPageEnter=()=>{};
  buildSidebar();updateHeader();window.exportCalls=[];
  exportSuppliersExcel=()=>window.exportCalls.push('suppliers-excel');
  openArchiveExport=resource=>window.exportCalls.push('archive-'+resource);
 });
 let checks=0;
 for(const lang of ['en','ar'])for(const width of [320,390,768,1440]){
  await page.setViewport({width,height:900});
  await page.evaluate(lang=>{currentLang=lang;document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';applyLang();closeSidebar();},lang);
  for(const route of ['suppliers','inventory','products','clients','expenses','reports','users']){
   await page.evaluate(route=>{navigateTo(route,false);if(route==='users')renderUsers();SouliaExportMenus.refresh();},route);
   const root='#page-'+route,trigger=root+' .ui-export-menu:not([hidden])>.ui-export-trigger';
   await page.waitForSelector(trigger,{visible:true});
   await new Promise(resolve=>setTimeout(resolve,250));
   assert.equal(await page.$eval(root,el=>[...el.querySelectorAll('button[onclick]')].filter(b=>/\b(?:openArchiveExport|export(?:Suppliers|Inventory|Products|Clients|Expenses|Report)Excel)\s*\(/.test(b.getAttribute('onclick'))&&!b.closest('.ui-export-menu,details,[role="menu"]')).length),0,route+': exports grouped');
   await page.click(trigger);
   await page.waitForSelector(root+' .ui-export-panel.is-open',{visible:true,timeout:5000}).catch(async error=>{
    await page.screenshot({path:path.join(out,'error.png')});
    throw new Error(JSON.stringify({lang,width,route,errors,state:await page.$eval(trigger,el=>({expanded:el.getAttribute('aria-expanded'),disabled:el.disabled,rect:el.getBoundingClientRect().toJSON(),focused:document.activeElement?.outerHTML.slice(0,300)}))})+' '+error.message);
   });
   const geometry=await page.$eval(root+' .ui-export-panel',el=>{
    const r=el.getBoundingClientRect(),items=[...el.children].filter(b=>b.getClientRects().length);
    return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,items:items.length,labels:items.every(b=>b.textContent.trim()),focus:el.contains(document.activeElement),touch:items.every(b=>b.getBoundingClientRect().height>=43),overflow:document.documentElement.scrollWidth>innerWidth+1};
   });
   assert(geometry.items&&geometry.labels&&geometry.focus,JSON.stringify({lang,width,route,geometry}));
   assert(geometry.left>=0&&geometry.right<=width+1&&geometry.top>=0&&geometry.bottom<=900,JSON.stringify({lang,width,route,geometry}));
   assert(!geometry.overflow);if(width<=768)assert(geometry.touch);
   if(route==='suppliers'&&[390,1440].includes(width))await page.screenshot({path:path.join(out,`${lang}-${width}.png`)});
   await page.keyboard.press('End');
   assert.equal(await page.$eval(root+' .ui-export-panel',el=>document.activeElement===Array.from(el.children).filter(b=>!b.hidden&&getComputedStyle(b).display!=='none'&&!b.disabled).at(-1)),true);
   await page.keyboard.press('Escape');
   assert.equal(await page.$eval(trigger,el=>el.getAttribute('aria-expanded')),'false');
   assert.equal(await page.$eval(trigger,el=>document.activeElement===el),true);
   checks++;
  }
 }
 await page.evaluate(()=>{navigateTo('suppliers',false);switchSuppliersTab('cards');});
 const trigger='#page-suppliers .ui-export-trigger',panel='#page-suppliers .ui-export-panel';
 await page.click(trigger);await page.click(panel+' button[onclick="exportSuppliersExcel()"]');
 assert.equal(await page.evaluate(()=>window.exportCalls.at(-1)),'suppliers-excel');
 assert.equal(await page.$eval(trigger,el=>el.getAttribute('aria-expanded')),'false');
 await page.focus(trigger);await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>window.exportCalls.at(-1)),'archive-suppliers');
 await page.click(trigger);await page.click('#shell-breadcrumb');
 assert.equal(await page.$eval(trigger,el=>el.getAttribute('aria-expanded')),'false','outside click closes');
 await page.click(trigger);await page.keyboard.press('Tab');
 assert.equal(await page.$eval(trigger,el=>el.getAttribute('aria-expanded')),'false','Tab dismisses without trapping focus');
 await page.evaluate(()=>{const panel=document.querySelector('#page-suppliers .ui-export-panel');window.exportOriginalNodes=[...panel.children];for(const button of panel.children)button.style.display='none';});
 await page.waitForFunction(()=>document.querySelector('#page-suppliers .ui-export-menu').hidden);
 await page.evaluate(()=>{for(const button of window.exportOriginalNodes)button.style.display='inline-flex';});
 await page.waitForFunction(()=>!document.querySelector('#page-suppliers .ui-export-menu').hidden);
 assert.equal(await page.evaluate(()=>window.exportOriginalNodes.every(b=>b.parentElement===document.querySelector('#page-suppliers .ui-export-panel'))),true,'original action nodes retained');
 assert.equal(await page.$eval('#cat-archive-export-btn',el=>el.closest('.ui-export-menu').hidden),true,'initially hidden category export stays hidden');
 assert.equal(await page.$eval('#appr-export-hub-btn',el=>el.closest('.ui-export-menu').hidden),true,'Hub export stays hidden until allowed by its tab');
 assert.equal(await page.$eval('#sp-tools-menu button[onclick*="openArchiveExport"]',el=>!el.closest('.ui-export-menu')),true,'existing Shopify menu retained');
 assert.deepEqual(errors,[]);
 console.log(`PASS export menus: ${checks} page/language/width combinations; unclipped options, original handlers, keyboard, focus, dismissal and hidden-action state.`);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
