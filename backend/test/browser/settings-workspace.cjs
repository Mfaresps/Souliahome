const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../../frontend/public');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
if (!process.argv.includes('--settings-only')) for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) new vm.Script(match[1]);
const start = html.indexOf('<div class="page" id="page-settings">');
const end = html.indexOf('</div><!-- /page-settings -->', start) + '</div><!-- /page-settings -->'.length;
const navigation = html.slice(html.indexOf('const STG_INNER_PAGES ='), html.indexOf('/* Show/hide promotions placeholder'));
new vm.Script(navigation);
(async () => {
 const browser = await puppeteer.launch({ headless: true });
 try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', req => req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: `<html dir="rtl"><body><div id="main">${html.slice(start,end)}</div></body></html>` }));
  await page.goto('https://soulia.test/');
  await page.addStyleTag({ content: html.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1] });
  for (const name of ['navigation-shell.css','notification-settings.css','announcements.css','settings-responsive.css']) await page.addStyleTag({ path: path.join(root,name) });
  await page.evaluate(() => {
   window.qs = s => document.querySelector(s); window.qsa = s => [...document.querySelectorAll(s)];
   window.admin = true; window.isAdmin = () => window.admin; window.currentLang = 'ar'; window.t = key => key;
   document.querySelector('#page-settings').classList.add('active');
   for (const id of ['emp-shifts-section','emp-leaves-section','emp-perf-criteria-section','stg-shopify-card']) document.getElementById(id).style.display = '';
   document.getElementById('stg-shopify-card').innerHTML='<div class="stg-card-title-text"><strong>Shopify connection</strong></div>';
  });
  await page.addScriptTag({ content: navigation });
  await page.evaluate(() => {
   const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
   qs('#emp-shifts-table-body').innerHTML='<table class="sm-tbl"><thead><tr><th class="sm-emp-h">Employee</th>'+days.map(day=>'<th class="sm-day-h"><span class="sm-day-n">'+day+'</span><span class="sm-day-c">1 employee</span><span class="sm-day-oc">No on-call</span></th>').join('')+'<th class="sm-act-h">Actions</th></tr></thead><tbody>'+['Gannh','Reem','Hassan Ammar','Rana Nour'].map((name,i)=>'<tr><td class="sm-emp"><div class="sm-emp-n">'+name+'</div><div class="sm-emp-m">'+(i?'No schedule':'7 days ? 84h')+'</div></td>'+days.map(()=>i?'<td class="sm-cell is-off"><span class="sm-off">Rest</span></td>':'<td class="sm-cell k-morning"><span class="sm-t" dir="ltr">09:00?21:00</span><span class="sm-k">Morning</span></td>').join('')+'<td class="sm-act"><button class="btn btn-sm">Edit</button></td></tr>').join('')+'</tbody></table>';
   stgRestoreTab();
  });
  assert.equal(await page.$('.stg-shortcuts'),null,'Top shortcuts must be removed');
  await page.setViewport({width:2249,height:1100});
  await page.evaluate(()=>stgOpenInnerPage('shipping',qs('[data-inner-tab="shipping"]')));
  await new Promise(resolve=>setTimeout(resolve,400));
  const compact=await page.evaluate(()=>({page:qs('.settings-page-inner').getBoundingClientRect().width,price:qs('#set-cairo-price').getBoundingClientRect().width,height:qs('#set-cairo-price').getBoundingClientRect().height,name:qs('#new-ship-name').getBoundingClientRect().width,button:qs('.settings-ship-add .btn').getBoundingClientRect().width}));
  assert.ok(compact.page<=1180 && compact.price<=160 && compact.height<=36 && compact.name<=220 && compact.button<200,JSON.stringify(compact));
  await page.screenshot({path:path.resolve(__dirname,'../../../artifacts/settings-shipping-wide.png'),fullPage:true});
  for (const width of [320,390,768,1440]) {
   await page.setViewport({width,height:1000});
   for (const dir of ['rtl','ltr']) {
    await page.evaluate(dir => { document.documentElement.dir=dir; currentLang=dir==='rtl'?'ar':'en'; },dir);
    for (const target of ['notifications','appearance','workforce','shipping','integrations','security','printing','promotions','advertising','data']) {
     await page.evaluate(target => {
      const btn=qs('#stg-sidebar [data-inner-tab="'+target+'"]') || qs('#stg-sidebar [data-tab="'+target+'"]');
      btn.click();
     },target);
     await new Promise(resolve => setTimeout(resolve,220));
     const overflow=await page.evaluate(() => [...document.querySelectorAll('.stg-content,.stg-content-heading,.stg-panels,.stg-panel.active,.stg-shortcut')].filter(e=>e.getClientRects().length).filter(e=>{const r=e.getBoundingClientRect();return r.left < -1 || r.right > innerWidth+1;}).map(e=>e.className));
     assert.deepEqual(overflow,[],`${width} ${dir} ${target} overflow`);
     assert.equal(await page.$$eval('#stg-sidebar [aria-selected="true"]', els=>els.length),1);
     if(target==='workforce') {
      const sizes=await page.evaluate(()=>{const wrap=qs('#emp-shifts-table-wrap');const body=wrap.closest('.settings-pref-body');const card=body.closest('.settings-card');return {wrap:wrap.clientWidth,body:body.clientWidth,card:card.clientWidth,scroll:wrap.scrollWidth};});
      assert.ok(sizes.wrap>=sizes.body-3 && sizes.body>=sizes.card-35,JSON.stringify(sizes));
      if(width===1440) assert.ok(sizes.scroll<=sizes.wrap+1,'Full weekly table must fit on desktop: '+JSON.stringify(sizes));
     }
    }
   }
  }
  await page.evaluate(() => { stgOpenInnerPage('appearance',qs('[data-inner-tab="appearance"]')); qs('#stg-search').value='shipping'; stgSearch('shipping'); });
  assert.ok(await page.$('.stg-search-result'));
  const duplicates=await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(el=>el.id);return ids.filter((id,i)=>ids.indexOf(id)!==i);});
  assert.deepEqual(duplicates,[],'Search must not duplicate form IDs');
  await page.click('.stg-search-result');
  assert.equal(await page.$eval('#stg-search',el=>el.value),'');
  assert.equal(await page.$('#stg-search-results'),null);
  assert.ok(await page.$eval('#stg-ship-defaults-card',el=>el.getClientRects().length>0));
  await page.evaluate(()=>{stgOpenInnerPage('appearance',qs('[data-inner-tab="appearance"]'));stgSearch('no-match-123');stgSearch('');});
  assert.equal(await page.$eval('#stg-sidebar [aria-selected="true"]',el=>el.dataset.innerTab),'appearance');
  await page.setViewport({width:1440,height:1000});
  await page.focus('#stg-sidebar [data-inner-tab="appearance"]');
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.$eval('#stg-sidebar [aria-selected="true"]',el=>el.dataset.innerTab),'workforce');
  await page.evaluate(()=>{admin=false;qs('#stg-mov-kpi-card').style.display='none';stgSearch('kpi');});
  assert.equal(await page.$('.stg-search-result'),null,'Hidden controls must not appear in search');
  await page.evaluate(()=>{admin=true;currentLang='ar';document.documentElement.dir='rtl';stgSearch('');stgOpenInnerPage('appearance',qs('[data-inner-tab="appearance"]'));});
  await page.evaluate(()=>document.activeElement?.blur());
  await new Promise(resolve=>setTimeout(resolve,400));
  await page.screenshot({path:path.resolve(__dirname,'../../../artifacts/settings-desktop.png'),fullPage:true});
  await page.setViewport({width:390,height:844});
  await new Promise(resolve=>setTimeout(resolve,400));
  await page.screenshot({path:path.resolve(__dirname,'../../../artifacts/settings-mobile.png'),fullPage:true});
  await page.setViewport({width:1440,height:1000});
  await page.evaluate(()=>stgOpenInnerPage('workforce',qs('[data-inner-tab="workforce"]')));
  await new Promise(resolve=>setTimeout(resolve,400));
  await page.screenshot({path:path.resolve(__dirname,'../../../artifacts/settings-shifts-table.png'),fullPage:true});
  console.log('PASS: settings navigation syntax; 10 destinations at four widths in RTL/LTR; search opens original controls without duplicate IDs; search restoration; keyboard navigation; hidden controls.');
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});

