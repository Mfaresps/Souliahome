/* Employee daily home, using shipped markup, styles and renderers. No live APIs. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..');
const publicDir = path.join(root, 'frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) new vm.Script(match[1]);
(async () => {
  const browser = await puppeteer.launch({headless:true,pipe:true});
  try {
    const page = await browser.newPage();
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request',request=>{
      const url=new URL(request.url());
      if(url.origin==='http://soulia.test') {
        if(url.pathname==='/') return request.respond({status:200,contentType:'text/html',body:html});
        if(url.pathname==='/soulia-logo.svg') return request.respond({status:200,contentType:'image/svg+xml',body:fs.readFileSync(path.join(publicDir,'soulia-logo.svg'),'utf8')});
        if(['/employee-home.css','/admin-team-home.css','/admin-team-home.js','/navigation-shell.css','/navigation-shell.js','/shopify-edit-approvals.js'].includes(url.pathname)) return request.respond({status:200,contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(path.join(publicDir,url.pathname.slice(1)),'utf8')});
        if(url.pathname.startsWith('/api/')) return request.respond({status:200,contentType:'application/json',body:'[]'});
      }
      if(request.resourceType()==='script') return request.respond({status:200,contentType:'text/javascript',body:'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});'});
      return request.respond({status:200,contentType:'text/plain',body:''});
    });
    await page.setViewport({width:390,height:844});
    await page.goto('http://soulia.test/',{waitUntil:'domcontentloaded'});
    await page.evaluate(()=>{
      currentUser={_id:'employee-1',name:'سارة أحمد',username:'sara',role:'staff',perms:['dashboard','shopify-orders','complaints']};
      _myWorkspaceRecipientId='employee-1';
      currentPage='dashboard';currentLang='ar';document.documentElement.dir='rtl';
      qs('#app').style.display='';qs('#login-page').style.display='none';qs('#splash-screen')?.remove();
      qsa('.page').forEach(el=>el.classList.toggle('active',el.id==='page-dashboard'));
      _myWorkspace={assignedOrdersTotal:37,assignedOrdersInPeriod:12,periodLabel:'أكتوبر 2026',openFollowUpsCount:4,
        points:{total:89,prevPeriodPoints:70,bonusTotal:10,penaltyTotal:3},
        adjustments:[{points:10,reason:'مكافأة على سرعة المتابعة',createdAt:'2026-10-24T10:00:00Z'},
          {points:-3,reason:'تأخير تحديث الطلب',createdAt:'2026-10-23T10:00:00Z'}],followUps:[
            {ticketNo:'FU-100',orderRef:'100',clientName:'Mona Ibrahim',status:'قيد المتابعة',reason:'تأكيد عنوان العميل',escalationBaseline:new Date(Date.now()-2*3600000).toISOString(),lastActivityAt:new Date(Date.now()-5*60000).toISOString()},
            {ticketNo:'FU-250',orderRef:'250',clientName:'Dina Sayed',status:'بانتظار العميل',reason:'العميل لم يرد',escalationBaseline:new Date(Date.now()-51*3600000).toISOString(),updatedAt:new Date().toISOString()},
            {ticketNo:'FU-300',orderRef:'300',clientName:'Ali Hassan',status:'يحتاج مراجعة',reason:'مراجعة موعد التوصيل',escalationBaseline:new Date(Date.now()-18*3600000).toISOString()},
            {ticketNo:'FU-400',orderRef:'400',status:'قيد المتابعة',reason:'موعد غير متاح'}]};
      onPageEnter=()=>{};renderDashWelcome(false);renderMyKpis();buildSidebar();initMobileNav();_syncShipAdminBits();
      _rfzLastAt=Date.now()-60000;renderDashRefreshBtn();
    });
    for(const language of ['ar','en']) for(const width of [320,390,768,1024,1440]) {
      await page.setViewport({width,height:900});
      await page.evaluate(language=>{
        currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
        renderDashWelcome(false);renderMyKpis();
      },language);
      await new Promise(resolve=>setTimeout(resolve,500));
      const state=await page.evaluate(()=>{
        const visible=selector=>{const el=qs(selector);return !!el&&getComputedStyle(el).display!=='none';};
        const cards=[...qsa('#dash-me-kpis .ds-me-kpi')];
        return {name:qs('#page-dashboard .page-title').textContent,
          create:visible('#page-dashboard .actions-dd'),archive:visible('#page-dashboard button[onclick="openArchiveExport(\'dashboard\')"]'),
          delivered:visible('.ds-ship-tab[data-tab="delivered"]'),count:cards.length,
          first:qs('.ds-me-kpi.is-followups').getBoundingClientRect().top===Math.min(...cards.map(c=>c.getBoundingClientRect().top)),
          messages:qs('#dash-me-adjustments').textContent,values:cards.map(el=>el.querySelector('.ds-me-kpi-value').textContent),
          overflow:document.documentElement.scrollWidth>innerWidth,
          cta:qs('.employee-followup-go').getBoundingClientRect().height,
          samples:[...qsa('.employee-followup-sample')].map(el=>el.textContent),
          unknown:myFollowUpPriorities().at(-1).minutes,
          refreshInside:!!qs('.is-followups #dash-refresh-slot'),refreshCount:qsa('#dash-refresh-slot').length,
          compact:qs('#rfz-time-dashboard').textContent,
          timeVisible:getComputedStyle(qs('#rfz-time-dashboard')).display!=='none',
          largeCount:parseFloat(getComputedStyle(qs('.is-followups .ds-me-kpi-value')).fontSize),
          largeRef:parseFloat(getComputedStyle(qs('.employee-sample-order')).fontSize),
          call:qs('.employee-sample-call').textContent,
          stack:[...qsa('.employee-order-stack .employee-followup-sample')].map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width};}),
          more:qs('.employee-stack-more bdi')?.textContent};
      });
      assert.ok(state.name.includes('سارة أحمد'));
      assert.equal(state.create,false);assert.equal(state.archive,false);assert.equal(state.delivered,false);
      assert.equal(state.count,3);assert.equal(state.first,true);assert.equal(state.overflow,false);
      assert.ok(state.values.includes('37')&&state.values.includes('89')&&state.values.includes('4'));
      assert.ok(state.messages.includes('مكافأة على سرعة المتابعة')&&state.messages.includes('تأخير تحديث الطلب'));
      assert.ok(state.cta>=44);
      assert.equal(state.samples.length,3);assert.ok(state.samples[0].includes('#250'));
      assert.ok(state.samples[0].includes(language==='en'?'No update for':'دون تحديث منذ'));
      assert.equal(state.unknown,null,'Missing baseline never fabricates a delay');
      assert.equal(state.refreshInside,true);assert.equal(state.refreshCount,1);assert.ok(state.compact.length<=3);assert.equal(state.timeVisible,true);
      assert.ok(state.largeCount>=48&&state.largeRef>=28);assert.ok(state.call.includes(language==='en'?'Contact':'تواصل'));
      assert.equal(state.more,'+1');
      assert.ok(state.stack[0].width>state.stack[1].width&&state.stack[1].width>state.stack[2].width,'Cards taper into a stack');
      assert.ok(state.stack[1].top<state.stack[0].bottom&&state.stack[2].top<state.stack[1].bottom,'Cards overlap');
      fs.mkdirSync(path.join(root,'artifacts/employee-home'),{recursive:true});
      await page.screenshot({path:path.join(root,`artifacts/employee-home/${language}-${width}.png`),fullPage:false});
    }
    for(const language of ['ar','en']) for(const width of [320,390,768,1440]) {
      await page.setViewport({width,height:1000});
      await page.evaluate(language=>{
        currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';
        _myRoster={todayWeekday:6,onShiftNow:false,leaves:[],shifts:[{daysOfWeek:[0,1,2,3,4,5,6],shiftStart:'09:00',shiftEnd:'21:00',lengthMinutes:720,isActive:true}]};
        _dutyBoard={onDuty:[],nextUp:[],onLeave:[],onCall:null,coverageGap:true};
        renderMyShift();renderDutyBoard();
      },language);
      const schedule=await page.evaluate(()=>{
        const wrap=qs('#dash-shift-body .ms-personal-week'),bounds=wrap.getBoundingClientRect();
        const cells=qsa('#dash-shift-body .sm-cell');
        return {days:cells.length,labels:cells.every(c=>!!c.dataset.day),fits:wrap.scrollWidth<=wrap.clientWidth+1,
          fullWidth:qs('#dash-shift-section').getBoundingClientRect().width>=qs('.ds-shift-row').getBoundingClientRect().width-2,
          overflow:document.documentElement.scrollWidth>innerWidth,
          formal:qs('#dash-duty').textContent.includes(t('dsDutyGap'))&&!/مفيش|دلوقتي|هيتسند/.test(qs('#dash-duty').textContent),
          cellsFit:cells.every(c=>{const b=c.getBoundingClientRect();return b.left>=bounds.left-1&&b.right<=bounds.right+1;})};
      });
      assert.deepEqual(schedule,{days:7,labels:true,fits:true,fullWidth:true,overflow:false,formal:true,cellsFit:true},`Schedule ${language}/${width}`);
      await page.$eval('#dash-shift-section',el=>el.scrollIntoView({block:'start'}));
      await page.screenshot({path:path.join(root,`artifacts/employee-home/schedule-${language}-${width}.png`)});
    }
    await page.evaluate(()=>{_myRoster=null;_dutyBoard=null;scrollTo(0,0);});
    const counts=await page.evaluate(()=>{
      const workspace=_myWorkspace;
      try {
        return [0,1,2,3,4,12].map(count=>{
          _myWorkspace={points:{},openFollowUpsCount:count,followUps:Array.from({length:count},(_,i)=>({orderRef:String(i+1)}))};
          renderMyKpis();
          return {count,shown:qsa('.employee-followup-sample').length,more:qs('.employee-stack-more bdi')?.textContent||null};
        });
      } finally {_myWorkspace=workspace;renderMyKpis();}
    });
    assert.deepEqual(counts,[0,1,2,3,4,12].map(count=>({count,shown:Math.min(3,count),more:count>3?'+'+(count-3):null})));
    const waiting = await page.evaluate(() => {
      const workspace=_myWorkspace, originalNow=Date.now;
      const now=originalNow();
      try {
        Date.now=()=>now;
        _myWorkspace={points:{},followUps:[{orderRef:'TEST-30',escalationBaseline:new Date(now-3*3600000).toISOString(),lastActivityAt:new Date(now-29*60000).toISOString()}]};
        renderMyKpis();
        const fresh=myFollowUpPriorities()[0].minutes===29 && qs('.employee-sample-wait').hidden;
        Date.now=()=>now+2*60000;syncMyFollowUpWaitLabels();
        const delayed=!qs('.employee-sample-wait').hidden && qs('.employee-sample-wait').textContent.includes('31m') && qs('.employee-followup-sample').classList.contains('is-late');
        _myWorkspace.followUps[0].lastActivityAt=new Date(now+2*60000).toISOString();syncMyFollowUpWaitLabels();
        const reset=qs('.employee-sample-wait').hidden && !qs('.employee-followup-sample').classList.contains('is-late');
        return {fresh,delayed,reset,boundary:myFollowUpWaitLabel(29)===''&&myFollowUpWaitLabel(30).includes('30m'),missing:myFollowUpWaitLabel(null)===''};
      } finally {Date.now=originalNow;_myWorkspace=workspace;renderMyKpis();}
    });
    assert.deepEqual(waiting,{fresh:true,delayed:true,reset:true,boundary:true,missing:true});
    await page.evaluate(()=>{
      window.peekedOrder=null;openSpOrderPeek=id=>{window.peekedOrder=id;};
      _shopifyOrders=['100','250','300','900'].map(ref=>({_id:'so-'+ref,ref,shopifyId:'remote-'+ref,status:'pending',items:[],total:100,client:'Test client',createdAt:new Date().toISOString()}));
      loadShopifyOrders=async()=>{renderShopifyOrders();};
    });
    await page.click('.employee-sample-open');
    await page.waitForFunction(()=>window.peekedOrder==='so-250');
    assert.equal(await page.evaluate(()=>currentPage),'shopify-orders','Preview opens Shopify contact panel for oldest order');
    await page.evaluate(()=>{navigateTo('dashboard');renderDashWelcome(false);renderMyKpis();});
    await page.click('.employee-coach-open');
    assert.ok(await page.$eval('#modal-content',el=>el.textContent.includes('#250')&&el.textContent.includes('سارة أحمد')));
    assert.ok(await page.$eval('#modal-content',el=>el.textContent.includes('30 minutes')&&el.textContent.includes('Follow-up priorities')));
    await page.screenshot({path:path.join(root,'artifacts/employee-home/followup-coach-desktop.png')});
    await page.setViewport({width:390,height:844});
    await page.evaluate(()=>{closeModal();currentLang='ar';document.documentElement.dir='rtl';openMyFollowUpCoach();});
    await new Promise(resolve=>setTimeout(resolve,350));
    await page.screenshot({path:path.join(root,'artifacts/employee-home/followup-coach-mobile.png')});
    await page.click('.employee-coach-actions .btn-primary');
    assert.equal(await page.$eval('#modal-overlay',el=>el.classList.contains('active')),false);
    await page.waitForFunction(()=>currentPage==='shopify-orders');
    assert.equal(await page.evaluate(()=>window.peekedOrder),'so-250');
    await page.evaluate(()=>{navigateTo('dashboard');_myRoster={onShiftNow:true};scheduleMyFollowUpCoach();});
    await new Promise(resolve=>setTimeout(resolve,1400));
    assert.equal(await page.$eval('#modal-overlay',el=>el.classList.contains('active')),true,'Overdue work prompts once');
    await page.evaluate(()=>{closeModal();scheduleMyFollowUpCoach();});
    await new Promise(resolve=>setTimeout(resolve,1400));
    assert.equal(await page.$eval('#modal-overlay',el=>el.classList.contains('active')),false,'Repeated refresh does not nag');
    await page.evaluate(()=>{currentLang='en';renderMyKpis();});
    await page.click('.employee-followup-go');
    await page.waitForFunction(()=>currentPage==='shopify-orders');
    const routed=await page.evaluate(()=>({ids:_shopifyOrders.filter(_spMatchesMyFollowUpScope).map(o=>o._id).sort(),
      chip:qs('#sp-active-chips').textContent,marked:qsa('.sp-my-followup-match').length,selected:_shopifySelectedIds.size}));
    assert.deepEqual(routed.ids,['so-100','so-250','so-300']);assert.ok(routed.chip.includes('My orders needing follow-up'));
    assert.ok(routed.marked>=3);assert.equal(routed.selected,0,'Highlighting does not select orders for bulk actions');
    await page.evaluate(()=>renderShopifyOrders());
    assert.equal(await page.$$eval('.sp-my-followup-match',rows=>rows.length)>=3,true,'Scope survives refresh');
    await page.evaluate(()=>openMyFollowUpsInShopify(3));
    assert.ok(await page.$eval('#page-shopify-orders',el=>el.textContent.includes('No matching Shopify orders')));
    await page.evaluate(()=>clearAllSpFilters());
    assert.equal(await page.evaluate(()=>_spMyFollowUpScope),null,'Clear filters releases follow-up scope');
    const identities=await page.evaluate(()=>{
      const userId=String(currentUser._id);
      _spMyFollowUpScope={userId,tickets:[{shopifyOrderId:'remote-250',orderRef:'900'}]};
      const exact=_spMatchesMyFollowUpScope(_shopifyOrders[1])&&!_spMatchesMyFollowUpScope(_shopifyOrders[3]);
      _spMyFollowUpScope={userId,tickets:[{orderRef:'##250'}]};
      const ref=_spMatchesMyFollowUpScope(_shopifyOrders[1]);
      _spMyFollowUpScope.userId='another-employee';
      const isolated=!_spMatchesMyFollowUpScope(_shopifyOrders[1]);
      _spMyFollowUpScope=null;return {exact,ref,isolated};
    });
    assert.deepEqual(identities,{exact:true,ref:true,isolated:true});
    const unified=await page.evaluate(()=>{
      const workspace=_myWorkspace, priorTransactions=transactions;
      try {
        _myWorkspace={...workspace,openFollowUpsCount:2,pendingConfirmationCount:2,
          followUps:[{orderRef:'250',shopifyOrderId:'so-250',reason:'تأكيد العنوان'},{orderRef:'300',reason:'مراجعة الموعد'}],
          orders:[{id:'so-250',shopifyId:'remote-250',ref:'250',status:'pending',client:'Dina'},
            {id:'so-900',shopifyId:'remote-900',ref:'900',status:'pending',client:'Ali'},
            {id:'so-100',ref:'100',status:'approved',client:'Mona'}]};
        renderMyKpis();renderMyFollowUps();
        transactions=[{remaining:446,cancelled:false}];renderDashAttention(0);
        return {refs:myFollowUpPriorities().map(row=>row.f.orderRef).sort(),
          pending:myFollowUpPriorities().filter(row=>row.f.isConfirmation).map(row=>row.f.orderRef),
          oldSections:['#dash-myorders-section','#dash-myfu-section'].every(selector=>getComputedStyle(qs(selector)).display==='none'),
          debt:qs('#dash-attn').textContent.includes('فواتير عليها')||qs('#dash-attn').textContent.includes('Invoices with a balance')};
      } finally {_myWorkspace=workspace;transactions=priorTransactions;renderMyKpis();}
    });
    assert.deepEqual(unified,{refs:['250','300','900'],pending:['900'],oldSections:true,debt:false});
    await page.evaluate(()=>{
      navigateTo('dashboard');currentLang='ar';document.documentElement.dir='rtl';renderDashWelcome(false);
      window.employeeHomeWorkspace=_myWorkspace;
      _myWorkspace={orders:[],followUps:[],openFollowUpsCount:0,assignedOrdersInPeriod:12,points:{total:89},periodLabel:'أكتوبر 2026'};
      renderMyKpis();
    });
    assert.ok(await page.$eval('.is-followups',el=>el.classList.contains('is-complete')&&el.textContent.includes('اكتملت مهامك الحالية')&&el.textContent.includes('12')&&el.textContent.includes('89')));
    assert.equal(await page.$('.employee-followup-go'),null,'Completed work has no empty follow-up action');
    await new Promise(resolve=>setTimeout(resolve,500));
    await page.screenshot({path:path.join(root,'artifacts/employee-home/completed-mobile.png')});
    await page.evaluate(()=>{
      _myWorkspace.orders=[{status:'pending',ref:'123'}];renderMyKpis();
    });
    assert.ok(await page.$eval('.is-followups',el=>!el.classList.contains('is-complete')&&el.textContent.includes('بانتظار التأكيد')),'Pending confirmations prevent a false completion message');
    await page.evaluate(()=>{_myWorkspace.orders=[];_myWorkspace.pendingConfirmationCount=3;renderMyKpis();});
    assert.ok(await page.$eval('.is-followups',el=>!el.classList.contains('is-complete')&&el.querySelector('.ds-me-kpi-value').textContent==='3'),'Server count prevents false completion when pending orders are outside the preview limit');
    await page.evaluate(()=>{
      _myWorkspace={...window.employeeHomeWorkspace,openFollowUpsCount:5,followUps:[...window.employeeHomeWorkspace.followUps,
        {id:'shipping-fu-777',ticketNo:'FU-777',orderRef:'777',clientName:'Heba Ali',clientPhone:'01001234567',autoSource:'shipping-issue',autoTrigger:'FAILED_ATTEMPT',status:'في انتظار المتابعة',reason:'مشكلة في الاستلام',lastActivityAt:new Date(Date.now()-60000).toISOString()}]};
      renderMyKpis();
    });
    const issue=await page.evaluate(()=>{
      const card=qs('.employee-followup-sample');
      return {first:card.textContent.includes('#777'),red:card.classList.contains('is-delivery-issue')&&getComputedStyle(card).backgroundColor==='rgb(165, 42, 50)'&&getComputedStyle(card).color==='rgb(255, 255, 255)',reason:card.textContent.includes('تعذّر تسليم الشحنة'),endRule:card.textContent.includes('إضافة تعليق وحدها لا تُغلق المشكلة'),
        tel:card.querySelector('a[href^="tel:"]')?.getAttribute('href'),vrobo:card.querySelector('a.is-vrobo')?.getAttribute('href'),nested:qsa('.employee-followup-sample button a').length};
    });
    assert.deepEqual(issue,{first:true,red:true,reason:true,endRule:true,tel:'tel:+201001234567',vrobo:'https://merchant.vrobo.co/inbox?contact=201001234567&channel=whatsapp',nested:0});
    const commentPreview=await page.evaluate(()=>{
      const f=myFollowUpPriorities()[0].f;
      f.latestComment={text:'العميل طلب التأجيل إلى الغد <script>unsafe</script>',authorName:'سارة',at:'2026-10-24T10:00:00Z'};
      renderMyKpis();
      const note=qs('.is-delivery-issue .employee-sample-comment');
      const visible=!!note&&getComputedStyle(note).display!=='none'&&note.textContent.includes('العميل طلب التأجيل')&&note.textContent.includes('سارة')&&!note.querySelector('script');
      f.latestComment={...f.latestComment,text:'تم الاتفاق على موعد التسليم الجديد'};
      renderMyKpis();
      return {visible,updated:qs('.is-delivery-issue .employee-sample-comment').textContent.includes('موعد التسليم الجديد')};
    });
    assert.deepEqual(commentPreview,{visible:true,updated:true});
    assert.ok(await page.$eval('.employee-delivery-issues-button',el=>el.textContent.includes('عرض مشكلات التوصيل')&&!!el.querySelector('svg')&&el.querySelector('bdi').textContent==='1'&&getComputedStyle(el.querySelector('bdi')).color==='rgb(165, 42, 50)'));
    await page.evaluate(()=>{
      _myWorkspace.followUps.push({id:'shipping-fu-778',ticketNo:'FU-778',orderRef:'778',clientName:'Sara Hatem',clientPhone:'01001234567',autoSource:'shipping-issue',autoTrigger:'RETURNED',status:'قيد المتابعة',reason:'مشكلة في الاستلام',lastActivityAt:new Date().toISOString()});
      _myWorkspace.openFollowUpsCount=6;renderMyKpis();
    });
    for(const width of [390,768,1440]) {
      await page.setViewport({width,height:1000});
      const grid=await page.evaluate(()=>{
        const cards=qsa('.employee-delivery-grid .employee-followup-sample'),a=cards[0].getBoundingClientRect(),b=cards[1].getBoundingClientRect();
        const wide=qs('.employee-task-panel').clientWidth>=560;
        return {count:cards.length,issueSelected:qs('#employee-delivery-issues-tab').getAttribute('aria-selected')==='true',otherSelected:qs('#employee-other-tasks-tab').getAttribute('aria-selected')==='false',
          noMixed:qsa('.employee-followup-sample').every(c=>c.classList.contains('is-delivery-issue')),
          distinct:wide?Math.abs(a.top-b.top)<2&&(a.right+8<=b.left||b.right+8<=a.left):b.top>=a.bottom+8,
          actions:cards.every(c=>getComputedStyle(c.querySelector('.employee-defer-button')).display!=='none'&&!!c.querySelector('.employee-defer-button svg')&&c.querySelector('.employee-defer-button').getBoundingClientRect().height>=48),
          overflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert.deepEqual(grid,{count:2,issueSelected:true,otherSelected:true,noMixed:true,distinct:true,actions:true,overflow:false},`Separated delivery cards at ${width}`);
      await page.$eval('.employee-task-tabs',el=>el.scrollIntoView({block:'start'}));
      await page.screenshot({path:path.join(root,`artifacts/employee-home/delivery-grid-${width}.png`)});
    }
    await page.click('#employee-other-tasks-tab');
    assert.ok(await page.$eval('#employee-other-tasks-tab',el=>el.getAttribute('aria-selected')==='true'));
    assert.equal(await page.$('.employee-followup-sample.is-delivery-issue'),null);
    await page.focus('#employee-other-tasks-tab');await page.keyboard.press('Home');
    assert.ok(await page.$eval('#employee-delivery-issues-tab',el=>el.getAttribute('aria-selected')==='true'));
    await page.evaluate(()=>openMyFollowUpDeferral(1));
    assert.ok(await page.$eval('.modal-head h3',el=>el.textContent.includes('#778')),'Second delivery card has its own scheduling action');
    await new Promise(resolve=>setTimeout(resolve,350));
    await page.screenshot({path:path.join(root,'artifacts/employee-home/followup-schedule-desktop.png')});
    await page.evaluate(()=>closeModal());
    await page.setViewport({width:390,height:1000});
    await page.evaluate(()=>openMyFollowUpDeferral(1));
    await new Promise(resolve=>setTimeout(resolve,350));
    assert.ok(await page.$eval('.employee-defer-form [type="submit"]',el=>{const b=el.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;}),'Mobile reminder confirmation is visible');
    await page.screenshot({path:path.join(root,'artifacts/employee-home/followup-schedule-mobile.png')});
    await page.evaluate(()=>{closeModal();_myWorkspace.followUps=_myWorkspace.followUps.filter(f=>f.ticketNo!=='FU-778');_myWorkspace.openFollowUpsCount=5;renderMyKpis();});
    await page.evaluate(()=>{
      window.originalGoToFu=goToFuAndHighlight;window.shippingDestination=null;window.peekedOrder=null;
      goToFuAndHighlight=(id,thread,comment,hash)=>{window.shippingDestination={id,thread,hash};navigateTo('followups');};
    });
    await page.click('.is-delivery-issue .employee-sample-open');
    assert.deepEqual(await page.evaluate(()=>({page:currentPage,target:window.shippingDestination,peek:window.peekedOrder})),
      {page:'followups',target:{id:'shipping-fu-777',thread:true,hash:true},peek:null},'Shipping issue opens its customer-service ticket, never Shopify');
    await page.evaluate(()=>{navigateTo('dashboard');renderMyKpis();});
    await page.click('.employee-followup-go');
    assert.equal(await page.evaluate(()=>currentPage),'followups','Shipping queue action opens customer service');
    await page.evaluate(()=>{navigateTo('dashboard');renderMyKpis();});
    await page.click('.employee-coach-open');
    await page.click('.employee-coach-actions .btn-primary');
    assert.equal(await page.evaluate(()=>currentPage),'followups','Shipping coach action opens customer service');
    const shippingPermissions=await page.evaluate(()=>{
      navigateTo('dashboard');const perms=currentUser.perms;
      try {
        currentUser.perms=['complaints'];renderMyKpis();
        const serviceOnly=!qs('.is-delivery-issue .employee-sample-open').disabled&&!!qs('.employee-coach-open');
        currentUser.perms=['shopify-orders'];renderMyKpis();window.shippingDestination=null;
        openMyHomeFollowUp(0);
        return {serviceOnly,denied:qs('.is-delivery-issue .employee-sample-open').disabled&&currentPage==='dashboard'&&window.shippingDestination===null};
      } finally {currentUser.perms=perms;goToFuAndHighlight=window.originalGoToFu;renderMyKpis();}
    });
    assert.deepEqual(shippingPermissions,{serviceOnly:true,denied:true});
    await new Promise(resolve=>setTimeout(resolve,500));
    await page.screenshot({path:path.join(root,'artifacts/employee-home/delivery-issue-mobile.png')});
    await page.evaluate(()=>{myFollowUpPriorities()[0].f.clientPhone='';renderMyKpis();});
    assert.ok(await page.$eval('.employee-followup-sample',el=>!el.querySelector('a[href^="tel:"]')&&el.textContent.includes('رقم هاتف العميل غير متاح')));
    const deferral=await page.evaluate(async()=>{
      const originalApi=api;
      const workspace=_myWorkspace;
      let saved;
      api=async(url,options)=>{
        if(url.endsWith('/defer')) {
          saved=JSON.parse(options.body);
          const row=workspace.followUps.find(f=>f.id==='shipping-fu-777');
          row.deferredUntil=saved.until;row.deferReason=saved.reason;
          workspace.deferredFollowUps=[{id:row.id,until:saved.until}];
          return row;
        }
        if(url==='/employee-performance/my-workspace') return workspace;
        if(url==='/employee-performance/my-roster') return {};
        return originalApi(url,options);
      };
      try {
        toggleMyOtherTasks();
        const remainingVisible=!qs('.employee-followup-sample.is-delivery-issue')&&!!qs('.employee-followup-sample');
        qs('.employee-delivery-issues-button').click();
        if(!qs('.employee-followup-sample.is-delivery-issue')) throw new Error('Delivery issues button did not restore issue cards');
        openMyFollowUpDeferral(0);
        const form=qs('.employee-defer-form');
        form.elements.reason.value='awaiting_return';
        const choices=form.elements.reason.options.length;
        const shortcut=form.querySelectorAll('.employee-defer-shortcuts button')[1];setMyFollowUpReminderDelay(shortcut,3);
        const delta=(new Date(form.elements.until.value).getTime()-Date.now())/3600000;
        const quickTime=delta>2.98&&delta<=3&&shortcut.getAttribute('aria-pressed')==='true';
        await saveMyFollowUpDeferral('shipping-fu-777',form);
        const waiting=!qs('.employee-followup-sample.is-delivery-issue')&&qs('.employee-deferred-work').textContent.includes('بانتظار استلام المرتجع');
        const count=myActionableFollowUpCount()===4;
        const savedRows=workspace.followUps, savedOpen=workspace.openFollowUpsCount, savedOrders=workspace.orders, savedPending=workspace.pendingConfirmationCount;
        workspace.followUps=[savedRows.find(f=>f.id==='shipping-fu-777')];workspace.openFollowUpsCount=1;workspace.orders=[];workspace.pendingConfirmationCount=0;
        renderMyKpis();
        const waitingOnly=qs('.ds-me-kpi.is-followups').textContent.includes('لا توجد متابعات عاجلة')&&!qs('.ds-me-kpi.is-followups').classList.contains('is-complete');
        workspace.followUps=savedRows;workspace.openFollowUpsCount=savedOpen;workspace.orders=savedOrders;workspace.pendingConfirmationCount=savedPending;
        workspace.followUps.find(f=>f.id==='shipping-fu-777').deferredUntil=new Date(Date.now()-1000).toISOString();
        workspace.deferredFollowUps[0].until=new Date(Date.now()-1000).toISOString();
        syncMyFollowUpWaitLabels();
        const resurfaced=qs('.employee-followup-sample.is-delivery-issue')?.textContent.includes('#777')&&myActionableFollowUpCount()===5;
        return {remainingVisible,choices,quickTime,waiting,count,waitingOnly,resurfaced,reason:saved.reason};
      } finally {api=originalApi;}
    });
    assert.deepEqual(deferral,{remainingVisible:true,choices:3,quickTime:true,waiting:true,count:true,waitingOnly:true,resurfaced:true,reason:'awaiting_return'});
    await page.evaluate(()=>{
      _myWorkspace.followUps=_myWorkspace.followUps.filter(f=>f.ticketNo!=='FU-777');_myWorkspace.deferredFollowUps=[];_myWorkspace.openFollowUpsCount=4;renderMyKpis();
    });
    assert.equal(await page.$('.employee-followup-sample.is-delivery-issue'),null,'Resolved shipping follow-up disappears after the refreshed server payload');
    assert.ok(await page.$eval('.employee-delivery-issues-button',el=>el.disabled&&el.textContent.includes('لا توجد مشكلات توصيل')&&!!el.querySelector('svg')&&!el.querySelector('bdi')));
    assert.ok(await page.$eval('.employee-followup-sample',el=>el.textContent.includes('#250')),'Other open follow-ups remain visible');
    const privacy=await page.evaluate(()=>{
      const originalUser=currentUser;
      const originalModal=openModal;
      let opened=0;
      openModal=()=>{opened++;};
      const results=[];
      try {
        for (const [role,id,allowed] of [['staff','employee-1',true],['admin','employee-1',false],['manager','employee-1',false],['viewer','employee-1',false],['staff','employee-2',false]]) {
          currentUser={...originalUser,role,_id:id};
          renderMyHomeAdjustments();
          const before=opened;
          openMyAdjustments();
          results.push({role,id,visible:getComputedStyle(qs('#dash-me-adjustments')).display!=='none',details:opened>before,allowed});
          if (!allowed && qs('#dash-me-adjustments').textContent) throw new Error('Hidden point messages retained in DOM');
        }
      } finally {currentUser=originalUser;openModal=originalModal;renderMyKpis();}
      return results;
    });
    for(const result of privacy) {
      assert.equal(result.visible,result.allowed,`Point messages visible only to recipient: ${result.role}/${result.id}`);
      assert.equal(result.details,result.allowed,`Point details accessible only to recipient: ${result.role}/${result.id}`);
    }
    const cases=await page.evaluate(()=>{
      currentPage='dashboard';currentLang='en';_myWorkspace={points:{total:0},adjustments:[],openFollowUpsCount:0};renderMyKpis();
      const empty=qs('#dash-me-adjustments').textContent.includes('No bonuses');
      _myWorkspace=null;_myWsFailed=true;renderMyKpis();
      const failed=qs('#dash-me-kpis').textContent.includes(t('dsMeLoadError'));
      currentUser.role='admin';renderDashWelcome(false);renderMyKpis();_syncShipAdminBits();
      return {empty,failed,admin:!qs('#page-dashboard').classList.contains('employee-home')&&getComputedStyle(qs('#page-dashboard .actions-dd')).display!=='none'&&getComputedStyle(qs('.ds-ship-tab[data-tab="delivered"]')).display!=='none'};
    });
    assert.deepEqual(cases,{empty:true,failed:true,admin:true});assert.deepEqual(errors,[]);
    await page.evaluate(async()=>{
      window.teamOriginalApi=api;currentPage='dashboard';
      window.teamFixture={periodLabel:'أكتوبر 2026',totals:{orders:255,pending:23,followUps:73,issues:15,deferred:10},employees:[
        {id:'sara',name:'سارة أحمد',username:'sara',jobTitle:'Order Confirmation Agent',active:true,orders:250,pending:20,followUps:70,deferred:10,issues:15,points:89,delivered:12},
        {id:'omar',name:'عمر علي',username:'omar',jobTitle:'Customer Service Agent',active:true,orders:5,pending:3,followUps:3,deferred:0,issues:0,points:30,delivered:2},
        {id:'inactive',name:'موظف غير نشط',active:false,orders:100,pending:50,followUps:10,issues:5},
      ]};
      window.teamDetails={sara:{employee:{id:'sara',name:'سارة أحمد'},orders:[{id:'order2929',ref:'2929',client:'Dina',status:'pending'},{id:'order2928',ref:'2928',client:'Ali',status:'approved'}],followUps:[
        {id:'issue777',orderRef:'777',clientName:'Heba',status:'قيد المتابعة',reason:'مشكلة في الاستلام',autoSource:'shipping-issue',latestComment:{text:'تم التواصل مع العميل لتحديد موعد تسليم جديد',authorName:'سارة'}},
        {id:'stale-issue',orderRef:'2771',clientName:'Resolved issue',status:'قيد المتابعة',autoSource:'shipping-issue',isDeliveryIssue:false},
        {id:'duplicate-issue',orderRef:'777',clientName:'Heba',status:'قيد المتابعة',autoSource:'shipping-issue',isDeliveryIssue:true},
        {id:'fu500',orderRef:'500',clientName:'Mona',status:'بانتظار العميل',reason:'أجل الاستلام',deferredUntil:new Date(Date.now()+86400000).toISOString()},
      ]},omar:{employee:{id:'omar',name:'عمر علي'},orders:[{id:'order111',ref:'111',client:'Omar client',status:'pending'}],followUps:[]}};
      window.teamRequests=[];api=async url=>{window.teamRequests.push(url);if(url.split('?')[0]==='/employee-performance/team-workspace')return window.teamFixture;if(url.startsWith('/employee-performance/team-workspace/'))return window.teamDetails[url.split('?')[0].split('/').at(-1)];return window.teamOriginalApi(url);};
      await loadAdminTeamWorkspace();
    });
    for(const language of ['ar','en']) for(const width of [390,1440]) {
      await page.setViewport({width,height:1000});
      await page.evaluate(language=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';renderAdminTeamWorkspace();},language);
      const teamState=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,employees:qsa('.ath-person').length,selected:qs('.ath-person-header h4').textContent,
        count:!qs('.ath-person-metrics').textContent.includes('250')&&qsa('.ath-person-metrics>span').length===3&&!qs('[data-filter=orders]')&&!!qs('[data-team-period]'),note:qs('.ath-task.is-issue').textContent.includes('تم التواصل مع العميل'),noMessages:!qs('#dash-admin-team .employee-adjustments')}));
      assert.deepEqual(teamState,{overflow:false,employees:2,selected:'سارة أحمد',count:true,note:true,noMessages:true});
      assert.equal(await page.$('#admin-team-search'),null,'Employee search was removed');
      assert.equal(await page.$$eval('.ath-totals>div',cards=>cards.length),3,'Team assigned orders summary was removed');
      assert.ok(await page.$eval('.ath-employee-list',el=>!el.textContent.includes('موظف غير نشط')),'Inactive accounts do not appear');
      fs.mkdirSync(path.join(root,'artifacts/admin-team-home'),{recursive:true});
      await page.screenshot({path:path.join(root,`artifacts/admin-team-home/${language}-${width}.png`)});
    }
    await page.evaluate(()=>{const input=qs('[data-team-period]');input.value='2026-09';input.dispatchEvent(new Event('change',{bubbles:true}));});
    await page.waitForFunction(()=>window.teamRequests.includes('/employee-performance/team-workspace/sara?period=month&periodKey=2026-09')&&!!qs('.ath-task'));
    assert.ok(await page.evaluate(()=>window.teamRequests.includes('/employee-performance/team-workspace?period=month&periodKey=2026-09')));
    assert.equal(await page.$eval('[data-team-period]',input=>input.value),'2026-09');
    await page.click('[data-filter="waiting"]');
    assert.equal(await page.$$eval('.ath-task',rows=>rows.length),1);
    assert.ok(await page.$eval('.ath-task',el=>el.textContent.includes('#500')));
    await page.click('[data-filter="issues"]');
    assert.equal(await page.$$eval('.ath-task',rows=>rows.length),1);
    await page.evaluate(()=>{window.teamOriginalFu=goToFuAndHighlight;goToFuAndHighlight=id=>{window.teamOpenedIssue=id;};});
    await page.click('.ath-task [data-team-action="open"]');
    assert.equal(await page.evaluate(()=>window.teamOpenedIssue),'issue777');
    await page.click('[data-team-action="select"][data-id="omar"]');
    await page.waitForFunction(()=>qs('.ath-person-header h4')?.textContent==='عمر علي'&&!!qs('.ath-task'));
    assert.ok(await page.$eval('.ath-tasks',el=>el.textContent.includes('#111')&&!el.textContent.includes('#777')));
    await page.evaluate(async()=>{window.teamFixture.employees.forEach(employee=>employee.active=false);await loadAdminTeamWorkspace();});
    assert.equal(await page.$('.ath-person'),null,'No inactive employee remains selectable');
    assert.equal(await page.$('.ath-person-header'),null,'The previous selected employee is cleared when no active accounts remain');
    const hiddenTeam=await page.evaluate(async()=>{
      api=window.teamOriginalApi;goToFuAndHighlight=window.teamOriginalFu;
      currentUser.role='staff';await loadAdminTeamWorkspace();
      return qs('#dash-admin-team').style.display==='none'&&!qs('#dash-admin-team').textContent;
    });
    assert.equal(hiddenTeam,true);assert.deepEqual(errors,[]);
    console.log('PASS: Shopify follow-up filtering, exact order contact panels, scoped identity matching, removable highlights, compact refresh time, glass samples, large counters, coach, Arabic/English and mobile/desktop.');
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
