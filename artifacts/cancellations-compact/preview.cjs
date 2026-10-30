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

    await page.evaluate(()=>{
      const base={code:'customer-refused-deposit',stage:'shopify',client:'Customer',date:'2026-10-20',lostValue:1250,refunded:0};
      fixture.cancellations.recent=[
        {...base,ref:'1001',requestedBy:'Amira Sales',approvedBy:'Ziad Manager',cancelledBy:'Ziad Manager',by:'Amira Sales',cancellationMode:'approved-request'},
        {...base,ref:'1002',requestedBy:'Zeinab Sales',approvedBy:'Ali Manager',by:'Zeinab Sales',cancellationMode:'approved-request'},
        {...base,ref:'1003',requestedBy:'',approvedBy:'',cancelledBy:'Direct Admin',by:'Direct Admin',cancellationMode:'direct'},
        {...base,ref:'1004',requestedBy:'',approvedBy:'Known Reviewer',cancelledBy:'Known Reviewer',by:'',cancellationMode:'approved-request'},
        {...base,ref:'1005',requestedBy:'',approvedBy:'',cancelledBy:'Shopify',by:'Shopify',cancellationMode:'system'}
      ];
    });
    for(const lang of ['ar','en'])for(const width of [1440,1180,390]){
      await page.setViewport({width,height:1000});
      await page.evaluate(lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';renderCancellationsReport(fixture);},lang);
      assert.equal(await page.$$eval('#cxr-thead th',els=>els.length),9);
      assert.equal(await page.$eval('#cxr-thead .cxr-c-requester',el=>el.nextElementSibling.classList.contains('cxr-c-approver')),true);
      assert.equal(await page.$eval('#cxr-tbody .cxr-requester',el=>el.nextElementSibling.classList.contains('cxr-approver')),true);
      if(width>=1180)assert.equal(await page.$eval('.cxr-scroll',el=>el.scrollWidth<=el.clientWidth+1),true,'compact table fits desktop');
      assert.equal(await page.$eval('#cxr-tbody tr .cxr-requester',el=>el.textContent.trim()),'Amira Sales');
      assert.equal(await page.$eval('#cxr-tbody tr .cxr-approver',el=>el.textContent.trim()),'Ziad Manager');
      assert.equal(await page.$eval('#cxr-tbody tr:nth-child(4) .cxr-requester',el=>el.textContent.includes('Known Reviewer')),false);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      await page.$eval('.cxr-tbl-card',el=>el.scrollIntoView({block:'start'}));
      await page.screenshot({path:path.join(__dirname,lang+'-'+width+'.png')});
    }
    await page.type('#cxr-search','Ziad Manager');await new Promise(r=>setTimeout(r,250));
    assert.equal(await page.$$eval('#cxr-tbody tr',els=>els.length),1);
    assert.equal(await page.$eval('#cxr-tbody .cxr-requester',el=>el.textContent),'Amira Sales');
    await page.evaluate(()=>{resetCxrFilters();onCxrSearch('Zeinab Sales');});await new Promise(r=>setTimeout(r,250));
    assert.equal(await page.$eval('#cxr-tbody .cxr-ref',el=>el.textContent),'1002');
    await page.evaluate(()=>resetCxrFilters());
    await page.click('#cxr-thead .cxr-c-requester');
    assert.equal(await page.$eval('#cxr-tbody .cxr-requester',el=>el.textContent),'Zeinab Sales');
    await page.click('#cxr-thead .cxr-c-approver');
    assert.equal(await page.$eval('#cxr-tbody .cxr-approver',el=>el.textContent),'Ziad Manager');
    await page.evaluate(()=>onCxrSearch('no-such-person'));await new Promise(r=>setTimeout(r,250));
    assert.equal(await page.$eval('#cxr-tbody td',el=>el.colSpan),9);
    await page.setViewport({width:1180,height:1000});
    await page.evaluate(()=>{
      fixture.cancellations.recent[0].note='A detailed customer explanation. '.repeat(15);
      fixture.cancellations.recent[0].lostValue=1234567.89;
      fixture.cancellations.recent[0].refunded=234567.89;
      fixture.cancellations.recent[1].note='Short note';
      renderCancellationsReport(fixture);resetCxrFilters();
    });
    const compactHeight=await page.$eval('.cxr-note-details',el=>el.closest('tr').getBoundingClientRect().height);
    assert.equal(await page.$eval('.cxr-note-details',el=>el.open),false);
    await page.click('.cxr-note-details summary');
    assert.equal(await page.$eval('.cxr-note-details',el=>el.open),true);
    assert.ok(await page.$eval('.cxr-note-details',el=>el.closest('tr').getBoundingClientRect().height)>compactHeight);
    await page.click('.cxr-note-details summary');
    assert.equal(await page.$$eval('.cxr-tbl td.cxr-money',cells=>cells.filter(cell=>cell.scrollWidth>cell.clientWidth+1).length),0,'financial values remain inside their columns');
    await page.screenshot({path:path.join(__dirname,'compact-notes.png')});
    console.log('Passed adjacent actor columns, compact desktop width and expandable notes; requester priority, separate approver, missing attribution, direct/system labels, both-name search and sorting, empty colspan and Arabic/English desktop/mobile layout.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
