const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),puppeteer=require('puppeteer');
const source=fs.readFileSync(path.resolve(__dirname,'../../../frontend/public/index.html'),'utf8');
const suggestions=source.slice(source.indexOf('const FU_ADMIN_QUICK_NOTES ='),source.indexOf('function _fuRenderCallAttemptRow()'));
const save=source.slice(source.indexOf('async function saveFuComment()'),source.indexOf('/* Smart Product Card */',source.indexOf('async function saveFuComment()')));
const css=source.match(/<style[^>]*>([\s\S]*?)<\/style>/i)[1];
(async()=>{
 const browser=await puppeteer.launch({headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setRequestInterception(true);page.on('request',req=>req.respond({status:200,contentType:'text/html',body:'<meta charset="utf-8"><section id="fixture"><div id="fu-comment-suggestions"></div><textarea id="fu-comment-text"></textarea><button id="fu-comment-save-btn" onclick="saveFuComment()">Send</button></section>'}));
  await page.goto('http://localhost/followup-suggestions-test');await page.addStyleTag({content:css});
  await page.addStyleTag({content:'body{padding:12px;font:14px Arial}#fixture{width:min(420px,100%);margin:250px auto 0}#fu-comment-suggestions{position:relative}textarea{width:100%;box-sizing:border-box;margin-top:10px}'});
  await page.addScriptTag({content:`
   let currentLang='ar',currentUser={role:'admin'},fuCommentTargetId='trail-1',_fuEditingCommentId=null;
   let followUps=[{_id:'trail-1',reason:'\u0639\u0645\u0644\u064a\u0629 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u0637\u0644\u0628',comments:[]}];
   const qs=s=>document.querySelector(s),isAdmin=()=>currentUser.role==='admin',fmtN=String;
   const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const escHtml=esc;
   const t=k=>({fuSugMore:currentLang==='ar'?'\u0627\u0644\u0645\u0632\u064a\u062f':'More',fuSugLess:'Less',fuSugTitle:'Suggestions'}[k]||k);
   const _fuAutoGrow=()=>{},_fuCancelEditComment=()=>{qs('#fu-comment-text').value='';},_fuRenderCommentThread=()=>{},renderFollowUps=()=>{},toast=()=>{};
   window.sent=[];async function api(url,options){sent.push({url,body:JSON.parse(options.body)});return {comments:[{text:JSON.parse(options.body).text}]};}
   ${suggestions}\n${save}\n_fuRenderSuggestions();
  `});
  for(const lang of ['ar','en']){
   await page.evaluate(lang=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';currentUser.role='admin';qs('#fu-comment-text').value='';_fuSugExpanded=false;_fuRenderSuggestions();},lang);
   const top=await page.$$eval('.fu-sug-strip .fu-sug-chip',els=>els.map(e=>e.textContent));
   assert.deepEqual(top,lang==='ar'?['يرجى متابعة الطلب.','ما آخر مستجدات هذا الطلب؟','يرجى الاتصال بالعميل.']:['Please follow up on this order.','What is the latest update on this order?','Please call the customer.']);
   await page.click('.fu-sug-strip .fu-sug-chip');
   assert.equal(await page.$eval('#fu-comment-text',e=>e.value),top[0]);assert.equal(await page.evaluate(()=>document.activeElement.id),'fu-comment-text');
   assert.equal(await page.evaluate(()=>sent.length),lang==='ar'?0:1,'Suggestions do not send automatically');
   await page.click('#fu-comment-save-btn');await page.waitForFunction(n=>sent.length===n,{},lang==='ar'?1:2);
   assert.equal(await page.evaluate(()=>sent.at(-1).body.text),top[0],'Send stores the selected language verbatim');
   await page.click('.fu-sug-more');
   const all=await page.$$eval('.fu-sug-panel .fu-sug-chip',els=>els.map(e=>e.textContent));
   assert.ok(all.includes(lang==='ar'?'يرجى الاتصال بالعميل فورًا.':'Please call the customer immediately.'));
   assert.ok(all.includes(lang==='ar'?'هذا الطلب دون متابعة؛ يرجى تحديث حالته.':'This order has not been followed up. Please update its status.'));
   for(const width of [320,390,900]){
    await page.setViewport({width,height:800});
    assert.ok(await page.$eval('#fu-comment-suggestions',el=>el.scrollWidth<=el.clientWidth+1),`${lang} ${width} chips stay within the composer`);
   }
   await page.evaluate(()=>{currentUser.role='staff';_fuSugExpanded=false;_fuRenderSuggestions();});
   const staff=await page.$$eval('.fu-sug-strip .fu-sug-chip',els=>els.map(e=>e.textContent));
   assert.equal(staff[0],lang==='ar'?'العميل ما زال مترددًا':'Customer is still hesitant');
  }
  await page.evaluate(()=>{currentUser.role='admin';followUps[0].reason='\u0631\u0641\u0636 \u0627\u0644\u0627\u0633\u062a\u0644\u0627\u0645';_fuRenderSuggestions();});
  assert.ok(await page.evaluate(()=>_fuQuickNotesFor(followUps[0].reason).some(n=>n.en.includes('refused delivery'))));
  assert.ok(await page.evaluate(()=>!_fuQuickNotesFor(followUps[0].reason).some(n=>n.en.includes('deposit'))));
  await page.evaluate(()=>{followUps[0].cancelled=true;_fuRenderSuggestions();});assert.equal(await page.$eval('#fu-comment-suggestions',e=>e.style.display),'none');
  assert.deepEqual(errors,[]);console.log('PASS: admin directives in Arabic/English, staff notes preserved, relevant reasons, insertion and send text, mobile widths, cancelled trails.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
