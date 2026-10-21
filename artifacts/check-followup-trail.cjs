const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const puppeteer=require('../backend/node_modules/puppeteer'),express=require('../frontend/node_modules/express');
const html=fs.readFileSync('frontend/public/index.html','utf8');
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!m[1].includes('src=')&&!m[1].includes('application/'))new vm.Script(m[2]);
(async()=>{
 const app=express();app.get('/config.js',(req,res)=>res.type('js').send('window.__ENV__={API_BASE_URL:""};'));app.use(express.static(path.resolve('frontend/public')));
 const server=app.listen(8089);let browser;
 try{
  browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setViewport({width:390,height:844,hasTouch:true});await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
  await page.evaluateOnNewDocument(()=>{document.startViewTransition=undefined;localStorage.setItem('token','trail-preview');localStorage.setItem('soulia-push-prompt:preview','dismissed');localStorage.setItem('user',JSON.stringify({_id:'preview',name:'Fares',username:'preview',role:'admin',perms:[]}));});
  await page.setRequestInterception(true);page.on('request',request=>{
   const url=new URL(request.url());
   if(url.origin!=='http://localhost:8089')return request.respond({status:200,contentType:request.resourceType()==='stylesheet'?'text/css':'text/javascript',body:''});
   if(url.pathname.startsWith('/api/')){
    const data=url.pathname==='/api/auth/me'?{_id:'preview',name:'Fares',username:'preview',role:'admin',perms:[]}:url.pathname==='/api/settings'?{lang:'en'}:url.pathname==='/api/notifications'||url.pathname==='/api/notifications/preferences'?{preferences:{enabled:false},devices:0,configured:false,language:'en',categories:[]}:url.pathname.includes('branding')?{logos:[],selection:{}}:[];
    return request.respond({status:200,contentType:'application/json',body:JSON.stringify(data)});
   }request.continue();
  });
  await page.goto('http://localhost:8089/#shopify-orders',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.spCompactHeader&&!document.querySelector('#splash-screen'));
  await page.evaluate(()=>{
   const now=Date.now();users=[{_id:'preview',name:'Fares',jobTitle:'General Manager'},{_id:'agent',name:'Gannh',jobTitle:'Order Confirmation Agent'}];
   followUps=[{_id:'trail-ui',orderRef:'2873',clientName:'Eyad Eyad Ahmed',clientPhone:'01012345678',reason:'عملية تأكيد الطلب',status:'في انتظار العميل',comments:Array.from({length:35},(_,i)=>({_id:'c-'+i,authorId:i%2?'preview':'agent',authorName:i%2?'Fares':'Gannh',createdAt:new Date(now-(35-i)*3600000).toISOString(),text:i%2?'Please follow up on this order.':'هيتم التواصل هاتفيًا صباحًا — متابعة الطلب وتأكيد العنوان.'}))}];
   window.trailRequests=[];window.trailToasts=[];window.trailFail=false;
   const originalApi=api;api=async(url,options={})=>{
    if(!url.startsWith('/followups/trail-ui'))return originalApi(url,options);
    trailRequests.push({url,method:options.method,body:options.body?JSON.parse(options.body):null});
    await new Promise(resolve=>setTimeout(resolve,30));if(trailFail)throw new Error('Test save failed');
    const f=followUps.find(f=>f._id==='trail-ui'),body=options.body?JSON.parse(options.body):{};
    if(url.endsWith('/call-attempts'))f.comments.push({_id:'call-'+trailRequests.length,kind:'call',callOutcome:body.outcome,callAttemptNo:f.comments.filter(c=>c.kind==='call').length+1,authorId:'preview',authorName:'Fares',createdAt:new Date().toISOString()});
    else if(options.method==='POST')f.comments.push({_id:'new-'+trailRequests.length,text:body.text,authorId:'preview',authorName:'Fares',createdAt:new Date().toISOString()});
    else if(options.method==='PATCH')f.comments.find(c=>c._id===url.split('/').pop()).text=body.text;
    else if(options.method==='DELETE')f.comments=f.comments.filter(c=>c._id!==url.split('/').pop());
    return {...f,comments:[...f.comments]};
   };
   toast=(text,error=false)=>trailToasts.push({text,error});renderFollowUps=()=>{};showConfirm=async()=>true;
  });
  for(const [width,height]of [[320,640],[390,844],[430,932],[1440,900],[390,480]])for(const lang of ['ar','en']){
   await page.setViewport({width,height,hasTouch:true});
   await page.evaluate(lang=>{if(document.querySelector('#fu-comment-popup').classList.contains('show'))closeFuCommentPopup();currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';openFuCommentPopup('trail-ui');},lang);
   await page.waitForFunction(()=>document.activeElement.id==='fu-comment-text');
   assert(await page.$eval('#fu-comment-text',e=>getComputedStyle(e).overflowY==='hidden'&&e.scrollHeight<=e.clientHeight+1),'Empty input does not show scroll arrows');
   assert.equal(await page.$eval('.fu-sug-more',e=>getComputedStyle(e).animationName),'none','More appears immediately with the notes');
   await page.$eval('#fu-comment-text',e=>{e.value=Array(40).fill('Long comment line').join('\n');_fuAutoGrow(e);});
   assert(await page.$eval('#fu-comment-text',e=>getComputedStyle(e).overflowY==='auto'&&e.scrollHeight>e.clientHeight),'Long comments retain internal scrolling');
   await page.$eval('#fu-comment-text',e=>{e.value='';_fuAutoGrow(e);});

   const layout=await page.evaluate(()=>{
    const modal=document.querySelector('.fu-thread-modal'),thread=document.querySelector('#fu-comment-thread'),input=document.querySelector('#fu-comment-text'),send=document.querySelector('#fu-comment-save-btn');
    const a=modal.getBoundingClientRect(),b=input.getBoundingClientRect(),c=send.getBoundingClientRect(),d=thread.getBoundingClientRect();
    return {scroll:thread.scrollHeight>thread.clientHeight,threadHeight:d.height,inputVisible:b.top>=a.top&&b.bottom<=a.bottom+1&&b.bottom<=innerHeight,sendVisible:c.bottom<=a.bottom+1&&c.bottom<=innerHeight,modalVisible:a.top>=0&&a.bottom<=innerHeight+1,overflow:modal.scrollWidth>modal.clientWidth+1,items:thread.querySelectorAll('.fu-timeline-item').length};
   });
   assert(layout.scroll&&layout.threadHeight>=45,JSON.stringify({width,height,lang,layout}));assert(layout.inputVisible&&layout.sendVisible&&layout.modalVisible&&!layout.overflow,JSON.stringify({width,height,lang,layout}));assert.equal(layout.items,35);
   const before=await page.$eval('#fu-comment-save-btn',e=>e.getBoundingClientRect().top);
   await page.$eval('#fu-comment-thread',e=>{e.scrollTop=0;});
   const after=await page.$eval('#fu-comment-save-btn',e=>e.getBoundingClientRect().top);assert.equal(after,before,'Thread scroll does not move Send');
   assert.equal(await page.evaluate(()=>document.body.style.position),'fixed');
   await page.$eval('.fu-sug-strip .fu-sug-chip',e=>e.click());assert(await page.$eval('#fu-comment-text',e=>e.value.length>0));
   await page.$eval('.fu-sug-more',e=>e.click());assert(await page.$('.fu-sug-panel'));
   await page.$eval('.fu-sug-panel .fu-sug-chip',e=>e.click());assert.equal(await page.$('.fu-sug-panel'),null);
   if(width===390&&height===844){
    await page.evaluate(()=>{document.querySelector('#fu-comment-thread').scrollTop=document.querySelector('#fu-comment-thread').scrollHeight;document.querySelector('#fu-comment-text').value='';_fuAutoGrow(document.querySelector('#fu-comment-text'));});
    await page.screenshot({path:`artifacts/followup-trail-${lang}.png`});
   }
   await page.evaluate(()=>closeFuCommentPopup());
  }
  await page.setViewport({width:390,height:844,hasTouch:true});
  await page.evaluate(()=>openFuCommentPopup('trail-ui'));
  const longHeight=await page.$eval('.fu-thread-modal',e=>e.getBoundingClientRect().height);
  assert(longHeight<=680,'Mobile trail has a compact maximum height');
  await page.evaluate(()=>{window.fullTrailComments=followUps[0].comments;followUps[0].comments=fullTrailComments.slice(0,1);_fuRenderCommentThread();});
  assert(await page.$eval('.fu-thread-modal',e=>e.getBoundingClientRect().height)<longHeight,'Short trails shrink to their content');
  await page.screenshot({path:'artifacts/followup-trail-compact-short.png'});
  await page.evaluate(()=>{followUps[0].comments=fullTrailComments;closeFuCommentPopup();});
  await page.evaluate(()=>{currentLang='en';document.documentElement.dir='ltr';openFuCommentPopup('trail-ui');document.querySelector('#fu-comment-text').value='New trail comment';});
  await page.evaluate(()=>Promise.all([saveFuComment(),saveFuComment()]));
  assert.equal(await page.evaluate(()=>trailRequests.filter(r=>r.method==='POST').length),1,'Duplicate submits are blocked');
  assert.equal(await page.$eval('#fu-comment-text',e=>e.value),'');assert((await page.$eval('#fu-comment-thread',e=>e.textContent)).includes('New trail comment'));
  assert.deepEqual(await page.evaluate(()=>trailToasts),[],'No saved-comment toast');
  await page.evaluate(()=>{_fuStartEditComment('new-1');document.querySelector('#fu-comment-text').value='Edited trail comment';});await page.evaluate(()=>saveFuComment());
  assert((await page.$eval('#fu-comment-thread',e=>e.textContent)).includes('Edited trail comment'));
  await page.evaluate(()=>_fuDeleteComment('new-1'));assert(!(await page.$eval('#fu-comment-thread',e=>e.textContent)).includes('Edited trail comment'));
  await page.$eval('#fu-call-attempt-btn',e=>e.click());assert(await page.$('[onclick="logFuCallAttempt(\'answered\')"]'));
  await page.evaluate(()=>logFuCallAttempt('answered'));assert.equal(await page.$$eval('.fu-timeline-item.is-call',els=>els.length),1);
  await page.evaluate(()=>{trailFail=true;document.querySelector('#fu-comment-text').value='Keep draft on failure';});await page.evaluate(()=>saveFuComment());
  assert.equal(await page.$eval('#fu-comment-text',e=>e.value),'Keep draft on failure');assert.equal(await page.$eval('#fu-comment-save-btn',e=>e.disabled),false);assert(await page.evaluate(()=>trailToasts.some(t=>t.error&&t.text==='Test save failed')));
  await page.evaluate(()=>{trailFail=false;document.body.classList.add('dark-mode');});await page.screenshot({path:'artifacts/followup-trail-dark.png'});
  await page.focus('.fu-thread-close');await page.keyboard.down('Shift');await page.keyboard.press('Tab');await page.keyboard.up('Shift');assert.equal(await page.evaluate(()=>document.activeElement.id),'fu-comment-save-btn');
  await page.keyboard.press('Escape');assert.equal(await page.$eval('#fu-comment-popup',e=>e.classList.contains('show')),false);assert.equal(await page.evaluate(()=>document.body.style.position),'');
  await page.evaluate(()=>{followUps[0].cancelled=true;followUps[0].cancelledAt=new Date().toISOString();followUps[0].cancelledByName='Fares';openFuCommentPopup('trail-ui');});
  assert.equal(await page.$eval('.fu-thread-composer',e=>getComputedStyle(e).display),'none');assert(await page.$('.fu-timeline-item.is-decision'));await page.evaluate(()=>closeFuCommentPopup());
  assert.deepEqual(errors,[]);console.log('PASS: 35-entry timeline, internal scroll, pinned input/send, mobile and keyboard-sized viewports, RTL/LTR, suggestions, add/edit/delete, duplicate prevention, silent success/error feedback, call logging, cancelled trail, keyboard focus and dark mode.');
 }finally{await browser?.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
