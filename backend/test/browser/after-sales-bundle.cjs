/* «طلبات تُشحن مع البديل»: a new sale shipped inside an exchange waybill.
   Real application HTML, mocked HTTP only: no customer, carrier or live database writes. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), dir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/after-sales-bundle'); fs.mkdirSync(output, { recursive: true });
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++; };
const eq = (a, b, message) => { assert.equal(a, b, message); checks++; };
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => errors.push(String(e.message || e)));
    await page.setViewport({ width: 1440, height: 1000 });
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
      window.saleB={_id:'555555555555555555555555',ref:'1002',type:'مبيعات',client:'عميل اختبار الاستبدال',total:950,discount:100,deposit:300,remaining:650,items:[{code:'B1',name:'سجادة جديدة',qty:1,total:1000}]};
      window.testInvoice={_id:'111111111111111111111111',ref:'1001',type:'مبيعات',client:saleB.client,phone:'01000000000',total:500,remaining:0,deliveredAt:new Date().toISOString(),items:[{lineId:'one',code:'ITEM',name:'طقم سفرة',qty:1,price:500,total:500}]};
      window.view=(extra={})=>({transactionId:saleB._id,ref:'1002',client:saleB.client,total:950,discount:100,deposit:300,remaining:650,cod:650,prepared:false,pickupStatus:'Pending',pendingDeposits:0,cancelled:false,linked:true,collected:false,items:[{code:'B1',name:'سجادة جديدة',qty:1,total:1000}],...extra});
      window.baseCase=()=>({_id:'222222222222222222222222',originalTransactionId:testInvoice._id,originalRef:'1001',client:testInvoice.client,reason:'customer-choice',requestKind:'exchange',createdAt:new Date().toISOString(),items:testInvoice.items,exchangeItems:[{name:'طقم سفرة أحمر',qty:1}],total:500,status:'معلق',bundleBlock:'',
        workflow:{version:2,ref:'AS-2026-000001',stage:'approved',approvedAt:new Date().toISOString(),replacementTxId:'666666666666666666666666',replacementRef:'202680000001',replacementPrepared:true,selectedLines:[{...testInvoice.items[0],lineIndex:0,unitIds:[]}],selectedUnits:[],history:[{action:'requested',by:'موظف',at:new Date().toISOString()}],quote:{credit:500,replacement:600,customerFee:50,creditApplied:500,collectDue:150,refundDue:0}}});
      window.testCase=baseCase();
      transactions=[testInvoice,saleB];buildSidebar=()=>{};buildNotifications=()=>{};syncVaultState=async()=>{};
      window.showConfirm=async()=>true;
      api=async(url,options={})=>{
        const body=options.body?JSON.parse(options.body):{};
        if(['POST','PATCH'].includes(options.method)) writes.push({url,body});
        if(url.endsWith('/bundle-candidates'))return {blocked:'',candidates:[
          {transactionId:saleB._id,ref:'1002',date:'2026-11-15',total:950,discount:100,deposit:300,remaining:650,prepared:false,pendingDeposits:1,items:saleB.items,block:''},
          {transactionId:'777777777777777777777777',ref:'1003',date:'2026-11-14',total:400,discount:0,deposit:0,remaining:400,prepared:false,pendingDeposits:0,items:[{code:'C',name:'وسادة',qty:2}],block:'الطلب من مخزن مختلف عن مخزن الاستبدال'}]};
        if(url.endsWith('/bundle')&&options.method==='POST'){testCase.workflow.bundledSales=[{transactionId:body.transactionId,ref:'1002'}];testCase.bundleView=[view()];testCase.bundleCod=800;return testCase;}
        if(url.endsWith('/unbundle')&&options.method==='POST'){testCase.workflow.bundledSales=[];delete testCase.bundleView;delete testCase.bundleCod;return testCase;}
        if(url.startsWith('/after-sales/'))return testCase;
        if(url==='/transactions')return transactions;
        return [];
      };
    });

    // 1. Approved exchange, nothing bundled yet: the card offers to add an order.
    await page.evaluate(async()=>{await AfterSales.open(testCase._id);});
    await page.waitForSelector('[data-as-section="bundle"]');
    ok(await page.$('[data-as-bundle-add]'), 'add button shown before the waybill');
    // The dialog animates in and resizes: a click mid-animation can land beside the button.
    await page.waitForFunction(() => !document.querySelector('.as-dialog')?.getAnimations({ subtree: true }).some(a => a.playState === 'running'));
    await page.click('[data-as-bundle-add]');
    try { await page.waitForSelector('[data-as-bundle-pick]', { timeout: 10000 }); }
    catch (error) {
      console.error('picker state:', await page.evaluate(() => ({ title: document.querySelector('#as-title')?.textContent, picker: document.querySelector('[data-as-bundle-picker]')?.textContent?.slice(0, 120) })));
      throw error;
    }
    const pickerText = await page.$eval('[data-as-bundle-picker]', n => n.textContent);
    ok(/#1002/.test(pickerText) && /#1003/.test(pickerText), 'both customer orders listed');
    ok(/مخزن مختلف/.test(pickerText), 'blocked order states why');
    eq(await page.$$eval('[data-as-bundle-pick]', b => b.length), 1, 'only the eligible order has a button');
    ok(/بانتظار الموافقة/.test(pickerText), 'a pending deposit is stated');
    await page.screenshot({ path: path.join(output, 'picker-ar-1440.png') });
    await page.click('[data-as-bundle-pick]');
    await page.waitForFunction(()=>writes.some(w=>w.url.endsWith('/bundle')));
    const bundleWrite = await page.evaluate(()=>writes.find(w=>w.url.endsWith('/bundle')));
    eq(bundleWrite.body.transactionId, '555555555555555555555555', 'sends the picked order');
    ok(bundleWrite.body.operationKey, 'with an operation key');

    // 2. The case lists the order and the waybill COD.
    await page.waitForSelector('.as-bundle-row');
    const card = await page.$eval('[data-as-section="bundle"]', n => n.textContent);
    ok(/#1002/.test(card) && /650/.test(card), 'bundled order with its COD');
    ok(/800/.test(card), 'waybill COD = 150 + 650');
    ok(/بانتظار التجهيز/.test(card), 'prep state shown');
    ok(/تجهيز الطلبات المضمومة/.test(await page.$eval('.as-steps', n=>n.textContent)), 'workflow step added');
    ok(/جهّز الطلبات المضمومة/.test(await page.$eval('.as-next-step', n=>n.textContent)), 'next action points at the added order');
    await page.screenshot({ path: path.join(output, 'case-ar-1440.png') });

    // 3. Remove it again.
    await page.click('[data-as-unbundle]');
    await page.waitForFunction(()=>writes.some(w=>w.url.endsWith('/unbundle')));
    eq(await page.evaluate(()=>writes.find(w=>w.url.endsWith('/unbundle')).body.transactionId), '555555555555555555555555', 'unbundle sends the order');

    // 4. Shipped and delivered: no edits, the settlement counts the added order.
    await page.evaluate(async()=>{
      testCase=baseCase();testCase.workflow.bundledSales=[{transactionId:saleB._id,ref:'1002'}];testCase.bundleView=[view({prepared:true})];testCase.bundleCod=800;
      Object.assign(testCase.workflow,{stage:'settlement',shipment:{status:'created',deliveryId:'d1',trackingNumber:'123456',cod:800,bundled:[{transactionId:saleB._id,ref:'1002',cod:650,shipCharged:50}]},receivedAt:new Date().toISOString(),replacementDeliveredAt:new Date().toISOString()});
      await AfterSales.open(testCase._id);
    });
    await page.waitForSelector('[data-as-section="bundle"]');
    eq(await page.$('[data-as-bundle-add]'), null, 'no add after the waybill');
    eq(await page.$('[data-as-unbundle]'), null, 'no remove after the waybill');
    await page.click('[data-as-action="settle"]');
    await page.waitForSelector('[data-as-net]');
    ok(/الطلبات المضمومة/.test(await page.$eval('input[name="includesCollection"]', n => n.closest('label').textContent)), 'transfer includes the added orders');
    await page.$eval('input[name="actualCost"]', n => { n.value = '70'; n.dispatchEvent(new Event('input', { bubbles: true })); });
    ok(/730/.test(await page.$eval('[data-as-net]', n => n.textContent)), 'net vault = 150 + 650 - 70');

    // 5. The bundled invoice says where it ships; index gates follow the case.
    const notice = await page.evaluate(()=>AfterSales.invoiceActions({...saleB,afterSalesBundle:{caseId:testCase._id,caseRef:'AS-2026-000001',shipmentPending:true}}));
    ok(/يُشحن هذا الطلب مع شحنة الاستبدال/.test(notice) && /AS-2026-000001/.test(notice), 'invoice notice');
    eq(await page.evaluate(()=>_bostaCaseId({_id:'x',afterSalesBundle:{caseId:'case-1'}})), 'case-1', 'prep send opens the case');
    ok(await page.evaluate(()=>_saleDepBlock({type:'مبيعات',afterSalesBundle:{caseId:'c',shipmentPending:true},remaining:650})), 'deposit blocked once the waybill exists');
    eq(await page.evaluate(()=>_saleDepBlock({type:'مبيعات',afterSalesBundle:{caseId:'c'},remaining:650,total:950})), '', 'deposit still allowed before the waybill');

    // 6. English, dark, phone width: the card fits.
    await page.setViewport({ width: 390, height: 900 });
    await page.evaluate(async()=>{currentLang='en';document.body.classList.add('dark-mode');testCase=baseCase();testCase.workflow.bundledSales=[{transactionId:saleB._id,ref:'1002'}];testCase.bundleView=[view({pendingDeposits:1})];testCase.bundleCod=800;await AfterSales.open(testCase._id);});
    await page.waitForSelector('.as-bundle-row');
    const en = await page.$eval('[data-as-section="bundle"]', n => n.textContent);
    ok(/Orders shipped with the replacement/.test(en) && /Waybill COD/.test(en), 'English labels');
    ok(/Deposit awaiting approval/.test(en), 'pending deposit badge');
    ok(await page.$eval('.as-body', n => n.scrollWidth <= n.clientWidth + 1), 'no sideways overflow at 390px');
    await page.$eval('[data-as-section="bundle"]', n => n.scrollIntoView());
    await page.screenshot({ path: path.join(output, 'case-en-390-dark.png') });

    // 7. «عربون على فرق الاستبدال»: paid 100 of the 150 difference, one request waiting.
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluate(async()=>{
      currentLang='ar';document.body.classList.remove('dark-mode');
      window.depositCalls=[];window.openSaleDeposit=async(...args)=>{depositCalls.push(args);};
      testCase=baseCase();testCase.workflow.bundledSales=[{transactionId:saleB._id,ref:'1002'}];testCase.bundleView=[view({prepared:true})];testCase.bundleCod=700;
      testCase.advance={due:150,paid:100,left:50,pending:1,deposits:[{id:'d1',amount:100,method:'كاش',by:'موظف',vaultTxNo:'TXN-9'}],requests:[{id:'w1',amount:30,method:'Instapay',status:'معلق',submittedBy:'موظف'}]};
      await AfterSales.open(testCase._id);
    });
    await page.waitForSelector('[data-as-section="advance"]');
    const adv = await page.$eval('[data-as-section="advance"]', n => n.textContent);
    ok(/عربون على فرق الاستبدال/.test(adv) && /100/.test(adv) && /50/.test(adv), 'paid and left of the difference');
    ok(/بانتظار الموافقة/.test(adv), 'waiting request listed');
    await page.waitForFunction(() => !document.querySelector('.as-dialog')?.getAnimations({ subtree: true }).some(a => a.playState === 'running'));
    await (await page.$('[data-as-section="financial"]')).screenshot({ path: path.join(output, 'advance-card-ar.png'), captureBeyondViewport: false });
    ok(/700/.test(await page.$eval('[data-as-section="bundle"]', n => n.textContent)), 'waybill COD = 50 left + 650');
    ok(/عربون على فرق الاستبدال بانتظار موافقة/.test(await page.$eval('.as-next-step', n => n.textContent)), 'next action: decide the deposit');
    await page.waitForFunction(() => !document.querySelector('.as-dialog')?.getAnimations({ subtree: true }).some(a => a.playState === 'running'));
    await page.click('[data-as-adv-approve="w1"]');
    await page.waitForFunction(()=>writes.some(w=>w.url.endsWith('/deposit-requests/w1/approve')));
    ok(await page.evaluate(()=>writes.some(w=>w.url==='/transactions/666666666666666666666666/deposit-requests/w1/approve')), 'approve hits the replacement invoice');
    await page.waitForSelector('[data-as-adv-add="image"]');
    await page.waitForFunction(() => !document.querySelector('.as-dialog')?.getAnimations({ subtree: true }).some(a => a.playState === 'running'));
    await page.click('[data-as-adv-add="image"]');
    await page.waitForFunction(()=>depositCalls.length===1);
    eq(JSON.stringify(await page.evaluate(()=>depositCalls[0])), JSON.stringify(['666666666666666666666666','image',false,'222222222222222222222222']), 'opens the usual deposit dialog on the replacement, returning to the case');
    eq(await page.evaluate(()=>!!document.querySelector('.as-dialog')?.open), false, 'case window closed so the deposit dialog is on top');
    // The replacement accepts a deposit before its waybill, not after (mirror of the server).
    const repl = { type: 'مبيعات', remaining: 50, total: 650, afterSales: { caseId: 'c', role: 'replacement' } };
    eq(await page.evaluate(r=>_saleDepBlock(r), repl), '', 'replacement takes a deposit before the waybill');
    ok(await page.evaluate(r=>_saleDepBlock({...r,afterSales:{...r.afterSales,shipmentPending:true}}), repl), 'refused after the waybill');
    ok(await page.evaluate(r=>_saleDepBlock({...r,afterSales:{caseId:'c',role:'return'}}), repl), 'a return invoice never takes one');
    // Settlement after the waybill: the exchange part is the frozen 50.
    await page.evaluate(async()=>{
      testCase=baseCase();testCase.workflow.bundledSales=[{transactionId:saleB._id,ref:'1002'}];testCase.bundleView=[view({prepared:true})];testCase.advance={due:150,paid:100,left:50,pending:0,deposits:[],requests:[]};
      Object.assign(testCase.workflow,{stage:'settlement',shipment:{status:'created',deliveryId:'d1',trackingNumber:'123456',exchangeCod:50,cod:700,bundled:[{transactionId:saleB._id,ref:'1002',cod:650,shipCharged:50}]},receivedAt:new Date().toISOString(),replacementDeliveredAt:new Date().toISOString()});
      await AfterSales.open(testCase._id);
    });
    await page.waitForSelector('[data-as-action="settle"]');
    await page.click('[data-as-action="settle"]');
    await page.waitForSelector('[data-as-net]');
    await page.$eval('input[name="actualCost"]', n => { n.value = '70'; n.dispatchEvent(new Event('input', { bubbles: true })); });
    ok(/630/.test(await page.$eval('[data-as-net]', n => n.textContent)), 'net vault = 50 + 650 - 70');
    ok(/700/.test(await page.$eval('input[name="includesCollection"]', n => n.closest('label').textContent)), 'transfer amount stated');
    await page.screenshot({ path: path.join(output, 'advance-settle-ar-1440.png') });

    const own = errors.filter(e => !/Chart|XLSX|io is not|socket|SouliaDateRange is not defined/i.test(e));
    eq(own.length, 0, 'no page errors: ' + own.join(' | '));
    console.log(`PASS after-sales bundle: ${checks} checks`);
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
