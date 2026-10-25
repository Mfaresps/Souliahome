/* Isolated shipped-shell QA. No requests reach the backend or external services. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const publicDir = path.join(root, 'frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) new vm.Script(match[1]);
let checks = 0;
function check(condition, message) { assert.ok(condition, message); checks++; }
const pause = () => new Promise(resolve => setTimeout(resolve, 250));
(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test') {
        if (url.pathname === '/') return request.respond({status:200,contentType:'text/html',body:html});
        if (url.pathname === '/design-system.css') return request.respond({status:200,contentType:'text/css',body:fs.readFileSync(path.join(publicDir,'design-system.css'),'utf8')});
        if (url.pathname === '/order-status.js') return request.respond({status:200,contentType:'text/javascript',body:fs.readFileSync(path.join(publicDir,'order-status.js'),'utf8')});
        if (url.pathname === '/shopify-edit-approvals.js') return request.respond({status:200,contentType:'text/javascript',body:fs.readFileSync(path.join(publicDir,'shopify-edit-approvals.js'),'utf8')});
        if (['/navigation-shell.js','/navigation-shell.css','/soulia-logo.svg','/inventory-scanner.js','/inventory-scanner.css','/global-search-scanner.js','/global-search-scanner.css'].includes(url.pathname)) return request.respond({status:200,contentType:url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'image/svg+xml',body:fs.readFileSync(path.join(publicDir,url.pathname.slice(1)))});
        if (url.pathname === '/config.js') return request.respond({status:200,contentType:'text/javascript',body:'window.__ENV__={API_BASE_URL:""};'});
        if (url.pathname.startsWith('/api/')) return request.respond({status:200,contentType:'application/json',body:'[]'});
      }
      if (request.resourceType() === 'script') return request.respond({status:200,contentType:'text/javascript',body:'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});'});
      return request.respond({status:200,contentType:'text/plain',body:''});
    });
    await page.goto('http://soulia.test/', {waitUntil:'domcontentloaded'});
    await page.evaluate(() => {
      currentUser={_id:'shell-admin',name:'Fares',username:'fares',role:'admin',perms:[]}; currentLang='en';currentPage='dashboard';
      document.documentElement.lang='en';document.documentElement.dir='ltr';
      qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();
      buildSidebar();updateHeader();
      qsa('.page').forEach(el=>el.classList.toggle('active',el.id==='page-dashboard'));
      // Page renderers are outside this test's scope; navigation still executes the real shell path.
      onPageEnter=()=>{};
      api=async(url)=>({results:url.includes('empty-query')?[]:[{type:'customer',id:'client-1',title:'Osama Khamis',subtitle:'3 orders',score:180}]});
    });
    check(await page.$eval('.shell-breadcrumb',el=>el.textContent.includes('Dashboard')), 'Dashboard breadcrumb');
    check(await page.$$eval('.shell-nav-label',rows=>rows.length===5), 'Five permission-aware groups');
    check(await page.$eval('#sidebar',el=>Math.round(el.getBoundingClientRect().width)===248), 'Expanded sidebar width');
    check(await page.evaluate(()=>NAV_ITEMS.find(item=>item.id==='barcodes')?.icon===NAV_ICONS.barcodes && NAV_ICONS.barcodes!==NAV_ICONS.inventory), 'Barcode page uses a distinct barcode icon');
    // Frequent realtime refreshes must preserve the loaded logo, focused row
    // and scrolled position while still updating badges and permissions.
    await page.setViewport({width:1440,height:420});await pause();
    const stability = await page.evaluate(() => {
      const brand = qs('.shell-brand'), logo = brand.querySelector('img');
      const scroll = qs('.shell-nav-scroll'), row = qs('#sidebar [data-page="products"]');
      row.focus();scroll.scrollTop = 120;
      const top = scroll.scrollTop, y = row.getBoundingClientRect().y;
      const previousExpenses = expenses;
      const results = [];
      try {
        for (let i = 0; i < 20; i++) {
          expenses = Array.from({length:i + 1}, () => ({status:'معلق'}));
          buildSidebar();
          results.push(brand === qs('.shell-brand') && logo === qs('.shell-brand img')
            && scroll === qs('.shell-nav-scroll') && scroll.scrollTop === top
            && row === document.activeElement && row.getBoundingClientRect().y === y
            && qs('#sidebar [data-page="approvals"] .nav-badge')?.textContent === String(i + 1));
        }
      } finally { expenses = previousExpenses;buildSidebar(); }
      return {scrolled:top > 0, stable:results.every(Boolean)};
    });
    check(stability.scrolled, 'Stability check exercises a scrolled sidebar');
    check(stability.stable, 'Repeated badge updates preserve logo, focus and scroll without shifting rows');
    if (process.argv.includes('--sidebar-stability')) {
      for (const direction of ['ltr','rtl']) {
        for (const width of [1440,390]) {
          await page.setViewport({width,height:420});
          await page.evaluate(direction => {
            document.documentElement.dir=direction;currentLang=direction==='ltr'?'en':'ar';
            buildSidebar();qs('#sidebar').classList.add('open');
          },direction);
          await pause();
          check(await page.evaluate(() => {
            const scroll=qs('.shell-nav-scroll'),logo=qs('.shell-brand img');
            const row=qs('#sidebar [data-page="products"]');
            row.focus();scroll.scrollTop=100;const top=scroll.scrollTop;
            for(let i=0;i<20;i++) buildSidebar();
            return logo===qs('.shell-brand img') && row===document.activeElement && scroll.scrollTop===top;
          }),`Stable repeated updates ${direction} ${width}`);
        }
      }
      await page.evaluate(()=>{currentUser.role='staff';currentUser.perms=['products'];buildSidebar();});
      check(await page.$$eval('#sidebar [data-page="reports"]',rows=>rows.length===0),'Permission change removes reports');
      check(await page.$$eval('#sidebar [data-page="products"]',rows=>rows.length===1),'Permission change retains products');
      for (const width of [320,390,768]) {
        await page.setViewport({width,height:844});
        const dock = await page.evaluate(() => {
          closeSidebar();initMobileNav();
          const results=[];
          for (const direction of ['ltr','rtl']) for (const dark of [false,true]) {
            document.documentElement.dir=direction;document.body.classList.toggle('dark-mode',dark);
            for (const perms of [[],['shopify-orders'],['dashboard','shopify-orders','complaints'],['dashboard','shopify-orders','movements','complaints','inventory']]) {
              currentUser={role:'staff',perms};_syncMobileNavPermissions();
              const nav=qs('#mobile-bottom-nav'),style=getComputedStyle(nav);
              const buttons=[...nav.querySelectorAll('button')].filter(el=>getComputedStyle(el).display!=='none');
              const boxes=buttons.map(el=>el.getBoundingClientRect()).sort((a,b)=>a.left-b.left);
              const bounds=nav.getBoundingClientRect();
              results.push(boxes.length>=1 && boxes.every(box=>Math.abs(box.width-boxes[0].width)<1)
                && Math.abs(boxes[0].left-bounds.left-parseFloat(style.borderLeftWidth)-parseFloat(style.paddingLeft))<1
                && Math.abs(bounds.right-boxes.at(-1).right-parseFloat(style.borderRightWidth)-parseFloat(style.paddingRight))<1
                && boxes.slice(1).every((box,i)=>Math.abs(box.left-boxes[i].right-2)<1));
            }
          }
          return results.every(Boolean);
        });
        check(dock,`Visible dock buttons fill equal widths for staff permissions, Arabic/English, light/dark at ${width}px`);
      }
      assert.deepEqual(errors,[],'No browser runtime errors');
      console.log(`Navigation stability: ${checks} checks passed, including 100 sidebar refreshes and equal dock widths across 48 permission/theme/direction/viewport combinations.`);
      return;
    }
    await page.setViewport({width:1440,height:768});await pause();
    check(await page.$eval('.shell-nav-scroll',el=>el.scrollHeight<=el.clientHeight+1),'All main navigation items fit laptop height');
    check(await page.$eval('body',el=>getComputedStyle(el).fontFamily.startsWith('Inter') && getComputedStyle(el).fontFamily.includes('Cairo')),'Latin font with unchanged Arabic fallback');
    check(await page.$eval('body',el=>getComputedStyle(el).fontVariantNumeric.includes('tabular-nums')),'Amounts use tabular numerals');
    await page.setViewport({width:1600,height:1000});await pause();
    await page.click('.shell-brand .shell-fold');await pause();
    await page.waitForFunction(()=>Math.round(qs('#sidebar').getBoundingClientRect().width)===76);
    check(await page.$eval('#sidebar',el=>Math.round(el.getBoundingClientRect().width)===76), 'Collapsed sidebar width');
    check(await page.evaluate(()=>localStorage.getItem('soulia_sidebar_collapsed')==='1'), 'Collapse preference saved');
    check(await page.$eval('#sidebar [data-page="products"]',el=>el.getAttribute('aria-label')==='Products'), 'Icon-only rows have labels');
    await page.evaluate(()=>buildSidebar());
    check(await page.$eval('body',el=>el.classList.contains('sidebar-collapsed')), 'Badge rebuild preserves collapse');
    await page.click('.shell-expand');await pause();
    await page.keyboard.down('Control');await page.keyboard.press('k');await page.keyboard.up('Control');
    check(await page.$eval('#global-search',el=>el===document.activeElement),'Ctrl K focuses search');
    check(await page.$eval('#search-dropdown',el=>el.classList.contains('active')),'Empty history opens useful prompt');
    await page.evaluate(()=>{saveRecentSearch('Linen');saveRecentSearch('Osama');saveRecentSearch('linen');renderRecentSearches();});
    check(await page.evaluate(()=>getRecentSearches().join('|')==='linen|Osama'),'Deduplicated newest-first history');
    check(await page.$$eval('.shell-history-last',rows=>rows.length===1),'Latest search labelled');
    await page.keyboard.press('ArrowDown');
    check(await page.$eval('#global-search',el=>el.getAttribute('aria-activedescendant')==='search-option-0'),'Keyboard navigates history');
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>searchResults[0]?.type==='customer');
    check(await page.$eval('#global-search',el=>el.value==='linen'),'History reruns query');
    await page.keyboard.press('Enter');
    check(await page.evaluate(()=>currentPage==='clients'),'Enter opens actual result destination');
    check(await page.$eval('.shell-breadcrumb',el=>el.textContent.includes('Clients')),'Breadcrumb follows navigation');
    await page.focus('#global-search');
    await page.click('.shell-history-remove');
    check(await page.evaluate(()=>getRecentSearches().join('|')==='Osama'),'Remove one history entry');
    await page.click('.search-recent-clear');
    check(await page.evaluate(()=>getRecentSearches().length===0),'Clear history');
    await page.evaluate(()=>{localStorage.setItem(recentSearchesKey(),'{bad json');renderRecentSearches();});
    check(await page.evaluate(()=>getRecentSearches().length===0),'Malformed history is safe');
    await page.evaluate(()=>{
      localStorage.setItem(recentSearchesKey(),JSON.stringify(['other-user']));
      currentUser={...currentUser,_id:'shell-user-2'};
    });
    check(await page.evaluate(()=>getRecentSearches().length===0),'History isolated by account');
    await page.evaluate(()=>{
      window.pendingSearches=[];api=url=>new Promise(resolve=>pendingSearches.push({url,resolve}));
      const input=qs('#global-search');input.value='zyx_old_record';handleGlobalSearch('zyx_old_record');input.value='zyx_new_record';handleGlobalSearch('zyx_new_record');
      pendingSearches[1].resolve({results:[{type:'customer',id:'new',title:'Newest result',score:180}]});
    });
    await page.waitForFunction(()=>searchResults[0]?.id==='new');
    await page.evaluate(()=>pendingSearches[0].resolve({results:[{type:'customer',id:'old',title:'Stale result',score:180}]}));
    await pause();
    check(await page.evaluate(()=>searchResults[0]?.id==='new'),'Late response cannot overwrite newer query');
    await page.evaluate(()=>{qs('#global-search').value='closing';handleGlobalSearch('closing');closeSearchDropdown();pendingSearches.at(-1).resolve({results:[{type:'customer',id:'late',title:'Late result'}]});});
    await pause();
    check(await page.$eval('#search-dropdown',el=>!el.classList.contains('active')),'Late response cannot reopen closed dropdown');
    await page.evaluate(()=>{qs('#global-search').value='queued';debouncedGlobalSearch('queued');clearGlobalSearch();});
    await pause();
    check(await page.evaluate(()=>!qs('#global-search').value && searchResults.every(row=>row.type==='recent')),'Clear cancels queued query');
    await page.keyboard.press('Escape');
    check(await page.$eval('#global-search',el=>el.getAttribute('aria-expanded')==='false'),'Escape closes history');
    await page.keyboard.down('Control');await page.keyboard.press('k');await page.keyboard.up('Control');
    check(await page.$eval('#search-dropdown',el=>el.classList.contains('active')),'Ctrl K reopens history while input is already focused');
    await page.evaluate(()=>{api=async(url)=>url.startsWith('/search')?({results:[]}):[];qs('#global-search').value='empty-query';handleGlobalSearch('empty-query');});
    await page.waitForFunction(()=>!!qs('#search-dropdown .search-empty'));
    await page.keyboard.press('Escape');
    check(await page.$eval('#search-dropdown',el=>!el.classList.contains('active')),'Escape closes no-results state');
    check(await page.evaluate(()=>buildNavSearchItems('products')[0]?.title==='Products'),'English navigation results use English labels');
    await page.evaluate(()=>{
      closeSearchDropdown();
      transactions=[{_id:'shell-invoice',ref:'2772',type:'مبيعات',client:'Osama',items:[],total:1500,deposit:500,createdAt:'2026-10-10T10:00:00Z'}];
      currentPage='invoice-view';window._invoiceViewTxId='shell-invoice';window._invoiceViewRef='2772';
      _ivHydrateFull=()=>{};_ivLoadBostaDetails=()=>{};
      transactions[0].remaining=1000;
      qsa('.page').forEach(el=>el.classList.toggle('active',el.id==='page-invoice-view'));
      renderInvoiceViewPage();syncNavigationShell();
    });
    await page.waitForFunction(()=>qs('#shell-breadcrumb').textContent.includes('#2772'));
    check(await page.$eval('#shell-breadcrumb',el=>el.textContent.includes('Transactions') && !el.textContent.includes('Invoice')),'Invoice hierarchy appears in header');
    check(await page.$eval('#inv-view-content .shell-page-breadcrumb',el=>getComputedStyle(el).display==='none'),'No duplicate invoice breadcrumb on desktop');
    check(await page.$$eval('.inv2-header-actions > button',els=>els.length===2 && els.every(el=>/^(printInvoice|openCollectMovement)/.test(el.getAttribute('onclick')))),'Only print and collection are direct invoice actions');
    await page.click('.inv2-header-actions .dd-toggle');await pause();
    check(await page.$eval('.dd-menu-portal .inv2-menu-action[onclick^="openEditMovement"]',el=>el.textContent.trim().length>0),'Secondary edit action has a readable menu label');
    await page.evaluate(()=>{window.invoiceEditTarget=null;openEditMovement=id=>{window.invoiceEditTarget=id;};});
    await page.click('.dd-menu-portal .inv2-menu-action[onclick^="openEditMovement"]');
    await pause();
    check(await page.evaluate(()=>window.invoiceEditTarget==='shell-invoice'&&!qs('.dd-menu-portal.show')),'Invoice menu invokes the correct action and closes');
    await page.screenshot({path:path.join(root,'design-preview/refined-invoice.png')});
    await page.evaluate(()=>{transactions[0].ref='2773';renderInvoiceViewPage();});
    await page.waitForFunction(()=>qs('#shell-breadcrumb').textContent.includes('#2773'));
    check(await page.$eval('#shell-breadcrumb',el=>!el.textContent.includes('#2772')),'Invoice breadcrumb follows live content replacement');
    await page.setViewport({width:390,height:844});await pause();
    check(await page.$eval('#inv-view-content .shell-page-breadcrumb',el=>getComputedStyle(el).display!=='none'),'Invoice retains one usable breadcrumb on mobile');
    await page.click('.inv2-header-actions .dd-toggle');await pause();
    check(await page.$eval('.dd-menu-portal',el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;}),'Invoice actions menu fits mobile viewport');
    await page.evaluate(()=>closeAllMenus());
    await page.setViewport({width:1600,height:1000});await pause();
    await page.evaluate(()=>{currentPage='clients';qsa('.page').forEach(el=>el.classList.toggle('active',el.id==='page-clients'));syncNavigationShell();});
    await page.evaluate(()=>{currentLang='ar';document.documentElement.dir='rtl';buildSidebar();});
    await pause();
    check(await page.$eval('.shell-breadcrumb',el=>el.textContent.includes('العملاء')),'Arabic breadcrumb');
    check(await page.$eval('#header',el=>Math.round(el.getBoundingClientRect().right)===1352),'RTL header leaves sidebar space');
    await page.evaluate(()=>{document.body.classList.add('dark-mode');qs('#global-search').focus();});
    check(await page.$eval('#global-search',el=>getComputedStyle(el).transform==='none'),'Dark search does not scale');
    await page.evaluate(()=>{document.body.classList.remove('dark-mode');currentLang='en';document.documentElement.dir='ltr';currentPage='dashboard';qsa('.page').forEach(el=>el.classList.toggle('active',el.id==='page-dashboard'));qs('#global-search').placeholder=t('globalSearchPlaceholder');buildSidebar();closeSearchDropdown();});
    await pause();
    await page.evaluate(()=>{saveRecentSearch('Linen cushion');saveRecentSearch('Osama');qs('#global-search').value='';qs('#global-search').focus();renderRecentSearches();applyPrivacyMode();});
    await page.screenshot({path:path.join(root,'design-preview/implemented-history.png')});
    await page.keyboard.press('Escape');
    await page.screenshot({path:path.join(root,'design-preview/implemented-desktop.png')});
    await page.setViewport({width:390,height:844});await pause();
    await page.click('#hamburger-btn');await pause();
    check(await page.$eval('#sidebar',el=>el.classList.contains('open')),'Mobile drawer opens');
    await page.click('#sidebar [data-page="products"]');await pause();
    check(await page.$eval('#sidebar',el=>!el.classList.contains('open')),'Mobile navigation closes drawer');
    await page.click('#m-search-toggle');await pause();
    check(await page.$eval('.header-search',el=>el.classList.contains('m-search-open')),'Mobile search opens');
    const bounds=await page.$eval('#search-dropdown',el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}));
    check(bounds.left>=0 && bounds.right<=390,'Mobile history fits viewport');
    await page.screenshot({path:path.join(root,'design-preview/implemented-mobile.png')});
    await page.keyboard.press('Escape');
    check(await page.$eval('.header-search',el=>!el.classList.contains('m-search-open')),'Mobile Escape closes search');
    for (const direction of ['rtl','ltr']) {
      await page.evaluate(direction=>{currentLang=direction==='rtl'?'ar':'en';document.documentElement.dir=direction;buildSidebar();},direction);
      for (const width of [320,390,768,1024,1440]) {
        await page.setViewport({width,height:900});
        await page.evaluate(width=>{qs('.header-search').classList.toggle('m-search-open',width<=768);qs('#global-search').value='layout';toggleSearchClear('layout');},width);
        await pause();
        const layout=await page.evaluate(()=>{
          const input=qs('#global-search'),box=input.getBoundingClientRect(),style=getComputedStyle(input);
          const start=box.left+parseFloat(style.paddingLeft),end=box.right-parseFloat(style.paddingRight);
          const controls=['#global-search-scan','#search-clear-btn','.shell-search-shortcut','.search-icon-btn'].map(selector=>qs(selector)).filter(el=>el&&getComputedStyle(el).display!=='none').map(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,external:el.id==='global-search-scan'&&innerWidth>768};});
          const shell=qs('.header-search').getBoundingClientRect();
          return {start,end,left:box.left,right:box.right,shellLeft:shell.left,shellRight:shell.right,controls};
        });
        check(layout.end-layout.start>40,`Search text space ${direction} ${width}: ${JSON.stringify(layout)}`);
        // Desktop scanner intentionally sits beside the input, inside the search shell.
        check(layout.controls.every(c=>c.left>=(c.external?layout.shellLeft:layout.left)-1&&c.right<=(c.external?layout.shellRight:layout.right)+1&&(c.right<=layout.start+1||c.left>=layout.end-1)),`Search icons outside text ${direction} ${width}: ${JSON.stringify(layout)}`);
        check(layout.controls.every((a,i)=>layout.controls.slice(i+1).every(b=>a.right<=b.left||b.right<=a.left)),`Search icons separated ${direction} ${width}: ${JSON.stringify(layout)}`);
        if ([390,1440].includes(width)) await page.screenshot({path:path.join(root,`design-preview/search-controls-${direction}-${width}.png`)});
      }
    }
    await page.evaluate(()=>{qs('.header-search').classList.remove('m-search-open');closeSearchDropdown();});
    await page.evaluate(()=>{currentUser.role='staff';currentUser.perms=['products'];buildSidebar();});
    check(await page.$$eval('#sidebar [data-page="reports"]',rows=>rows.length===0),'No unauthorized reports row');
    check(await page.$$eval('#sidebar [data-page="products"]',rows=>rows.length===1),'Authorized product row remains');
    await page.evaluate(()=>{document.documentElement.dir='rtl';});await pause();
    check(await page.$eval('#global-search-scan',el=>el.hidden),'Scanner hidden without unit-view permission');
    check(await page.evaluate(()=>{const input=qs('#global-search'),style=getComputedStyle(input),shortcut=qs('.shell-search-shortcut').getBoundingClientRect();return shortcut.right<=input.getBoundingClientRect().left+parseFloat(style.paddingLeft);}), 'RTL shortcut remains outside text without scanner permission');
    assert.deepEqual(errors,[],'No browser runtime errors');
    console.log(`Navigation shell: ${checks} checks passed. Desktop and mobile screenshots saved.`);
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
