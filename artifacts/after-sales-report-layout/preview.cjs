/* Real application HTML, mocked HTTP only: no customer, carrier or live database writes. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('../../backend/node_modules/puppeteer');
const root = path.resolve(__dirname, '../..'), dir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/after-sales-report-layout'); fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { let n=0; if(!crypto.randomUUID) Object.defineProperty(crypto,'randomUUID',{ value:()=>String(++n).padStart(8,'0')+'-0000-4000-8000-000000000000' }); });
    await page.setRequestInterception(true);
    page.on('request', r => {
      const url = new URL(r.url());
      if(url.origin === 'http://soulia.test' && url.pathname === '/') return r.respond({status:200,contentType:'text/html',body:fs.readFileSync(path.join(dir,'index.html'),'utf8')});
      if(['/after-sales.js','/after-sales.css','/order-status.js','/design-system.css','/approvals-compact.css','/order-status.css'].includes(url.pathname)) return r.respond({status:200,contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(path.join(dir,url.pathname.slice(1)))});
      if(r.resourceType()==='script') return r.respond({status:200,contentType:'text/javascript',body:'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});'});
      return r.respond({status:200,contentType:'application/json',body:'[]'});
    });
    await page.goto('http://soulia.test/',{waitUntil:'domcontentloaded'});
    await page.evaluate(() => {
      currentUser={_id:'operator',role:'admin',perms:[]};currentLang='ar';currentPage='dashboard';
      document.querySelector('#app').style.display='';document.querySelector('#login-page').style.display='none';document.querySelector('#splash-screen')?.remove();
      window.writes=[];
      window.testProductImage='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==';
      window.testInvoice={_id:'111111111111111111111111',ref:'1001',type:'مبيعات',client:'عميل اختبار الاستبدال',phone:'01000000000',total:500,remaining:0,deliveredAt:new Date().toISOString(),items:[{lineId:'one',code:'ITEM',name:'طقم سفرة',qty:1,price:500,total:500}]};
      window.testCase={_id:'222222222222222222222222',originalTransactionId:testInvoice._id,originalRef:'1001',client:testInvoice.client,reason:'customer-choice',requestKind:'exchange',createdAt:new Date().toISOString(),items:testInvoice.items,exchangeItems:[{name:'طقم بديل',qty:1}],total:500,status:'معلق',workflow:{version:2,ref:'AS-222222222222222222222222',stage:'approved',approvedAt:new Date().toISOString(),selectedLines:[{...testInvoice.items[0],lineIndex:0,unitIds:['333333333333333333333333']}],selectedUnits:['333333333333333333333333'],history:[{action:'requested',by:'موظف',at:new Date().toISOString()}],quote:{credit:500,replacement:600,customerFee:50,creditApplied:500,collectDue:150,refundDue:0}}};
      transactions=[testInvoice];buildSidebar=()=>{};buildNotifications=()=>{};syncVaultState=async()=>{};
      api=async(url,options={})=>{
        const body=options.body?JSON.parse(options.body):{};
        if(options.method==='POST') writes.push({url,body});
        if(url==='/after-sales/shipping/cities')return [{id:'city-cairo',name:'Cairo',nameAr:'القاهرة'}];
        if(url==='/after-sales/shipping/cities/city-cairo/districts')return [...Array.from({length:120},(_,i)=>({id:'district-'+i,name:'Other district '+i,nameAr:'منطقة أخرى '+i,pickupAvailability:true,dropOffAvailability:true})),{id:'district-customer',name:'Nasr City',nameAr:'مدينة نصر',pickupAvailability:true,dropOffAvailability:true}];
        if(url.startsWith('/after-sales/invoice/'))return {invoice:testInvoice,prior:[],cases:[],identities:{lines:[{lineId:'one',current:[{unitId:'333333333333333333333333',barcode:'SU-333333333333333333333333'}]}]},products:[{_id:'444444444444444444444444',code:'NEW',name:'طقم بديل',sellPrice:600,available:8,imageUrl:testProductImage}],policy:{customerFeesEnabled:true,returnFee:50,exchangeFee:50,feePolicyNote:'حالة مسموحة وفق السياسة'}};
        if(url==='/after-sales/quote')return {quote:{credit:500,replacement:body.kind==='exchange'?600:0,customerFee:50,creditApplied:body.kind==='exchange'?500:0,collectDue:body.kind==='exchange'?150:0,refundDue:body.kind==='exchange'?0:450}};
        if(url==='/after-sales'&&options.method==='POST')return testCase;
        if(url==='/after-sales')return [testCase];
        if(url.startsWith('/after-sales/report'))return {rows:[testCase],summary:{total:1,open:1,closed:0,exchanges:1,returns:0,refunded:0,collected:0,refundPending:0,collectPending:150,carrierCost:0,damagedValue:0}};
        if(url.startsWith('/after-sales/'))return testCase;
        if(url==='/transactions')return [testInvoice];
        return [];
      };
    });

    await page.evaluate(()=>{
      const clients=['Nour Fathy','Sara Taha','\u0639\u0644\u064a\u0627\u0621 \u0647\u0634\u0627\u0645','Manar hani Hani'];
      window.reportRows=clients.map((client,i)=>({...testCase,_id:'case-'+i,client,originalRef:['2817','2867','2790','2545'][i],total:[726.68,1196.43,750,617.9][i],workflow:{...testCase.workflow,stage:i<2?'requested':'shipping',shipment:i<2?null:{deliveryId:'shipment-'+i,carrierStatus:'IN_TRANSIT',trackingNumber:i===2?'3437687987':'4725253629'}}}));
      const previousApi=api;api=async(url,options)=>url.startsWith('/after-sales/report')?{rows:reportRows,summary:{open:4,closed:0,exchanges:4,returns:0,refunded:0,carrierCost:0,refundPending:60,collectPending:246.89,damagedValue:0}}:previousApi(url,options);
    });
    const results=[];
    for(const lang of ['ar','en'])for(const width of [1440,838,390]){
      await page.setViewport({width,height:1000});
      await page.evaluate(async lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';await AfterSales.report();},lang);
      await new Promise(r=>setTimeout(r,250));
      const layout=await page.evaluate(()=>{
        const body=document.querySelector('.as-body'),wrap=document.querySelector('.as-report-table-wrap');
        return {bodyOverflow:body.scrollWidth>body.clientWidth+1,tableScroll:wrap.scrollWidth>wrap.clientWidth+1,rows:document.querySelectorAll('.as-report-table tbody tr').length,clipped:[...document.querySelectorAll('.as-report-table td,.as-report-shipment')].filter(el=>el.scrollWidth>el.clientWidth+1).length};
      });
      assert.equal(layout.bodyOverflow,false);assert.equal(layout.rows,4);assert.equal(layout.clipped,0);if(width===1440)assert.equal(layout.tableScroll,false);if(width===390)assert.equal(layout.tableScroll,true);
      results.push({lang,width,...layout});
      await page.screenshot({path:path.join(output,lang+'-'+width+'.png')});
    }
    await page.evaluate(()=>{reportRows=[];return AfterSales.report();});assert.ok(await page.$('.as-report-empty'));
    await page.evaluate(()=>{reportRows=[testCase];return AfterSales.report();});await page.click('.as-report-table [data-as-open]');await page.waitForSelector('[data-as-section="status"]');
    fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
