
const fs=require('fs'),assert=require('assert/strict'),vm=require('vm');
const puppeteer=require('../backend/node_modules/puppeteer');
const html=fs.readFileSync('frontend/public/index.html','utf8');
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!m[1].includes('src=')&&!m[1].includes('application/'))new vm.Script(m[2]);
const renderer=html.slice(html.indexOf('function _renderShopifyPagination('),html.indexOf('function renderPagination('));
(async()=>{const browser=await puppeteer.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{const page=await browser.newPage();await page.setContent('<style>:root{--border:#d2dfd9;--muted:#668578;--text:#14291f;--surface:#f8fbfa;--accent:#237e51}*{box-sizing:border-box}body{margin:12px;font-family:Arial}</style><div id="shopify-pagination"></div>');
await page.addStyleTag({content:fs.readFileSync('frontend/public/shopify-responsive.css','utf8')});
await page.addScriptTag({content:'var currentLang="en";var selectedPage=0,selectedSize=0;function fmtN(v){return String(v)}function setPage(p){selectedPage=p}function setSize(s){selectedSize=s}'+renderer});
for(const width of [320,390,768,1440])for(const lang of ['en','ar'])for(const count of [0,15,205]){
await page.setViewport({width,height:500});await page.evaluate(({lang,count})=>{currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';_renderShopifyPagination(document.getElementById('shopify-pagination'),count,count===205?2:1,30,'setPage',[15,30,50,100],'setSize');},{lang,count});
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow: '+width+' '+lang);
assert.equal(await page.$eval('.sp-pag-size select',e=>e.getBoundingClientRect().width<100),true);
if(count===205){await page.select('.sp-pag-current select','7');assert.equal(await page.evaluate(()=>selectedPage),7);await page.click('.sp-pag-arrow.is-next');assert.equal(await page.evaluate(()=>selectedPage),3);assert(await page.$eval('.sp-pagination',e=>e.getBoundingClientRect().height<=100));}
else {assert.equal(await page.$('.sp-pag-nav'),null);}
await page.select('.sp-pag-size select','50');assert.equal(await page.evaluate(()=>selectedSize),50);
}
for(const at of [1,7]){await page.evaluate(at=>_renderShopifyPagination(document.getElementById('shopify-pagination'),205,at,30,'setPage',[30,50],'setSize'),at);assert.equal(await page.$$eval('.sp-pag-arrow:disabled',els=>els.length),2);}
await page.setViewport({width:390,height:200});await page.evaluate(()=>{document.documentElement.dir='rtl';currentLang='ar';_renderShopifyPagination(document.getElementById('shopify-pagination'),205,2,30,'setPage',[15,30,50,100],'setSize');});await page.screenshot({path:'artifacts/shopify-pagination-mobile.png'});
console.log('PASS: pagination at 4 widths, RTL/LTR, empty/single/multiple pages, bounded selector widths, direct page selection, next-page and page-size actions, first/last disabled states.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
