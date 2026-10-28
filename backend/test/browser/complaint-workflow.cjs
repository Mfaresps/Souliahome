/* Real UI with isolated HTTP fixtures. No live customer, shipment or payment writes. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'../../..'),pub=path.join(root,'frontend/public'),out=path.join(root,'artifacts/complaint-workflow');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await puppeteer.launch({headless:true,pipe:true});
 try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.evaluateOnNewDocument(()=>{let i=0;if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>`fixture-key-${++i}`});});
 await page.setRequestInterception(true);
 page.on('request',r=>{const u=new URL(r.url());if(u.origin==='http://soulia.test'&&u.pathname==='/')return r.respond({status:200,contentType:'text/html',body:fs.readFileSync(path.join(pub,'index.html'),'utf8')});
  if(['/complaint-flow.js','/complaint-flow.css','/after-sales.js','/after-sales.css','/order-status.js','/design-system.css'].includes(u.pathname))return r.respond({status:200,contentType:u.pathname.endsWith('.js')?'text/javascript':'text/css',body:fs.readFileSync(path.join(pub,u.pathname.slice(1)))});
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
  api=async(url,options={})=>{
   const body=options.body?JSON.parse(options.body):{};
   if(url==='/complaints/message-templates'){if(options.method==='PUT'){messageConfig.templates=body.templates;messageConfig.revision++;}return structuredClone(messageConfig);}
   if(url.includes('/customer-message?')){const params=new URL(url,'http://soulia.test').searchParams,lang=params.get('lang')||'ar',kind=fixture.workflow.stage==='closed'?'resolved':fixture.execution.ready?'confirmation':params.get('event')==='registered'?'registered':'update';return {kind,text:messageConfig.templates[kind][lang].replace('{customerName}',fixture.clientName).replace('{complaintNo}',fixture.complaintNo)};}
   if(url==='/users')return [currentUser];if(url==='/complaints'){
    if(options.method==='POST'){createWrites.push(body);return fixture;}return [fixture];
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
   if(url.startsWith('/after-sales/'))return {_id:'444444444444444444444444',originalTransactionId:transactions[0]._id,originalRef:'2790',client:fixture.clientName,requestKind:'exchange',items:fixture.items,exchangeItems:[],workflow:{version:2,ref:'AS-2026-000002',stage:'requested',complaintIds:[fixture._id],quote:{credit:500,replacement:500,customerFee:0,collectDue:0,refundDue:0},history:[]}};
   if(url==='/transactions')return transactions;if(url==='/returns'||url==='/transactions/inventory')return [];return [];
  };
 });
 for(const lang of ['ar','en'])for(const width of [1440,390]){
  await page.setViewport({width,height:width===390?844:1000});
  await page.evaluate(async lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';await ComplaintFlow.open(fixture._id);},lang);
  if(width===1440)assert(await page.$eval('.cf-dialog',e=>{const r=e.getBoundingClientRect();return Math.abs(r.left+r.width/2-innerWidth/2)<3&&Math.abs(r.top+r.height/2-innerHeight/2)<3;}),'desktop dialog centered');
  assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1),`detail overflow ${lang}/${width}`);
  await page.screenshot({path:path.join(out,`detail-${lang}-${width}.png`)});
  await page.evaluate(()=>ComplaintFlow.form(fixture._id,'plan'));
  assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1),`plan overflow ${lang}/${width}`);
  await page.screenshot({path:path.join(out,`plan-${lang}-${width}.png`)});
 }
 for(const lang of ['ar','en']){
  await page.evaluate(lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';},lang);
  await page.setViewport({width:390,height:844});
  for(const action of ['assign','wait','contact','close','items']){
   await page.evaluate(action=>ComplaintFlow.form(fixture._id,action),action);
   assert(await page.$eval('.cf-body',e=>e.scrollWidth<=e.clientWidth+1),`${action} form overflow ${lang}`);
   await page.screenshot({path:path.join(out,`${action}-${lang}-390.png`)});
  }
 }
 await page.evaluate(async()=>{document.body.classList.add('dark-mode');currentLang='ar';await ComplaintFlow.open(fixture._id);});
 await page.screenshot({path:path.join(out,'detail-dark-ar-390.png')});
 await page.evaluate(async()=>{document.body.classList.remove('dark-mode');currentLang='en';document.documentElement.dir='ltr';await ComplaintFlow.form(fixture._id,'plan');});
 await page.select('.cf-dialog select[name=solution]','exchange');await page.type('.cf-dialog textarea[name=note]','Exchange approved after reviewing customer photos');
 await page.click('.cf-dialog button[type=submit]');await page.waitForSelector('[data-cf-action=create-case]');
 assert.equal(await page.evaluate(()=>writes.at(-1).solution),'exchange');
 await page.click('[data-cf-action=create-case]');await page.waitForSelector('[data-as-create]');
 assert.equal(await page.$eval('[data-as-line="0"] [data-as-qty]',e=>e.value),'1');
 assert.equal(await page.$eval('[data-as-line="1"] [data-as-qty]',e=>e.value),'0');
 assert.equal(await page.$eval('[data-as-create] select[name=kind]',e=>e.disabled),true);
 await page.select('[data-as-create] select[name=fulfillmentChannel]','direct');
 assert.equal(await page.$eval('[data-as-create] input[name=customerFee]',e=>e.disabled),true);
 await page.click('[data-as-add]');await page.click('[data-as-pick]');await page.click('[data-as-create] button[type=submit]');await page.waitForSelector('[data-as-complaint]');
 assert.equal(await page.evaluate(()=>lastCase.complaintId),'333333333333333333333333');
 assert.equal(await page.evaluate(()=>lastCase.fulfillmentChannel),'direct');
 await page.click('[data-as-complaint]');await page.waitForSelector('.cf-dialog[open] .cf-grid');
 await page.evaluate(async()=>{fixture.workflow.caseId='444444444444444444444444';fixture.workflow.caseRef='AS-2026-000002';fixture.workflow.stage='execution';fixture.execution={ready:true,blockers:[],financialPending:true,caseRef:'AS-2026-000002',receivedAt:new Date().toISOString(),deliveredAt:new Date().toISOString()};fixture.lifecycleStage='confirmation';await ComplaintFlow.open(fixture._id);});
 await page.screenshot({path:path.join(out,'confirmation-mobile.png')});
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
 assert.deepEqual(errors,[],'no browser runtime errors');
 console.log('PASS: Arabic/English desktop/mobile dialogs, plan -> linked exchange -> confirmation -> close -> reopen, grouped draft recovery and staff actions.');
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exit(1)});
