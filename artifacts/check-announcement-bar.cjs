
const fs=require('fs'),assert=require('assert/strict'),vm=require('vm'),puppeteer=require('../backend/node_modules/puppeteer');
const html=fs.readFileSync('frontend/public/index.html','utf8');
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!m[1].includes('src=')&&!m[1].includes('application/'))new vm.Script(m[2]);
const styles=[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].filter(m=>m.index<html.indexOf('<body')).map(m=>m[1]).join('\n');
const code=html.slice(html.indexOf("const ANN_KEY       ="),html.indexOf('function annCtrlReadDraft()'))+html.slice(html.indexOf('function annBroadcast(cfg)'),html.indexOf('function annCtrlReset()'));
(async()=>{const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});try{
const page=await browser.newPage();await page.setContent('<style>'+styles+fs.readFileSync('frontend/public/navigation-shell.css','utf8')+'</style><header id="header"></header><nav id="sidebar"><div class="shell-brand">Soulia</div><div class="shell-nav-scroll">Dashboard</div></nav><main id="main">Orders</main><div id="announcement-bar" class="ann-hidden"><div class="ann-inner"><div class="ann-track"><div id="ann-line-a"></div><div id="ann-line-b"></div></div></div></div><input type="checkbox" id="ann-enabled-toggle">');
await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
await page.addScriptTag({content:'var currentLang="en",currentUser={role:"admin"};var published=[],errors=[];function isAdmin(){return currentUser.role==="admin"}var socket={connected:true,timeout:()=>({emit:(event,cfg,ack)=>{published.push(cfg);ack(null,{ok:true})}}),emit:()=>{},once:()=>{}};function toast(msg){errors.push(msg)};'+code+';annCtrlReadDraft=()=>({messages:["Welcome"],bgColor:"#38a9d7"});annCtrlUpdatePreview=annCtrlRenderAudit=annUpdateLiveStatusBadge=()=>{};'});
for(const width of [390,1024,1440])for(const dir of ['ltr','rtl'])for(const collapsed of [false,true]){
await page.setViewport({width,height:800});await page.evaluate(({dir,collapsed})=>{document.documentElement.dir=dir;document.body.classList.toggle('sidebar-collapsed',collapsed);annApply({enabled:true,messages:['Welcome'],bgColor:'#38a9d7'});},{dir,collapsed});
await page.evaluate(()=>new Promise(r=>setTimeout(r,250)));
const r=await page.evaluate(()=>{const b=document.getElementById('announcement-bar').getBoundingClientRect(),s=document.getElementById('sidebar').getBoundingClientRect();return {left:b.left,right:b.right,width:b.width,sideLeft:s.left,sideRight:s.right,sidebarTop:s.top,padding:getComputedStyle(document.querySelector('.shell-nav-scroll')).paddingTop};});
if(width>768){assert(dir==='ltr'?r.left>=r.sideRight-1:r.right<=r.sideLeft+1,JSON.stringify({width,dir,collapsed,r}));}else assert.equal(r.width,width);
assert.equal(r.sidebarTop,0);assert.notEqual(r.padding,'54px');
await page.evaluate(()=>annHide());assert.equal(await page.$eval('#announcement-bar',e=>getComputedStyle(e).visibility),'hidden');assert(!await page.evaluate(()=>document.body.classList.contains('ann-visible')));
}
await page.evaluate(async()=>{annApply({enabled:true,messages:['Welcome']});document.getElementById('ann-enabled-toggle').checked=false;await annCtrlToggleEnabled();});assert.equal(await page.evaluate(()=>published.at(-1).enabled),false);assert(!await page.evaluate(()=>document.body.classList.contains('ann-visible')));
await page.evaluate(()=>{annStore({enabled:true,messages:['Stale local banner']});annInit();});assert(!await page.evaluate(()=>document.body.classList.contains('ann-visible')),'Cached state must not override admin hiding');
await page.evaluate(async()=>{socket.connected=false;document.getElementById('ann-enabled-toggle').checked=false;await annCtrlToggleEnabled();});assert.equal(await page.evaluate(()=>errors.length),1,'Failed save is reported');
console.log('PASS: announcement stays beside expanded/collapsed sidebar in RTL/LTR; mobile full width; hiding removes banner and gap; admin toggle broadcasts disabled state; stale cache stays hidden; offline save reports failure.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
