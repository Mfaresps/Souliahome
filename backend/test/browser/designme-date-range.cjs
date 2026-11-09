const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({headless:true,pipe:true});
  try {
    const page = await browser.newPage();
    if (process.env.DESIGNME_WIDTH) await page.setViewport({width:Number(process.env.DESIGNME_WIDTH),height:844});
    const source = fs.readFileSync(path.resolve(__dirname,'../../../frontend/public/index.html'),'utf8');
    const markup = source.match(/<div class="rep-date-range">[\s\S]*?<\/div>/)?.[0];
    assert.ok(markup, 'reports date controls are present in index.html');
    await page.setContent(`<!doctype html><html lang="ar" dir="rtl"><head><style>:root{--primary:#2d7a4f;--primary-pale:#e8f5ee;--surface:#fff;--surface2:#f5f6f7;--border:#e5e7eb;--text:#151a17;--muted:#647067}</style></head><body><div id="page-reports">${markup}</div><script>window.calls=[];window.onReportRangeChange=()=>calls.push('/transactions/reports?from='+document.querySelector('#rep-from').value+'&to='+document.querySelector('#rep-to').value)</script></body></html>`);
    await page.addStyleTag({path:path.resolve(__dirname,'../../../frontend/public/designme/date-range-picker/soulia-range.css')});
    await page.addScriptTag({path:path.resolve(__dirname,'../../../frontend/public/designme/date-range-picker/soulia-range.js')});
    await page.evaluate(() => SouliaDateRange.attach('#rep-from','#rep-to',{anchor:document.querySelector('.rep-date-range'),presets:['today','yesterday','last7','last30','quarter','thisMonth','lastMonth','last90']}));
    await page.click('.soulia-range-trigger');
    assert.equal(await page.$eval('.soulia-drx',e=>e.getAttribute('dir')),'rtl');
    assert.equal(await page.$eval('.soulia-range-trigger',e=>e.textContent.trim()),'');
    assert.equal(await page.$eval('.soulia-range-popover .drx-direction',e=>e.textContent),'←');
    assert.equal(await page.$eval('.soulia-range-popover',e=>{const r=e.getBoundingClientRect();return Math.abs(r.left-(innerWidth-r.right))<=1}),true);
    assert.equal(await page.$eval('.soulia-range-popover',e=>getComputedStyle(e).animationDuration),'0.16s');
    if (process.env.DESIGNME_SCREENSHOT) await page.screenshot({path:process.env.DESIGNME_SCREENSHOT});
    await page.click('.soulia-range-popover .drx-quarter-open');
    assert.equal(await page.$eval('.soulia-range-popover .drx-quarter-screen',e=>e.hidden),false);
    assert.equal(await page.$eval('.soulia-range-popover .drx-quarter-screen',e=>getComputedStyle(e).animationDuration),'0.15s');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#rep-from').value,document.querySelector('#rep-to').value,calls.length]),['','',0]);
    assert.equal(await page.$eval('.soulia-range-popover .drx-quarter-open',e=>e.getAttribute('aria-expanded')),'true');
    if (process.env.DESIGNME_QUARTER_SCREENSHOT) await page.screenshot({path:process.env.DESIGNME_QUARTER_SCREENSHOT});
    await page.click('.soulia-range-popover .drx-quarter-back');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#rep-from').value,document.querySelector('#rep-to').value,calls.length]),['','',0]);
    assert.equal(await page.$eval('.soulia-range-popover .drx-quarter-open',e=>e.getAttribute('aria-expanded')),'false');
    const today=await page.evaluate(() => SouliaDateRange.iso(new Date()));
    for (const id of ['today','yesterday','last7','last30','quarter','thisMonth','lastMonth','last90']) {
      await page.click(`.drx-p[data-p="${id}"]`);
      const expected=await page.evaluate(id => {const [a,b]=SouliaDateRange.presets[id](new Date());return [SouliaDateRange.iso(a),SouliaDateRange.iso(b)]},id);
      assert.equal(await page.$eval(`.drx-p[data-p="${id}"]`,e=>e.getAttribute('aria-pressed')),'true');
      assert.equal(await page.$eval('.drx-ok',e=>e.disabled),false);
      assert.equal(await page.$eval('#rep-from',e=>e.value),''); // draft selection leaves filters alone
      if (id==='last90') {
        await page.click('.drx-ok');
        assert.deepEqual(await page.evaluate(() => [document.querySelector('#rep-from').value,document.querySelector('#rep-to').value]),expected);
      }
    }
    assert.equal(await page.evaluate(() => calls.length),1);
    assert.match(await page.evaluate(() => calls[0]),/^\/transactions\/reports\?from=\d{4}-\d\d-\d\d&to=\d{4}-\d\d-\d\d$/);
    await page.click('.soulia-range-trigger');
    await page.click('.drx-clr');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#rep-from').value,document.querySelector('#rep-to').value]),['','']);
    assert.equal(await page.evaluate(() => calls.length),2);
    await page.click('.soulia-range-trigger');
    const dates=await page.$$eval('.drx-cal[data-o="0"] .drx-d[data-date]',xs=>xs.slice(5,7).map(x=>x.dataset.date));
    await page.click(`.drx-d[data-date="${dates[0]}"]`);
    assert.equal(await page.$eval('.drx-ok',e=>e.disabled),false); // open ended filters remain possible
    await page.click(`.drx-d[data-date="${dates[1]}"]`);
    await page.click('.drx-ok');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#rep-from').value,document.querySelector('#rep-to').value]),dates);
    assert.equal(await page.evaluate(() => calls.length),3);
    await page.click('.soulia-range-trigger');
    await page.click('.drx-open-end');
    await page.click('.drx-ok');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#rep-from').value,document.querySelector('#rep-to').value]),[dates[0],'']);
    assert.equal(await page.evaluate(() => calls.length),4);
    const cairo = await page.evaluate(() => {
      const root=document.createElement('div'); document.body.append(root);
      let applied;
      SouliaDateRange.mount(root,{today:()=> '2026-01-01',max:'2026-01-01',presets:['last7'],onApply:(a,b)=>applied=[a,b]});
      root.querySelector('[data-p="last7"]').click(); root.querySelector('.drx-ok').click();
      return {applied, futureDisabled:root.querySelector('[data-date="2026-01-02"]')?.disabled};
    });
    assert.deepEqual(cairo.applied,['2025-12-26','2026-01-01']);
    assert.equal(cairo.futureDisabled,true);
    const future = await page.evaluate(() => {
      const root=document.createElement('div'); root.id='future-case'; document.body.append(root);
      let applied=false;
      SouliaDateRange.mount(root,{today:()=> '2026-11-08',max:'2026-12-31',presets:['today'],onApply:()=>applied=true});
      const current=root.querySelector('[data-date="2026-11-08"]');
      const next=root.querySelector('[data-date="2026-11-09"]');
      current.focus(); current.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
      const keyboardStayed=document.activeElement===current;
      next.click();
      root.querySelector('.drx-ok').click();
      return {currentEnabled:!current.disabled,futureDisabled:next.disabled,faded:Number(getComputedStyle(next).opacity)<.4,keyboardStayed,applyDisabled:root.querySelector('.drx-ok').disabled,applied};
    });
    assert.deepEqual(future,{currentEnabled:true,futureDisabled:true,faded:true,keyboardStayed:true,applyDisabled:true,applied:false});
    await page.evaluate(() => {
      const root=document.createElement('div'); root.id='quarter-case'; document.body.append(root);
      SouliaDateRange.mount(root,{today:()=> '2026-11-08',presets:['quarter'],onApply:(a,b)=>window.quarterApplied=[a,b]});
    });
    await page.click('#quarter-case .drx-quarter-open');
    assert.deepEqual(await page.$$eval('#quarter-case .drx-quarter-item',xs=>xs.map(x=>x.textContent.trim())),['Q3 2026','Q2 2026','Q1 2026','Q4 2025']);
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.from),'2026-07-01');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.from),'2026-04-01');
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#quarter-case .drx-quarter-screen',e=>e.hidden),true);
    await page.click('#quarter-case .drx-quarter-open');
    await page.click('#quarter-case .drx-quarter-back');
    assert.equal(await page.$eval('#quarter-case .drx-quarter-screen',e=>e.hidden),true);
    await page.click('#quarter-case .drx-quarter-open');
    await page.click('#quarter-case .drx-quarter-item[data-from="2026-07-01"]');
    assert.equal(await page.$eval('#quarter-case .drx-quarter-screen',e=>e.hidden),true);
    assert.equal(await page.evaluate(() => window.quarterApplied),undefined);
    await page.click('#quarter-case .drx-ok');
    assert.deepEqual(await page.evaluate(() => quarterApplied),['2026-07-01','2026-09-30']);
    await page.click('#quarter-case .drx-quarter-open');
    await page.click('#quarter-case .drx-quarter-item[data-from="2025-10-01"]');
    assert.deepEqual(await page.evaluate(() => quarterApplied),['2026-07-01','2026-09-30']);
    await page.click('#quarter-case .drx-ok');
    assert.deepEqual(await page.evaluate(() => quarterApplied),['2025-10-01','2025-12-31']);
    const english = await page.evaluate(() => {
      document.documentElement.lang='en'; document.documentElement.dir='ltr';
      const root=document.createElement('div'); document.body.append(root);
      SouliaDateRange.mount(root,{today:()=> '2026-11-08'});
      root.querySelector('.drx-quarter-open').click();
      return [root.querySelector('.drx-quarter-head strong').textContent,root.querySelector('.drx-quarter-back').textContent,root.dir];
    });
    assert.deepEqual(english,['Quarters','←','ltr']);
    const direct = await page.evaluate(() => {
      const button=document.createElement('button'); button.id='direct-date-icon'; button.textContent='◫'; button.style.cssText='position:fixed;top:8px;left:8px'; document.body.append(button);
      const old=document.createElement('div'); old.id='old-date-menu'; old.innerHTML='<input type="date" id="direct-from"><input type="date" id="direct-to"><button>Date range</button>'; document.body.append(old);
      let applied=null;
      SouliaDateRange.attach('#direct-from','#direct-to',{trigger:'#direct-date-icon',anchor:old,presets:['today'],onCommit:(a,b)=>{applied=[a,b];}});
      button.click();
      const result={oldHidden:getComputedStyle(old).display==='none',open:!document.querySelector('.soulia-range-popover').hidden,arrow:document.querySelector('.soulia-range-popover .drx-direction').textContent};
      document.querySelector('.soulia-range-popover [data-p="today"]').click();
      document.querySelector('.soulia-range-popover .drx-ok').click();
      result.applied=applied; result.closed=document.querySelector('.soulia-range-popover').hidden;
      return result;
    });
    assert.equal(direct.oldHidden,true);
    assert.equal(direct.open,true);
    assert.equal(direct.arrow,'→');
    assert.equal(direct.closed,true);
    assert.deepEqual(direct.applied,[today,today]);
    await page.evaluate(() => { window.currentLang='en'; document.body.insertAdjacentHTML('beforeend','<div id="kpi-test" style="position:fixed;top:8px;left:70px"></div>'); });
    await page.addScriptTag({path:path.resolve(__dirname,'../../../frontend/public/shopify-kpis.js')});
    const kpi = await page.evaluate(() => {
      const host=document.querySelector('#kpi-test'); host.innerHTML=_spkPeriodHtml();
      const button=host.querySelector('#spk-period-btn'); button.click();
      const first={open:!document.querySelector('.soulia-range-popover').hidden,oldMenu:!!document.querySelector('#spk-period-menu')};
      document.querySelector('.soulia-range-popover [data-p="last3"]').click();
      document.querySelector('.soulia-range-popover .drx-ok').click();
      first.three=_spkPeriod==='three';
      button.click(); document.querySelector('.soulia-range-popover .drx-quarter-open').click();
      document.querySelector('.soulia-range-popover .drx-quarter-item[data-from="2026-07-01"]').click();
      document.querySelector('.soulia-range-popover .drx-ok').click();
      first.custom=_spkPeriod==='custom'&&_spkCustomFrom==='2026-07-01'&&_spkCustomTo==='2026-09-30';
      button.click(); document.querySelector('.soulia-range-popover .drx-clr').click();
      first.clear=_spkPeriod==='today';
      return first;
    });
    assert.deepEqual(kpi,{open:true,oldMenu:false,three:true,custom:true,clear:true});
    const bootstrap=source.slice(source.lastIndexOf('<script>')+8,source.lastIndexOf('</script>'));
    await page.setContent(`<!doctype html><html lang="en" dir="ltr"><head></head><body>
      <button id="shopify-filter-icon-btn" onclick="window.oldShopifyOpen=true">Calendar</button>
      <div id="shopify-date-filter-bar"><button>Today</button><button>Date range</button><input type="date" id="shopify-date-from"><input type="date" id="shopify-date-to" onchange="window.shopifyChanges++"></div>
      <button id="mov-date-btn" onclick="window.oldMovOpen=true">Calendar</button>
      <script>window.shopifyChanges=0;window.fxState={mov:{dateFrom:'',dateTo:'',dateField:'transactionDate'}};window.t=x=>x;window._closeAllFxSortMenus=()=>{};window._updateMovDateLabel=()=>{};window.movPage=2;window.renderMovements=()=>window.movRenders=(window.movRenders||0)+1;window.setMovDateField=x=>{fxState.mov.dateField=x;renderMovements()};</script>
    </body></html>`);
    await page.addStyleTag({path:path.resolve(__dirname,'../../../frontend/public/designme/date-range-picker/soulia-range.css')});
    await page.addScriptTag({path:path.resolve(__dirname,'../../../frontend/public/designme/date-range-picker/soulia-range.js')});
    await page.addScriptTag({content:bootstrap});
    await page.click('#shopify-filter-icon-btn');
    assert.equal(await page.evaluate(() => !window.oldShopifyOpen && getComputedStyle(document.querySelector('#shopify-date-filter-bar')).display==='none' && !document.querySelector('.soulia-range-popover').hidden),true);
    await page.click('.soulia-range-popover [data-p="today"]'); await page.click('.soulia-range-popover .drx-ok');
    assert.deepEqual(await page.evaluate(() => [shopifyChanges,document.querySelector('#shopify-date-from').value,document.querySelector('#shopify-date-to').value]),[1,today,today]);
    await page.click('#shopify-filter-icon-btn'); await page.click('.soulia-range-popover .drx-clr');
    assert.deepEqual(await page.evaluate(() => [shopifyChanges,document.querySelector('#shopify-date-from').value,document.querySelector('#shopify-date-to').value]),[2,'','']);
    await page.click('#mov-date-btn');
    assert.equal(await page.evaluate(() => !window.oldMovOpen && !document.querySelector('#mov-date-menu') && !!document.querySelector('.soulia-range-date-field')),true);
    await page.click('.soulia-range-date-field [data-field="createdAt"]');
    await page.click('.soulia-range-popover [data-p="last7"]'); await page.click('.soulia-range-popover .drx-ok');
    assert.equal(await page.evaluate(() => fxState.mov.dateField==='createdAt' && !!fxState.mov.dateFrom && !!fxState.mov.dateTo && movPage===1 && movRenders>=2),true);
    console.log('DesignMe date range: presets, selection, Apply, Clear, centered popup, RTL/LTR arrows, Shopify and movements icon callbacks passed; today='+today);
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
