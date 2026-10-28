/* Real UI with isolated HTTP fixtures. No live customer, shipment or payment writes. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'../../..'),pub=path.join(root,'frontend/public'),out=process.env.COMPLAINT_SCREENSHOT_DIR||path.join(root,'artifacts/complaint-workflow');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await puppeteer.launch({headless:true,pipe:true});
 try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.evaluateOnNewDocument(()=>{let i=0;if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>`fixture-key-${++i}`});});
 await page.setRequestInterception(true);
 page.on('request',r=>{const u=new URL(r.url());if(u.origin==='http://soulia.test'&&u.pathname==='/')return r.respond({status:200,contentType:'text/html',body:fs.readFileSync(path.join(pub,'index.html'),'utf8')});
  if(['/complaint-flow.js','/complaint-flow.css','/after-sales.js','/after-sales.css','/order-status.js','/order-status.css','/design-system.css'].includes(u.pathname))return r.respond({status:200,contentType:u.pathname.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(path.join(pub,u.pathname.slice(1)))});
  if(u.pathname==='/fixture-product.svg')return r.respond({status:200,contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#f5f1e8"/><ellipse cx="32" cy="36" rx="23" ry="16" fill="#b8c9bc"/><ellipse cx="32" cy="30" rx="23" ry="12" fill="#e1e9df"/><ellipse cx="32" cy="30" rx="17" ry="8" fill="#f8faf5"/></svg>'});
  if(r.resourceType()==='script')return r.respond({status:200,contentType:'text/javascript',body:'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});'});
  return r.respond({status:200,contentType:'application/json',body:'[]'});
 });
 await page.goto('http://soulia.test/',{waitUntil:'domcontentloaded'});
 await page.evaluate(()=>{
  currentUser={_id:'111111111111111111111111',role:'admin',name:'مسؤول الخدمة',perms:[]};currentLang='ar';currentPage='complaints';
  document.querySelector('#app').style.display='';document.querySelector('#login-page').style.display='none';document.querySelector('#splash-screen')?.remove();
  products=[];transactions=[{_id:'222222222222222222222222',type:'مبيعات',ref:'2790',client:'نور فتحي',phone:'01000000000',deliveredAt:new Date().toISOString(),items:[{lineId:'line-a',name:'طقم سفرة',code:'A',qty:3},{lineId:'line-b',name:'غطاء وسادة',code:'B',qty:2}]}];
  window.fixture={_id:'333333333333333333333333',complaintNo:'CMP-261028-2790',transactionId:transactions[0]._id,transactionRef:'2790',clientName:'نور فتحي',phone:'01000000000',description:'العميل استلم قطعة بلون مختلف، ويطلب استبدالها باللون المتفق عليه.',status:'معلق',submittedBy:'مسؤول الخدمة',createdAt:new Date().toISOString(),items:[{lineIndex:0,lineId:'line-a',code:'A',name:'طقم سفرة',qty:1}],notes:[{id:'note',kind:'system',text:'تم إنشاء الشكوى',author:'مسؤول الخدمة',createdAt:new Date().toISOString()}],workflow:{version:2,revision:0,cycle:1,stage:'review',ownerId:currentUser._id,owner:'مسؤول الخدمة',dueAt:new Date(Date.now()+86400000).toISOString(),solution:'',history:[],operations:[]},execution:{ready:false,blockers:['evidence']},lifecycleStage:'review'};
  complaints=[fixture];window.writes=[];window.createWrites=[];window.lastCase=null;
  window.copiedMessage='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copiedMessage=text;}}});
  window.messageConfig={revision:0,tokens:['customerName','complaintNo','invoiceRef','resolution','customerMessage'],templates:Object.fromEntries(['registered','update','confirmation','resolved','closed'].map(kind=>[kind,{ar:`${kind} مرحبًا {customerName} — {complaintNo}`,en:`${kind} Hello {customerName} — {complaintNo}`}]))};
  buildSidebar=()=>{};buildNotifications=()=>{};syncVaultState=async()=>{};toast=()=>{};
  window.apiCalls=[];window.holdWorkspace=false;window.pendingWorkspace=[];window.failWorkspace=false;window.holdExecution=false;window.pendingExecution=[];window.executionKind='exchange';
  const customerMessage=url=>{const params=new URL(url,'http://soulia.test').searchParams,language=params.get('lang')||'ar',kind=fixture.workflow.stage==='closed'?'resolved':fixture.execution.ready?'confirmation':params.get('event')==='registered'?'registered':'update';return {kind,language,text:messageConfig.templates[kind][language].replace('{customerName}',fixture.clientName).replace('{complaintNo}',fixture.complaintNo)};};
  api=async(url,options={})=>{
   apiCalls.push({url,method:options.method||'GET'});
   const body=options.body&&!(options.body instanceof FormData)?JSON.parse(options.body):{};
   if(url===`/complaints/${fixture._id}`&&options.method==='DELETE'){
    if(window.failComplaintDelete)throw new Error('Cloudflare deletion unavailable');
    window.fixtureDeleted=true;return {message:'Deleted'};
   }
   if(url.includes('/evidence')){
    if(options.method==='POST'){
     window.evidenceAttempts=(window.evidenceAttempts||0)+1;
     if(window.failEvidenceUploadAt===window.evidenceAttempts)throw new Error('Fixture image upload unavailable');
     const file=options.body.get('file');window.evidenceUploads=(window.evidenceUploads||0)+1;
     fixture.attachments=[...(fixture.attachments||[]),{id:'image-'+evidenceUploads,name:file.name}];return structuredClone(fixture);
    }
    if(options.method==='DELETE'){
     if(window.failEvidenceDelete)throw new Error('Cloudflare unavailable');
     fixture.attachments=fixture.attachments.filter(a=>a.id!==url.split('/').pop());return structuredClone(fixture);
    }
    return {data:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
   }
   if(url==='/complaints/message-templates'){if(options.method==='PUT'){messageConfig.templates=body.templates;messageConfig.revision++;}return structuredClone(messageConfig);}
   if(url.includes('/customer-message?'))return customerMessage(url);
   if(url.includes('?view=workspace')){if(failWorkspace)throw new Error('Fixture connection unavailable');const row={...structuredClone(fixture),customerMessage:customerMessage(url)};return holdWorkspace?new Promise(resolve=>pendingWorkspace.push(()=>resolve(row))):row;}
   if(url==='/users')return [currentUser];if(url==='/complaints'){
    if(options.method==='POST'){createWrites.push(body);return fixture;}return window.fixtureDeleted?[]:[fixture];
   }
   if(url.startsWith('/complaints/')&&url.endsWith('/workflow')){
    writes.push(body);const w=fixture.workflow;
    if(body.action==='plan'){w.solution=body.solution;w.stage='planned';w.dueAt=body.dueAt;fixture.execution.blockers=['case_required'];}
    if(body.action==='wait'){w.stage='waiting';w.waitReason=body.note;w.dueAt=body.dueAt;}
    if(body.action==='close'){if(!fixture.execution.ready)throw new Error('الحل غير مكتمل');w.stage='closed';w.outcome=body.outcome;w.closureNote=body.note;fixture.surveySlug='safe-fixture-survey';}
    if(body.action==='reopen'){w.stage='review';w.solution='';w.caseId='';w.cycle++;fixture.surveySlug=undefined;fixture.execution={ready:false,blockers:['evidence']};}
    w.history.push({id:String(w.revision),action:body.action,by:currentUser.name,note:body.note,at:new Date().toISOString()});w.revision++;fixture.lifecycleStage=w.stage;return fixture;
   }
   if(url.startsWith('/complaints/'))return fixture;
   if(url.startsWith('/after-sales/invoice/'))return {invoice:transactions[0],prior:[],cases:[],identities:{lines:[]},products:[{_id:'555555555555555555555555',name:'طقم سفرة',code:'A',sellPrice:500,available:10}],policy:{}};
   if(url==='/after-sales/quote')return {quote:{credit:500,replacement:500,customerFee:0,creditApplied:500,collectDue:0,refundDue:0}};
   if(url==='/after-sales'&&options.method==='POST'){lastCase=body;return {_id:'444444444444444444444444'};}
   if(url.startsWith('/after-sales?'))return [];
   if(url.startsWith('/after-sales/')){const row={_id:'444444444444444444444444',originalTransactionId:transactions[0]._id,originalRef:'2790',client:fixture.clientName,requestKind:executionKind,items:fixture.items,exchangeItems:[],workflow:{version:2,ref:'AS-2026-000002',stage:'requested',complaintIds:[fixture._id],quote:{credit:500,replacement:500,customerFee:0,collectDue:0,refundDue:0},history:[]}};return holdExecution?new Promise(resolve=>pendingExecution.push(()=>resolve(row))):row;}
   if(url==='/transactions')return transactions;if(url==='/returns'||url==='/transactions/inventory')return [];return [];
  };
 });
 // A slow detail response must not blank the locally available case or overwrite a new form.
 await page.evaluate(()=>{holdWorkspace=true;window.openTask=ComplaintFlow.open(fixture._id);});
 assert(await page.$('.cf-grid'),'case is rendered before the network response');
 assert(await page.$('.cf-refresh-status'));
 assert.equal(await page.evaluate(()=>apiCalls.filter(c=>c.url.includes('?view=workspace')).length),1);
 await page.evaluate(async()=>{holdWorkspace=false;pendingWorkspace.splice(0).forEach(resolve=>resolve());await openTask;});
 assert.equal(await page.evaluate(()=>apiCalls.filter(c=>c.url.includes('/customer-message?')).length),0,'message arrives in the same workspace response');
 const beforeForm=await page.evaluate(()=>apiCalls.length);
 await page.evaluate(()=>ComplaintFlow.form(fixture._id,'contact'));
 assert.equal(await page.evaluate(()=>apiCalls.length),beforeForm,'opening an action reuses the fresh detail');
 await page.evaluate(async()=>{holdWorkspace=true;window.openTask=ComplaintFlow.open(fixture._id);await ComplaintFlow.create();});
 await page.type('[name=description]','Keep this draft during the delayed response');
 await page.evaluate(async()=>{holdWorkspace=false;pendingWorkspace.splice(0).forEach(resolve=>resolve());await openTask;});
 assert.equal(await page.$eval('[name=description]',e=>e.value),'Keep this draft during the delayed response');
 await page.click('[data-cf-discard]');
 await page.evaluate(async()=>{failWorkspace=true;await ComplaintFlow.open(fixture._id);});
 assert(await page.$('.cf-grid'),'failed refresh retains the visible case');
 assert((await page.$eval('[data-cf-error]',e=>e.textContent)).includes('Fixture connection unavailable'));
 await page.evaluate(()=>{failWorkspace=false;});await page.click('[data-cf-error] button');
 await page.waitForFunction(()=>!document.querySelector('.cf-refresh-status'));
 await page.evaluate(()=>document.querySelector('.cf-dialog').close());
 // List columns, owner search, and pagination use the same workflow fields as the case.
 await page.evaluate(()=>{
  window.originalComplaints=complaints;
  document.querySelectorAll('.page').forEach(e=>e.style.display='none');document.querySelector('#page-complaints').style.display='block';switchMainTab('complaints',true,true);
  transactions[0].bostaOrderId='test-shipment';transactions[0].bostaStatus='OUT_FOR_DELIVERY';
  complaints=Array.from({length:65},(_,i)=>({...structuredClone(fixture),_id:String(i+1).padStart(24,'0'),complaintNo:`CMP-list-${i}`,phone:`0100000${String(i).padStart(4,'0')}`,workflow:{...structuredClone(fixture.workflow),owner:'مريم',solution:'exchange',stage:'execution',caseId:'444444444444444444444444',caseRef:`AS-case-${i}`,dueAt:'2026-01-01T09:00:00Z'},execution:{ready:false,blockers:['receipt']},lifecycleStage:'execution',overdue:true}));renderComplaints();
 });
 assert.equal(await page.$$eval('#cmp-table th',els=>els.length),10);
 assert.equal(await page.$$eval('#cmp-tbody tr',els=>els.length),30);
 assert((await page.$eval('#cmp-tbody',e=>e.textContent)).includes('مريم'));
 assert.equal(await page.$$eval('#cmp-tbody [data-order-state=OUT_FOR_DELIVERY]',els=>els.length),30);
 await page.$eval('[data-cf-next]',e=>e.click());assert.equal(await page.$$eval('#cmp-tbody tr',els=>els.length),30);
 await page.$eval('[data-cf-next]',e=>e.click());assert.equal(await page.$$eval('#cmp-tbody tr',els=>els.length),5);
 await page.evaluate(()=>{document.querySelector('#cmp-search').value='AS-case-64';renderComplaints();});assert.equal(await page.$$eval('#cmp-tbody tr[data-complaint-id]',els=>els.length),1);
 await page.evaluate(()=>{document.querySelector('#cmp-search').value='01000000003';renderComplaints();});assert.equal(await page.$$eval('#cmp-tbody tr[data-complaint-id]',els=>els.length),1);
 await page.evaluate(()=>{document.querySelector('#cmp-search').value='';document.querySelector('#cmp-emp-filter').value='مريم';renderComplaints();});assert.equal(await page.$$eval('#cmp-tbody tr[data-complaint-id]',els=>els.length),30);
 await page.evaluate(()=>{document.querySelector('#cmp-emp-filter').value='';complaints=complaints.slice(0,3);renderComplaints();});
 for(const lang of ['ar','en'])for(const width of [1440,390]){
  await page.setViewport({width,height:1000});await page.evaluate(lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';renderComplaints();},lang);
  await page.$eval('[data-cf-queue]',e=>e.scrollIntoView({block:'center',behavior:'instant'}));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.$$eval('[data-cf-queue] .fsel-btn',els=>els.length),1);
  assert(await page.$eval('[data-cf-queue]',e=>e.parentElement.matches(innerWidth<=768?'.cmp-mobile-bar':'.cmp-filter-bar')),'queue is beside the filters');
  if(width===1440){
   assert(await page.$eval('#cmp-search',e=>e.getBoundingClientRect().width<=191),'desktop search stays compact');
   assert(await page.$eval('.cmp-filter-clear',e=>Math.abs(e.getBoundingClientRect().bottom-document.querySelector('#cmp-search').getBoundingClientRect().bottom)<2),'desktop filters share one row');
  }
  assert(await page.$eval(width===1440?'.cmp-filter-bar':'.cmp-mobile-bar',e=>e.scrollWidth<=e.clientWidth+1),'filter controls fit the toolbar');
  assert(await page.$eval('#cf-queue',e=>e.getBoundingClientRect().width<=1&&e.tabIndex===-1));
  assert(await page.$eval('#cf-queue-trigger',e=>e.getBoundingClientRect().width<=(innerWidth>650?301:innerWidth)));
  await page.focus('#cf-queue-trigger');await page.keyboard.press('Enter');await page.waitForSelector('.fsel-panel-portal.show');
  assert(await page.$eval('.fsel-panel-portal.show',e=>{const r=e.getBoundingClientRect();return r.width<=381&&r.height<=361&&r.left>=0&&r.right<=innerWidth;}));
  assert(await page.$eval('.fsel-panel-portal.show .fsel-list',e=>e.scrollHeight>e.clientHeight));
  await page.screenshot({path:path.join(out,`work-queue-${lang}-${width}.png`)});
  await page.waitForFunction(()=>document.activeElement.matches('.fsel-search input'));
  await page.keyboard.type(lang==='ar'?'مغلقة':'Closed');await page.keyboard.press('Tab');await page.keyboard.press('Enter');
  assert.equal(await page.$eval('#cf-queue',e=>e.value),'closed');
  assert.equal(await page.$$eval('#cmp-tbody tr[data-complaint-id]',els=>els.length),0);
  await page.waitForFunction(()=>!document.querySelector('.fsel-panel-portal'));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.click('#cf-queue-trigger');await page.waitForSelector('.fsel-panel-portal.show');
  await page.click('.fsel-panel-portal.show [data-val=active]');
  assert.equal(await page.$eval('#cf-queue',e=>e.value),'active');
  if(width===1440){await page.$eval('#cmp-complaints-section',e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:path.join(out,`table-${lang}.png`)});}
  else{await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await page.waitForFunction(()=>{const s=getComputedStyle(document.querySelector('#main'));return s.marginRight==='0px'&&s.marginLeft==='0px';});await (await page.$('#cmp-cards .cf-list-card')).screenshot({path:path.join(out,`list-card-${lang}.png`)});assert(await page.$eval('#cmp-cards .cf-list-card',e=>{const r=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth+1&&r.left>=0&&r.right<=innerWidth;}));}
 }
 // Resizing moves the existing control without losing the selected queue.
 await page.select('#cf-queue','mine');
 for(const width of [320,768,1024,1440]){
  await page.setViewport({width,height:1000});
  await page.waitForFunction(()=>document.querySelector('[data-cf-queue]').parentElement.matches(innerWidth<=768?'.cmp-mobile-bar':'.cmp-filter-bar'));
  assert.equal(await page.$$eval('#cf-queue',els=>els.length),1);
  assert.equal(await page.$eval('#cf-queue',e=>e.value),'mine');
  assert(await page.$eval(width<=768?'.cmp-mobile-bar':'.cmp-filter-bar',e=>e.scrollWidth<=e.clientWidth+1));
 }
 await page.select('#cf-queue','active');
 await page.evaluate(()=>{complaints=originalComplaints;renderComplaints();});
 // Search against a crowded fixture, then verify the selected invoice and persisted form values.
 await page.evaluate(()=>{
  window.originalTransactions=transactions;
  products=[{_id:'catalog-a',code:'A',imageUrl:'/fixture-product.svg'}];
  transactions=Array.from({length:12},(_,i)=>({...originalTransactions[0],_id:`search-${i}`,ref:String(2200+i),bostaOrderId:`shipment-${i}`,bostaStatus:i===11?'DELIVERED':'OUT_FOR_DELIVERY'}));
  transactions.push({...transactions[0],_id:'purchase',type:'مشتريات'});
 });
 for(const lang of ['ar','en'])for(const width of [1440,390,320]){
  await page.setViewport({width,height:width===1440?1000:844});
  await page.evaluate(async lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';await ComplaintFlow.create();},lang);
  await page.type('[name=orderSearch]','22');
  assert.equal(await page.$$eval('[data-cf-pick]',rows=>rows.length),5);
  assert((await page.$eval('[data-cf-search-hint]',e=>e.textContent)).includes('12'));
  assert.equal(await page.$$eval('[data-cf-results] [data-order-state=OUT_FOR_DELIVERY]',rows=>rows.length),5);
  assert(await page.$eval('[data-cf-results]',e=>e.getBoundingClientRect().height<=312));
  assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1),`search overflow ${lang}/${width}`);
  await page.screenshot({path:path.join(out,`search-${lang}-${width}.png`)});
  await page.$eval('[name=orderSearch]',e=>{e.value='#٢٢١١';e.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await page.$$eval('[data-cf-pick]',rows=>rows.length),1);
  await page.click('[data-cf-pick]');
  assert.equal(await page.$eval('[data-cf-selected] [data-order-state]',e=>e.dataset.orderState),'DELIVERED');
  assert.equal(await page.$eval('.cf-order-search',e=>e.hidden),true);
  await page.waitForFunction(()=>document.querySelector('[data-cf-line="0"] img')?.naturalWidth>0);
  assert.equal(await page.$$eval('[data-cf-line="1"] .cf-product-image img',rows=>rows.length),0,'missing image stays a placeholder');
  assert(await page.$eval('[data-cf-clear]',e=>e.getBoundingClientRect().height>=38&&parseFloat(getComputedStyle(e).fontSize)>=12));
  for(const name of ['priority','categoryGroup'])assert(await page.$eval(`[name=${name}] + .pm-sel-btn`,e=>e.getBoundingClientRect().height>=44&&!!e.getAttribute('aria-labelledby')),`accessible select trigger ${name}`);
  await page.$eval('[name=priority] + .pm-sel-btn',e=>e.scrollIntoView({block:'center'}));
  await page.click('[name=priority] + .pm-sel-btn');
  await page.waitForSelector('.cf-select-panel.show');
  assert(await page.$eval('.cf-select-panel',e=>{const r=e.getBoundingClientRect();return e.matches(':popover-open')&&r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}),'menu stays in the viewport and above the dialog');
  await page.click('.cf-select-panel [data-idx="1"]');
  assert.equal(await page.$eval('[name=priority]',e=>e.value),'عالية');
  const category=await page.$eval('[name=categoryGroup]',e=>e.options[1].value);
  await page.select('[name=categoryGroup]',category);
  await page.click('[data-cf-line="0"] input[type=checkbox]');
  await page.$eval('[data-cf-line="0"] input[type=number]',e=>{e.value='2';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.click('[data-cf-back]');
  await page.evaluate(()=>ComplaintFlow.create());
  assert.equal(await page.$eval('[name=priority]',e=>e.value),'عالية');
  assert.equal(await page.$eval('[name=categoryGroup]',e=>e.value),category);
  assert.equal(await page.$eval('[data-cf-line="0"] input[type=number]',e=>e.value),'2');
  assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1),`selected invoice overflow ${lang}/${width}`);
  await page.$eval('.cf-body',e=>e.scrollTop=0);
  await page.screenshot({path:path.join(out,`selected-${lang}-${width}.png`)});
  if(lang==='ar'&&width===390){await page.evaluate(()=>document.body.classList.add('dark-mode'));assert.equal(await page.$eval('[name=categoryGroup]',e=>getComputedStyle(e).backgroundImage),'none','dark mode keeps a single select arrow');await page.screenshot({path:path.join(out,'selected-dark-ar-390.png')});await page.evaluate(()=>document.body.classList.remove('dark-mode'));}
  await page.click('[data-cf-clear]');
  assert.equal(await page.evaluate(()=>document.activeElement.name),'orderSearch');
  await page.type('[name=orderSearch]','no-match');
  assert.equal(await page.$eval('[data-cf-results]',e=>e.hidden),true);
  assert((await page.$eval('[data-cf-search-hint]',e=>e.textContent)).length>0);
  await page.click('[data-cf-discard]');
 }
 await page.evaluate(()=>{transactions=originalTransactions;products=[];});
 for(const lang of ['ar','en'])for(const width of [1440,390]){
  await page.setViewport({width,height:width===390?844:1000});
  await page.evaluate(async lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';await ComplaintFlow.open(fixture._id);},lang);
  if(width===1440)assert(await page.$eval('.cf-dialog',e=>{const r=e.getBoundingClientRect();return Math.abs(r.left+r.width/2-innerWidth/2)<3&&Math.abs(r.top+r.height/2-innerHeight/2)<3;}),'desktop dialog centered');
  assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1),`detail overflow ${lang}/${width}`);
  await page.screenshot({path:path.join(out,`detail-${lang}-${width}.png`)});
  await page.evaluate(()=>ComplaintFlow.form(fixture._id,'plan'));
  assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1),`plan overflow ${lang}/${width}`);
  await page.screenshot({path:path.join(out,`plan-${lang}-${width}.png`)});
  await page.click('[name=solution] + .pm-sel-btn');
  await page.waitForSelector('.cf-select-panel.show');
  assert.equal(await page.$$eval('.cf-select-panel [role=option]',rows=>rows.length),6);
  assert(await page.$eval('.cf-select-panel [data-idx="4"]',e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}),'options receive pointer events above the modal');
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('.cf-select-panel')).opacity==='1');
  await page.screenshot({path:path.join(out,`solution-menu-${lang}-${width}.png`)});
  if(lang==='ar'&&width===390){await page.evaluate(()=>document.body.classList.add('dark-mode'));await page.screenshot({path:path.join(out,'solution-menu-dark-ar-390.png')});await page.evaluate(()=>document.body.classList.remove('dark-mode'));}
  await page.click('.cf-select-panel [data-idx="4"]');
  assert.equal(await page.$eval('[name=solution]',e=>e.value),'compensation');
  assert.equal(await page.$eval('[data-cf-money]',e=>e.hidden),false,'custom selection updates dependent fields');
  await page.keyboard.press('ArrowDown');
  await page.waitForSelector('.cf-select-panel.show');
  await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
  assert.equal(await page.$eval('[name=solution]',e=>e.value),'refund_without_return');
  await page.click('[name=solution] + .pm-sel-btn');await page.keyboard.press('Escape');
  assert.equal(await page.$('.cf-select-panel'),null);
  assert.equal(await page.$eval('.cf-dialog',e=>e.open),true,'Escape closes just the options');
  await page.click('[name=solution] + .pm-sel-btn');await page.click('textarea[name=note]');
  assert.equal(await page.$('.cf-select-panel'),null,'outside click closes the options');
  await page.$eval('[name=solution]',e=>e.disabled=true);
  await page.waitForFunction(()=>document.querySelector('[name=solution] + .pm-sel-btn').disabled);
  await page.$eval('[name=solution]',e=>e.disabled=false);
 }
 for(const lang of ['ar','en']){
  await page.evaluate(lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';},lang);
  await page.setViewport({width:390,height:844});
  for(const action of ['assign','wait','contact','close','items']){
   await page.evaluate(action=>ComplaintFlow.form(fixture._id,action),action);
   assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1),`${action} form overflow ${lang}`);
   if(action!=='items'){
    assert.equal(await page.$eval('[name=note]',e=>e.required),action==='close');
    if(action!=='close')assert((await page.$eval('[name=note]',e=>e.closest('label').textContent)).includes(lang==='ar'?'اختياري':'Optional'));
   }
   if(action==='close'){
    await page.select('[name=outcome]','withdrawn');
    assert(await page.$eval('[name=customerConfirmed]',e=>e.closest('.cf-check').hidden),'withdrawal does not ask for confirmation of a successful resolution');
   }
   await page.screenshot({path:path.join(out,`${action}-${lang}-390.png`)});
  }
 }
 await page.evaluate(async()=>{document.body.classList.add('dark-mode');currentLang='ar';await ComplaintFlow.open(fixture._id);});
 await page.screenshot({path:path.join(out,'detail-dark-ar-390.png')});
 await page.evaluate(async()=>{document.body.classList.remove('dark-mode');currentLang='en';document.documentElement.dir='ltr';await ComplaintFlow.form(fixture._id,'plan');});
 await page.select('.cf-dialog select[name=solution]','exchange');await page.type('.cf-dialog textarea[name=note]','Exchange approved after reviewing customer photos');
 const beforeSave=await page.evaluate(()=>apiCalls.length);
 await page.click('.cf-dialog button[type=submit]');await page.waitForSelector('[data-cf-action=create-case]');
 assert.equal(await page.evaluate(start=>apiCalls.slice(start).filter(c=>c.url==='/complaints'||c.url.includes('?view=workspace')).length,beforeSave),0,'save uses its returned detail without reloading the list or workspace');
 assert.equal(await page.evaluate(()=>writes.at(-1).solution),'exchange');
 await page.click('[data-cf-action=create-case]');await page.waitForSelector('[data-as-create]');
 assert.equal(await page.$eval('[data-as-line="0"] [data-as-qty]',e=>e.value),'1');
 assert.equal(await page.$eval('[data-as-line="1"] [data-as-qty]',e=>e.value),'0');
 assert.equal(await page.$eval('[data-as-create] select[name=kind]',e=>e.disabled),true);
 await page.type('[data-as-create] textarea[name=note]','Keep this execution draft');
 await page.click('[data-as-back-complaint]');await page.waitForSelector('.cf-dialog[open] .cf-grid');
 assert.equal(await page.$$eval('dialog[open]',els=>els.length),1,'return opens only the complaint');
 await page.click('[data-cf-action=create-case]');await page.waitForSelector('.as-dialog[open] [data-as-create]');
 assert.equal(await page.$eval('[data-as-create] textarea[name=note]',e=>e.value),'Keep this execution draft','returning to the execution form preserves unsaved fields');
 await page.select('[data-as-create] select[name=fulfillmentChannel]','direct');
 assert.equal(await page.$eval('[data-as-create] input[name=customerFee]',e=>e.disabled),true);
 await page.click('[data-as-add]');await page.click('[data-as-pick]');await page.click('[data-as-create] button[type=submit]');await page.waitForSelector('[data-as-complaint]');
 assert.equal(await page.evaluate(()=>lastCase.complaintId),'333333333333333333333333');
 assert.equal(await page.evaluate(()=>lastCase.fulfillmentChannel),'direct');
 await page.click('[data-as-complaint]');await page.waitForSelector('.cf-dialog[open] .cf-grid');
 await page.evaluate(async()=>{fixture.workflow.caseId='444444444444444444444444';fixture.workflow.caseRef='AS-2026-000002';fixture.workflow.stage='execution';fixture.execution={ready:true,blockers:[],financialPending:true,caseRef:'AS-2026-000002',receivedAt:new Date().toISOString(),deliveredAt:new Date().toISOString()};fixture.lifecycleStage='confirmation';await ComplaintFlow.open(fixture._id);});
 // The two workspaces share geometry, retain context and have one visible dialog.
 for(const lang of ['ar','en'])for(const width of [1440,390,320]){
  await page.setViewport({width,height:width===1440?1000:844});
  await page.evaluate(async lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';await ComplaintFlow.open(fixture._id);},lang);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.waitForFunction(()=>Math.abs(document.querySelector('.cf-dialog').getBoundingClientRect().width-(innerWidth<=650?innerWidth:Math.min(1040,innerWidth-32)))<=2);
  const source=await page.$eval('.cf-dialog',e=>({width:e.getBoundingClientRect().width,left:e.getBoundingClientRect().left}));
  const scroll=await page.$eval('.cf-body',e=>{e.scrollTop=240;return e.scrollTop;});
  // Invoke the same table link handler without scrolling the source to the button.
  await page.evaluate(()=>ComplaintFlow.execution(fixture._id));
  await page.waitForSelector('.as-dialog[open] [data-as-print]');
  assert.equal(await page.$$eval('dialog[open]',els=>els.length),1,'execution replaces the complaint');
  assert(await page.$eval('.as-body',e=>e.scrollWidth<=e.clientWidth+1),`execution overflow ${lang}/${width}`);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const destination=await page.$eval('.as-dialog',e=>({width:e.getBoundingClientRect().width,left:e.getBoundingClientRect().left}));
  assert(Math.abs(source.width-destination.width)<=2&&Math.abs(source.left-destination.left)<=1,`matching geometry ${lang}/${width}: ${JSON.stringify({source,destination})}`);
  assert((await page.$eval('[data-as-complaint-nav]',e=>e.textContent)).includes('CMP-261028-2790'));
  await page.screenshot({path:path.join(out,`linked-execution-${lang}-${width}.png`)});
  if(width===1440)await page.click('[data-as-back-complaint]');
  else if(width===390)await page.click('.as-close');
  else await page.keyboard.press('Escape');
  await page.waitForSelector('.cf-dialog[open] .cf-grid');
  await page.waitForFunction(()=>!document.querySelector('.cf-refresh-status'));
  assert.equal(await page.$$eval('dialog[open]',els=>els.length),1,'back/close/Escape returns to the complaint');
  assert(Math.abs(await page.$eval('.cf-body',e=>e.scrollTop)-scroll)<=1,`complaint scroll restored ${lang}/${width}`);
 }
 await page.screenshot({path:path.join(out,'confirmation-mobile.png')});
 await page.evaluate(async()=>{executionKind='return';await ComplaintFlow.execution(fixture._id);});
 assert((await page.$eval('#as-title',e=>e.textContent)).includes('Return'),'return cases use the same parent navigation');
 await page.click('[data-as-back-complaint]');await page.waitForSelector('.cf-dialog[open]');
 await page.evaluate(()=>{holdExecution=true;window.executionTask=ComplaintFlow.execution(fixture._id);});
 assert(await page.$('.as-dialog[open] [data-as-print]'),'reopening the same case keeps cached content while updating');
 await page.click('[data-as-back-complaint]');await page.waitForSelector('.cf-dialog[open]');
 await page.evaluate(async()=>{holdExecution=false;pendingExecution.splice(0).forEach(resolve=>resolve());await executionTask;executionKind='exchange';});
 assert.equal(await page.$$eval('dialog[open]',els=>els.map(e=>e.className)).then(names=>names.join()),'cf-dialog','a delayed execution response cannot reopen or overwrite the complaint');
 for(const lang of ['ar','en'])for(const width of [1440,390,320]){
  await page.setViewport({width,height:width===1440?1000:844});
  await page.evaluate(async lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';await ComplaintFlow.form(fixture._id,'close');},lang);
  assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1),`close overflow ${lang}/${width}`);
  if(width===1440)assert(await page.$eval('.cf-dialog',e=>e.getBoundingClientRect().width<=722),'compact close dialog');
  assert(await page.$eval('[name=customerConfirmed]',e=>{
   const box=e.getBoundingClientRect(),text=e.nextElementSibling.getBoundingClientRect();
   const gap=getComputedStyle(e.closest('.cf-dialog')).direction==='rtl'?box.left-text.right:text.left-box.right;
   return !e.closest('.cf-check').hidden&&box.width===18&&box.height===18&&gap>=8&&gap<=12;
  }),`confirmation checkbox stays beside its label ${lang}/${width}`);
  await page.click('.cf-check span');
  assert(await page.$eval('[name=customerConfirmed]',e=>e.checked),'label toggles confirmation');
  await page.select('[name=outcome]','partial_agreement');
  assert.equal(await page.$eval('[name=customerConfirmed]',e=>e.closest('.cf-check').hidden),false);
  await page.screenshot({path:path.join(out,`close-ready-${lang}-${width}.png`)});
  if(lang==='ar'&&width===390){await page.evaluate(()=>document.body.classList.add('dark-mode'));await page.screenshot({path:path.join(out,'close-ready-dark-ar-390.png')});await page.evaluate(()=>document.body.classList.remove('dark-mode'));}
 }
 await page.setViewport({width:390,height:844});
 await page.evaluate(()=>{currentLang='en';document.documentElement.dir='ltr';});
 await page.evaluate(()=>ComplaintFlow.form(fixture._id,'close'));await page.type('.cf-dialog textarea[name=note]','Customer confirmed receipt of the correct replacement');await page.click('.cf-dialog input[name=customerConfirmed]');await page.click('.cf-dialog button[type=submit]');await page.waitForSelector('[data-cf-copy]');
 await page.screenshot({path:path.join(out,'closed-mobile.png')});
 await page.waitForFunction(()=>document.querySelector('[data-cf-message-text]')?.value.startsWith('resolved'));
 await page.click('[data-cf-message]');assert((await page.evaluate(()=>copiedMessage)).startsWith('resolved'));
 await page.evaluate(()=>ComplaintFlow.form(fixture._id,'reopen'));await page.type('.cf-dialog textarea[name=note]','New issue reported');await page.click('.cf-dialog button[type=submit]');await page.waitForFunction(()=>fixture.workflow.cycle===2);
 await page.evaluate(()=>openAddTicketModal(transactions[0]._id));await page.waitForSelector('[data-cf-new]');
 await page.screenshot({path:path.join(out,'customer-care-mobile.png')});
 await page.click('[data-cf-new]');await page.waitForSelector('[data-cf-create]');
 await page.click('[data-cf-line="0"] input[type=checkbox]');await page.click('[data-cf-line="1"] input[type=checkbox]');await page.type('.cf-dialog textarea[name=description]','Two affected products in one complaint');
 await page.screenshot({path:path.join(out,'create-mobile.png')});
 await page.click('[data-cf-back]');await page.evaluate(()=>ComplaintFlow.create());
 assert.equal(await page.$eval('.cf-dialog textarea[name=description]',e=>e.value),'Two affected products in one complaint');
 await page.click('.cf-dialog button[type=submit]');await page.waitForFunction(()=>createWrites.length===1);
 assert.deepEqual(await page.evaluate(()=>createWrites[0].items.map(i=>i.qty)),[1,1]);
 assert.equal(await page.evaluate(()=>createWrites[0].items.length),2);
 await page.waitForFunction(()=>document.querySelector('[data-cf-message-text]')?.value.startsWith('registered'));
 await page.click('[data-cf-message]');assert((await page.evaluate(()=>copiedMessage)).includes('CMP-261028-2790'));
 assert.equal(await page.$eval('[data-cf-message-text]',e=>e.readOnly),true);
 await page.screenshot({path:path.join(out,'registered-message-mobile.png')});
 await page.click('[data-cf-templates]');await page.waitForSelector('[data-cf-template-form]');
 await page.select('[data-cf-template-form] select[name=language]','en');
 await page.$eval('[data-cf-template-form] textarea[name=template]',e=>{e.value='Saved template: {customerName} / {complaintNo}';e.dispatchEvent(new Event('input',{bubbles:true}));});
 assert.equal(await page.$eval('[data-cf-template-preview]',e=>e.value),'Saved template: Nour / CMP-0001');
 assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1));
 await page.screenshot({path:path.join(out,'message-template-editor-mobile.png')});
 await page.click('[data-cf-template-form] button[type=submit]');
 await page.waitForFunction(()=>document.querySelector('[data-cf-message-text]')?.value.startsWith('Saved template:'));
 assert.equal(await page.evaluate(()=>messageConfig.revision),1);
 await page.evaluate(()=>{currentUser.role='staff';currentUser.perms=['complaints'];return ComplaintFlow.open(fixture._id);});
 assert.equal(await page.$('[data-cf-templates]'),null);
 assert.equal(await page.$('[data-cf-action=plan]'),null);assert.equal(await page.$('[data-cf-action=close]'),null);
 assert.equal(await page.$('[data-cf-action=delete]'),null);
 await page.evaluate(()=>ComplaintFlow.form(fixture._id,'delete'));assert.equal(await page.$('[data-cf-delete-form]'),null);
 await page.evaluate(()=>ComplaintFlow.form(fixture._id,'contact'));
 await page.click('[data-cf-form] button[type=submit]');
 await page.waitForSelector('.cf-dialog[open] .cf-grid');
 assert.equal(await page.evaluate(()=>writes.at(-1).action),'contact');
 assert.equal(await page.evaluate(()=>writes.at(-1).note),'');
 // Exercise the custom picker, validation, retry and deletion controls in both languages.
 const uploadFixture=path.join(out,'evidence-fixture.png');
 fs.writeFileSync(uploadFixture,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
 for(const [language,width] of [['ar',390],['en',1440]]){
  await page.setViewport({width,height:950});
  await page.evaluate(async language=>{currentLang=language;fixture.attachments=[];await ComplaintFlow.open(fixture._id);},language);
  assert.equal(await page.$eval('[data-cf-upload]',e=>getComputedStyle(e).display),'none');
  const chooserPromise=page.waitForFileChooser();await page.click('[data-cf-choose-images]');const chooser=await chooserPromise;await chooser.accept([uploadFixture]);
  await page.waitForSelector('[data-cf-remove-image]');
  await page.waitForFunction(()=>!document.querySelector('[data-cf-choose-images]').disabled);
  await page.$eval('.cf-evidence',e=>e.scrollIntoView({block:'center'}));
  assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1));
  await page.screenshot({path:path.join(out,`evidence-${language}-${width}.png`)});
  await page.evaluate(()=>{window.failEvidenceDelete=true;});await page.click('[data-cf-remove-image]');
  await page.waitForFunction(()=>document.querySelector('[data-cf-error]').textContent.includes('Cloudflare'));
  assert.equal(await page.$$eval('[data-cf-remove-image]',els=>els.length),1);
  await page.evaluate(()=>{window.failEvidenceDelete=false;});await page.click('[data-cf-remove-image]');
  await page.waitForFunction(()=>!document.querySelector('[data-cf-remove-image]'));
  // Same file can be selected again after deletion.
  const input=await page.$('[data-cf-upload]');await input.uploadFile(uploadFixture);
  await page.waitForSelector('[data-cf-remove-image]');
  await page.waitForFunction(()=>!document.querySelector('[data-cf-choose-images]').disabled);
 }
 const uploadCount=await page.evaluate(()=>window.evidenceUploads);
 await page.$eval('[data-cf-upload]',input=>{const files=new DataTransfer();files.items.add(new File(['invalid'],'invalid.svg',{type:'image/svg+xml'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
 await page.waitForFunction(()=>document.querySelector('[data-cf-error]').textContent.includes('JPEG'));
 assert.equal(await page.evaluate(()=>window.evidenceUploads),uploadCount);
 assert.equal(await page.$eval('[data-cf-upload]',e=>e.value),'');
 await page.evaluate(async()=>{fixture.attachments=Array.from({length:10},(_,i)=>({id:'cap-'+i,name:'photo.png'}));await ComplaintFlow.open(fixture._id);});
 assert.equal(await page.$eval('[data-cf-choose-images]',e=>e.disabled),true);
 await page.click('[data-cf-remove-image]');await page.waitForFunction(()=>!document.querySelector('[data-cf-choose-images]').disabled);
 for(const [language,width] of [['ar',390],['en',1440]]){
  await page.setViewport({width,height:950});
  await page.evaluate(async language=>{currentLang=language;currentUser.role='admin';window.fixtureDeleted=false;fixture.workflow.stage='closed';fixture.workflow.archivedAt=new Date().toISOString();fixture.lifecycleStage='closed';complaints=[fixture];await ComplaintFlow.open(fixture._id);},language);
  const deletes=await page.evaluate(()=>apiCalls.filter(c=>c.method==='DELETE'&&c.url===`/complaints/${fixture._id}`).length);
  await page.click('[data-cf-action=delete]');await page.waitForSelector('[data-cf-delete-form]');
  assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-cf-cancel-delete')),true);
  assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1));
  await page.screenshot({path:path.join(out,`delete-confirm-${language}-${width}.png`)});
  await page.click('[data-cf-cancel-delete]');await page.waitForSelector('.cf-grid');
  assert.equal(await page.evaluate(()=>apiCalls.filter(c=>c.method==='DELETE'&&c.url===`/complaints/${fixture._id}`).length),deletes);
  await page.evaluate(()=>deleteComplaint(fixture._id));await page.waitForSelector('[data-cf-delete-form]');
  await page.evaluate(()=>{window.failComplaintDelete=true;});await page.click('[data-cf-delete-form] button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('[data-cf-error]').textContent.includes('Cloudflare'));
  assert.equal(await page.evaluate(()=>complaints.length),1);
  assert.equal(await page.$eval('.cf-dialog',e=>e.open),true);
  await page.evaluate(()=>{window.failComplaintDelete=false;});await page.click('[data-cf-delete-form] button[type=submit]');
  await page.waitForFunction(()=>!document.querySelector('.cf-dialog').open);
  assert.equal(await page.evaluate(()=>complaints.length),0);
 }
 // New complaints use the same image picker, with previews, saved drafts and safe upload retries.
 for(const [language,width] of [['ar',390],['en',1440]]){
  await page.setViewport({width,height:950});
  await page.evaluate(async language=>{
   currentLang=language;window.fixtureDeleted=false;fixture.attachments=[];fixture.workflow.stage='review';delete fixture.workflow.archivedAt;fixture.lifecycleStage='review';
   await ComplaintFlow.create(transactions[0]._id);
  },language);
  assert.equal(await page.$('[data-cf-create] [name=imageUrl]'),null);
  assert.equal(await page.$eval('[data-cf-upload]',e=>getComputedStyle(e).display),'none');
  const beforeCreates=await page.evaluate(()=>createWrites.length),beforeUploads=await page.evaluate(()=>evidenceUploads||0);
  await page.$eval('[data-cf-upload]',input=>{const files=new DataTransfer();files.items.add(new File(['invalid'],'bad.svg',{type:'image/svg+xml'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>document.querySelector('[data-cf-error]').textContent.includes('JPEG'));
  assert.equal(await page.$$eval('[data-cf-remove-draft-image]',els=>els.length),0);
  const picker=page.waitForFileChooser();await page.click('[data-cf-choose-images]');await (await picker).accept([uploadFixture]);
  await page.waitForFunction(()=>document.querySelectorAll('[data-cf-remove-draft-image]').length===1&&!document.querySelector('[data-cf-choose-images]').disabled);
  await page.click('[data-cf-remove-draft-image]');await page.waitForFunction(()=>!document.querySelector('[data-cf-remove-draft-image]')&&!document.querySelector('[data-cf-choose-images]').disabled);
  await page.$eval('[data-cf-upload]',input=>{
   const files=new DataTransfer(),bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
   files.items.add(new File([bytes],'first.png',{type:'image/png'}));files.items.add(new File([bytes],'second.png',{type:'image/png'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await page.waitForFunction(()=>document.querySelectorAll('[data-cf-remove-draft-image]').length===2&&!document.querySelector('[data-cf-choose-images]').disabled);
  await page.type('[data-cf-create] [name=description]','Issue with attached photos');
  await page.click('[data-cf-back]');await page.evaluate(()=>ComplaintFlow.create());
  assert.equal(await page.$$eval('[data-cf-remove-draft-image]',els=>els.length),2);
  const stored=await page.evaluate(async()=>{
   const key='complaint-draft:'+currentUser._id,draft=JSON.parse(sessionStorage.getItem(key));
   return new Promise((resolve,reject)=>{const request=indexedDB.open('soulia-complaint-drafts',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,read=db.transaction('images').objectStore('images').get(key+':'+draft.operationKey);read.onsuccess=()=>{db.close();resolve(read.result.map(item=>({name:item.file.name,size:item.file.size})));};};});
  });
  assert.equal(stored.length,2);assert.equal(stored[0].name,'first.png');assert(stored[0].size>0);
  assert.equal(await page.evaluate(()=>createWrites.length),beforeCreates);assert.equal(await page.evaluate(()=>evidenceUploads),beforeUploads);
  await page.$eval('.cf-evidence',e=>e.scrollIntoView({block:'center'}));
  assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1));
  await page.screenshot({path:path.join(out,`create-images-${language}-${width}.png`)});
  await page.evaluate(()=>{window.failEvidenceUploadAt=(window.evidenceAttempts||0)+2;});
  await page.click('[data-cf-create] button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('[data-cf-error]').textContent.includes('Fixture image upload unavailable'));
  assert.equal(await page.evaluate(()=>createWrites.length),beforeCreates+1);
  assert.equal(await page.evaluate(()=>evidenceUploads),beforeUploads+1);
  assert.equal(await page.$$eval('[data-cf-remove-draft-image]',els=>els.length),1);
  assert.equal(await page.$eval('[data-cf-create-details]',e=>e.disabled),true);
  await page.click('[data-cf-back]');await page.evaluate(()=>ComplaintFlow.create());
  assert.equal(await page.$$eval('[data-cf-remove-draft-image]',els=>els.length),1);
  await page.click('[data-cf-create] button[type=submit]');await page.waitForSelector('.cf-dialog[open] .cf-grid');
  assert.equal(await page.evaluate(()=>createWrites.length),beforeCreates+1,'retry must not create another complaint');
  assert.equal(await page.evaluate(()=>evidenceUploads),beforeUploads+2);
  assert.equal(await page.evaluate(()=>createWrites.at(-1).imageUrl),undefined);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('complaint-draft:'+currentUser._id)),null);
 }
 // The timeline explains actual events in chronological order; help never executes actions.
 await page.evaluate(()=>{
  currentUser.role='admin';fixture.createdAt='2026-10-29T08:00:00Z';
  fixture.notes=[{id:'registered',kind:'system',text:'تم إنشاء الشكوى',author:'خدمة العملاء',createdAt:fixture.createdAt}];
  fixture.workflow={version:2,revision:6,cycle:2,stage:'review',ownerId:currentUser._id,owner:'خدمة العملاء',solution:'',history:[
   {action:'reopen',at:'2026-10-29T14:00:00Z',by:'المدير',cycle:2,note:'The customer requested another follow-up.'},
   {action:'plan',at:'2026-10-29T09:00:00Z',by:'المدير',cycle:1,solution:'exchange',note:'Agreed to replace the damaged piece.'},
   {action:'close',at:'2026-10-29T13:00:00Z',by:'المدير',cycle:1,outcome:'resolved',note:'The customer confirmed the solution.'},
   {action:'future-internal-code',at:'2026-10-29T15:00:00Z',by:'خدمة العملاء',cycle:2,note:'<img src=x onerror=alert(1)> Keep the original details.'}
  ],executionEvents:[{action:'replacement-delivered',at:'2026-10-29T12:00:00Z',by:'فريق التنفيذ',caseRef:'AS-0001'}]};
  fixture.lifecycleStage='review';fixture.execution={ready:false,blockers:['evidence']};
 });
 for(const [language,width] of [['ar',390],['en',1440],['ar',320]]){
  await page.setViewport({width,height:950});await page.evaluate(language=>{currentLang=language;return ComplaintFlow.open(fixture._id);},language);
  assert.equal(await page.$$eval('.cf-timeline-step',rows=>rows.length),6);
  const titles=await page.$$eval('.cf-timeline-heading>strong',els=>els.map(e=>e.textContent));
  assert.equal(titles[0],language==='ar'?'تسجيل المشكلة':'Issue registered');
  assert.equal(titles[1],language==='ar'?'اختيار الحل':'Solution chosen');
  assert.equal(titles[4],language==='ar'?'إعادة فتح المشكلة':'Issue reopened');
  assert.equal(await page.$$eval('.cf-timeline-latest',els=>els.length),1);
  assert.equal(await page.$('.cf-timeline img'),null);
  assert(!(await page.$eval('.cf-timeline',e=>e.textContent)).includes('future-internal-code'));
  await page.$eval('.cf-timeline-step:last-child summary',e=>e.click());
  assert((await page.$eval('.cf-timeline-step:last-child details p',e=>e.textContent)).includes('<img src=x onerror=alert(1)>'));
  assert.equal(await page.$$eval('.cf-action-panel [data-cf-help]',els=>els.length),1);
  assert.equal(await page.$('.cf-next [data-cf-help]'),null);
  assert.equal(await page.$('.cf-action-help'),null);
  assert(await page.$eval('.cf-action-panel',e=>e.getBoundingClientRect().height<330));
  assert.equal(await page.$eval('.cf-action-list',e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),2);
  await page.$eval('.cf-action-panel',e=>e.scrollIntoView({block:'center',behavior:'instant'}));
  await page.screenshot({path:path.join(out,`actions-compact-${language}-${width}.png`)});
  const calls=await page.evaluate(()=>apiCalls.length),writesBefore=await page.evaluate(()=>writes.length);
  const help=await page.$('.cf-action-panel [data-cf-help]');await help.click();
  assert.equal(await help.evaluate(e=>e.getAttribute('aria-expanded')),'true');
  assert(await help.evaluate(e=>!document.getElementById(e.getAttribute('aria-controls')).hidden));
  assert((await page.$$eval('.cf-action-guide dt',els=>els.length))>=(await page.$$eval('.cf-action-panel [data-cf-action]',els=>els.length)));
  assert.equal(await page.evaluate(()=>apiCalls.length),calls);assert.equal(await page.evaluate(()=>writes.length),writesBefore);
  await page.keyboard.press('Escape');assert.equal(await page.$eval('.cf-dialog',e=>e.open),true);
  assert.equal(await help.evaluate(e=>e.getAttribute('aria-expanded')),'false');
  await help.focus();await page.keyboard.press('Enter');
  assert.equal(await help.evaluate(e=>e.getAttribute('aria-expanded')),'true');
  assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1));
  await page.$eval('.cf-action-panel',e=>e.scrollIntoView({block:'start'}));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(out,`actions-help-${language}-${width}.png`)});
  await page.$eval('.cf-log',e=>e.scrollIntoView({block:'start'}));
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:path.join(out,`timeline-${language}-${width}.png`)});
 }
 await page.evaluate(()=>{currentUser.role='staff';return ComplaintFlow.open(fixture._id);});
 assert.equal(await page.$('.cf-action-panel [data-cf-action=delete]'),null);
 assert.equal(await page.$('.cf-action-panel [data-cf-action=plan]'),null);
 assert.equal(await page.$$eval('.cf-action-panel [data-cf-help]',els=>els.length),1);
 assert(!(await page.$eval('.cf-action-guide',e=>e.textContent)).includes('حذف نهائي'));
 assert.deepEqual(errors,[],'no browser runtime errors');
 console.log('PASS: complaint/exchange/return navigation, back/close/Escape, scroll and execution draft recovery, delayed response guards; bounded invoice search, shipping, images, selects and workflow at 1440/390/320px in Arabic/English.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
