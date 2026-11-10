const assert=require('node:assert/strict'),fs=require('node:fs'),puppeteer=require('../backend/node_modules/puppeteer');
(async()=>{
 const browser=await puppeteer.launch({headless:true});
 try {
  const page=await browser.newPage(),errors=[],report=[];
  const out='artifacts/catalog-header';fs.mkdirSync(out,{recursive:true});
  page.on('pageerror',e=>errors.push(e.stack));
  await page.setRequestInterception(true);
  page.on('request',req=>{const u=new URL(req.url());if(!u.pathname.startsWith('/api/'))return req.continue();let data=[];if(u.pathname==='/api/settings')data={};if(u.pathname==='/api/notifications/preferences')data={preferences:{enabled:false},subscriptions:[]};return req.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});});
  await page.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle2'});
  await page.evaluate(()=>{
   currentUser={_id:'catalog-review',name:'Layout review',role:'admin',perms:[]};_transactionSummariesComplete=true;
   qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();onPageEnter=()=>{};
   products=Array.from({length:5},(_,i)=>({_id:String(i+1).padStart(24,'0'),code:'SH-'+i,name:'Cotton basket '+i,price:450,sellPrice:450,buyPrice:200,openingBalance:10,current:10,minStock:2,isActive:true,warehouseBalances:{MAIN:10}}));inventoryCache=products;
   buildSidebar();updateHeader();loadInventoryLog=async()=>{};loadSpecDrafts=async()=>{};
  });
  for(const lang of ['en','ar'])for(const width of [320,390,768,1024,1440]){
   await page.setViewport({width,height:900});
   await page.evaluate(lang=>{currentLang=lang;document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';applyLang();closeSidebar();},lang);
   for(const route of ['inventory','products']){
    await page.evaluate(route=>{navigateTo(route,false);if(route==='inventory'){switchInvTab('list');renderInventory();}else{switchProductsTab('items');renderProducts();}SouliaTabs.refresh();},route);
    await new Promise(r=>setTimeout(r,180));
    const result=await page.evaluate(async route=>{
     await document.fonts.ready;
     const root=qs('#page-'+route),bar=root.querySelector('.ui-tabs-shell'),actions=root.querySelector('.inv-header-actions,.prod-page-actions');
     const visible=el=>el.getClientRects().length&&getComputedStyle(el).display!=='none';
     const buttons=[...actions.querySelectorAll('.btn')].filter(visible),rects=buttons.map(el=>el.getBoundingClientRect());
     const a=actions.getBoundingClientRect(),b=bar.getBoundingClientRect(),kpi=root.querySelector('.kpi'),sheet=qs('link[href*="/compact-pages.css"]').sheet;
     let kpiSize=null;
     if(kpi){
      const after=kpi.getBoundingClientRect().height,padding=getComputedStyle(kpi).padding,font=getComputedStyle(kpi.querySelector('.kpi-val')).fontSize,styles=[];
      const visit=rules=>{for(const rule of rules){if(rule.selectorText?.includes('#inv-summary-cards')&&rule.selectorText.includes('.kpi')){styles.push([rule,rule.style.cssText]);rule.style.cssText='';}if(rule.cssRules)visit(rule.cssRules);}};visit(sheet.cssRules);
      const before=kpi.getBoundingClientRect().height,oldPadding=getComputedStyle(kpi).padding,oldFont=getComputedStyle(kpi.querySelector('.kpi-val')).fontSize;
      for(const [rule,style]of styles)rule.style.cssText=style;
      kpiSize={before,after,padding,oldPadding,font,oldFont,count:root.querySelectorAll('.kpi').length};
     }
     return {buttons:buttons.length,oneLine:rects.every(r=>Math.abs(r.top-rects[0].top)<1),aligned:Math.abs((a.top+a.bottom-b.top-b.bottom)/2)<2,touch:rects.every(r=>r.height>=43),overflow:document.documentElement.scrollWidth>innerWidth+1,kpiSize};
    },route);
    assert(result.buttons>=4,`${lang}/${width}/${route}: actions retained ${JSON.stringify(result)}`);
    assert(result.oneLine,`${lang}/${width}/${route}: one action row ${JSON.stringify(result)}`);
    if(width>768)assert(result.aligned,`${lang}/${width}/${route}: tabs and actions aligned ${JSON.stringify(result)}`);else assert(result.touch,`${lang}/${width}/${route}: touch sizes ${JSON.stringify(result)}`);
    assert(!result.overflow,`${lang}/${width}/${route}: no page overflow`);
    if(result.kpiSize){const k=result.kpiSize;assert(k.after<k.before&&k.after>=k.before-10,JSON.stringify(k));assert.equal(k.font,k.oldFont);assert.equal(k.count,7);}
    report.push({lang,width,route,...result});
    if(width===390||width===1440)await page.screenshot({path:`${out}/${route}-${lang}-${width}.png`});
   }
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(out+'/measurements.json',JSON.stringify(report,null,2));console.log('PASS catalog headers: '+report.length+' language/width/page combinations; one action row, desktop alignment, mobile touch sizes, smaller KPIs with unchanged values and no overflow.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
