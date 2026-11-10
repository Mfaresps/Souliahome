const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const puppeteer=require('../backend/node_modules/puppeteer');
(async()=>{const browser=await puppeteer.launch({headless:true});try{
  const page=await browser.newPage(),errors=[],out=path.resolve(__dirname,'expenses-layout');fs.mkdirSync(out,{recursive:true});
  page.on('pageerror',e=>errors.push(e.stack));
  await page.setRequestInterception(true);page.on('request',req=>{
    const u=new URL(req.url());if(!u.pathname.startsWith('/api/'))return req.continue();
    const data=u.pathname==='/api/settings'?{}:u.pathname.includes('/notifications')?{preferences:{enabled:false},ids:[],items:[],unread:0}:[];
    return req.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle2'});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluate(async()=>{
    currentUser={_id:'expenses-layout-admin',name:'Layout review',role:'admin',perms:[]};_transactionSummariesComplete=true;
    qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();onPageEnter=()=>{};
    buildSidebar();updateHeader();
    const date=today(),previous=new Date();previous.setMonth(previous.getMonth()-1);
    expenses=[{_id:'e1',expNo:'EXP-1',date,desc:'Office supplies',category:'مستلزمات مكتبية',account:'كاش',amount:1200,status:'معتمد',submittedBy:'Mona'},
      {_id:'e2',expNo:'EXP-2',date,desc:'Storage rent',category:'إيجارات',account:'كاش',amount:25000,status:'معلق',submittedBy:'Mona'},
      {_id:'e3',expNo:'EXP-3',date:previous.toISOString().slice(0,10),desc:'Packaging',category:'تغليف',account:'كاش',amount:2000,status:'معتمد',submittedBy:'Mona'}];
    navigateTo('expenses',false);renderExpenses();
    window.layoutActions=[];openExpenseModal=()=>layoutActions.push('new');exportExpensesExcel=()=>layoutActions.push('export');openArchiveExport=()=>layoutActions.push('archive');
  });
  for(const lang of ['en','ar'])for(const width of [320,390,768,1024,1440]){
    await page.setViewport({width,height:900});
    await page.evaluate(lang=>{currentLang=lang;document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';applyLang();closeSidebar();renderExpenses();SouliaExportMenus.refresh();},lang);
    await page.waitForSelector('#page-expenses .ui-export-trigger',{visible:true});
    const layout=await page.evaluate(()=>{
      const q=s=>document.querySelector('#page-expenses '+s),rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
      return {kpi:rect(q('#exp-kpi-strip')),toolbar:rect(q('.exp-toolbar')),filters:rect(q('.exp-filter-bar')),actions:rect(q('.exp-header-actions')),tabs:rect(q('.ui-tabs-shell')),
        overflow:document.documentElement.scrollWidth>innerWidth+1,
        stats:[...q('#exp-kpi-row').children].map(e=>({box:rect(e),label:rect(e.querySelector('.exp-kpi-stat-label')),value:rect(e.querySelector('.exp-kpi-stat-val'))}))};
    });
    assert(!layout.overflow,`${lang}/${width}: page fits`);
    assert(layout.kpi.bottom<=layout.toolbar.top&&layout.toolbar.bottom<=layout.filters.top,`${lang}/${width}: summary, tools, filters`);
    for(const stat of layout.stats){assert(stat.box.left>=layout.kpi.left-1&&stat.box.right<=layout.kpi.right+1);assert(stat.label.bottom<=stat.value.top+1,'label is above its value');}
    if(width>768)assert(Math.abs((layout.tabs.top+layout.tabs.bottom)/2-(layout.actions.top+layout.actions.bottom)/2)<2,'tabs and actions align');
    else assert.equal(new Set(layout.stats.map(s=>Math.round(s.box.top))).size,2,'mobile shows all four KPIs in two rows');
    await page.click('#page-expenses .exp-header-actions .btn-primary');
    assert.equal(await page.evaluate(()=>layoutActions.at(-1)),'new');
    await page.click('#page-expenses .ui-export-trigger');
    assert.equal(await page.$$eval('#page-expenses .ui-export-panel button',els=>els.filter(e=>getComputedStyle(e).display!=='none').length),2,'both export commands available');
    await page.keyboard.press('Escape');
    await page.click('#exp-tab-pending');
    assert.equal(await page.$eval('#exp-tab-pending',e=>e.getAttribute('aria-pressed')),'true');
    await page.click('#exp-tab-all');
    if([390,1440].includes(width))await page.screenshot({path:path.join(out,`${lang}-${width}.png`)});
  }
  await page.evaluate(()=>{currentUser.role='staff';renderExpenses();});
  assert.equal(await page.$eval('#exp-kpi-strip',e=>getComputedStyle(e).display),'none','admin metrics remain restricted');
  assert.deepEqual(errors,[]);console.log('PASS: expense KPI hierarchy, toolbar alignment, new/export actions and status filters in Arabic/English at 320/390/768/1024/1440px.');
}finally{await browser.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
