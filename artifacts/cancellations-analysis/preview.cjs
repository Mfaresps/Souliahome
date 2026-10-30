const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('../../backend/node_modules/puppeteer');
const publicDir = path.resolve(__dirname, '../../frontend/public');
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== 'http://soulia.test') return request.abort();
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(publicDir, relative);
      if (file.startsWith(publicDir + path.sep) && fs.existsSync(file) && ['.html','.css','.js','.svg'].includes(path.extname(file))) {
        return request.respond({ contentType: {'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'}[path.extname(file)], body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ contentType:'text/javascript', body:'window.Chart=class{static register(){} destroy(){}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ contentType:'application/json', body:'[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentUser={_id:'preview',role:'admin',perms:[]};currentLang='ar';
      document.querySelectorAll('link[rel=stylesheet]').forEach(link=>document.head.appendChild(link));
      document.body.innerHTML='<main style="padding:24px;max-width:1800px;margin:auto"><div id="rep-cancellations-body"></div></main>';
      const codes = CANCEL_REASONS.slice(0,10).map(reason=>reason.code);
      const counts=[54,11,8,5,5,5,3,3,1,1];
      const breakdown=codes.flatMap((code,i)=>[{code,stage:'shopify',count:counts[i]-(i===3?1:0),lostValue:counts[i]*1250,refunded:0},...(i===3?[{code,stage:'transaction',count:1,lostValue:1500,refunded:300}]:[])]);
      const recent=breakdown.flatMap(b=>Array.from({length:b.count},(_,i)=>({ref:`${b.code}-${i}`,code:b.code,stage:b.stage,client:'عميل تجريبي',date:'2026-10-20',lostValue:1250,refunded:0,by:'Operator'})));
      const names=['طقم عشاء بورسلين أبيض — 24 قطعة','صينية تقديم خشب','طقم أكواب زجاج','مفرش سفرة قطن','طبق تقديم سيراميك','منظّم أدوات المطبخ','سلّة تخزين','مزهرية زجاج','طقم ملاعق','حامل مناديل','فنجان قهوة','برطمان توابل','طبق حلويات','اسم منتج طويل جدًا لاختبار التفاف النص بدون تداخل مع عدد الطلبات والقطع'];
      const products=names.map((name,i)=>({key:'id:'+i,name,code:'SKU-'+i,breakdown:[{code:codes[0],stage:'shopify',orderCount:30-i,quantity:i===1?120:40-i},{code:codes[3],stage:'transaction',orderCount:1,quantity:2}],orderCount:31-i,quantity:(i===1?120:40-i)+2}));
      window.fixture={cancellations:{total:96,shopifyCount:95,transactionCount:1,lostValue:194000,refunded:300,avgHoursToCancel:12,unspecified:0,breakdown,products,productCoverage:[{code:codes[0],stage:'shopify',orders:54,missingOrders:2,partialOrders:1,excludedOrders:0},{code:codes[3],stage:'transaction',orders:1,missingOrders:0,partialOrders:0,excludedOrders:0}],recent}};
      window.fixtureCodes=codes;
      currentReportData=fixture;
    });
    const results=[];
    for(const lang of ['ar','en'])for(const width of [1744,1440,390])for(const dark of [false,true]){
      await page.setViewport({width,height:1100});
      await page.evaluate(({lang,dark})=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',dark);renderCancellationsReport(fixture);}, {lang,dark});
      const size=await page.evaluate(()=>({width:innerWidth,body:document.documentElement.scrollWidth,products:document.querySelectorAll('.cxra-product-table tbody tr').length,reasons:document.querySelectorAll('.cxra-reason-table tbody tr').length}));
      if(size.body>size.width+1)console.log(await page.evaluate(()=>[...document.querySelectorAll('#rep-cancellations-body *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>innerWidth||r.left<0||r.right>innerWidth;}).slice(0,25).map(el=>({tag:el.tagName,cls:el.className,width:el.getBoundingClientRect().width,left:el.getBoundingClientRect().left}))));
      assert.ok(size.body<=size.width+1,JSON.stringify(size));assert.equal(size.products,10);assert.equal(size.reasons,10);
      await page.screenshot({path:path.join(__dirname,`${lang}-${width}${dark?'-dark':''}.png`),fullPage:true});results.push({lang,width,dark,...size});
    }
    await page.select('[data-cxra-sort]','units');
    assert.equal(await page.$eval('.cxra-product-table tbody tr .cxra-sku',el=>el.textContent),'SKU-1');
    await page.click('[data-cxra-more]');assert.equal(await page.$$eval('.cxra-product-table tbody tr',rows=>rows.length),14);
    await page.evaluate(()=>setCxrStage('transaction'));
    assert.equal(await page.$$eval('.cxra-reason-table tbody tr',rows=>rows.length),1);
    assert.equal(await page.$eval('.cxra-total',el=>el.textContent.trim()),'1 orders');
    await page.evaluate(()=>setCxrReason(fixtureCodes[0]));
    assert.ok(await page.$('.cxra-products .cxra-empty'));
    await page.evaluate(()=>{resetCxrFilters();onCxrSearch('not-found');});
    await new Promise(r=>setTimeout(r,250));
    assert.match(await page.$eval('#cxr-tbody',el=>el.textContent),/No rows match/);
    assert.equal(await page.$$eval('.cxra-reason-table tbody tr',rows=>rows.length),10,'table search leaves analytics intact');
    await page.evaluate(()=>{resetCxrFilters();fixture.cancellations.products=[];renderCancellationsReport(fixture);});
    assert.ok(await page.$('.cxra-products .cxra-empty'));
    await page.evaluate(()=>{fixture.cancellations.total=0;renderCancellationsReport(fixture);});
    assert.ok(await page.$('.cxr-empty'));
    fs.writeFileSync(path.join(__dirname,'checks.json'),JSON.stringify(results,null,2));
    console.log('Passed 12 responsive language/theme previews, product sorting/expansion, combined filters, search isolation and empty states.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
