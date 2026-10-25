/* Real application HTML, mocked HTTP only: no customer, carrier or live database writes. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), dir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/after-sales'); fs.mkdirSync(output, { recursive: true });
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
    for(const lang of ['ar','en']) for(const width of [1440,390]) {
      await page.setViewport({width,height:width===390?844:1000});
      await page.evaluate(async lang=>{currentLang=lang;await AfterSales.open(testCase._id);},lang);
      assert.equal(await page.$eval('.as-body',e=>e.scrollWidth<=e.clientWidth+1),true,`case overflow ${lang}/${width}`);
      assert.doesNotMatch(await page.$eval('.as-summary',e=>e.textContent),/[٠-٩]/,'numbers match the system in both languages');
      assert.equal(await page.$eval('.as-dialog',e=>{const r=e.getBoundingClientRect();return Math.abs(r.left+r.width/2-innerWidth/2)<3&&Math.abs(r.top+r.height/2-innerHeight/2)<3;}),true,`case centered ${lang}/${width}`);
      await page.click('[data-as-step=receive]');
      assert.equal(await page.evaluate(()=>document.activeElement?.dataset.asAction),'receive','step navigation focuses the one available action');
      assert.equal(await page.$$eval('[data-as-action=receive]',buttons=>buttons.length),1);
      if(width===390){
        const before=await page.$eval('.as-body',body=>{body.scrollTop=180;return body.scrollTop;});
        await page.$eval('[data-as-action=receive]',button=>button.click());
        await page.click('[data-as-back]');
        await page.waitForSelector('[data-as-flow]');
        assert.equal(await page.$eval('.as-body',body=>body.scrollTop>=100),before>=100,'back restores case scroll position');
      }
      await page.screenshot({path:path.join(output,`case-${lang}-${width}.png`)});
      assert.equal(await page.$$eval('[data-as-action=receive],[data-as-next=receive]',buttons=>buttons.length),1,'receive action appears only once');
      await page.evaluate(async()=>{testCase.workflow.receivedAt=new Date().toISOString();await AfterSales.open(testCase._id);});
      await page.click('[data-as-action=settle]');
      await page.waitForSelector('[data-as-settlement-wait]');
      assert.equal(await page.$('select[name=kind]'),null,'ineligible settlement has an explanation instead of an empty select');
      assert.equal(await page.$eval('.as-body',e=>e.scrollWidth<=e.clientWidth+1),true);
      await page.screenshot({path:path.join(output,`settlement-wait-${lang}-${width}.png`)});
      await page.evaluate(async()=>{testCase.workflow.replacementDeliveredAt=new Date().toISOString();await AfterSales.open(testCase._id);});
      await page.click('[data-as-action=settle]');
      assert.equal(await page.$eval('select[name=kind]',e=>e.options.length),2);
      assert.equal(await page.$eval('.as-body',e=>e.scrollWidth<=e.clientWidth+1),true);
      await page.select('select[name=kind]','carrier');
      assert.equal(await page.$eval('[data-as-carrier-fields]',e=>e.hidden),false);
      await page.screenshot({path:path.join(output,`settlement-ready-${lang}-${width}.png`)});
      await page.evaluate(()=>{delete testCase.workflow.receivedAt;delete testCase.workflow.replacementDeliveredAt;});
      await page.click('[data-as-back]');
      await page.waitForSelector('[data-as-action=ship]');
      await page.click('[data-as-action=ship]');
      assert.equal(await page.$eval('.as-dialog',e=>{const r=e.getBoundingClientRect();return Math.abs(r.left+r.width/2-innerWidth/2)<3&&Math.abs(r.top+r.height/2-innerHeight/2)<3&&r.width<=620;}),true,`action centered and compact ${lang}/${width}`);
      await page.evaluate(()=>AfterSales.create(testInvoice._id,'exchange'));
      assert.equal(await page.$eval('.as-body',e=>e.scrollWidth<=e.clientWidth+1),true,`form overflow ${lang}/${width}`);
      assert.equal(await page.$eval('.as-dialog',e=>{const r=e.getBoundingClientRect();return Math.abs(r.left+r.width/2-innerWidth/2)<3&&Math.abs(r.top+r.height/2-innerHeight/2)<3;}),true,`form centered ${lang}/${width}`);
    }
    await page.select('.as-dialog select[name=kind]','exchange');
    await page.$eval('[data-as-qty]',e=>{e.value='1';e.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.click('[data-as-unit]');
    await page.click('[data-as-add]');await page.type('[data-as-search]','طقم بديل');
    await page.click('[data-as-pick="444444444444444444444444"]');
    assert.match(await page.$eval('[data-as-replacement-list]',e=>e.textContent),/طقم بديل/);
    assert.equal(await page.$eval('[data-as-replacement-list] img',e=>e.alt),'طقم بديل');
    assert.equal(await page.$eval('[data-as-pick="444444444444444444444444"]',e=>e.disabled),true,'no duplicate product rows');
    await page.click('[data-as-plus]');
    assert.equal(await page.$eval('[data-as-replacement-qty]',e=>e.value),'2');
    await page.click('[data-as-minus]');
    assert.match(await page.$eval('[data-as-exchange-summary]',e=>e.textContent),/One piece for one piece/);
    await page.type('[name=feeBasis]','Allowed policy reason');
    await page.screenshot({path:path.join(output,'replacement-picker-mobile.png')});
    await page.click('[data-as-create] button[type=submit]');
    await page.waitForFunction(()=>document.querySelector('[data-as-action="receive"]'));
    await page.evaluate(async()=>{testCase.workflow.shipment={status:'created',deliveryId:'waybill',trackingNumber:'9528380106'};await AfterSales.open(testCase._id);});
    assert.equal(await page.$$eval('[data-as-action=receive],[data-as-next=receive]',buttons=>buttons.length),1,'received shipment has one receive action');
    await page.screenshot({path:path.join(output,'single-receive-action-mobile.png')});
    await page.evaluate(()=>{delete testCase.workflow.shipment;});
    assert.equal(await page.evaluate(()=>writes.filter(w=>w.url==='/after-sales').length),1);
    assert.deepEqual(await page.evaluate(()=>writes.find(w=>w.url==='/after-sales').body.items[0].unitIds),['333333333333333333333333']);
    await page.click('[data-as-action=receive]');
    await page.click('[name=physicalPossessionConfirmed]');
    await page.click('[data-as-receive] button[type=submit]');
    assert.equal(await page.evaluate(()=>writes.filter(w=>w.url.endsWith('/receive')).length),0,'missing identity must block receipt');
    await page.select('[data-as-label-state]','intact');await page.click('[data-as-attached]');
    await page.click('[data-as-receive] button[type=submit]');
    await page.waitForFunction(()=>writes.some(w=>w.url.endsWith('/receive')));
    assert.equal(await page.evaluate(()=>writes.filter(w=>w.url.endsWith('/receive')).length),1);
    await page.evaluate(async()=>{testCase.workflow.selectedLines[0].qty=2;testCase.workflow.selectedLines[0].unitIds.push('555555555555555555555555');await AfterSales.open(testCase._id);});
    await page.click('[data-as-action=receive]');await page.select('[data-as-condition]','mixed');
    assert.equal(await page.$eval('[data-as-damaged-qty]',e=>!e.hidden&&!e.disabled),true);
    await page.select('[data-as-label="333333333333333333333333"] [data-as-label-state]','intact');
    await page.select('[data-as-label="555555555555555555555555"] [data-as-label-state]','intact');
    await page.select('[data-as-label="555555555555555555555555"] [data-as-unit-condition]','تالف');
    await page.$$eval('[data-as-attached]',inputs=>inputs.forEach(input=>input.checked=true));
    await page.click('[name=physicalPossessionConfirmed]');
    await page.screenshot({path:path.join(output,'mixed-receipt-mobile.png')});
    await page.click('[data-as-receive] button[type=submit]');
    await page.waitForFunction(()=>writes.filter(w=>w.url.endsWith('/receive')).length===2);
    const mixed=await page.evaluate(()=>writes.filter(w=>w.url.endsWith('/receive'))[1].body);
    assert.equal(mixed.items[0].damagedQty,1);assert.equal(mixed.identities[1].condition,'تالف');
    await page.evaluate(()=>AfterSales.report());
    await page.waitForSelector('[data-as-report-results] table');
    assert.equal(await page.$eval('.as-body',e=>e.scrollWidth<=e.clientWidth+1),true,'report mobile overflow');
    await page.screenshot({path:path.join(output,'report-mobile.png')});
    await page.evaluate(async()=>{
      testCase.requestKind='return';testCase.exchangeItems=[];
      testCase.workflow.quote={credit:500,replacement:0,customerFee:50,creditApplied:0,collectDue:0,refundDue:450};
      await AfterSales.open(testCase._id);
    });
    assert.equal(await page.$eval('[data-as-flow]',e=>e.dataset.asFlow),'return');
    const returnText=await page.$eval('.as-body',e=>e.textContent);
    assert.doesNotMatch(returnText,/Replacement Pending|Prepare replacement|Replacement delivery|Replacement value|Difference collected|credit transferred to replacement/i);
    assert.match(returnText,/Net customer refund/);
    assert.equal(await page.$('[data-as-action=delivery]'),null);
    assert.match(await page.$eval('[data-as-action=ship]',e=>e.textContent),/collect return/i);
    await page.screenshot({path:path.join(output,'return-path-mobile.png')});
    assert.match(await page.$eval('.as-next-step',e=>e.textContent),/customer address/);
    await page.click('[data-as-action=ship]');
    await page.waitForSelector('select[name=customerCityId] option[value=city-cairo]');
    await page.click('[data-as-combo=customerCityId] [data-as-combo-search]');
    await page.type('[data-as-combo=customerCityId] [data-as-combo-search]','Cairo');
    await page.click('[data-as-combo=customerCityId] [role=option]');
    await page.waitForSelector('select[name=customerDistrictId] option[value=district-customer]');
    await page.click('[data-as-combo=customerDistrictId] [data-as-combo-search]');
    await page.type('[data-as-combo=customerDistrictId] [data-as-combo-search]','Nasr');
    assert.equal(await page.$$eval('[data-as-combo=customerDistrictId] [role=option]',items=>items.length),1);
    assert.equal(await page.$eval('[data-as-combo=customerDistrictId] .as-combo-list',e=>{const r=e.getBoundingClientRect(),body=e.closest('.as-body').getBoundingClientRect();return r.top>=body.top-1&&r.bottom<=body.bottom+1;}),true,'district list remains inside the dialog scroll area');
    await page.screenshot({path:path.join(output,'searchable-district-open-mobile.png')});
    await page.keyboard.press('Enter');
    assert.equal(await page.$eval('select[name=customerDistrictId]',e=>e.value),'district-customer');
    await page.screenshot({path:path.join(output,'searchable-district-mobile.png')});
    await page.type('[name=customerPhone]','01000000000');
    await page.type('[name=customerFirstLine]','Customer confirmed return address');
    await page.click('[data-as-action-form] button[type=submit]');
    await page.waitForFunction(()=>writes.some(w=>w.url.endsWith('/ship')));
    assert.deepEqual(await page.evaluate(()=>writes.find(w=>w.url.endsWith('/ship')).body.customerAddress),{cityId:'city-cairo',districtId:'district-customer',firstLine:'Customer confirmed return address',phone:'01000000000',customerName:'عميل اختبار الاستبدال'});
    await page.evaluate(()=>AfterSales.create(testInvoice._id,'return'));
    assert.equal(await page.$eval('#as-title',e=>e.textContent),'Product return request');
    assert.equal(await page.$eval('[data-as-replacements]',e=>e.hidden),true);
    await page.$eval('[data-as-qty]',e=>{e.value='1';e.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForSelector('[data-as-summary-kind="return"]');
    assert.doesNotMatch(await page.$eval('[data-as-quote]',e=>e.textContent),/Replacement value/);
    await page.select('select[name=kind]','exchange');
    assert.equal(await page.$eval('#as-title',e=>e.textContent),'Product exchange request');
    assert.equal(await page.$eval('[data-as-replacements]',e=>e.hidden),false);
    await page.evaluate(() => {
      document.querySelector('.as-dialog').close();
      const host = document.createElement('div'); host.id = 'audit-fixture'; document.body.appendChild(host);
      testInvoice.afterSalesEvents = [{ caseId:testCase._id, caseRef:'AS-2026-000001', action:'received-and-inspected', by:'Operator', at:new Date().toISOString(), originalRef:'1001', returnRef:'RT-2026-000001' }];
      host.innerHTML = AfterSales.timeline(testInvoice) + AfterSales.ledgerDetails({ afterSalesId:testCase._id, afterSales:{ caseRef:'AS-2026-000001',originalRef:'1001',grossCollection:150,carrierCost:70,net:80,creditApplied:500,paymentReference:'PAY-1' } });
    });
    const shipping = await page.evaluate(() => {
      const tx = { bostaStatus:'DELIVERED', afterSales:{ shipments:{ one:{caseId:testCase._id,kind:'return',deliveryId:'return-1',trackingNumber:'12345',status:'IN_TRANSIT'} } } };
      return { badge:_bostaStatusBadge(tx), card:AfterSales.orderBadge(tx), pickup:_puDisplayStatus({bostaStatus:'IN_TRANSIT',pickupStatus:'Ready',afterSales:{caseId:'one',shipments:tx.afterSales.shipments}}) };
    });
    assert.match(shipping.badge,/Delivered/); assert.match(shipping.badge,/as-operation-return/); assert.match(shipping.badge,/aria-label="Return/); assert.match(shipping.badge,/12345/);
    assert.match(shipping.card,/12345/); assert.equal(shipping.pickup,'Shipped');
    const shipmentCell = await page.evaluate(() => {
      const host=document.createElement('div');host.id='as-movement-shipment-fixture';host.style.cssText='width:340px;margin:12px auto';document.body.appendChild(host);
      const tx={bostaStatus:'CREATED',afterSales:{shipments:{one:{caseId:testCase._id,kind:'return',deliveryId:'return-1',trackingNumber:'9528380106',status:'CREATED'}}}};
      host.innerHTML='<table id="mov-table" style="width:340px;table-layout:fixed"><tr><td style="width:70px">USER</td><td style="width:100px">TAG</td><td data-col="bosta" style="width:170px;text-align:center;white-space:nowrap"><span class="mov-bosta-line">'+_bostaStatusBadge(tx)+'</span></td></tr></table>';
      const cell=host.querySelector('td[data-col=bosta]').getBoundingClientRect(),icon=host.querySelector('.as-operation-icon'),badge=icon.getBoundingClientRect();
      return {inside:badge.left>=cell.left-1&&badge.right<=cell.right+1,tracking:icon.title.includes('9528380106'),iconOnly:icon.textContent.trim()===''};
    });
    assert.deepEqual(shipmentCell,{inside:true,tracking:true,iconOnly:true});
    await (await page.$('#as-movement-shipment-fixture')).screenshot({path:path.join(output,'operation-icon-in-table.png')});
    const audit = await page.$eval('#audit-fixture', e=>e.textContent);
    assert.equal(await page.$$eval('.as-case-path',nodes=>nodes.length),1);
    assert.equal(await page.$$eval('.as-path-events .is-latest',nodes=>nodes.length),1);
    assert.match(audit,/RT-2026-000001/); assert.match(audit,/PAY-1/); assert.match(audit,/150/); assert.match(audit,/80/);
    await page.click('#audit-fixture button');
    await page.waitForFunction(()=>document.querySelector('.as-dialog').open);
    await page.evaluate(()=>document.querySelector('.as-dialog').close());
    const filters = await page.evaluate(() => {
      const base={...testInvoice,items:testInvoice.items,createdAt:new Date().toISOString(),payStatus:'مكتمل'};
      const rows=[
        {...base,_id:'a11111111111111111111111',ref:'8101',afterSalesEvents:[{caseId:'r1',kind:'return'}]},
        {...base,_id:'a22222222222222222222222',ref:'8102',afterSalesEvents:[{caseId:'e1',kind:'exchange'}]},
        {...base,_id:'a33333333333333333333333',ref:'8103',afterSales:{caseId:'e1',role:'replacement',kind:'exchange'}},
        {...base,_id:'a44444444444444444444444',ref:'RT-8104',type:'مرتجع',afterSales:{caseId:'e1',role:'return',kind:'exchange'}},
        {...base,_id:'a55555555555555555555555',ref:'RT-8105',type:'مرتجع',afterSales:{caseId:'r1',role:'return',kind:'return'}},
        {...base,_id:'a66666666666666666666666',ref:'8106'}
      ];
      transactions=rows;returnRequests=[];movFilter='all';fxState.mov.operation.clear();
      openFxDrawer('mov');
      return {matches:rows.map(row=>[matchesMovAfterSalesKind(row,'return'),matchesMovAfterSalesKind(row,'exchange')]),labels:[...document.querySelectorAll('[data-fx=operation]')].map(input=>input.closest('label').textContent.trim())};
    });
    assert.deepEqual(filters.matches,[[true,false],[false,true],[false,true],[false,true],[true,false],[false,false]]);
    assert.equal(filters.labels.length,2);
    await page.$eval('[data-fx=operation][value=return]',input=>{input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));});
    assert.equal(await page.evaluate(()=>fxState.mov.operation.has('return')),true);
    assert.match(await page.$eval('#mov-chips',el=>el.textContent),/Return/);
    assert.deepEqual((await page.evaluate(()=>window._movOrderSeq)).sort(),['a11111111111111111111111','a55555555555555555555555'].sort());
    await page.$eval('[data-fx=operation][value=exchange]',input=>{input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));});
    assert.deepEqual(await page.evaluate(()=>[...fxState.mov.operation].sort()),['exchange','return']);
    assert.deepEqual((await page.evaluate(()=>window._movOrderSeq)).sort(),['a11111111111111111111111','a22222222222222222222222','a33333333333333333333333','a44444444444444444444444','a55555555555555555555555'].sort());
    await page.evaluate(()=>{resetFxFilters();closeFxDrawer();});
    assert.equal(await page.evaluate(()=>fxState.mov.operation.size),0);
    await page.evaluate(()=>{transactions.find(row=>row.ref==='8101').total=478.56;});
    for (const width of [1440,1024]) {
      await page.setViewport({width,height:900});
      const fit = await page.evaluate(() => {
        document.querySelector('#page-movements').style.display='block';
        renderMovements();fitMovTableColumns();
        const table=document.querySelector('#mov-table'),scroll=document.querySelector('#mov-table-wrap .ent-table-scroll');
        const invoice=[...table.querySelectorAll('tbody tr')].find(row=>row.querySelector('td[data-col=ref]')?.textContent.includes('8101'))?.querySelector('td[data-col=invoice] .mov-col-total');
        return {available:scroll.clientWidth,width:table.getBoundingClientRect().width,minimum:parseFloat(table.style.minWidth),ref:parseFloat(getComputedStyle(table.querySelector('th[data-col=ref]')).width),invoice:invoice?.textContent.trim(),exact:invoice?.title};
      });
      assert.ok(fit.width>=fit.available-2,`table fills viewport at ${width}px`);
      assert.ok(fit.width>=fit.minimum-2,`columns retain readable minimum at ${width}px`);
      assert.ok(fit.ref>=130,`invoice reference stays readable at ${width}px`);
      assert.match(fit.invoice,/479/);
      assert.match(fit.exact,/478\.56/);
      const requestBadges=await page.evaluate(() => {
        const tbody=document.querySelector('#mov-table tbody');
        tbody.insertAdjacentHTML('beforeend',['return','exchange'].map((requestKind,i)=>renderMovementReturnRequestRow({_id:'request-'+i,originalRef:'1001',client:'أحمد محمد علي حسن',status:'معلق',requestKind,createdAt:new Date().toISOString(),total:i?500:1234567.89})).join(''));
        fitMovTableColumns();
        return [...tbody.querySelectorAll('.mov-ret-req-row td[data-col=type] .badge')].map(badge=>{
          const cell=badge.closest('td').getBoundingClientRect(),rect=badge.getBoundingClientRect();
          return {inside:rect.left>=cell.left-1&&rect.right<=cell.right+1,text:badge.textContent,className:badge.className};
        });
      });
      assert.equal(requestBadges.length,2);
      assert.ok(requestBadges.every(badge=>badge.inside),`request type labels fit their column at ${width}px`);
      assert.match(requestBadges[1].className,/badge-type-exchange/);
      const invoiceFit=await page.evaluate(() => {
        const amount=document.querySelector('.mov-ret-req-row td[data-col=invoice] .mov-col-total'),cell=amount.closest('td').getBoundingClientRect(),rect=amount.getBoundingClientRect();
        return {inside:rect.left>=cell.left-1&&rect.right<=cell.right+1,display:amount.textContent.trim(),exact:amount.title};
      });
      assert.equal(invoiceFit.inside,true,`whole invoice amount fits its column at ${width}px`);
      assert.match(invoiceFit.display,/1,234,568/);
      assert.match(invoiceFit.exact,/1,234,567\.89/);
      assert.deepEqual(await page.$$eval('.mov-ret-req-row td[data-col=client] .mov-client-name',links=>links.map(link=>({visible:link.textContent,full:link.title}))),[
        {visible:'أحمد محمد',full:'أحمد محمد علي حسن'},
        {visible:'أحمد محمد',full:'أحمد محمد علي حسن'}
      ]);
      await (await page.$('#mov-table-wrap')).screenshot({path:path.join(output,`movements-fit-${width}.png`)});
    }
    const hiddenFit=await page.evaluate(() => {
      const table=document.querySelector('#mov-table'),before=parseFloat(table.style.minWidth),hidden=_getHiddenMovCols();
      hidden.add('tag');_setHiddenMovCols(hidden);applyMovColsVisibility();
      const after=parseFloat(table.style.minWidth);
      hidden.delete('tag');_setHiddenMovCols(hidden);applyMovColsVisibility();
      return {before,after};
    });
    assert.ok(hiddenFit.after<hiddenFit.before,'hidden columns release their reserved width');
    const editGate = await page.evaluate(() => ({
      returnInvoice: txEditGate(transactions.find(row=>row.ref==='RT-8105')),
      replacementInvoice: txEditGate(transactions.find(row=>row.ref==='8103')),
      originalWithCase: txEditGate({...testInvoice,afterSales:{hasCases:true}}),
      ordinary: txEditGate({...testInvoice,deliveredAt:null,pickupStatus:'Pending',bostaStatus:''})
    }));
    assert.equal(editGate.returnInvoice.reason,'editTxAfterSalesBlocked');
    assert.equal(editGate.replacementInvoice.reason,'editTxAfterSalesBlocked');
    assert.equal(editGate.originalWithCase.reason,'editTxAfterSalesOriginalBlocked');
    assert.equal(editGate.ordinary.ok,true);
    await page.evaluate(async()=>{document.querySelector('.as-dialog')?.close(); await openEditMovement(transactions.find(row=>row.ref==='RT-8105')._id);});
    assert.equal(await page.evaluate(()=>document.querySelector('.as-dialog')?.open),true,'linked invoice opens its case');
    assert.equal(await page.evaluate(()=>writes.some(w=>w.url.endsWith('/lock'))),false,'linked invoice never requests an edit lock');
    const operationIcons = await page.evaluate(() => {
      const host=document.createElement('div');document.body.append(host);
      host.innerHTML=AfterSales.shippingBadges({afterSales:{shipments:{return:{caseId:testCase._id,kind:'return',deliveryId:'waybill-1',trackingNumber:'9528380106',status:'created'}}}},true)
        +AfterSales.orderBadge({afterSales:{caseId:testCase._id,role:'replacement',originalRef:'1001'}});
      const result=[...host.querySelectorAll('button')].map(button=>({text:button.textContent.trim(),label:button.getAttribute('aria-label'),title:button.title,hasIcon:!!button.querySelector('svg')}));
      host.remove();return result;
    });
    assert.equal(operationIcons.length,2);
    assert.deepEqual(operationIcons.map(icon=>icon.text),['','']);
    assert.equal(operationIcons.every(icon=>icon.hasIcon&&icon.label&&icon.title),true);
    assert.match(operationIcons[0].label,/Return|استرجاع/);
    assert.match(operationIcons[1].label,/Exchange|استبدال/);
    console.log('PASS after-sales: Arabic/English desktop/mobile, case flow, operation icons and adaptive movement columns');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
