const assert=require('node:assert/strict'),path=require('node:path'),puppeteer=require('../backend/node_modules/puppeteer');
(async()=>{
  const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',userDataDir:path.join(__dirname,'navigation-refresh-browser')});
  try{
    const page=await browser.newPage();await page.setViewport({width:1440,height:1100});
    const user={_id:'preview',name:'Preview',username:'preview',role:'staff',perms:['dashboard','transaction','movements','inventory','products','categories-view','complaints','csp-view','clients','approvals','suppliers','expenses','reports','vault','users','settings','shopify-orders']};
    await page.evaluateOnNewDocument(user=>{localStorage.clear();localStorage.setItem('soulia_lang_pref','en');localStorage.setItem('token','preview-only');localStorage.setItem('user',JSON.stringify(user));},user);
    await page.setRequestInterception(true);let refreshRequests=0;
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.origin!=='http://localhost:8080')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:url.hostname==='cdn.socket.io'?'window.io=function(){return {on:function(){},emit:function(){},disconnect:function(){}}}':''});
      if(url.pathname.startsWith('/api/')){
        const data=url.pathname==='/api/auth/me'?user:url.pathname==='/api/settings'?{lang:'en'}:[];
        if(url.pathname==='/api/_refresh-preview'){
          refreshRequests++;
          return setTimeout(()=>request.respond({status:200,contentType:'application/json',body:'[]'}).catch(()=>{}),650);
        }
        return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
      }
      request.continue();
    });
    await page.goto('http://localhost:8080/#userhub',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>!document.querySelector('#splash-screen')&&document.querySelector('#sidebar .shell-brand'));
    await page.evaluate(()=>{window.headerActivity=[];const bar=document.getElementById('header-loadbar');new MutationObserver(()=>headerActivity.push(bar.className)).observe(bar,{attributes:true,attributeFilter:['class']});});
    await page.evaluate(()=>Promise.all([api('/_refresh-preview'),api('/_refresh-preview')]));
    assert.equal(await page.evaluate(()=>headerActivity.some(c=>c.includes('active'))),false);
    await page.evaluate(()=>{window.refreshTask=withHeaderRefresh('preview',()=>api('/_refresh-preview'));window.duplicateTask=withHeaderRefresh('preview',()=>api('/_refresh-preview'));});
    await page.waitForFunction(()=>document.getElementById('header-loadbar').classList.contains('active'));
    assert.equal(refreshRequests,3);
    await page.screenshot({path:path.join(__dirname,'navigation-green-expanded.png')});
    await page.evaluate(()=>Promise.all([refreshTask,duplicateTask]));
    await page.waitForFunction(()=>document.getElementById('header-loadbar').className==='');
    await page.evaluate(()=>{document.body.classList.add('sidebar-collapsed');});
    await new Promise(r=>setTimeout(r,200));
    await page.screenshot({path:path.join(__dirname,'navigation-green-collapsed.png')});
    const style=await page.$eval('#sidebar',el=>({background:getComputedStyle(el).backgroundImage,text:getComputedStyle(el).getPropertyValue('--shell-nav-text')}));
    assert(style.background.includes('gradient'));
    assert.equal(style.text,'#d1e3d8');
    await page.setViewport({width:390,height:844});
    await page.evaluate(()=>{document.documentElement.dir='rtl';document.documentElement.lang='ar';document.body.classList.remove('sidebar-collapsed');document.getElementById('sidebar').classList.add('open');});
    await new Promise(r=>setTimeout(r,200));
    const sidebarVisible=await page.$eval('#sidebar',el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;});
    assert(sidebarVisible);
    await page.screenshot({path:path.join(__dirname,'navigation-green-mobile.png')});
    console.log('Background requests remain silent; repeated refresh clicks make one request and one indicator. Expanded and collapsed green navigation verified.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
