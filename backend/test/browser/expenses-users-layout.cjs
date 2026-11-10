const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),puppeteer=require('puppeteer');
(async()=>{const browser=await puppeteer.launch({headless:true});try{
 const page=await browser.newPage(),errors=[],out=path.resolve(__dirname,'../../../artifacts/expenses-users');fs.mkdirSync(out,{recursive:true});
 page.on('pageerror',e=>errors.push(e.stack));
 await page.setRequestInterception(true);page.on('request',req=>{
  const u=new URL(req.url());if(!u.pathname.startsWith('/api/'))return req.continue();let data=[];
  if(u.pathname==='/api/settings')data={};
  if(u.pathname==='/api/roles')data={canManage:true,roles:[{slug:'review-role',name:'Review role',description:'Workspace role',perms:['users'],users:[],locked:false,system:false}]};
  if(u.pathname==='/api/notifications'||u.pathname==='/api/notifications/preferences')data={preferences:{enabled:false},subscriptions:[]};
  return req.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle2'});
 await page.evaluate(()=>{
  currentUser={_id:'layout-admin',name:'Layout review',role:'admin',perms:[]};_transactionSummariesComplete=true;
  qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();onPageEnter=()=>{};
  loadSecurityPanel=async()=>{};buildSidebar();updateHeader();
 });
 let checks=0;
 for(const lang of ['en','ar'])for(const width of [320,390,768,1024,1440]){
  await page.setViewport({width,height:900});
  await page.evaluate(lang=>{currentLang=lang;document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';applyLang();closeSidebar();},lang);
  let usersAnchor;
  for(const route of ['expenses','users','roles']){
   await page.evaluate(route=>{navigateTo(route,false);if(route==='users')renderUsers();if(route==='expenses')renderExpenses();if(route==='roles')rbacOpen();},route);
   if(route==='roles')await page.waitForSelector('#rbac-create:not([hidden])');
   await new Promise(resolve=>setTimeout(resolve,250));
   const geometry=await page.evaluate(route=>{
    const root=document.querySelector(route==='expenses'?'#page-expenses':'#page-users'),track=root.querySelector('.ui-tabs-shell');
    const action=root.querySelector(route==='expenses'?'.exp-toolbar .btn-primary':route==='users'?'#users-accounts-view .btn-primary':'#rbac-create');
    const r=track.getBoundingClientRect(),p=root.getBoundingClientRect(),a=action.getBoundingClientRect();
    const trigger=root.querySelector(route==='expenses'?'.exp-header-actions .ui-export-trigger':'#users-accounts-view .ui-export-trigger');
    return {x:r.x-p.x,y:r.y-p.y,width:r.width,height:r.height,actionHeight:a.height,
      aligned:Math.abs((a.top+a.bottom-r.top-r.bottom)/2)<3,
      menuVisible:!!trigger?.getClientRects().length,
      accountsHidden:document.querySelector('#users-accounts-view').hidden,rolesHidden:document.querySelector('#users-roles-view').hidden,
      overflow:document.documentElement.scrollWidth>innerWidth+1};
   },route);
   assert(!geometry.overflow,JSON.stringify({route,lang,width,geometry}));
   assert(geometry.actionHeight>0,`${route}: primary action stays visible`);
   if(width>768)assert(geometry.aligned,JSON.stringify({route,lang,width,geometry}));else assert(geometry.actionHeight>=43,`${route}: touch height`);
   if(route==='users'){
    usersAnchor=geometry;assert(!geometry.accountsHidden&&geometry.rolesHidden&&geometry.menuVisible,'only account tools are shown');
   }else if(route==='roles'){
    assert(geometry.accountsHidden&&!geometry.rolesHidden&&!geometry.menuVisible,'account tools hide on Roles');
    for(const key of ['x','y','width','height'])assert(Math.abs(geometry[key]-usersAnchor[key])<=1,`${lang}/${width}: users tab track ${key} stays fixed`);
    await page.click('#rbac-create');await page.waitForSelector('#rbac-dialog[open]');
    await page.click('#rbac-dialog [data-close]');await page.waitForSelector('#rbac-dialog[open]',{hidden:true});
   }else{
    assert(geometry.menuVisible,'expense exports use the menu');
    await page.focus('#exp-tab-all');await page.keyboard.press(lang==='ar'?'ArrowLeft':'ArrowRight');await page.keyboard.press('Enter');
    await page.waitForFunction(()=>expStatusFilter==='معلق');
    assert.equal(await page.$eval('#exp-tab-pending',el=>el.getAttribute('aria-pressed')),'true');
   }
   if([390,1440].includes(width))await page.screenshot({path:path.join(out,`${route}-${lang}-${width}.png`)});
   checks++;
  }
 }
 assert.deepEqual(errors,[]);
 console.log(`PASS expenses/users: ${checks} page/language/width combinations; aligned desktop actions, touch sizes, stable Users tabs, hidden panel tools, expense filters and real role-create dialog.`);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
