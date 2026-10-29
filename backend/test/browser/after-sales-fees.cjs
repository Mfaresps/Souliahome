/* Real application HTML, mocked HTTP only: no customer, carrier or live database writes. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), dir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/after-sales-fees'); fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => { let n=0; if(!crypto.randomUUID) Object.defineProperty(crypto,'randomUUID',{ value:()=>String(++n).padStart(8,'0')+'-0000-4000-8000-000000000000' }); });
    await page.setRequestInterception(true);
    page.on('request', r => {
      const url = new URL(r.url());
      if(url.origin === 'http://soulia.test' && url.pathname === '/') return r.respond({status:200,contentType:'text/html',body:fs.readFileSync(path.join(dir,'index.html'),'utf8')});
      if(['/after-sales.js','/after-sales.css','/order-status.js','/design-system.css','/approvals-compact.css'].includes(url.pathname)) return r.respond({status:200,contentType:url.pathname.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(path.join(dir,url.pathname.slice(1)))});
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
    await page.evaluate(() => {
      window.testFeesEnabled = true;
      const baseApi = api;
      api = async (url, options = {}) => {
        if (url === '/after-sales/quote') {
          const body = JSON.parse(options.body); writes.push({url, body});
          const replacement = body.kind === 'exchange' ? 300 : 0;
          const customerFee = body.reason === 'customer-choice' && testFeesEnabled ? body.customerFee : 0;
          const delta = replacement - 500 + customerFee;
          return {quote:{credit:500,replacement,customerFee,refundDue:Math.max(0,-delta),collectDue:Math.max(0,delta)}};
        }
        const result = await baseApi(url, options);
        if (url.startsWith('/after-sales/invoice/')) result.policy.customerFeesEnabled = testFeesEnabled;
        return result;
      };
    });
    const setFee = async value => {
      await page.$eval('[name=customerFee]', (e,value) => {e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}, String(value));
    };
    const expectRefund = async value => {
      try {
        await page.waitForFunction(value => document.querySelector('[data-as-quote] .as-total b')?.textContent.includes(value), {timeout:5000}, value);
      } catch(error) {
        throw new Error(`Expected refund ${value}: ${await page.$eval('[data-as-quote]',e=>e.textContent)}; ${JSON.stringify(await page.evaluate(()=>writes.at(-1)))}`, {cause:error});
      }
    };
    for (const lang of ['ar','en']) for (const width of [1440,390]) {
      await page.setViewport({width,height:1000});
      await page.evaluate(async lang => {currentLang=lang;await AfterSales.create(testInvoice._id);},lang);
      await page.$eval('[data-as-qty]',e=>{e.value='1';e.dispatchEvent(new Event('change',{bubbles:true}));});
      await page.click('[data-as-unit]');
      await page.type('[name=feeBasis]','Agreed cost');
      await expectRefund('450');
      await page.select('[name=fulfillmentChannel]','direct');
      assert.equal(await page.$eval('[name=customerFee]',e=>e.disabled),false);
      assert.equal(await page.$eval('[name=customerFee]',e=>e.value),'0');
      await setFee(75.25);
      await expectRefund('424.75');
      await page.select('[name=fulfillmentChannel]','bosta');
      assert.equal(await page.$eval('[name=customerFee]',e=>e.value),'75.25');
      for(const reason of ['defect','wrong-item']) {
        await page.select('[name=reason]',reason);
        assert.equal(await page.$eval('[name=customerFee]',e=>e.disabled),true);
        await expectRefund('500');
      }
      await page.select('[name=reason]','customer-choice');
      assert.equal(await page.$eval('[name=customerFee]',e=>e.value),'75.25');
      await page.select('[name=kind]','exchange');
      await page.click('[data-as-add]');
      await page.$eval('[data-as-pick="444444444444444444444444"]',e=>e.click());
      await page.waitForSelector('[data-as-replacement]');
      await setFee(60.50);
      await expectRefund('139.5');
      await page.select('[name=fulfillmentChannel]','direct');
      assert.equal(await page.$eval('[name=customerFee]',e=>e.value),'60.5');
      await page.select('[name=kind]','return');
      assert.equal(await page.$eval('[name=customerFee]',e=>e.value),'75.25');
      await page.$eval('[data-as-reset-fee]',e=>e.click());
      await expectRefund('500');
      await page.select('[name=fulfillmentChannel]','bosta');
      assert.equal(await page.$eval('[name=customerFee]',e=>e.value),'50');
      await setFee(0);
      await expectRefund('500');
      await setFee(-1);
      assert.equal(await page.$eval('[name=customerFee]',e=>e.checkValidity()),false);
      await setFee(75.25);
      await page.select('[name=fulfillmentChannel]','direct');
      await expectRefund('424.75');
      assert.equal(await page.$eval('.as-body',e=>e.scrollWidth<=e.clientWidth+1),true,`fee form overflow ${lang}/${width}`);
      await page.screenshot({path:path.join(output,`manual-fee-${lang}-${width}.png`)});
      await page.$eval('[data-as-create]',e=>e.requestSubmit());
      await page.waitForSelector('[data-as-flow]');
      const saved = await page.evaluate(()=>writes.filter(w=>w.url==='/after-sales').at(-1).body);
      assert.equal(saved.customerFee,75.25);
      assert.equal(saved.fulfillmentChannel,'direct');
      assert.equal(saved.reason,'customer-choice');
    }
    await page.evaluate(async()=>{testFeesEnabled=false;await AfterSales.create(testInvoice._id);});
    assert.equal(await page.$eval('[name=customerFee]',e=>e.disabled),true);
    assert.equal(await page.$eval('[name=customerFee]',e=>e.value),'0');
    console.log('PASS manual fees: direct/shipped, returns/exchanges, net refund, defaults/zero, reason restrictions, saved payload, Arabic/English desktop/mobile');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
