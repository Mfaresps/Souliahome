/* Offline integration of real markup, all shipped styles and product handlers.
   Never sends requests to a live backend. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const publicDir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/design-system');
fs.mkdirSync(output, {recursive:true});
let checks = 0;
const check = (value, message) => {assert.ok(value, message); checks++;};
(async () => {
  const browser = await puppeteer.launch({headless:true, pipe:true});
  try {
    const page = await browser.newPage();
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.join(publicDir, url.pathname.slice(1));
      if (url.origin === 'http://soulia.test') {
        if (url.pathname === '/') return request.respond({status:200,contentType:'text/html',body:fs.readFileSync(path.join(publicDir,'index.html'))});
        if (url.pathname.endsWith('.css') || ['/navigation-shell.js','/shopify-compact-header.js','/order-status.js'].includes(url.pathname)) {
          if (fs.existsSync(file)) return request.respond({status:200,contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
        }
        if (/\.(svg|png|webp)$/.test(url.pathname) && fs.existsSync(file)) return request.respond({status:200,contentType:url.pathname.endsWith('.svg')?'image/svg+xml':'image/png',body:fs.readFileSync(file)});
      }
      if (request.resourceType()==='script') return request.respond({status:200,contentType:'text/javascript',body:'window.Chart=class{static register(){} destroy(){}};window.io=()=>({on(){},emit(){},disconnect(){}});'});
      return request.respond({status:200,contentType:'application/json',body:'[]'});
    });
    await page.goto('http://soulia.test/', {waitUntil:'load'});
    await page.evaluate(() => {
      currentUser={_id:'design-admin',name:'Design QA',role:'admin',perms:[]};
      qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();
      onPageEnter=()=>{};api=async()=>[];
      products=[{_id:'p1',code:'LINEN-01',name:'Linen blanket',sellPrice:1200,buyPrice:800,openingBalance:12,minStock:2},
        {_id:'p2',code:'COTTON-02',name:'Cotton blanket',sellPrice:950,buyPrice:650,openingBalance:1,minStock:2}];
      inventoryCache=products.map(p=>({...p,current:p.openingBalance}));
      inventoryCache.push({...products[0],_id:'inactive',code:'INACTIVE-01',isActive:false,current:12});
      buildSidebar();updateHeader();renderProducts();renderInventory();renderApprovals();renderFollowUps();
    });
    const results=[];
    for (const lang of ['ar','en']) for (const width of [1440,1024,768,390,320]) {
      await page.setViewport({width,height:960});
      await page.evaluate(lang => {
        currentLang=lang;document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';
        applyLang();buildSidebar();closeSidebar();renderProducts();renderInventory();renderApprovals();renderFollowUps();
      },lang);
      for (const id of ['products','inventory','complaints','approvals','clients','suppliers','expenses','reports','settings','shopify-orders','pickup-orders','movements','transaction','vault','users']) {
        await page.evaluate(id => {
          currentPage=id;qsa('.page').forEach(el=>el.classList.toggle('active',el.id==='page-'+id));
          window.scrollTo(0,0);
        },id);
        const metrics=await page.evaluate(() => {
          const visible=el=>!!el.getClientRects().length;
          const current=qs('.page.active');
          const title=current.querySelector('.page-title');
          const controls=[...current.querySelectorAll('.fx-search input,#fu-search,#appr-search')].filter(visible);
          return {title:title&&getComputedStyle(title).fontSize,header:qs('#header').getBoundingClientRect().height,
            overflow:document.documentElement.scrollWidth>innerWidth+1,
            controls:controls.map(el=>({id:el.id,height:el.getBoundingClientRect().height,font:getComputedStyle(el).fontSize})),
            titleBounds:title&&title.getBoundingClientRect().toJSON()};
        });
        const label=`${id} ${lang} ${width}`;
        check(metrics.header===64,`${label}: header ${metrics.header}`);
        if(metrics.title) check(metrics.title===(width<=768?'20px':'24px'),`${label}: title ${metrics.title}`);
        if(metrics.overflow) console.log(label,await page.evaluate(()=>[...qs('.page.active').querySelectorAll('*')].filter(el=>el.getClientRects().length&&el.getBoundingClientRect().right>innerWidth+1).slice(0,12).map(el=>({tag:el.tagName,id:el.id,cls:el.className,right:el.getBoundingClientRect().right}))));
        check(!metrics.overflow,`${label}: document overflow`);
        if(id==='inventory') {
          check(await page.$$eval('#page-inventory .page-title svg',els=>els.length===0),`${label}: plain page title`);
          check(await page.evaluate(()=>{
            const row=qs('#inv-tbody tr[data-key="INACTIVE-01"]');
            return !!row.querySelector('.inv-activation-badge.is-inactive') && row.lastElementChild.textContent===t('invAvailable')
              && !!qs('#inv-tbody .inv-activation-badge.is-active')
              && row.children.length===qs('#inv-table thead tr').children.length;
          }),`${label}: activation and stock are independent and columns match`);
        }
        if(id==='pickup-orders') {
          check(await page.evaluate(()=>{
            const pickup=getComputedStyle(qs('#page-pickup-orders')),inventory=getComputedStyle(qs('#page-inventory'));
            return ['backgroundColor','borderRadius','borderTopWidth','padding'].every(key=>pickup[key]===inventory[key]);
          }),`${label}: same page surface as inventory`);
        }
        for(const control of metrics.controls) {
          check(control.height>=(width<=768?44:40),`${label}: ${control.id} height ${control.height}`);
          check(control.font===(width<=768?'16px':'14px'),`${label}: ${control.id} font ${control.font}`);
        }
        results.push({id,lang,width,...metrics});
        if([1440,390].includes(width)&&['products','inventory','complaints','approvals','shopify-orders','pickup-orders'].includes(id))
          await page.screenshot({path:path.join(output,`${id}-${lang}-${width}.png`)});
      }
    }
    await page.setViewport({width:1440,height:960});
    await page.evaluate(()=>{qsa('.page').forEach(el=>el.classList.toggle('active',el.id==='page-products'));currentPage='products';renderProducts();});
    await page.type('#prod-search','LINEN-01');
    await page.waitForFunction(()=>!qs('#prod-table tbody').textContent.includes('Cotton blanket'));
    check(await page.$eval('#prod-table tbody',el=>el.textContent.includes('Linen blanket')),'Product search retains matching row');
    await page.$eval('#prod-search',el=>{el.value='';el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForFunction(()=>qs('#prod-table tbody').textContent.includes('Cotton blanket'));
    check(true,'Clearing search restores rows');
    await page.click('#prod-toolbar [data-status="low"]');
    check(await page.$eval('#prod-table tbody',el=>el.textContent.includes('Cotton blanket')&&!el.textContent.includes('Linen blanket')),'Stock filter returns only low-stock product');
    await page.click('#prod-toolbar [data-status="all"]');
    check(await page.$eval('#prod-table tbody',el=>el.querySelectorAll('tr').length===2),'All filter restores both products');
    for(const direction of ['rtl','ltr']) {
      await page.evaluate(dir=>document.documentElement.dir=dir,direction);
      const alignment=await page.evaluate(()=>{
        const table=qs('#prod-table');
        return [4,8,10,12].map(n=>[getComputedStyle(table.querySelector(`thead th:nth-child(${n})`)).textAlign,getComputedStyle(table.querySelector(`tbody td:nth-child(${n})`)).textAlign]);
      });
      check(alignment.every(([head,cell])=>head===cell),`${direction}: text, amount, quantity and action columns align`);
    }
    await page.focus('#prod-search');
    check(await page.$eval('#prod-search',el=>getComputedStyle(el).outlineStyle!=='none'),'Keyboard focus visible');
    await page.evaluate(()=>{document.body.classList.add('dark-mode');});
    const dark=await page.$eval('#sidebar',el=>getComputedStyle(el).backgroundColor);
    check(dark==='rgb(22, 29, 24)',`Dark sidebar surface: ${dark}`);
    await page.screenshot({path:path.join(output,'products-dark.png')});
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,errors,results},null,2));
    check(errors.length===0,`Browser errors: ${errors.join('; ')}`);
    console.log(`PASS ${checks} checks: 15 pages, 5 widths, Arabic/English, search and dark theme.`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
