/* Real UI with isolated HTTP fixtures. No live customer, shipment or payment writes. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'../../..'),pub=path.join(root,'frontend/public'),out=process.env.COMPLAINT_SCREENSHOT_DIR||path.join(root,'artifacts/complaint-page');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await puppeteer.launch({headless:true,pipe:true});
 try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
 await page.evaluateOnNewDocument(()=>{let i=0;if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>`fixture-key-${++i}`});});
 await page.setRequestInterception(true);
 page.on('request',r=>{const u=new URL(r.url());if(u.origin==='http://soulia.test'&&u.pathname==='/')return r.respond({status:200,contentType:'text/html',body:fs.readFileSync(path.join(pub,'index.html'),'utf8')});
  if(['/complaint-flow.js','/after-sales.js','/order-status.js','/navigation-shell.js','/navigation-history.js','/workspace-tabs.js','/designme/date-range-picker/soulia-range.js'].includes(u.pathname)||u.pathname.endsWith('.css')||u.pathname.endsWith('.svg')){
   const file=path.resolve(pub,'.'+u.pathname);
   if(file.startsWith(pub+path.sep)&&fs.existsSync(file))return r.respond({status:200,contentType:u.pathname.endsWith('.js')?'text/javascript':u.pathname.endsWith('.css')?'text/css':'image/svg+xml',body:fs.readFileSync(file)});
  }
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
  _transactionSummariesComplete=true;
  window.fixtureBuildSidebar=buildSidebar;buildSidebar=()=>{};buildNotifications=()=>{};syncVaultState=async()=>{};toast=()=>{};
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
    if(window.failEvidenceRead)throw new Error('Fixture photo unavailable');
    return {data:window.evidencePhoto||'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='};
   }
   if(url==='/complaints/message-templates'){if(options.method==='PUT'){messageConfig.templates=body.templates;messageConfig.revision++;}return structuredClone(messageConfig);}
   if(url.includes('/customer-message?'))return customerMessage(url);
   if(url.includes('?view=workspace')){if(failWorkspace)throw new Error('Fixture connection unavailable');const row={...structuredClone(fixture),customerMessage:customerMessage(url)};return holdWorkspace?new Promise(resolve=>pendingWorkspace.push(()=>resolve(row))):row;}
   if(url==='/users')return [currentUser];if(url==='/complaints'){
    if(options.method==='POST'){createWrites.push(body);return fixture;}return window.fixtureDeleted?[]:[fixture];
   }
   if(url.startsWith('/complaints/')&&url.endsWith('/workflow')){
    if(window.rejectPlan&&body.action==='plan')throw Object.assign(new Error('Plan rejected by fixture'),{status:400});
    writes.push(body);const w=fixture.workflow;
    if(body.action==='plan'){w.solution=body.solution;w.stage='planned';w.dueAt=body.dueAt;w.amount=body.amount||0;fixture.execution.blockers=['case_required'];}
    if(body.action==='wait'){w.stage='waiting';w.waitReason=body.note;w.dueAt=body.dueAt;}
    if(body.action==='close'){if(!fixture.execution.ready)throw new Error('الحل غير مكتمل');w.stage='closed';w.outcome=body.outcome;w.closureNote=body.note;fixture.surveySlug='safe-fixture-survey';}
    if(body.action==='reopen'){w.stage='review';w.solution='';w.caseId='';w.cycle++;fixture.surveySlug=undefined;fixture.execution={ready:false,blockers:['evidence']};}
    if(body.action==='contact'){w.dueAt=body.dueAt||w.dueAt;w.contacts=[...(w.contacts||[]),{channel:body.channel,result:body.contactResult,note:body.note,at:new Date().toISOString(),dueAt:body.dueAt}];}
    w.history.push({id:String(w.revision),action:body.action,by:currentUser.name,note:body.note,at:new Date().toISOString(),dueAt:body.dueAt,solution:body.solution,channel:body.channel,contactResult:body.contactResult});w.revision++;fixture.lifecycleStage=w.stage;return fixture;
   }
   if(url.startsWith('/complaints/'))return fixture;
   if(url.startsWith('/after-sales/invoice/'))return {invoice:transactions[0],prior:[],cases:[],identities:{lines:window.afterSalesIdentities||[]},products:[{_id:'555555555555555555555555',name:'طقم سفرة',code:'A',sellPrice:500,available:10,imageUrl:'/fixture-product.svg'}],policy:window.afterSalesPolicy||{}};
   if(url==='/after-sales/quote')return {quote:{credit:500,replacement:500,customerFee:0,creditApplied:500,collectDue:0,refundDue:0}};
   if(url==='/after-sales'&&options.method==='POST'){lastCase=body;return {_id:'444444444444444444444444'};}
   if(url.startsWith('/after-sales?'))return [];
   if(url.startsWith('/after-sales/')){const row={_id:'444444444444444444444444',originalTransactionId:transactions[0]._id,originalRef:'2790',client:fixture.clientName,requestKind:executionKind,items:fixture.items,exchangeItems:[],workflow:{version:2,ref:'AS-2026-000002',stage:'requested',complaintIds:[fixture._id],quote:{credit:500,replacement:500,customerFee:0,collectDue:0,refundDue:0},history:[]}};return holdExecution?new Promise(resolve=>pendingExecution.push(()=>resolve(row))):row;}
   if(url==='/transactions')return transactions;if(url==='/returns'||url==='/transactions/inventory')return [];return [];
  };
 });
 if(process.env.COMPLAINT_SOLUTION_FOLLOWUP_REVIEW){
  const flowOut=path.join(root,'artifacts/complaint-solution-followup');fs.mkdirSync(flowOut,{recursive:true});
  const M='dialog.cf-dialog[open] ',F=M+'[data-cf-form] ',P='#page-complaint-detail.active ';
  const ready=()=>page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open],dialog.as-dialog[open]')&&document.querySelector('#page-complaint-detail.active .cf-case-layout'));
  const due=async(day='2027-01-15')=>page.evaluate(day=>{const f=document.querySelector('[data-cf-form]');f.elements.dueDate.value=day;f.elements.dueTime.value='15:30';f.elements.dueTime.dispatchEvent(new Event('change',{bubbles:true}));},day);
  await page.emulateTimezone('America/Los_Angeles');
  for(const [language,width,dark] of [['ar',1440,false],['en',1440,false],['ar',390,false],['en',320,false],['ar',390,true]]){
   await page.setViewport({width,height:950});
   await page.evaluate(async({language,dark})=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',dark);await ComplaintFlow.open(fixture._id);await ComplaintFlow.form(fixture._id,'plan');},{language,dark});
   await page.click(F+'select[name=solution]+.pm-sel-btn');await page.waitForSelector('.cf-select-panel.show');
   assert(await page.$$eval('.cf-select-panel,.cf-select-panel .pm-sel-list,.cf-select-panel .pm-sel-opt',nodes=>nodes.every(e=>e.scrollWidth<=e.clientWidth+1)),'solution options never create horizontal scrolling');
   await page.screenshot({path:path.join(flowOut,`menu-${language}-${width}${dark?'-dark':''}.png`)});
   await page.keyboard.press('Escape');
   if(width>768){
    await page.click(F+'[name=dueDate]');await page.waitForSelector('.sdp-panel.show:popover-open');
    assert(await page.$eval('.sdp-panel',e=>e.closest('dialog')?.classList.contains('cf-dialog')),'approved calendar stays above the modal');
    await page.screenshot({path:path.join(flowOut,`calendar-${language}-${width}.png`)});
    await page.keyboard.press('Escape');assert(await page.$(F+'[name=dueDate]'),'calendar Escape keeps the action form open');
    await page.click(F+'[name=dueDate]');await page.waitForSelector('.sdp-panel.show:popover-open');
    const title=await page.$eval('.sdp-title',e=>e.textContent);await page.click('.sdp-panel [data-step="1"]');assert.notEqual(await page.$eval('.sdp-title',e=>e.textContent),title);
    const day=await page.$eval('.sdp-day:not(:disabled):not(.is-muted)',e=>e.dataset.date);await page.click('.sdp-day:not(:disabled):not(.is-muted)');
    assert.equal(await page.$eval(F+'[name=dueDate]',e=>e.value),day);
   }
   await page.screenshot({path:path.join(flowOut,`deadline-${language}-${width}${dark?'-dark':''}.png`)});
   await page.click(F+'[data-cf-back]');await ready();
   await page.evaluate(()=>ComplaintFlow.form(fixture._id,'contact'));await due();
   await page.select(F+'[name=channel]','whatsapp');await page.select(F+'[name=contactResult]','no_answer');await page.type(F+'[name=note]','Call again after 15:30.');
   await page.click(F+'[type=submit]');await ready();
   assert.equal(await page.evaluate(()=>writes.at(-1).dueAt),'2027-01-15T13:30:00.000Z','Cairo winter time is independent of the browser timezone');
   const note=await page.$eval(P+'[data-cf-activity=contact]',e=>e.textContent);assert(note.includes('WhatsApp')&&note.includes('Call again after 15:30.')&&note.includes('15:30'));
   assert(await page.$$eval(P+'.cf-activity-note',e=>e.length<=3),'recent notes remain compact');
   await page.screenshot({path:path.join(flowOut,`contact-${language}-${width}${dark?'-dark':''}.png`),fullPage:true});
  }
  await page.setViewport({width:1440,height:950});await page.evaluate(()=>{currentLang='en';document.documentElement.dir='ltr';document.body.classList.remove('dark-mode');});
  for(const solution of ['exchange','return','support','delivery','compensation','refund_without_return']){
   await page.evaluate(()=>ComplaintFlow.form(fixture._id,'plan'));const before=await page.evaluate(()=>writes.length);await page.select(F+'[name=solution]',solution);await due('2027-07-15');
   if(['compensation','refund_without_return'].includes(solution)){await page.$eval(F+'[name=amount]',e=>e.value='125.25');await page.click(F+'[name=confirmed]');}
   await page.type(F+'[name=note]','Agreed next step: '+solution);assert.equal(await page.evaluate(()=>writes.length),before,'choosing a solution alone never saves');
   await page.click(F+'[type=submit]');
   if(['exchange','return'].includes(solution)){
    await page.waitForSelector('dialog.as-dialog[open] [data-as-create]');assert.equal(await page.$eval('[data-as-create] [name=kind]',e=>e.value),solution);await page.click('[data-as-back-complaint]');
   }else{const action=['support','delivery'].includes(solution)?'fulfill':'payment';await page.waitForSelector(`dialog.cf-dialog[open][data-cf-form-action="${action}"]`);await page.click(F+'[data-cf-back]');}
   await ready();assert.equal(await page.evaluate(()=>writes.length),before+1,'only the plan is committed; execution still needs its own confirmation');
   assert.equal(await page.evaluate(()=>writes.at(-1).dueAt),'2027-07-15T12:30:00.000Z','Cairo summer time is converted correctly');
   assert((await page.$eval(P+'[data-cf-activity=plan]',e=>e.textContent)).includes('Agreed next step: '+solution));
  }
  await page.evaluate(()=>{rejectPlan=true;return ComplaintFlow.form(fixture._id,'plan');});await page.select(F+'[name=solution]','exchange');await due();await page.click(F+'[type=submit]');
   await page.waitForFunction(()=>document.querySelector('dialog.cf-dialog[open] [data-cf-error]')?.textContent.includes('Plan rejected'));
  assert(await page.$('dialog.cf-dialog[open][data-cf-form-action=plan]'),'failed plan stays on the same form');assert.equal(await page.$('dialog.as-dialog[open]'),null);
  assert.deepEqual(errors,[]);console.log('PASS solution/follow-up: no horizontal menus, approved calendar, Cairo winter/summer dates, visible contact notes, six next steps and failed-save guard');return;
 }
 if(process.env.COMPLAINT_PRODUCT_ISSUES_REVIEW){
  const productOut=path.join(root,'artifacts/complaint-product-issues');fs.mkdirSync(productOut,{recursive:true});
  const M='dialog.cf-dialog[open] ',F=M+'[data-cf-create] ',R=index=>F+`[data-cf-line="${index}"] `;
  await page.evaluate(()=>{
   transactions[0].items[0].qty=1;transactions[0].items.forEach(item=>item.imageUrl='/fixture-product.svg');
   const originalApi=api;
   api=async(url,options={})=>{const result=await originalApi(url,options);if(options.method==='POST'&&(url==='/complaints'||url.endsWith('/workflow')&&JSON.parse(options.body).action==='items')){
    const body=JSON.parse(options.body);fixture.categoryGroup=body.categoryGroup||fixture.categoryGroup;fixture.items=body.items.map(item=>{const saved={...transactions[0].items[item.lineIndex],...item};if(window.dropSavedProductDetails){delete saved.issueType;delete saved.issueDescription;}return saved;});fixture.additionalDescription=body.description||'';fixture.description=fixture.items.map(i=>i.name+': '+i.issueDescription).join('\n');return structuredClone(fixture);
   }return result;};
  });
  for(const [language,width,dark] of [['ar',1440,false],['en',1440,false],['ar',390,false],['en',320,false],['ar',390,true]]){
   await page.setViewport({width,height:950});
   await page.evaluate(async({language,dark})=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',dark);await ComplaintFlow.create(transactions[0]._id);},{language,dark});
   const before=await page.evaluate(()=>createWrites.length);
   assert(await page.$eval(R(0)+'[type=number]',e=>e.disabled),'unchecked products have inactive quantities');
   await page.click(R(0)+'[type=checkbox]');await page.click(R(1)+'[type=checkbox]');
   assert.equal(await page.$$eval(F+'.is-invalid',e=>e.length),0,'selecting a product does not show premature errors');
   assert.equal(await page.$eval(F+'[name=description]',e=>e.required),false,'general description is optional when each product owns an issue');
   await page.select(F+'[name=categoryGroup]','مشكلة في المنتج');
   await page.click(R(0)+'select+.pm-sel-btn');await page.waitForSelector('.cf-select-panel.show');
   assert(await page.$eval('.cf-select-panel',e=>getComputedStyle(e).overflowX==='hidden'&&getComputedStyle(e).overflowY==='hidden'&&e.scrollWidth<=e.clientWidth+1&&e.scrollHeight<=e.clientHeight+1),'menu frame never becomes a second scroll container');
   assert(await page.$eval('.cf-select-panel .pm-sel-list',e=>e.scrollHeight>e.clientHeight&&e.scrollWidth<=e.clientWidth+1),'product issue choices scroll vertically only');
   await page.$eval('.cf-select-panel .pm-sel-list',e=>e.scrollTop=e.scrollHeight);
   await page.screenshot({path:path.join(productOut,`issue-menu-${language}-${width}${dark?'-dark':''}.png`)});
   await page.click('.cf-select-panel [data-idx="7"]');assert.equal(await page.$eval(R(0)+'[data-cf-item-reason]',e=>e.value),'other','the last option remains selectable after scrolling');
   await page.$eval(R(0)+'[type=number]',e=>{e.value='99';e.dispatchEvent(new Event('input',{bubbles:true}));});
   assert.equal(await page.$eval(R(0)+'[type=number]',e=>e.value),'1','typing cannot exceed invoice quantity');
   await page.click(F+'[type=submit]');assert.equal(await page.evaluate(()=>createWrites.length),before,'each selected product requires its issue');
   await page.select(R(0)+'[data-cf-item-reason]','wrong_color');await page.type(R(0)+'[data-cf-item-description]','Ordered white, received beige.');
   await page.select(R(1)+'[data-cf-item-reason]','other');await page.click(F+'[type=submit]');
   assert.equal(await page.evaluate(()=>createWrites.length),before,'Other still requires a product-specific description');
   await page.type(R(1)+'[data-cf-item-description]','The zipper cannot close.');
   await page.$eval(R(0)+'[type=number]',e=>e.value='2');await page.click(F+'[type=submit]');assert.equal(await page.evaluate(()=>createWrites.length),before,'save rejects an out-of-range value even without an input event');
   await page.$eval(R(0)+'[type=number]',e=>{e.value='1';e.dispatchEvent(new Event('input',{bubbles:true}));});
   await page.click(R(1)+'[type=checkbox]');assert(await page.$eval(R(1)+'[data-cf-item-description]',e=>e.disabled));
   await page.click(R(1)+'[type=checkbox]');assert.equal(await page.$eval(R(1)+'[data-cf-item-description]',e=>e.value),'The zipper cannot close.');
   await page.click(F+'[data-cf-back]');await page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open]'));
   await page.evaluate(()=>ComplaintFlow.create());
   assert.equal(await page.$eval(R(0)+'[data-cf-item-reason]',e=>e.value),'wrong_color');assert.equal(await page.$eval(R(1)+'[data-cf-item-description]',e=>e.value),'The zipper cannot close.','per-product draft survives closing');
   assert(await page.$eval(M+'.cf-body',e=>e.scrollWidth<=e.clientWidth+1),`product issue form overflow ${language}/${width}`);
   await page.$eval(M+'.cf-body',e=>e.scrollTop=0);await page.screenshot({path:path.join(productOut,`form-${language}-${width}${dark?'-dark':''}.png`)});
   await page.click(F+'[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open]')&&document.querySelector('#page-complaint-detail.active .cf-case-layout'));
   assert.deepEqual(await page.evaluate(()=>createWrites.at(-1).items),[{lineIndex:0,qty:1,issueType:'wrong_color',issueDescription:'Ordered white, received beige.'},{lineIndex:1,qty:1,issueType:'other',issueDescription:'The zipper cannot close.'}]);
   const cards=await page.$$eval('#page-complaint-detail .cf-affected-with-issue',nodes=>nodes.map(e=>e.textContent));assert.equal(cards.length,2);assert(cards[0].includes('Ordered white')&&!cards[0].includes('zipper'));assert(cards[1].includes('zipper')&&!cards[1].includes('Ordered white'));
   assert.deepEqual(await page.$$eval('#page-complaint-detail .cf-product-issue',nodes=>nodes.map(e=>[...e.querySelectorAll('dt')].map(label=>label.textContent))),Array(2).fill(language==='ar'?['المشكلة','الوصف']:['Issue','Description']),'each product has explicit issue and description labels');
   assert.deepEqual(await page.$$eval('#page-complaint-detail [data-cf-item-description-text]',nodes=>nodes.map(e=>e.textContent)),['Ordered white, received beige.','The zipper cannot close.']);
   assert(await page.$$eval('#page-complaint-detail .cf-affected-item',nodes=>nodes.every(e=>e.querySelector('.cf-product-issue').getBoundingClientRect().top>=Math.max(e.querySelector('.cf-product-info').getBoundingClientRect().bottom,e.querySelector('.cf-product-image').getBoundingClientRect().bottom))),'issue details sit below their own product card header');
   await page.screenshot({path:path.join(productOut,`case-${language}-${width}${dark?'-dark':''}.png`),fullPage:true});
  }
  await page.evaluate(()=>ComplaintFlow.form(fixture._id,'items'));await page.waitForSelector(R(0)+'[data-cf-item-description]');
  assert.equal(await page.$eval(R(0)+'[data-cf-item-reason]',e=>e.value),'wrong_color','editing retains product issues');
  await page.select(R(0)+'[data-cf-item-reason]','missing');await page.$eval(R(0)+'[data-cf-item-description]',e=>{e.value='This item never arrived.';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.click(F+'[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open]'));
  assert.equal(await page.evaluate(()=>writes.at(-1).items[0].issueType),'missing');assert.equal(await page.evaluate(()=>writes.at(-1).items[1].issueDescription),'The zipper cannot close.');
  // The shared fix also covers menus outside a modal, with search and long labels.
  for(const [language,width] of [['en',1440],['ar',390],['en',320]]){
   await page.setViewport({width,height:950});
   await page.evaluate(language=>{document.body.classList.remove('dark-mode');currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';const host=document.createElement('div');host.dataset.menuRegression='';host.dir=language==='ar'?'rtl':'ltr';host.style.cssText='position:fixed;top:80px;inset-inline-end:8px;width:230px;z-index:1200';host.innerHTML='<span id="menu-regression-label">Product choices</span><select aria-labelledby="menu-regression-label">'+Array.from({length:12},(_,i)=>'<option value="'+i+'">'+(i===11?'TOKEN'+'x'.repeat(100):'Product option '+i)+'</option>').join('')+'</select>';document.body.appendChild(host);_pmEnhanceSelects(host);},language);
   await page.click('[data-menu-regression] .pm-sel-btn');await page.waitForSelector('.pm-sel-panel.show');
   const frame=await page.$eval('.pm-sel-panel',e=>{const r=e.getBoundingClientRect();return {className:e.className,overflow:getComputedStyle(e).overflowX,width:e.clientWidth,scrollWidth:e.scrollWidth,height:e.clientHeight,scrollHeight:e.scrollHeight,left:r.left,right:r.right,viewport:innerWidth,children:[...e.children].map(n=>({className:n.className,height:n.offsetHeight,width:n.offsetWidth}))};});
   assert(!frame.className.includes('cf-select-panel')&&frame.overflow==='hidden'&&frame.scrollWidth<=frame.width+1&&frame.scrollHeight<=frame.height+1&&frame.left>=0&&frame.right<=frame.viewport,'shared searchable menu fits its frame and viewport: '+JSON.stringify(frame));
   await page.type('.pm-sel-search','TOKEN');
   assert(await page.$eval('.pm-sel-opt[data-idx="11"]',e=>getComputedStyle(e).whiteSpace==='normal'&&e.scrollWidth<=e.clientWidth+1),'long option text wraps instead of creating horizontal overflow');
   await page.screenshot({path:path.join(productOut,`shared-menu-${language}-${width}.png`)});
   await page.click('.pm-sel-opt[data-idx="11"]');assert.equal(await page.$eval('[data-menu-regression] select',e=>e.value),'11');await page.$eval('[data-menu-regression]',e=>e.remove());
  }
  // An older server may accept items but discard fields it does not know.
  // Keep the intended details, retain the created ID, and repair that same case.
  const beforeMismatch=await page.evaluate(()=>createWrites.length);
  await page.evaluate(()=>{dropSavedProductDetails=true;return ComplaintFlow.create(transactions[0]._id);});
  await page.click(R(0)+'[type=checkbox]');await page.select(R(0)+'[data-cf-item-reason]','wrong_color');await page.type(R(0)+'[data-cf-item-description]','White was ordered; beige arrived.');await page.select(F+'[name=categoryGroup]','مشكلة في المنتج');
  await page.click(F+'[type=submit]');await page.waitForFunction(()=>document.querySelector('dialog.cf-dialog[open] [data-cf-error]')?.textContent.includes('not saved'));
  assert.equal(await page.evaluate(()=>createWrites.length),beforeMismatch+1);
  const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('complaint-draft:'+currentUser._id)));
  assert(pending.createdId&&pending.itemDetailsPending);assert.equal(pending.items[0].issueDescription,'White was ordered; beige arrived.');
  assert(await page.$eval(F+'[data-cf-discard]',e=>e.disabled),'unconfirmed product details cannot be silently discarded by skipping images');
  await page.click(F+'[data-cf-back]');await page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open]'));
  await page.evaluate(()=>ComplaintFlow.create());assert.equal(await page.$eval(R(0)+'[data-cf-item-description]',e=>e.value),'White was ordered; beige arrived.','unconfirmed product details survive closing the draft');
  await page.evaluate(()=>dropSavedProductDetails=false);await page.click(F+'[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open]'));
  assert.equal(await page.evaluate(()=>createWrites.length),beforeMismatch+1,'retry repairs the existing case instead of creating a duplicate');
  assert.equal(await page.evaluate(()=>writes.at(-1).action),'items');
  assert.equal(await page.$eval('#page-complaint-detail [data-cf-item-description-text]',e=>e.textContent),'White was ordered; beige arrived.');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('complaint-draft:'+currentUser._id)),null,'draft clears only after the saved product details are confirmed');
  // The edit path must also reject a successful response that lost the details.
  await page.evaluate(()=>{dropSavedProductDetails=true;return ComplaintFlow.form(fixture._id,'items');});
  await page.$eval(R(0)+'[data-cf-item-description]',e=>{e.value='Customer confirmed the beige color is wrong.';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.click(F+'[type=submit]');await page.waitForFunction(()=>document.querySelector('dialog.cf-dialog[open] [data-cf-error]')?.textContent.includes('not saved'));
  assert.equal(await page.$eval(R(0)+'[data-cf-item-description]',e=>e.value),'Customer confirmed the beige color is wrong.');
  await page.evaluate(()=>dropSavedProductDetails=false);await page.click(F+'[type=submit]');await page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open]'));
  assert.equal(await page.$eval('#page-complaint-detail [data-cf-item-description-text]',e=>e.textContent),'Customer confirmed the beige color is wrong.');
  assert.deepEqual(errors,[]);console.log('PASS product-specific complaints: bounded quantities, required reasons/descriptions, persisted item cards, drafts, edit/retry integrity, vertical-only menus and responsive layouts');return;
 }
 if(process.env.AFTER_SALES_MOTION_REVIEW){
  const motionOut=path.join(root,'artifacts/after-sales-motion');fs.mkdirSync(motionOut,{recursive:true});
  const M='dialog.as-dialog[open] ',F=M+'[data-as-create] ';
  const closed=()=>page.waitForFunction(()=>!document.querySelector('dialog.as-dialog[open]'));
  const settle=()=>page.evaluate(async()=>{const node=document.querySelector('dialog.as-dialog[open]');await Promise.allSettled(node.getAnimations().map(a=>a.finished));});
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
  await page.evaluate(()=>{const originalApi=api;window.pendingInvoice=[];window.holdInvoice=false;api=(url,options)=>holdInvoice&&url.startsWith('/after-sales/invoice/')?new Promise(resolve=>pendingInvoice.push(()=>originalApi(url,options).then(resolve))):originalApi(url,options);});
  for(const [kind,width,language] of [['return',1440,'en'],['exchange',390,'ar']]){
   await page.setViewport({width,height:950});
   await page.evaluate(async({kind,language})=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';await AfterSales.create(transactions[0]._id,kind);},{kind,language});
   assert(await page.$eval(M.trim(),node=>node.getAnimations().some(a=>a.effect.target===node&&a.effect.getTiming().duration===200&&a.effect.getKeyframes()[0].opacity==='0')),'first entry animates the entire window from transparent');
   assert.equal(await page.$eval(M.trim(),node=>getComputedStyle(node,'::backdrop').animationName),'as-backdrop-in');
   await settle();await page.screenshot({path:path.join(motionOut,`ready-${kind}-${width}.png`)});
   await page.click(M+'.as-close');assert(await page.$(M+'.as-close'),'window stays mounted during its exit');
   assert.equal(await page.$eval(M.trim(),node=>getComputedStyle(node,'::backdrop').animationName),'as-backdrop-out');await closed();
   await page.evaluate(async kind=>{fixture.workflow.solution=kind;await ComplaintFlow.open(fixture._id);await ComplaintFlow.execution(fixture._id);},kind);await page.waitForSelector(F+'[name=note]');
   assert(await page.$eval(M.trim(),node=>node.getAnimations().some(a=>a.effect.target===node&&a.effect.getTiming().duration===200)),'linked request also animates its frame');
   await page.type(F+'[name=note]','Keep this animated draft');await settle();await page.click('[data-as-back-complaint]');await closed();
   await page.evaluate(()=>ComplaintFlow.execution(fixture._id));await page.waitForSelector(F+'[name=note]');
   assert.equal(await page.$eval(F+'[name=note]',e=>e.value),'Keep this animated draft');
   await settle();
   await page.evaluate(()=>{document.querySelector('dialog.as-dialog .as-close').click();return ComplaintFlow.execution(fixture._id);});await settle();
   assert(await page.$(F+'[name=note]'),'a cancelled exit cannot dismiss a quickly reopened draft');
   await page.keyboard.press('Escape');await closed();
  }
  await page.setViewport({width:1440,height:950});
  await page.evaluate(()=>{holdInvoice=true;window.invoiceTask=AfterSales.create(transactions[0]._id);});await page.waitForSelector(M+'[data-as-create-loading]');await settle();
  const loadingWidth=await page.$eval(M.trim(),e=>e.offsetWidth);
  await page.evaluate(async()=>{holdInvoice=false;pendingInvoice.splice(0).forEach(resolve=>resolve());await invoiceTask;});
  assert.equal(await page.$eval(M.trim(),e=>e.offsetWidth),loadingWidth,'loading and the completed form share their width');
  assert(await page.$eval(M.trim(),node=>node.getAnimations().some(a=>a.effect.target===node&&a.effect.getKeyframes().some(frame=>frame.height))),'a delayed invoice changes the frame height gradually');await settle();
  await page.click(M+'.as-close');await closed();
  await page.evaluate(()=>{holdInvoice=true;window.invoiceTask=AfterSales.create(transactions[0]._id);});await page.waitForSelector(M+'[data-as-create-loading]');await settle();
  await page.click(M+'.as-close');
  await page.evaluate(async()=>{holdInvoice=false;pendingInvoice.splice(0).forEach(resolve=>resolve());await invoiceTask;});await closed();
  assert.equal(await page.$(M+'[data-as-create]'),null,'a response arriving during exit cannot reopen the request');
  await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);await page.evaluate(()=>AfterSales.create(transactions[0]._id));
  assert.equal(await page.$eval(M.trim(),node=>node.getAnimations().length),0,'reduced motion has no frame animations');
  assert.equal(await page.$eval(M.trim(),node=>getComputedStyle(node,'::backdrop').animationName),'none');await page.click(M+'.as-close');await closed();
  assert.deepEqual(errors,[]);console.log('PASS after-sales motion: full-frame entry/exit, backdrop fade, stable loading width, animated resize, drafts, rapid reopen, late-response guard and reduced motion');return;
 }
 if(process.env.AFTER_SALES_CREATE_REVIEW){
  const requestOut=path.join(root,'artifacts/after-sales-create');fs.mkdirSync(requestOut,{recursive:true});
  const M='dialog.as-dialog[open] ',F=M+'[data-as-create] ';
  await page.evaluate(()=>{transactions[0].items.forEach(i=>i.imageUrl='/fixture-product.svg');transactions[0].deliveredAt='2026-11-08T18:30:00Z';});
  for(const [language,width,dark] of [['ar',1440,false],['en',1440,false],['ar',390,false],['en',320,false],['ar',768,true]]){
   await page.setViewport({width,height:width>1000?900:844});
   await page.evaluate(async({language,dark})=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',dark);await AfterSales.create(transactions[0]._id);},{language,dark});
   assert.equal(await page.$$eval(F+'.pm-sel-btn',e=>e.length),3,'three compact enhanced selects');
   assert.equal(await page.$$eval(F+'.pm-sel-btn>.as-form-icon',e=>e.length),3,'selected values have icons');
   assert(await page.$eval(F+'.as-request-date time',e=>e.dateTime==='2026-11-08T18:30:00Z'&&!e.textContent.includes('18:30')),'compact delivery date');
   const geometry=()=>page.$eval('dialog.as-dialog[open]',e=>{const footer=e.querySelector('.as-foot').getBoundingClientRect(),r=e.getBoundingClientRect(),content=e.querySelector('.as-create-content');return {left:r.left,right:r.right,bottom:r.bottom,height:r.height,footerBottom:footer.bottom,footerTop:footer.top,viewport:innerHeight,width:innerWidth,overflow:content.scrollWidth-content.clientWidth,scroll:content.scrollHeight-content.clientHeight};});
   let g=await geometry();assert(g.left>=0&&g.right<=g.width&&g.bottom<=g.viewport&&g.overflow<=1,JSON.stringify({language,width,g}));
   assert(g.footerBottom<=g.viewport&&g.footerTop>=0,'submit action is always visible');
   if(width>1000)assert(g.scroll<=1&&g.height<740,'typical desktop request fits without inner scrolling');
   await page.screenshot({path:path.join(requestOut,`return-${language}-${width}${dark?'-dark':''}.png`)});
   await page.click(F+'select[name=kind]+.pm-sel-btn');await page.waitForSelector('.as-select-panel.show');
   assert.equal(await page.$$eval('.as-select-panel .as-form-icon',e=>e.length),2);
   assert(await page.$eval('.as-select-panel',e=>e.matches(':popover-open')),'menu escapes modal clipping in top layer');
   await page.click('.as-select-panel [data-idx="1"]');
   assert.equal(await page.$eval(F+'[name=kind]',e=>e.value),'exchange');
   await page.click(F+'select[name=reason]+.pm-sel-btn');await page.waitForSelector('.as-select-panel.show');
   assert(await page.$$eval('.as-select-panel .pm-sel-optlbl',labels=>labels.every(e=>getComputedStyle(e).whiteSpace==='normal'&&e.scrollWidth<=e.clientWidth+1)),'menu labels stay readable without truncation');
   await page.screenshot({path:path.join(requestOut,`menu-${language}-${width}${dark?'-dark':''}.png`)});
   await page.keyboard.press('Escape');assert(await page.$(M+'[data-as-create]'),'first Escape closes the menu only');
   await page.click(F+'select[name=fulfillmentChannel]+.pm-sel-btn');await page.waitForSelector('.as-select-panel.show');
   await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
   assert.equal(await page.$eval(F+'[name=fulfillmentChannel]',e=>e.value),'direct','fulfillment selection supports keyboard');
   await page.$eval(F+'[data-as-qty]',e=>{e.value='1';e.dispatchEvent(new Event('change',{bubbles:true}));});
   await page.click(F+'[data-as-add]');await page.click(F+'[data-as-pick]');
   await page.waitForSelector(F+'[data-as-summary-kind=exchange]');
   assert(await page.$eval(F+'.as-total',e=>{const luminance=color=>{const c=color.match(/[\d.]+/g).slice(0,3).map(Number).map(n=>{n/=255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return c[0]*.2126+c[1]*.7152+c[2]*.0722;};const a=luminance(getComputedStyle(e).color),b=luminance(getComputedStyle(e.closest('.as-card')).backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5;}),'settlement total remains readable in either theme');
   await page.focus(F+'[data-as-search]');await page.keyboard.press('Escape');
   assert(await page.$eval(F+'[data-as-picker]',e=>e.hidden),'Escape dismisses the product picker before the dialog');
   assert.equal(await page.$eval(F+'[data-as-add]',e=>e.getAttribute('aria-expanded')),'false');
   await page.$eval(F+'.as-create-content',e=>e.scrollTop=0);
   g=await geometry();assert(g.overflow<=1&&g.footerBottom<=g.viewport,JSON.stringify({language,width,g}));
   if(width>1000)assert(g.scroll<=1,'a two-item exchange also fits on desktop');
   await page.screenshot({path:path.join(requestOut,`exchange-${language}-${width}${dark?'-dark':''}.png`)});
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('dialog.as-dialog[open]'));
  }
  // Fee rules and submitted values remain the server-facing contract, including direct handover.
  await page.setViewport({width:1440,height:900});
  await page.evaluate(async()=>{document.body.classList.remove('dark-mode');afterSalesPolicy={customerFeesEnabled:true,returnFee:45,exchangeFee:60};await AfterSales.create(transactions[0]._id);});
  assert.equal(await page.$eval(F+'[name=customerFee]',e=>e.value),'45');assert(await page.$eval(F+'.as-fee-details',e=>e.open));
  await page.select(F+'[name=reason]','defect');assert.equal(await page.$eval(F+'[name=customerFee]',e=>e.value),'0');assert(await page.$eval(F+'[name=customerFee]',e=>e.disabled));
  await page.select(F+'[name=reason]','customer-choice');await page.select(F+'[name=fulfillmentChannel]','direct');assert.equal(await page.$eval(F+'[name=customerFee]',e=>e.value),'0');
  await page.$eval(F+'[name=customerFee]',e=>{e.value='55';e.dispatchEvent(new Event('input',{bubbles:true}));});
  await page.type(F+'[name=feeBasis]','Agreed collection and inspection cost');
  await page.$eval(F+'[data-as-qty]',e=>{e.value='1';e.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.click(F+'button[type=submit]');await page.waitForSelector(M+'[data-as-print]');
  assert.deepEqual(await page.evaluate(()=>({kind:lastCase.kind,fee:lastCase.customerFee,channel:lastCase.fulfillmentChannel,items:lastCase.items,exchangeItems:lastCase.exchangeItems})),{kind:'return',fee:55,channel:'direct',items:[{lineIndex:0,qty:1,unitIds:[]}],exchangeItems:[]});
  await page.keyboard.press('Escape');
  // Long invoices scroll once; the submit action stays outside the scroller.
  await page.evaluate(async()=>{transactions[0].items=Array.from({length:24},(_,i)=>({name:'منتج '+i,code:'P'+i,qty:2}));await AfterSales.create(transactions[0]._id);});
  assert(await page.$eval(F+'.as-create-content',e=>e.scrollHeight>e.clientHeight));
  assert(await page.$eval(F+'.as-foot',e=>e.getBoundingClientRect().bottom<=innerHeight));
  await page.keyboard.press('Escape');
  // Linked drafts preserve the new content scroller as well as the form values.
  await page.evaluate(async()=>{fixture.workflow.solution='exchange';await ComplaintFlow.open(fixture._id);await ComplaintFlow.execution(fixture._id);});
  await page.waitForSelector(F+'[name=note]');
  assert(await page.$eval(F+'[name=kind]',e=>e.disabled&&getComputedStyle(e).opacity==='0'),'locked request type keeps the native select hidden');
  assert.equal(await page.$$eval(F+'select[name=kind]+.pm-sel-btn',e=>e.length),1,'one visible request-type control');
  await page.screenshot({path:path.join(requestOut,'linked-request-type-ar-1440.png')});
  await page.type(F+'[name=note]','Keep the compact execution draft');
  const scrollTop=await page.$eval(F+'.as-create-content',e=>{e.scrollTop=180;return e.scrollTop;});
  await page.click(M+'[data-as-back-complaint]');await page.waitForFunction(()=>!document.querySelector('dialog.as-dialog[open]'));
  await page.evaluate(()=>ComplaintFlow.execution(fixture._id));await page.waitForSelector(F+'[name=note]');
  assert.equal(await page.$eval(F+'[name=note]',e=>e.value),'Keep the compact execution draft');
  assert(Math.abs(await page.$eval(F+'.as-create-content',e=>e.scrollTop)-scrollTop)<1,'linked draft scroll restored');
  await page.screenshot({path:path.join(requestOut,'linked-draft-ar-1440.png')});
  await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);console.log('After-sales compact creation PASS: return/exchange, Arabic/English, mobile/dark, menus, fees and long invoices');return;
 }
 if(process.env.COMPLAINT_CREATE_REVIEW){
  const createOut=path.join(root,'artifacts/complaint-create');fs.mkdirSync(createOut,{recursive:true});
  const sample=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=240;c.height=320;const p=c.getContext('2d');p.fillStyle='#e7ece6';p.fillRect(0,0,240,320);p.fillStyle='#b8c9bc';p.fillRect(0,240,240,80);p.fillStyle='#bf9f73';p.fillRect(55,120,130,130);p.beginPath();p.ellipse(120,120,65,25,0,0,Math.PI*2);p.fillStyle='#f2ede4';p.fill();p.beginPath();p.ellipse(120,120,48,16,0,0,Math.PI*2);p.fillStyle='#a88e6c';p.fill();return c.toDataURL('image/png').split(',')[1];});
  const photo=path.join(createOut,'sample.png');fs.writeFileSync(photo,Buffer.from(sample,'base64'));
  const M='dialog.cf-dialog[open] ';
  for(const [language,width,dark] of [['ar',1440,false],['en',1440,false],['ar',390,false],['en',320,false],['ar',390,true]]){
   await page.setViewport({width,height:950});
   await page.evaluate(async({language,dark})=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',dark);await ComplaintFlow.create();},{language,dark});
   assert.equal(await page.$eval(M+'[name=categoryGroup]',e=>e.required),true);
   assert.equal(await page.$$eval(M+'select[name=categoryGroup]+.pm-sel-btn>.cf-category-icon',e=>e.length),0,'placeholder has no category icon');
   await page.click(M+'select[name=categoryGroup]+.pm-sel-btn');await page.waitForSelector('.cf-select-panel.show');
   assert.deepEqual(await page.$$eval('.cf-select-panel .cf-category-icon',e=>e.map(icon=>[...icon.classList].find(c=>c.startsWith('lucide-')))),['lucide-package','lucide-truck','lucide-headset','lucide-ellipsis']);
   assert(await page.$$eval('.cf-select-panel .cf-category-icon',e=>e.every(icon=>icon.getAttribute('aria-hidden')==='true'&&getComputedStyle(icon).width==='17px')),'category icons stay decorative and consistently sized');
   await page.screenshot({path:path.join(createOut,`categories-${language}-${width}${dark?'-dark':''}.png`)});
   await page.click('.cf-select-panel [data-idx="2"]');
   assert(await page.$(M+'select[name=categoryGroup]+.pm-sel-btn>.lucide-truck'),'selected category updates its icon');
   await page.select(M+'[name=categoryGroup]','مشكلة في المنتج');
   assert.equal(await page.$$eval(M+'select[name=categoryGroup]+.pm-sel-btn>.cf-category-icon',e=>e.length),1,'programmatic updates keep one icon');
   await page.select(M+'[name=categoryGroup]','');
   assert.equal(await page.$$eval(M+'.is-invalid',e=>e.length),0,'required fields stay neutral when the form opens');
   assert(await page.$eval(M+'.cf-create-evidence',e=>e.getBoundingClientRect().height<145),'empty image section stays small');
   assert(await page.$eval(M+'.cf-body',e=>e.scrollWidth<=e.clientWidth+1));
   await page.screenshot({path:path.join(createOut,`empty-${language}-${width}${dark?'-dark':''}.png`)});
   await page.type(M+'[name=clientName]','Customer review');await page.type(M+'[name=phone]','01000000000');await page.type(M+'[name=description]','The basket arrived with a damaged handle.');
   await page.click(M+'[type=submit]');
   assert.equal(await page.evaluate(()=>createWrites.length),0,'missing category cannot create a complaint');
   assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('pm-sel-btn')),true,'focus reaches the visible category picker');
   assert.equal(await page.$eval(M+'[name=categoryGroup]',e=>e.getAttribute('aria-invalid')),'true');
   await page.select(M+'[name=categoryGroup]',await page.$eval(M+'[name=categoryGroup]',e=>e.options[1].value));
   assert.equal(await page.$eval(M+'[name=categoryGroup]',e=>e.hasAttribute('aria-invalid')),false);
   await (await page.$(M+'[data-cf-upload]')).uploadFile(photo,photo);
   await page.waitForFunction(()=>document.querySelectorAll('[data-cf-draft-preview]').length===2&&!document.querySelector('dialog.cf-dialog[open] [data-cf-choose-images]').disabled);
   await page.waitForFunction(()=>[...document.querySelectorAll('[data-cf-draft-preview] img')].every(e=>e.complete&&e.naturalWidth>0));
   const form=await page.evaluate(()=>{window.createForm=document.querySelector('[data-cf-create]');return createForm.elements.description.value;});
   await page.click(M+'[data-cf-draft-preview="0"]');
   await page.waitForSelector('.cf-photo-dialog[open] [data-cf-photo-full]:not([hidden])');
   assert(await page.$('dialog.cf-dialog[open] [data-cf-create]'),'draft form remains beneath the preview');
   assert(await page.$eval('[data-cf-photo-full]',e=>e.src.startsWith('blob:')),'draft preview reads the local image');
   await page.click('[data-cf-photo-next]');assert((await page.$eval('[data-cf-photo-count]',e=>e.textContent)).includes('2'));
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.cf-photo-dialog[open]'));
   assert.equal(await page.evaluate(()=>document.querySelector('[data-cf-create]')===createForm),true);
   assert.equal(await page.$eval(M+'[name=description]',e=>e.value),form);
   assert.equal(await page.evaluate(()=>createWrites.length),0);assert.equal(await page.evaluate(()=>window.evidenceUploads||0),0,'images are not uploaded before saving');
   await page.$eval(M+'.cf-create-evidence',e=>e.scrollIntoView({block:'center'}));
   await page.screenshot({path:path.join(createOut,`images-${language}-${width}${dark?'-dark':''}.png`)});
   await page.click(M+'[data-cf-remove-draft-image]');await page.waitForFunction(()=>document.querySelectorAll('[data-cf-draft-preview]').length===1&&!document.querySelector('[data-cf-choose-images]').disabled);
   await page.click(M+'[data-cf-back]');await page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open]'));
   await page.evaluate(()=>ComplaintFlow.create());assert.equal(await page.$$eval(M+'[data-cf-draft-preview]',e=>e.length),1,'image draft survives closing and reopening');
   await page.click(M+'[data-cf-discard]');await page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open]'));
  }
  await page.evaluate(()=>ComplaintFlow.create(transactions[0]._id));
  const category=await page.$eval(M+'[name=categoryGroup]',e=>e.options[1].value);await page.select(M+'[name=categoryGroup]',category);
  await page.type(M+'[name=description]','A complete issue with its category');await page.click(M+'[type=submit]');
  await page.waitForFunction(()=>createWrites.length===1&&currentPage==='complaint-detail');
  assert.equal(await page.evaluate(()=>createWrites[0].categoryGroup),category);
  assert.deepEqual(errors,[]);console.log('PASS: compact create form, required category, neutral validation, local gallery preview, preserved inputs and drafts, deferred uploads and successful creation.');return;
 }
 if(process.env.COMPLAINT_TIMELINE_REVIEW){
  await page.evaluate(()=>{
   fixture.createdAt='2026-11-01T08:00:00Z';
   fixture.notes=[{kind:'system',text:'تم إنشاء الشكوى',createdAt:fixture.createdAt},...Array.from({length:80},(_,i)=>({kind:'comment',text:'Internal follow-up '+i,author:'Service team',createdAt:new Date(Date.parse(fixture.createdAt)+i*300000).toISOString()}))];
   fixture.workflow={...fixture.workflow,cycle:2,stage:'execution',solution:'exchange',history:[
    {action:'review',at:'2026-11-01T09:00:00Z'},{action:'plan',solution:'return',at:'2026-11-01T10:00:00Z'},{action:'close',outcome:'resolved',at:'2026-11-02T08:00:00Z'},
    {action:'reopen',cycle:2,at:'2026-11-03T08:00:00Z'},{action:'plan',solution:'support',at:'2026-11-03T09:00:00Z'},{action:'plan',solution:'exchange',at:'2026-11-03T09:30:00Z'},
    {action:'case_linked',at:'2026-11-03T10:00:00Z'},{action:'wait',at:'2026-11-03T10:05:00Z'},
    {action:'future-code',note:'<img src=x onerror=alert(1)> End note',by:'Service team',at:'2026-11-04T09:00:00Z'}
   ],executionEvents:[...Array.from({length:200},(_,i)=>({action:'carrier-status',at:new Date(Date.parse('2026-11-03T10:10:00Z')+i*60000).toISOString()})),{action:'received-and-inspected',at:'2026-11-03T15:00:00Z'},{action:'replacement-delivered',at:'2026-11-03T16:00:00Z'},{action:'exception',at:'2026-11-03T16:30:00Z'},{action:'exception-resolved',at:'2026-11-03T17:00:00Z'}]};
   fixture.lifecycleStage='execution';window.historyCount=fixture.notes.length+fixture.workflow.history.length+fixture.workflow.executionEvents.length;
  });
  const historyOut=path.join(root,'artifacts/complaint-timeline');fs.mkdirSync(historyOut,{recursive:true});
  for(const [language,width,dark] of [['ar',1440,false],['en',1440,false],['ar',390,false],['en',320,false],['ar',390,true]]){
   await page.setViewport({width,height:1000});
   await page.evaluate(async({language,dark})=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',dark);await ComplaintFlow.open(fixture._id);},{language,dark});
   assert.equal(await page.$$eval('.cf-log>.cf-timeline>.cf-timeline-step',e=>e.length),6,'hundreds of events become six main milestones');
   assert.equal(await page.$$eval('.cf-timeline .cf-timeline-content>p',e=>e.length),0,'main steps use titles without repetitive descriptions');
   const summary=await page.$eval('.cf-log>.cf-timeline',e=>e.textContent);
   assert(summary.includes(language==='ar'?'استبدال':'Exchange'));
   assert(!summary.includes(language==='ar'?'استرجاع':'Return'),'previous cycle is not repeated in the main timeline');
   assert(!summary.includes('Internal follow-up'));
   assert.equal(await page.$$eval('[data-cf-audit-list]>li',e=>e.length),0,'full audit rows are rendered on demand');
   assert(await page.$eval('.cf-history-details',e=>e.getBoundingClientRect().height<(innerWidth>760?460:600)),'default history stays compact');
   await (await page.$('.cf-history-details')).screenshot({path:path.join(historyOut,`summary-${language}-${width}${dark?'-dark':''}.png`)});
   const before=await page.evaluate(()=>apiCalls.length);
   await page.click('[data-cf-audit]>summary');
   assert.equal(await page.$$eval('[data-cf-audit-list]>li',e=>e.length),10);
   assert.equal(await page.$('[data-cf-audit-list] img'),null);
   await page.click('[data-cf-audit-list] .cf-timeline-details>summary');
   assert((await page.$eval('[data-cf-audit-list] .cf-timeline-details p',e=>e.textContent)).includes('<img src=x onerror=alert(1)>'));
   let shown=10;
   while(await page.$eval('[data-cf-audit-next]',e=>!e.disabled)){
    await page.$eval('[data-cf-audit-next]',e=>e.click());
    const count=await page.$$eval('[data-cf-audit-list]>li',e=>e.length);assert(count<=10);shown+=count;
   }
   assert.equal(shown,await page.evaluate(()=>historyCount),'the complete audit remains accessible across pages');
   assert.equal(await page.evaluate(()=>apiCalls.length),before,'reading and paging the history performs no writes or extra requests');
   await page.click('[data-cf-audit]>summary');assert.equal(await page.$eval('[data-cf-audit]',e=>e.open),false);
  }
  await page.evaluate(async()=>{currentLang='en';fixture.workflow.stage='closed';fixture.workflow.history.push({action:'close',outcome:'resolved',at:'2026-11-04T10:00:00Z'});await ComplaintFlow.open(fixture._id);});
  assert((await page.$eval('.cf-timeline-step:last-child strong',e=>e.textContent)).includes('Resolved'),'closure keeps its actual outcome');
  assert.deepEqual(errors,[]);console.log('PASS: bounded current-cycle milestones, concise titles, lazy paginated full history, escaped notes, no extra requests and responsive Arabic/English layouts.');return;
 }
 if(process.env.COMPLAINT_TABLE_REVIEW){
  await page.evaluate(()=>{
   const rows=[
    ['CMP-261103-3014','Heba Omar','3014','review','','','الزرار الخيط يتفك وهيتبدل مع الأوردر الجديد',true],
    ['CMP-261102-2861','Nouran Hussain','2861','planned','exchange','','الغطاء في جانبه هيتم استبدال المنتج بالكامل',true],
    ['CMP-261029-2872','Asmaa Email','2872','execution','return','AS-2026-000006','مقاس المنتج مش مناسب',true],
    ['CMP-261028-2817','Nour Fathy','2817','execution','exchange','AS-2026-000005','استبدال المقاسات المتفق عليها مع العميل',true],
    ['CMP-260913-2510','آلاء حلمي','2510','review','','','المقاس المطلوب 50 × 50 بدلًا من 45 × 45',false],
   ];
   complaints=rows.map(([no,name,ref,stage,solution,caseRef,description,overdue],i)=>({...structuredClone(fixture),_id:String(i+1).padStart(24,'0'),complaintNo:no,clientName:name,transactionRef:ref,transactionId:'table-invoice-'+i,description,priority:i===4?'عالية':'متوسطة',createdAt:'2026-11-03T18:03:12Z',categoryGroup:i===4?'مشكلة في المنتج':'',workflow:{...structuredClone(fixture.workflow),owner:i===4?'Gannh':'Malak Abbas',stage,solution,caseRef,caseId:caseRef?'444444444444444444444444':'',dueAt:overdue?'2026-11-04T18:03:12Z':''},lifecycleStage:stage,overdue,execution:{ready:false,blockers:caseRef?['receipt']:solution?['case_required']:[]}}));
   transactions=complaints.map(c=>({...structuredClone(transactions[0]),_id:c.transactionId,ref:c.transactionRef,bostaOrderId:'table-shipment',bostaStatus:'DELIVERED'}));
   currentPage='complaints';document.querySelectorAll('.page').forEach(e=>e.classList.toggle('active',e.id==='page-complaints'));switchMainTab('complaints',true,true);
  });
  const tableOut=path.join(root,'artifacts/complaint-table');fs.mkdirSync(tableOut,{recursive:true});
  for(const [language,width,dark] of [['en',2200,false],['ar',2200,false],['en',1440,false],['ar',390,false],['en',320,false],['ar',2200,true],['en',390,true]]){
   await page.setViewport({width,height:1000});
   await page.evaluate(({language,dark})=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';document.body.classList.toggle('dark-mode',dark);renderComplaints();fixtureBuildSidebar();}, {language,dark});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const mobile=width<=768,target=mobile?'#cmp-cards':'#cmp-complaints-section .cmp-table-wrap';
   assert.equal(await page.$$eval('[data-cf-counts]',e=>e.length),1,'one shared KPI summary');
   assert(await page.$eval('[data-cf-counts]',e=>e.parentElement.dataset.summaryView===(innerWidth<=768?'mobile':'desktop')));
   assert.equal(await page.$eval('.cf-summary-open strong',e=>e.textContent),'5');
   assert.equal(await page.$eval('.cf-summary-overdue strong',e=>e.textContent),'4');
   assert.equal(await page.$eval('#cmp-kpi',e=>getComputedStyle(e).display),'none','duplicate KPI cards are merged into the status strip');
   if(mobile)assert(await page.$eval('[data-cf-counts]',e=>{const parent=e.parentElement.getBoundingClientRect();return [...e.children].filter(c=>c.getClientRects().length).every(c=>{const r=c.getBoundingClientRect();return r.left>=parent.left&&r.right<=parent.right;});}),'all mobile metrics fit the merged strip');
   await (await page.$(`.cf-status-summary[data-summary-view=${mobile?'mobile':'desktop'}]`)).screenshot({path:path.join(tableOut,`summary-${language}-${width}${dark?'-dark':''}.png`)});
   await page.$eval(target,e=>e.scrollIntoView({block:'start',behavior:'instant'}));
   await page.evaluate(()=>window.scrollBy({top:-180,behavior:'instant'}));
   if(!mobile){
    assert.equal(await page.$$eval('#cmp-tbody tr',e=>e.length),5);
    assert.equal(await page.$$eval('#cmp-tbody td:last-child .cf-owner-avatar',e=>e.length),5,'owner initials occupy the final column');
    assert.equal(await page.$eval('#cmp-tbody td:last-child',e=>e.textContent.trim()),'M');
    assert.equal(await page.$eval('#cmp-tbody td:last-child .cf-owner-avatar',e=>e.title),'Malak Abbas','full owner name remains available');
    assert.equal(await page.$$eval('#cmp-tbody .cf-client-identity small',e=>e.length),0,'customer phone is absent from the table');
    assert(!(await page.$eval('#cmp-tbody',e=>e.textContent)).includes('01000000000'));
    assert.equal(await page.$$eval('#cmp-tbody .cf-shipping>small',e=>e.length),0,'carrier names are absent from the table');
    assert(await page.$$eval('#cmp-tbody .cf-invoice-line',nodes=>nodes.every(e=>{const ref=e.querySelector('.cf-invoice-ref').getBoundingClientRect(),badge=e.querySelector('.order-state').getBoundingClientRect();return Math.abs((ref.top+ref.height/2)-(badge.top+badge.height/2))<2;})),'shipping status sits next to the order number');
    assert(await page.$$eval('#cmp-tbody .cf-followup-date',nodes=>nodes.every(e=>{const parent=e.getBoundingClientRect();return e.scrollWidth<=e.clientWidth+1&&[...e.querySelectorAll('time>span,time>small')].every(c=>{const r=c.getBoundingClientRect();return r.top>=parent.top-1&&r.bottom<=parent.bottom+1;})&&parent.height<22;})),'follow-up dates fit on one line');
    assert.equal(await page.$eval('#cmp-table th:nth-child(5)',e=>e.textContent),language==='ar'?'الحل والتنفيذ':'Resolution / execution');
    assert(await page.$('#cmp-tbody td:nth-child(5) .cf-resolution'));
    assert.equal(await page.$$eval('#cmp-tbody .cf-resolution.is-planned',e=>e.length),3);
    assert(await page.$$eval('#cmp-tbody tr',rows=>rows.every(row=>row.getBoundingClientRect().height<=90)),'compact rows stay at most 90px for multi-line fixtures');
    assert(await page.$$eval('#cmp-tbody .cf-ticket-line',nodes=>nodes.every(e=>e.scrollWidth<=e.clientWidth+1)),'ticket numbers and copy buttons fit without truncation');
    assert.notEqual(await page.$eval('[data-solution=exchange] .cf-resolution-label',e=>getComputedStyle(e).backgroundColor),await page.$eval('[data-solution=return] .cf-resolution-label',e=>getComputedStyle(e).backgroundColor));
    assert.equal(await page.$$eval('#cmp-tbody .cf-followup-date.is-overdue',e=>e.length),4);
    assert.equal(await page.$$eval('#cmp-tbody .cf-badge.is-overdue',e=>e.length),0,'overdue dates do not mask workflow status');
    assert.equal(await page.$eval('#cmp-tbody time[datetime="2026-11-04T18:03:12.000Z"] small',e=>e.textContent),'20:03','Cairo date display omits seconds');
    assert.equal(await page.$eval('#cmp-tbody time[datetime="2026-11-04T18:03:12.000Z"]>span',e=>e.textContent),'04/11/2026','numeric dates retain day/month/year order in Arabic and English');
    // Check actual contrast in the shipped browser styles, including both solution states.
    const contrast=await page.evaluate(()=>{
     const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number),luma=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
     return ['#cmp-table thead th','#cmp-tbody .cf-cell-stack small','#cmp-tbody .cmp-order-ref-link','#cmp-tbody .cf-ticket-open','#cmp-tbody [data-solution=exchange] .cf-resolution-label','#cmp-tbody [data-solution=return] .cf-resolution-label','#cmp-tbody .cf-resolution.is-unplanned .cf-resolution-label'].map(selector=>{const node=document.querySelector(selector),style=getComputedStyle(node);let parent=node,background;while(parent){background=getComputedStyle(parent).backgroundColor;if(background!=='rgba(0, 0, 0, 0)')break;parent=parent.parentElement;}const a=luma(rgb(style.color)),b=luma(rgb(background));return {selector,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
    });
    for(const entry of contrast)assert(entry.ratio>=4.5,`${language}/${dark}: ${entry.selector} contrast ${entry.ratio}`);
    const clip=await page.$eval(target,e=>{const r=e.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height};});
    await page.screenshot({path:path.join(tableOut,`table-${language}-${width}${dark?'-dark':''}.png`),clip,captureBeyondViewport:true});
   }else{
    assert(await page.$eval('#cmp-cards',e=>e.scrollWidth<=e.clientWidth+1));
    assert.equal(await page.$$eval('#cmp-cards .cf-resolution',e=>e.length),5);
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    await page.screenshot({path:path.join(tableOut,`cards-${language}-${width}${dark?'-dark':''}.png`),fullPage:true});
    await (await page.$('#cmp-cards .cf-list-card')).screenshot({path:path.join(tableOut,`card-${language}-${width}${dark?'-dark':''}.png`)});
   }
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'table overflow stays within its scroll region');
  }
  await page.setViewport({width:2200,height:1000});
  await page.evaluate(()=>{window.tableActions=[];window.tableOpen=ComplaintFlow.open;window.tableExecution=ComplaintFlow.execution;ComplaintFlow.open=id=>tableActions.push(['open',id]);ComplaintFlow.execution=id=>tableActions.push(['execution',id]);});
  await page.click('#cmp-tbody .cf-execution-link');
  assert.deepEqual(await page.evaluate(()=>tableActions.map(a=>a[0])),['execution'],'execution link does not also open the complaint');
  await page.click('#cmp-tbody .cmp-no-chip');assert.equal(await page.evaluate(()=>copiedMessage),'CMP-261103-3014');
  await page.click('#cmp-tbody .cf-ticket-open');
  assert.deepEqual(await page.evaluate(()=>tableActions.map(a=>a[0])),['execution','open'],'ticket number opens the file once');
  await page.focus('#cmp-tbody .cf-open-case');await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>tableActions.map(a=>a[0])),['execution','open','open'],'open action works from the keyboard');
  await page.click('#cmp-tbody tr:first-child td:nth-child(4)');
  assert.equal(await page.evaluate(()=>tableActions.length),4,'plain row click opens the file once');
  await page.$eval('#cmp-tbody tr:first-child td:nth-child(4)',e=>e.dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true})));
  assert.equal(await page.evaluate(()=>tableActions.length),4,'modified clicks do not unexpectedly navigate');
  await page.evaluate(()=>{ComplaintFlow.open=tableOpen;ComplaintFlow.execution=tableExecution;});
  await page.evaluate(()=>{complaints.push({...structuredClone(fixture),_id:'999999999999999999999999',status:'مقبول',overdue:true,workflow:{...fixture.workflow,stage:'closed'},execution:{ready:true}});renderComplaints();});
  assert.equal(await page.$eval('.cf-summary-open strong',e=>e.textContent),'5');
  assert.equal(await page.$eval('.cf-summary-overdue strong',e=>e.textContent),'4','closed records do not count as overdue');
  assert.equal(await page.$eval('.cf-summary-confirmation strong',e=>e.textContent),'0','closed records do not await confirmation');
  assert.deepEqual(errors,[]);console.log('PASS: complaint table hierarchy, solution emphasis, readable contrast, Cairo dates, responsive cards, dark mode and independent keyboard/copy/execution actions.');return;
 }
 await page.evaluate(async()=>{navigateTo('complaints');await loadComplaints();});
 // List columns, owner search, and pagination use the same workflow fields as the case.
 await page.evaluate(()=>{
  window.originalComplaints=complaints;
  currentPage='complaints';document.querySelectorAll('.page').forEach(e=>e.classList.toggle('active',e.id==='page-complaints'));switchMainTab('complaints',true,true);
  transactions[0].bostaOrderId='test-shipment';transactions[0].bostaStatus='OUT_FOR_DELIVERY';
  complaints=Array.from({length:65},(_,i)=>({...structuredClone(fixture),_id:String(i+1).padStart(24,'0'),complaintNo:`CMP-list-${i}`,phone:`0100000${String(i).padStart(4,'0')}`,workflow:{...structuredClone(fixture.workflow),owner:'مريم',solution:'exchange',stage:'execution',caseId:'444444444444444444444444',caseRef:`AS-case-${i}`,dueAt:'2026-01-01T09:00:00Z'},execution:{ready:false,blockers:['receipt']},lifecycleStage:'execution',overdue:true}));renderComplaints();
 });
 assert.equal(await page.$$eval('#cmp-table th',els=>els.length),10);
 assert.equal(await page.$$eval('#cmp-tbody tr',els=>els.length),30);
 assert.equal(await page.$eval('#cmp-tbody .cf-owner-avatar',e=>e.title),'مريم');
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
  for(const selector of ['[name=clientName]','[name=description]','[name=phone]','[name=orderSearch]'])await page.focus(selector);
  assert.equal(await page.$$eval('[data-cf-create] .is-invalid',fields=>fields.length),0,'new complaints stay neutral when tabbing through required fields');
  if(lang==='ar'&&width===390)await page.screenshot({path:path.join(out,'new-complaint-before-save.png')});
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

 await page.setViewport({width:1440,height:1000});
 await page.evaluate(async()=>{
  currentLang='en';document.documentElement.dir='ltr';
  evidencePhoto='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640"><rect width="480" height="640" fill="#e6e4de"/><path d="M0 470Q120 400 240 490T480 470V640H0" fill="#b8c9bc"/><ellipse cx="240" cy="320" rx="130" ry="170" fill="#c3a67e"/><ellipse cx="240" cy="240" rx="130" ry="70" fill="#f3eee4"/><ellipse cx="240" cy="240" rx="100" ry="46" fill="#bca27e"/></svg>');
  fixture.items[0].imageUrl='/fixture-product.svg';fixture.attachments=Array.from({length:3},(_,i)=>({id:'page-image-'+i,name:'Issue photo '+(i+1)}));
  await ComplaintFlow.open(fixture._id);
 });
 assert.equal(await page.evaluate(()=>currentPage),'complaint-detail');
 assert.equal(await page.$('dialog.cf-dialog[open]'),null);
 assert(await page.$('#page-complaint-detail.active .cf-case-layout'));
 await page.screenshot({path:path.join(out,'complaint-page-desktop.png')});
 const P='#page-complaint-detail.active ',M='dialog.cf-dialog[open] ';
 const closed=()=>page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open],dialog.as-dialog[open],dialog.cf-photo-dialog[open]'));
 const ready=()=>page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open],dialog.as-dialog[open],.cf-refresh-status')&&!!document.querySelector('#page-complaint-detail.active .cf-case-layout'));
 // A row opens with a brief opacity handoff, without retaining the list's deep scroll.
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
 await page.evaluate(async()=>{
  navigateTo('complaints');await loadComplaints();clearCmpFilters();
  complaints=Array.from({length:30},(_,i)=>i===29?fixture:{...structuredClone(fixture),_id:String(i+1).padStart(24,'0'),complaintNo:'CMP-motion-'+i});renderComplaints();
  document.querySelector('#cmp-tbody tr:last-child').scrollIntoView({block:'center',behavior:'instant'});
  holdWorkspace=true;window.motionReads=apiCalls.filter(c=>c.url.includes('?view=workspace')).length;window.motionHistory=history.length;
 });
 assert(await page.evaluate(()=>window.scrollY>300),'open from a scrolled list');
 await page.$eval('#cmp-tbody tr:last-child td:nth-child(4)',e=>{e.click();e.click();});
 await page.waitForFunction(()=>currentPage==='complaint-detail');
 assert.equal(await page.evaluate(()=>window.scrollY),0,'new complaint opens at its header');
 assert.equal(await page.evaluate(()=>history.length-motionHistory),1,'rapid row clicks create one route entry');
 assert.equal(await page.evaluate(()=>apiCalls.filter(c=>c.url.includes('?view=workspace')).length-motionReads),1);
 assert(await page.$eval('#page-complaint-detail',e=>e.getAnimations().some(a=>a.effect.getTiming().duration===170&&!a.effect.getKeyframes().some(f=>f.transform&&f.transform!=='none'))),'arrival fades without moving the layout');
 await page.evaluate(async()=>{window.motionCase=document.querySelector('#complaint-workspace>.cf-shell');window.motionHeaderHeight=document.querySelector('.cf-case-head').getBoundingClientRect().height;holdWorkspace=false;pendingWorkspace.splice(0).forEach(resolve=>resolve());});
 await ready();
 assert.equal(await page.evaluate(()=>motionCase===document.querySelector('#complaint-workspace>.cf-shell')),true,'unchanged refresh does not rebuild or flash the complaint');
 assert.equal(await page.$eval('.cf-case-head',e=>e.getBoundingClientRect().height),await page.evaluate(()=>motionHeaderHeight),'background refresh does not shift the complaint header');
 await page.waitForFunction(()=>!document.querySelector('#page-complaint-detail').getAnimations().length);
 await page.goBack();await page.waitForFunction(()=>currentPage==='complaints');
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
 await page.evaluate(()=>{complaints=[fixture];renderComplaints();document.querySelector('#cmp-tbody td:nth-child(4)').click();});
 await ready();assert.equal(await page.$eval('#page-complaint-detail',e=>e.getAnimations().length),0,'reduced motion opens immediately without effects');
 // Header metadata is always visible, with ordinary document scrolling and no detail dialog.
 for(const language of ['ar','en'])for(const width of [1440,1024,390,320]){
  await page.setViewport({width,height:width>1000?1000:844});
  await page.evaluate(async language=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';await ComplaintFlow.open(fixture._id);fixtureBuildSidebar();window.scrollTo(0,0);},language);
  assert.equal(await page.$$eval(P+'.cf-case-context>div',e=>e.length),4);
  assert(await page.$(P+'.cf-case-client [data-cf-invoice]'),'invoice is next to the customer name');
  assert((await page.$eval(P+'.cf-case-client',e=>e.textContent)).includes('01000000000'),'phone is next to the customer name');
  assert(await page.$(P+'.cf-case-context .cf-case-solution .cf-resolution-label svg'),'solution has its own icon');
  assert(await page.$(P+'.cf-case-context>div:last-child.cf-case-owner'),'owner is secondary and last in the context');
  assert.equal(await page.$$eval(P+'.cf-case-progress .cf-steps li',e=>e.length),5);
  assert(await page.$eval(P+'[data-cf-page-back]',e=>{const b=e.getBoundingClientRect(),h=document.querySelector('.cf-case-heading').getBoundingClientRect();return e.closest('[dir]').dir==='rtl'?b.left>=h.right:b.right<=h.left;}),`back precedes the title ${language}/${width}`);
  assert(await page.$eval(P+'[data-cf-page-back]',e=>e.getAttribute('aria-label')&&e.querySelector('svg')));
  assert.equal(await page.$eval(P+'.cf-body',e=>getComputedStyle(e).overflowY),'visible');
  assert(await page.$eval(P+'.cf-case-page',e=>e.scrollWidth<=e.clientWidth+1),`page overflow ${language}/${width}`);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`document overflow ${language}/${width}`);
  assert(await page.$eval(P+'.cf-case-progress',e=>e.getBoundingClientRect().bottom<=document.querySelector('.cf-case-layout').getBoundingClientRect().top));
  assert.equal(await page.$$eval(P+'.cf-action-list svg',e=>e.length),await page.$$eval(P+'.cf-action-list button',e=>e.length));
  assert.equal(await page.$eval(P+'.cf-action-list [data-cf-action]',e=>e.dataset.cfAction),'plan','resolution plan is first');
  assert.equal(await page.$eval(P+'.cf-action-priority [data-cf-action=plan]',e=>e.textContent),language==='ar'?'خطة الحل':'Resolution plan');
  assert(await page.$eval(P+'.cf-action-panel',e=>{const plan=e.querySelector('.cf-action-priority button'),secondary=e.querySelector('.cf-action-key-links button'),tools=[...e.querySelectorAll('.cf-action-tools button')];return !!(plan.compareDocumentPosition(secondary)&Node.DOCUMENT_POSITION_FOLLOWING)&&tools.every(button=>{const s=getComputedStyle(button);return s.backgroundColor==='rgba(0, 0, 0, 0)'&&s.borderTopWidth==='0px'&&parseFloat(s.fontSize)<parseFloat(getComputedStyle(plan).fontSize);});}),'plan comes first and other actions are small text without boxes');
  assert(await page.$$eval(P+'[data-cf-action]',buttons=>buttons.every(button=>{
   const label=button.querySelector('span'),icon=button.querySelector('svg.cf-action-icon');
   return label.textContent===button.getAttribute('aria-label')&&icon?.getAttribute('aria-hidden')==='true'&&label.scrollWidth<=label.clientWidth+1;
  })),`action names and icons are accessible and fit ${language}/${width}`);
  assert.equal(await page.$$eval(P+'.cf-log>h3',e=>e.length),0,'timeline uses its section heading');
  await page.screenshot({path:path.join(out,`page-${language}-${width}.png`),fullPage:true});
  await page.evaluate(()=>ComplaintFlow.form(fixture._id,'contact'));
  assert.equal(await page.$eval(M+'#cf-title',e=>e.textContent),await page.$eval(P+'[data-cf-action=contact]',e=>e.textContent));
  assert(await page.$eval(M+'.cf-body',e=>e.scrollWidth<=e.clientWidth+1),`action form overflow ${language}/${width}`);
  assert(await page.$eval(M.slice(0,-1),e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width<=562;}));
  await page.keyboard.press('Escape');await ready();
 }
 // Normal motion is brief; reduced motion closes immediately. Rapid reopen cannot close a new form.
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
 await page.evaluate(()=>ComplaintFlow.form(fixture._id,'comment'));
 assert(await page.$eval(M.slice(0,-1),e=>e.getAnimations().some(a=>a.effect.getTiming().duration===180)));
 await page.click(M+'[data-cf-dismiss]');await ready();
 await page.evaluate(async()=>{await ComplaintFlow.form(fixture._id,'comment');SouliaMotion.close(document.querySelector('dialog.cf-dialog'));await ComplaintFlow.form(fixture._id,'contact');});
 await new Promise(resolve=>setTimeout(resolve,220));
 assert(await page.$(M+'[name=channel]'),'a closing animation must not dismiss a newly opened action');
 await page.keyboard.press('Escape');await ready();
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
 for(const [language,width] of [['ar',1440],['en',1440],['ar',390],['en',320]]){
  await page.setViewport({width,height:950});
  await page.evaluate(async language=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';await ComplaintFlow.form(fixture._id,'plan');},language);
  assert.equal(await page.$$eval(M+'.pm-sel-btn>.cf-solution-icon',e=>e.length),1,'selected solution displays its icon');
  await page.click(M+'select[name=solution] + .pm-sel-btn');
  await page.waitForSelector('.cf-select-panel.show');
  assert.equal(await page.$$eval('.cf-select-panel .pm-sel-opt>.cf-solution-icon',e=>e.length),6,'all solution choices have icons');
  const icon=await page.$eval('.cf-select-panel [data-idx="1"]>.cf-solution-icon',e=>e.innerHTML);
  await page.screenshot({path:path.join(out,`solution-picker-${language}-${width}.png`)});
  await page.click('.cf-select-panel [data-idx="1"]');
  assert.equal(await page.$eval(M+'[name=solution]',e=>e.value),'return');
  assert.equal(await page.$eval(M+'.pm-sel-btn>.cf-solution-icon',e=>e.innerHTML),icon,'picking a solution updates its icon');
  await page.select(M+'[name=solution]','exchange');await page.select(M+'[name=solution]','support');
  assert.equal(await page.$$eval(M+'.pm-sel-btn>.cf-solution-icon',e=>e.length),1,'changing values does not duplicate icons');
  await page.keyboard.press('Escape');await ready();
 }
 await page.evaluate(()=>ComplaintFlow.form(fixture._id,'plan'));
 assert.equal(await page.$eval(M.slice(0,-1),e=>e.getAnimations().length),0);
 await page.select(M+'select[name=solution]','exchange');await page.type(M+'textarea[name=note]','Exchange approved after reviewing customer photos');
 const beforeSave=await page.evaluate(()=>apiCalls.length),route=await page.evaluate(()=>location.hash);
 await page.click(M+'button[type=submit]');await page.waitForSelector('dialog.as-dialog[open] [data-as-create]');
 assert.equal(await page.evaluate(start=>apiCalls.slice(start).filter(c=>c.url==='/complaints'||c.url.includes('?view=workspace')).length,beforeSave),0,'save uses returned data');
 await page.click('[data-as-back-complaint]');await ready();assert.equal(await page.evaluate(()=>location.hash),route);
 assert.equal(await page.evaluate(()=>writes.at(-1).solution),'exchange');
 // Existing-request linking stays explicit when a resolution is selected.
 for(const [language,width] of [['ar',1440],['en',768],['ar',390],['en',320]]){
  await page.setViewport({width,height:950});
  await page.evaluate(async language=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';await ComplaintFlow.open(fixture._id);},language);
  assert(await page.$(P+'[data-cf-action=link] svg'));
  assert.deepEqual(await page.$$eval(P+'.cf-action-list [data-cf-action]',nodes=>nodes.slice(0,3).map(e=>e.dataset.cfAction)),['plan','items','link']);
  assert.equal(await page.$eval(P+'.cf-action-priority [data-cf-action=plan]',e=>e.textContent),language==='ar'?'تغيير الحل':'Change solution','saved plans become Change solution');
  assert(await page.$$eval(P+'.cf-action-list button',buttons=>buttons.every(button=>button.scrollWidth<=button.clientWidth+1)),'full action labels fit after planning');
  await (await page.$(P+'.cf-action-panel')).screenshot({path:path.join(out,`actions-${language}-${width}.png`)});
  await page.click(P+'.cf-action-priority [data-cf-action=plan]');await page.waitForSelector(M+'#cf-title');assert.equal(await page.$eval(M+'#cf-title',e=>e.textContent),language==='ar'?'تغيير الحل':'Change solution');await page.keyboard.press('Escape');await ready();
 }
 // Execution opens above the document; back, close and Escape restore its scroll and drafts.
 await page.click(P+'[data-cf-action=create-case]');await page.waitForSelector('.as-dialog[open] [data-as-create]');
 assert.equal(await page.$eval('[data-as-line="0"] [data-as-qty]',e=>e.value),'1');
 assert.equal(await page.$eval('[data-as-create] select[name=kind]',e=>e.disabled),true);
 await page.type('[data-as-create] textarea[name=note]','Keep this execution draft');
 await page.click('[data-as-back-complaint]');await ready();
 await page.click(P+'[data-cf-action=create-case]');await page.waitForSelector('.as-dialog[open] [data-as-create]');
 assert.equal(await page.$eval('[data-as-create] textarea[name=note]',e=>e.value),'Keep this execution draft');
 await page.select('[data-as-create] select[name=fulfillmentChannel]','direct');
 await page.click('[data-as-add]');await page.click('[data-as-pick]');await page.click('[data-as-create] button[type=submit]');await page.waitForSelector('[data-as-complaint]');
 assert.equal(await page.evaluate(()=>lastCase.complaintId),'333333333333333333333333');
 await page.click('[data-as-complaint]');await ready();
 await page.evaluate(async()=>{fixture.workflow.caseId='444444444444444444444444';fixture.workflow.caseRef='AS-2026-000002';fixture.workflow.stage='execution';fixture.execution={ready:true,blockers:[],financialPending:true};fixture.lifecycleStage='confirmation';await ComplaintFlow.open(fixture._id);});
 for(const [width,exit] of [[1440,'back'],[390,'close'],[320,'escape']]){
  await page.setViewport({width,height:width>1000?1000:844});
  const top=await page.evaluate(()=>{window.scrollTo(0,240);return window.scrollY;});
  await page.evaluate(()=>ComplaintFlow.execution(fixture._id));await page.waitForSelector('.as-dialog[open] [data-as-print]');
  assert.equal(await page.$$eval('dialog[open]',e=>e.length),1);
  assert(await page.$eval('.as-body',e=>e.scrollWidth<=e.clientWidth+1));
  if(exit==='back')await page.click('[data-as-back-complaint]');else if(exit==='close')await page.click('.as-close');else await page.keyboard.press('Escape');
  await ready();assert(Math.abs(await page.evaluate(()=>window.scrollY)-top)<=1,'document scroll restored');
 }
 await page.evaluate(()=>{holdExecution=true;window.slowExecution=ComplaintFlow.execution(fixture._id);});
 await page.waitForSelector('.as-dialog[open]');await page.click('[data-as-back-complaint]');await ready();
 await page.evaluate(async()=>{holdExecution=false;pendingExecution.splice(0).forEach(resolve=>resolve());await slowExecution;});
 assert.equal(await page.$('dialog[open]'),null,'a delayed response cannot reopen execution');
 // Validation, confirmation, closure, copy and reopen continue to work on the same page.
 await page.evaluate(()=>ComplaintFlow.form(fixture._id,'close'));
 assert.equal(await page.$eval(M+'[name=customerConfirmed]',e=>e.checked),false);
 await page.click(M+'input[name=customerConfirmed]');await page.type(M+'textarea[name=note]','Customer confirmed receipt');await page.click(M+'button[type=submit]');await ready();
 await page.waitForFunction(()=>document.querySelector('#complaint-workspace [data-cf-message-text]')?.value.startsWith('resolved'));
 await page.click(P+'.cf-message-details>summary');await page.click(P+'[data-cf-message]');
 assert((await page.evaluate(()=>copiedMessage)).startsWith('resolved'));
 await page.evaluate(()=>ComplaintFlow.form(fixture._id,'reopen'));await page.type(M+'textarea[name=note]','New issue reported');await page.click(M+'button[type=submit]');await ready();
 assert.equal(await page.evaluate(()=>fixture.workflow.cycle),2);
 // Late or failed refreshes retain the current action and the cached document.
 await page.evaluate(()=>{holdWorkspace=true;window.slowOpen=ComplaintFlow.open(fixture._id);});
 await page.evaluate(()=>ComplaintFlow.form(fixture._id,'comment'));
 await page.type(M+'textarea[name=note]','Keep my note');
 await page.evaluate(async()=>{holdWorkspace=false;pendingWorkspace.splice(0).forEach(resolve=>resolve());await slowOpen;});
 assert.equal(await page.$eval(M+'textarea[name=note]',e=>e.value),'Keep my note');
 await page.keyboard.press('Escape');await ready();
 await page.evaluate(async()=>{failWorkspace=true;await ComplaintFlow.open(fixture._id);});
 assert(await page.$(P+'.cf-case-layout'));assert((await page.$eval(P+'[data-cf-error]',e=>e.textContent)).includes('Fixture connection unavailable'));
 await page.evaluate(async()=>{failWorkspace=false;await ComplaintFlow.open(fixture._id);});
 // Photo upload errors are recoverable; previews preserve the document and its scroll.
 const uploadFixture=path.join(out,'evidence-fixture.png');
 fs.writeFileSync(uploadFixture,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
 await page.evaluate(async()=>{fixture.attachments=[];await ComplaintFlow.open(fixture._id);});
 await (await page.$(P+'[data-cf-upload]')).uploadFile(uploadFixture);await page.waitForSelector(P+'[data-cf-remove-image]');
 await page.waitForFunction(()=>!document.querySelector('#complaint-workspace [data-cf-choose-images]').disabled);
 await page.evaluate(()=>{failEvidenceDelete=true;});await page.click(P+'[data-cf-remove-image]');
 await page.waitForFunction(()=>document.querySelector('#complaint-workspace [data-cf-error]').textContent.includes('Cloudflare'));
 assert.equal(await page.$$eval(P+'[data-cf-remove-image]',e=>e.length),1);
 await page.evaluate(()=>{failEvidenceDelete=false;});await page.click(P+'[data-cf-remove-image]');await page.waitForFunction(()=>!document.querySelector('#complaint-workspace [data-cf-remove-image]'));
 for(const [language,width,height] of [['ar',1440,950],['en',768,950],['ar',390,844],['en',320,650],['ar',844,390]]){
  await page.setViewport({width,height});
  await page.evaluate(async language=>{currentLang=language;document.documentElement.dir=language==='ar'?'rtl':'ltr';fixture.attachments=Array.from({length:3},(_,i)=>({id:`preview-${language}-${innerWidth}-${i}`,name:`issue-photo-${i+1}.png`}));await ComplaintFlow.open(fixture._id);document.querySelector('.cf-evidence').scrollIntoView({block:'center'});window.savedCase=document.querySelector('#complaint-workspace .cf-body');},language);
  await page.$eval(P+'[data-cf-preview="0"]',button=>button.addEventListener('click',()=>{window.previewSourceScroll=window.scrollY;},{once:true,capture:true}));
  await page.click(P+'[data-cf-preview="0"]');const top=await page.evaluate(()=>previewSourceScroll);
  await page.waitForSelector('.cf-photo-dialog[open] [data-cf-photo-full]:not([hidden])');
  assert.equal(await page.$eval('[data-cf-photo-prev]',e=>e.disabled),true);
  await page.keyboard.press(language==='ar'?'ArrowLeft':'ArrowRight');
  await page.waitForFunction(()=>document.querySelector('[data-cf-photo-name]').textContent==='issue-photo-2.png');
  assert(await page.$eval('.cf-photo-shell',e=>e.scrollWidth<=e.clientWidth+1&&e.scrollHeight<=e.clientHeight+1));
  await page.screenshot({path:path.join(out,`preview-${language}-${width}.png`)});
  await page.keyboard.press('Escape');await closed();
  assert.equal(await page.evaluate(()=>savedCase===document.querySelector('#complaint-workspace .cf-body')),true);
  assert.equal(await page.evaluate(()=>window.scrollY),top);
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.cfPreview),'0');
 }
 // New complaints use the same image picker, with previews, saved drafts and safe upload retries.
 for(const [language,width] of [['ar',390],['en',1440]]){
  await page.setViewport({width,height:950});
  await page.evaluate(async language=>{
   currentLang=language;window.fixtureDeleted=false;fixture.attachments=[];fixture.workflow.stage='review';delete fixture.workflow.archivedAt;fixture.lifecycleStage='review';
   await ComplaintFlow.create(transactions[0]._id);
  },language);
  await page.select('dialog.cf-dialog[open] [name=categoryGroup]',await page.$eval('dialog.cf-dialog[open] [name=categoryGroup]',e=>e.options[1].value));
  assert.equal(await page.$('[data-cf-create] [name=imageUrl]'),null);
  assert.equal(await page.$eval('dialog.cf-dialog[open] [data-cf-upload]',e=>getComputedStyle(e).display),'none');
  const beforeCreates=await page.evaluate(()=>createWrites.length),beforeUploads=await page.evaluate(()=>window.evidenceUploads||0);
  await page.$eval('dialog.cf-dialog[open] [data-cf-upload]',input=>{const files=new DataTransfer();files.items.add(new File(['invalid'],'bad.svg',{type:'image/svg+xml'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.waitForFunction(()=>document.querySelector('dialog.cf-dialog[open] [data-cf-error]').textContent.includes('JPEG'));
  assert.equal(await page.$$eval('dialog.cf-dialog[open] [data-cf-remove-draft-image]',els=>els.length),0);
  const picker=page.waitForFileChooser();await page.click('dialog.cf-dialog[open] [data-cf-choose-images]');await (await picker).accept([uploadFixture]);
  await page.waitForFunction(()=>document.querySelectorAll('dialog.cf-dialog[open] [data-cf-remove-draft-image]').length===1&&!document.querySelector('dialog.cf-dialog[open] [data-cf-choose-images]').disabled);
  await page.click('dialog.cf-dialog[open] [data-cf-remove-draft-image]');await page.waitForFunction(()=>!document.querySelector('dialog.cf-dialog[open] [data-cf-remove-draft-image]')&&!document.querySelector('dialog.cf-dialog[open] [data-cf-choose-images]').disabled);
  await page.$eval('dialog.cf-dialog[open] [data-cf-upload]',input=>{
   const files=new DataTransfer(),bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
   files.items.add(new File([bytes],'first.png',{type:'image/png'}));files.items.add(new File([bytes],'second.png',{type:'image/png'}));input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  });
  await page.waitForFunction(()=>document.querySelectorAll('dialog.cf-dialog[open] [data-cf-remove-draft-image]').length===2&&!document.querySelector('dialog.cf-dialog[open] [data-cf-choose-images]').disabled);
  await page.type('[data-cf-create] [name=description]','Issue with attached photos');
  await page.click('dialog.cf-dialog[open] [data-cf-back]');await page.evaluate(()=>ComplaintFlow.create());
  assert.equal(await page.$$eval('dialog.cf-dialog[open] [data-cf-remove-draft-image]',els=>els.length),2);
  const stored=await page.evaluate(async()=>{
   const key='complaint-draft:'+currentUser._id,draft=JSON.parse(sessionStorage.getItem(key));
   return new Promise((resolve,reject)=>{const request=indexedDB.open('soulia-complaint-drafts',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,read=db.transaction('images').objectStore('images').get(key+':'+draft.operationKey);read.onsuccess=()=>{db.close();resolve(read.result.map(item=>({name:item.file.name,size:item.file.size})));};};});
  });
  assert.equal(stored.length,2);assert.equal(stored[0].name,'first.png');assert(stored[0].size>0);
  assert.equal(await page.evaluate(()=>createWrites.length),beforeCreates);assert.equal(await page.evaluate(()=>evidenceUploads),beforeUploads);
  await page.$eval('dialog.cf-dialog[open] .cf-evidence',e=>e.scrollIntoView({block:'center'}));
  assert(await page.$eval('dialog.cf-dialog[open] .cf-body',e=>e.scrollWidth<=e.clientWidth+1));
  await page.screenshot({path:path.join(out,`create-images-${language}-${width}.png`)});
  await page.evaluate(()=>{window.failEvidenceUploadAt=(window.evidenceAttempts||0)+2;});
  await page.click('[data-cf-create] button[type=submit]');
  await page.waitForFunction(()=>document.querySelector('dialog.cf-dialog[open] [data-cf-error]').textContent.includes('Fixture image upload unavailable'));
  assert.equal(await page.evaluate(()=>createWrites.length),beforeCreates+1);
  assert.equal(await page.evaluate(()=>evidenceUploads),beforeUploads+1);
  assert.equal(await page.$$eval('dialog.cf-dialog[open] [data-cf-remove-draft-image]',els=>els.length),1);
  assert.equal(await page.$eval('dialog.cf-dialog[open] [data-cf-create-details]',e=>e.disabled),true);
  await page.click('dialog.cf-dialog[open] [data-cf-back]');await page.evaluate(()=>ComplaintFlow.create());
  assert.equal(await page.$$eval('dialog.cf-dialog[open] [data-cf-remove-draft-image]',els=>els.length),1);
  await page.click('[data-cf-create] button[type=submit]');await ready();
  assert.equal(await page.evaluate(()=>createWrites.length),beforeCreates+1,'retry must not create another complaint');
  assert.equal(await page.evaluate(()=>evidenceUploads),beforeUploads+2);
  assert.equal(await page.evaluate(()=>createWrites.at(-1).imageUrl),undefined);
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('complaint-draft:'+currentUser._id)),null);
 }
 // Page disclosure motion works in both directions and has a reduced-motion path.
 await page.setViewport({width:1440,height:1000});
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'no-preference'}]);
 await page.focus(P+'.cf-message-details>summary');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('.cf-message-details').open&&!document.querySelector('.cf-message-details .cf-disclosure-body').getAnimations().length);
 await page.keyboard.press('Enter');await page.waitForFunction(()=>!document.querySelector('.cf-message-details').open);
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
 // Permissions, escaped legacy data and explicit delete confirmation still apply.
 await page.evaluate(async()=>{fixture.items=[];fixture.productName='Legacy product';fixture.productCode='LEG-40';fixture.productQty=2;fixture.productImageUrl='/fixture-product.svg';fixture.imageUrl='http://soulia.test/fixture-product.svg';fixture.attachments=[];fixture.description='<img src=x onerror=alert(1)> Safe text';await ComplaintFlow.open(fixture._id);});
 assert.equal(await page.$eval(P+'.cf-affected-qty bdi',e=>e.textContent),'2');
 assert.equal(await page.$(P+'.cf-issue-description img'),null);
 assert.equal(await page.$$eval(P+'[data-cf-preview]',e=>e.length),1);
 await page.evaluate(async()=>{currentUser.role='staff';currentUser.perms=['complaints'];await ComplaintFlow.open(fixture._id);});
 assert.equal(await page.$(P+'[data-cf-action=delete]'),null);assert.equal(await page.$(P+'[data-cf-action=plan]'),null);
 await page.evaluate(()=>ComplaintFlow.form(fixture._id,'delete'));assert.equal(await page.$(M+'[data-cf-delete-form]'),null);
 await page.evaluate(async()=>{currentUser.role='admin';await ComplaintFlow.open(fixture._id);});
 await page.click(P+'[data-cf-action=delete]');await page.waitForSelector(M+'[data-cf-delete-form]');
 assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-cf-cancel-delete')),true);
 await page.click(M+'[data-cf-cancel-delete]');await ready();
 assert.equal(await page.evaluate(()=>apiCalls.filter(c=>c.method==='DELETE'&&c.url===`/complaints/${fixture._id}`).length),0);
 // Invoice navigation works after a direct complaint link with no loaded transaction list.
 await page.evaluate(()=>{window.invoiceRenderer=renderInvoiceViewPage;window.invoiceTransactions=transactions;renderInvoiceViewPage=()=>{};transactions=[];});
 await page.$eval(P+'[data-cf-invoice]',e=>e.click());assert.equal(await page.evaluate(()=>currentPage),'invoice-view',JSON.stringify(errors));
 assert.equal(await page.evaluate(()=>window._invoiceViewTxId),'222222222222222222222222');
 await page.goBack();await ready();
 await page.evaluate(()=>{renderInvoiceViewPage=invoiceRenderer;transactions=invoiceTransactions;const id=window._complaintViewId;window._complaintViewId='another-complaint';const snapshot=_navSnapshot('complaint-detail',location.href);snapshot.restore();if(window._complaintViewId!==id)throw Error('Wrong complaint restored');});
  // Browser Back restores the historical scroll; bring the header into view as a user would.
  await page.mouse.wheel({deltaY:-10000});await page.waitForFunction(()=>window.scrollY===0);
 await page.click(P+'[data-cf-page-back]');assert.equal(await page.evaluate(()=>currentPage),'complaints');
 await page.evaluate(()=>openComplaintBySlug(fixture._id));await ready();
 await page.goBack();await page.waitForFunction(()=>currentPage==='complaints');
 await page.goForward();await ready();
 assert.equal(await page.evaluate(()=>location.hash),'#complaints/view/333333333333333333333333');
 console.log('PASS: standalone complaint route, header progress, responsive Arabic/English pages and forms, smooth motion/reduced motion, execution draft and scroll recovery, delayed response guards, workflow saves, permissions and photo previews.');
 assert.deepEqual(errors,[]);
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
