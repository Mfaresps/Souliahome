const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),puppeteer=require('puppeteer');
(async()=>{const browser=await puppeteer.launch({headless:true});try{
 const page=await browser.newPage(),errors=[],writes=[],out=path.resolve(__dirname,'../../../artifacts/account-menu');fs.mkdirSync(out,{recursive:true});
 page.on('pageerror',e=>errors.push(e.stack));
 await page.setRequestInterception(true);page.on('request',req=>{
  const u=new URL(req.url());if(!u.pathname.startsWith('/api/'))return req.continue();let data=[];
  if(u.pathname==='/api/settings'){data={};if(req.method()==='PUT')writes.push(JSON.parse(req.postData()));}
  if(u.pathname==='/api/notifications'||u.pathname==='/api/notifications/preferences')data={preferences:{enabled:false},subscriptions:[]};
  return req.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('http://127.0.0.1:8080/',{waitUntil:'networkidle2'});
 await page.evaluate(()=>{
  currentUser={_id:'account-review',name:'Ahmed Fares',username:'ahmed',email:'ahmed@example.com',role:'admin',perms:[],totpEnabled:true,avatar:'/soulia-logo.svg'};
  _transactionSummariesComplete=true;qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();onPageEnter=()=>{};
  buildSidebar();updateHeader();navigateTo('products',false);
 });
 let checks=0;
 for(const lang of ['en','ar'])for(const width of [320,390,768,1440])for(const dark of [false,true]){
  await page.setViewport({width,height:900});
  await page.evaluate(({lang,dark})=>{
   closeProfileMenu();currentLang=lang;settings.langEnabled=true;document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';
   document.body.classList.toggle('dark-mode',dark);applyLang();updateHeader();syncThemeIcon();syncLangButton();closeSidebar();
  },{lang,dark});
  await new Promise(r=>setTimeout(r,220));
  await page.focus('#profile-trigger');await page.keyboard.press('ArrowDown');
  await page.waitForFunction(()=>document.activeElement?.id==='pm-account',{timeout:3000}).catch(async error=>{
   await page.screenshot({path:path.join(out,'error.png')});
   throw new Error(JSON.stringify({lang,width,dark,errors,state:await page.evaluate(()=>({focus:document.activeElement?.id,open:document.querySelector('#profile-menu').className,inert:document.querySelector('#profile-menu').inert,items:[...document.querySelectorAll('#profile-menu [role^="menuitem"]')].map(el=>({id:el.id,rect:el.getBoundingClientRect().toJSON(),tabindex:el.tabIndex}))}))})+' '+error.message);
  });
  await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('#profile-menu')).opacity)>.99);
  const geometry=await page.$eval('#profile-menu',el=>{
   const r=el.getBoundingClientRect();return {x:r.x,right:r.right,y:r.y,bottom:r.bottom,overflow:el.scrollWidth>el.clientWidth+1,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,inert:el.inert,
    email:el.querySelector('#pm-user-email').textContent,name:el.querySelector('#pm-user-name').textContent,
    theme:el.querySelector('#pm-theme').getAttribute('aria-checked'),language:el.querySelector('#pm-lang-en').getAttribute('aria-checked'),
    touch:[...el.querySelectorAll('[role^="menuitem"]')].every(b=>b.getBoundingClientRect().height>=43)};
  });
  assert(geometry.x>=0&&geometry.right<=width+1&&geometry.y>=0&&geometry.bottom<=900,JSON.stringify({lang,width,dark,geometry}));
  assert(!geometry.overflow&&!geometry.pageOverflow&&!geometry.inert);
  assert.equal(geometry.name,'Ahmed Fares');assert.equal(geometry.email,'ahmed@example.com');
  assert.equal(geometry.theme,String(dark));assert.equal(geometry.language,String(lang==='en'));if(width<=768)assert(geometry.touch);
  if([390,1440].includes(width))await page.screenshot({path:path.join(out,`${lang}-${width}-${dark?'dark':'light'}.png`)});
  await page.click('#pm-theme');assert.equal(await page.$eval('#pm-theme',el=>el.getAttribute('aria-checked')),String(!dark));
  assert.equal(await page.$eval('#profile-trigger',el=>el.getAttribute('aria-expanded')),'true','theme keeps card open');
  await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.id),'pm-logout');
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'profile-trigger');
  assert.equal(await page.$eval('#profile-menu',el=>el.inert&&el.getAttribute('aria-hidden')==='true'),true,'closed controls cannot receive focus');checks++;
 }
 await page.setViewport({width:390,height:900});
 await page.evaluate(()=>{document.body.classList.remove('dark-mode');settings.langEnabled=true;currentLang='ar';applyLang();updateHeader();});
 await page.click('#profile-trigger');await page.click('#pm-lang-en');
 await page.waitForFunction(()=>currentLang==='en'&&document.documentElement.dir==='ltr');
 assert.equal(await page.$eval('#pm-lang-en',el=>el.getAttribute('aria-checked')),'true');
 await page.click('#pm-lang-ar');await page.waitForFunction(()=>currentLang==='ar'&&document.documentElement.dir==='rtl');
 await page.evaluate(()=>{currentUser.role='staff';currentUser.perms=['products'];settings.langEnabled=false;syncLangControls();updateHeader();});
 assert.equal(await page.$eval('#pm-lang',el=>getComputedStyle(el).display),'none','language policy retained');
 await page.focus('#pm-theme');await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.id),'pm-logout','hidden language options skipped');
 await page.evaluate(()=>{changeLang('en');});assert.equal(await page.evaluate(()=>currentLang),'ar','forced language is enforced');
 await page.evaluate(()=>{delete currentUser.email;delete currentUser.totpEnabled;updateHeader();});
 assert.equal(await page.$eval('#profile-menu',el=>!el.querySelector('#pm-security,#pm-timezone')),true,'security and timezone labels are omitted');
 assert.equal(await page.$eval('#pm-user-email',el=>el.textContent),'@ahmed');
 await page.evaluate(()=>{const presence=document.querySelector('#header-presence');presence.classList.add('is-online');presence.setAttribute('aria-label','Online');});
 await page.waitForFunction(()=>document.querySelector('#pm-presence').classList.contains('is-online'));
 await page.click('#pm-calculator');assert.equal(await page.$eval('#calc-widget',el=>el.classList.contains('open')),true);await page.evaluate(()=>toggleCalc());
 await page.click('#profile-trigger');await page.click('#pm-account');assert.equal(await page.evaluate(()=>currentPage),'userhub');
 await page.evaluate(()=>{navigateTo('products',false);window.logoutCalls=0;doLogout=()=>window.logoutCalls++;});
 await page.click('#profile-trigger');await page.click('#pm-logout');assert.equal(await page.evaluate(()=>window.logoutCalls),1);
 await page.click('#profile-trigger');await page.click('#shell-breadcrumb');assert.equal(await page.$eval('#profile-trigger',el=>el.getAttribute('aria-expanded')),'false');
 await page.setViewport({width:1440,height:320});await page.click('#profile-trigger');await page.keyboard.press('End');
 const short=await page.$eval('#profile-menu',el=>{const r=el.getBoundingClientRect(),a=el.querySelector('#pm-logout').getBoundingClientRect();return {scroll:el.scrollHeight>el.clientHeight,fits:r.y>=0&&r.bottom<=innerHeight,logout:a.top>=r.top&&a.bottom<=r.bottom+1};});
 assert(short.scroll&&short.fits&&short.logout,JSON.stringify(short));
 assert(writes.some(body=>typeof body.darkMode==='boolean'),'existing theme persistence called');
 assert.deepEqual(errors,[]);
 console.log(`PASS account card: ${checks} language/width/theme combinations; real identity, dark mode, language policy, keyboard, account/calculator/logout actions, presence, unknown 2FA and short-screen scrolling.`);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
