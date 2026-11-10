const assert = require('node:assert/strict');
const puppeteer = require('../backend/node_modules/puppeteer');
(async () => {
  const browser = await puppeteer.launch({headless: true});
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack));
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('token', 'tabs-preview');
      localStorage.setItem('soulia-push-prompt:', 'dismissed');
      localStorage.setItem('user', JSON.stringify({name:'Tabs preview',role:'admin',perms:[]}));
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) return request.continue();
      let body = [];
      if (url.pathname === '/api/auth/me') body = {name:'Tabs preview',role:'admin',perms:[]};
      if (url.pathname === '/api/settings') body = {};
      if (url.pathname === '/api/notifications' || url.pathname === '/api/notifications/preferences') body = {preferences:{enabled:false},subscriptions:[],language:'ar'};
      if (url.pathname === '/api/shopify/orders/summary-page') body = {
        rows:[],page:1,limit:30,total:0,allCount:0,pendingCount:0,tabCount:0,
        filterCounts:{},baseCount:0,starredCount:0,filteredIds:[],selectionRows:[],
        depositSummary:{instapay:0,vodafone:0,paidCount:0,unpaidCount:0},
        panelFacets:{status:{},staff:{},tags:{},comments:0,stock:{}},
        pendingCancelCount:0,pendingEditCount:0,kpiStats:null
      };
      return request.respond({status:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await page.setViewport({width:1440,height:900});
    await page.goto('http://127.0.0.1:8080/#shopify-orders',{waitUntil:'networkidle2'});
    await page.waitForFunction(() => document.querySelector('#page-shopify-orders.active #sp-subnav-perf:not([hidden])') && !document.querySelector('#splash-screen'));
    await page.evaluate(() => { window.maybePromptPush = () => {}; closeModal(); });
    for (const language of ['ar', 'en']) {
      await page.evaluate(lang => changeLang(lang), language);
      for (const width of [390, 768, 1440]) {
        await page.setViewport({width,height:900});
        await page.evaluate(() => switchShopifySubnav('orders', true));
        await new Promise(resolve => setTimeout(resolve, 350));
        assert.equal(await page.$eval('#sp-subnav',el=>getComputedStyle(el).flexDirection),'row');
        assert.equal(await page.$eval('#sp-subnav-shell',el=>el.tagName),'DIV');
        assert.ok(await page.$eval('#sp-subnav-orders',(el,width)=>el.getBoundingClientRect().height >= (width<=768?44:32),width));
        await page.screenshot({path:`artifacts/shopify-inline-tabs-${language}-${width}.png`});
        for (const tab of ['deposits','deposit-log','perf','orders']) {
          await page.evaluate(tab => switchShopifySubnav(tab), tab);
          await new Promise(resolve => setTimeout(resolve, 350));
          const result = await page.evaluate(tab => {
            const bar = document.querySelector('#sp-subnav'), selected = document.querySelector('#sp-subnav-'+tab);
            const a = selected.getBoundingClientRect(), b = bar.getBoundingClientRect();
            const indicator = getComputedStyle(bar,'::before');
            const x = new DOMMatrixReadOnly(indicator.transform).m41 + b.left + bar.clientLeft - bar.scrollLeft;
            return {selected:selected.getAttribute('aria-selected'),visible:a.left>=b.left-1&&a.right<=b.right+1,aligned:Math.abs(x-a.left)<2,overflow:document.documentElement.scrollWidth > innerWidth+1};
          },tab);
          assert.equal(result.selected,'true');
          assert.ok(result.visible,`${language} ${width} ${tab}: visible`);
          assert.ok(result.aligned,`${language} ${width} ${tab}: indicator aligned`);
          assert.equal(result.overflow,false,`${language} ${width} ${tab}: page overflow`);
        }
      }
    }
    assert.deepEqual(errors,[]);
    console.log('PASS full app: section routes, persistent tabs, indicator alignment, RTL/LTR and 390/768/1440 screenshots.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });

