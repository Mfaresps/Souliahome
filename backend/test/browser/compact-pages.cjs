/* The shared compact layout must retain page identity and every existing action. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const publicDir = path.join(root, 'frontend/public');
const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:8080';
const screenshotDir = path.join(root, 'artifacts/compact-pages');
fs.mkdirSync(screenshotDir, {recursive:true});
(async () => {
  const browser = await puppeteer.launch({headless:true});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      let body = [];
      if (url.pathname === '/api/settings') body = {};
      return request.respond({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.setViewport({width:1440,height:900});
    await page.goto(origin, {waitUntil:'networkidle2'});
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    await page.evaluate(() => {
      currentUser = {_id:'compact-admin',name:'Layout review',username:'layout',role:'admin',perms:[]};
      currentLang='en';document.documentElement.lang='en';document.documentElement.dir='ltr';
      qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();
      onPageEnter = () => {};
      _transactionSummariesComplete = true;
      buildSidebar();updateHeader();applyLang();
    });
    const routes = await page.evaluate(() => [...document.querySelectorAll('#main > .page')].map(el=>el.id.slice(5)).filter(id=>!['barcodes','invoice-view'].includes(id)).concat('roles'));
    const measurements = [];
    for (const lang of ['en','ar']) {
      for (const width of [320,390,768,1024,1440]) {
        await page.setViewport({width,height:900});
        await page.evaluate(lang => {
          currentLang=lang;document.documentElement.lang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';
          applyLang();buildSidebar();closeSidebar();
        },lang);
        for (const route of routes) {
          await page.evaluate(route => navigateTo(route,false),route);
          await page.waitForFunction(route=>currentPage===route,{},route);
          const result = await page.evaluate(async route => {
            const active = qs('#main > .page.active');
            const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility!=='hidden';
            const controls = [...active.querySelectorAll('button,a,input,select,summary')];
            const data = active.querySelector('#shopify-filters-bar,#mov-table-wrap,#pu-board-filters-row,.stg-search-wrap,.fx-toolbar,.colp-table-wrap');
            const sheet = qs('link[href*="/compact-pages.css"]').sheet;
            sheet.disabled=true;
            const before = controls.filter(visible);
            const beforeBox = active.getBoundingClientRect();
            const beforeDataTop = data?.getBoundingClientRect().top;
            sheet.disabled=false;
            await new Promise(requestAnimationFrame);
            const breadcrumb=qs('#shell-breadcrumb'), current=breadcrumb.querySelector('[aria-current="page"]');
            const rect=breadcrumb.getBoundingClientRect();
            const pageRect=active.getBoundingClientRect();
            const headerRect=qs('#header').getBoundingClientRect();
            const missing = before.filter(el=>!visible(el)).filter(el=>!el.closest('.page-title,.shell-page-breadcrumb,.cat-breadcrumb,.rbac-breadcrumb'));
            return {route,pageId:active.id,titles:[...active.querySelectorAll('.page-title,#shopify-page-header>h2,.uh-title')].filter(visible).map(el=>el.textContent),label:current?.textContent.trim(),heading:current?.getAttribute('aria-level'),pathVisible:visible(breadcrumb),pathFits:rect.left>=headerRect.left-1&&rect.right<=headerRect.right+1&&rect.bottom<=headerRect.bottom+1,
              missing:missing.map(el=>el.outerHTML.slice(0,300)),overflow:document.documentElement.scrollWidth>innerWidth+1,offenders:[...document.body.querySelectorAll('*')].filter(el=>visible(el)&&el.getBoundingClientRect().right>innerWidth+1&&!el.closest('.colp-table-wrap')).slice(0,7).map(el=>({tag:el.tagName,id:el.id,cls:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right})),top:pageRect.top,beforeTop:beforeBox.top,savedHeight:data&&visible(data)?Math.round(beforeDataTop-data.getBoundingClientRect().top):null};
          },route);
          assert.equal(result.titles.length,0,`${lang}/${width}/${route}: duplicate page title ${JSON.stringify(result)}`);
          assert.ok(result.label,`${lang}/${width}/${route}: page identity`);
          assert.equal(result.heading,'1',`${lang}/${width}/${route}: accessible page heading`);
          assert.ok(result.pathVisible&&result.pathFits,`${lang}/${width}/${route}: visible path fits header`);
          assert.deepEqual(result.missing,[],`${lang}/${width}/${route}: existing actions stay available`);
          assert.equal(result.overflow,false,`${lang}/${width}/${route}: page overflow ${JSON.stringify(result.offenders)}`);
          measurements.push({lang,width,...result});
          if (['shopify-orders','movements','pickup-orders','products','reports','settings'].includes(route) && [390,1440].includes(width))
            await page.screenshot({path:path.join(screenshotDir,`${route}-${lang}-${width}.png`)});
        }
      }
    }
    for (const width of [320,390,1440]) {
      await page.setViewport({width,height:900});
      for (const lang of ['en','ar']) {
        const dark = await page.evaluate(lang=>{
          currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.body.classList.add('dark-mode');
          navigateTo('movements',false);applyLang();syncNavigationShell();
          const current=qs('#shell-breadcrumb [aria-current="page"]'),rect=current.getBoundingClientRect(),header=qs('#header').getBoundingClientRect();
          return {fits:rect.left>=header.left&&rect.right<=header.right&&rect.bottom<=header.bottom,label:current.textContent,color:getComputedStyle(current).color};
        },lang);
        assert.ok(dark.fits&&dark.label,`dark ${lang}/${width}: page identity fits`);
        if(width===390) await page.screenshot({path:path.join(screenshotDir,`movements-${lang}-${width}-dark.png`)});
      }
    }
    await page.evaluate(()=>document.body.classList.remove('dark-mode'));
    await page.evaluate(()=>navigateTo('products',false));
    await page.emulateMediaType('print');
    assert.equal(await page.$eval('#page-products .page-title',el=>getComputedStyle(el).display),'block','screen compaction does not remove printed headings');
    await page.emulateMediaType('screen');
    fs.writeFileSync(path.join(screenshotDir,'measurements.json'),JSON.stringify(measurements,null,2));
    assert.deepEqual(errors,[]);
    console.log(`PASS compact pages: ${measurements.length} page/language/width combinations, visible breadcrumbs, no duplicate titles, preserved actions and no page overflow.`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
