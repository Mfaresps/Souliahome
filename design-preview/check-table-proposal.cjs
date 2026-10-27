const {pathToFileURL}=require('node:url');
const path=require('node:path');
const assert=require('node:assert/strict');
const puppeteer=require('../backend/node_modules/puppeteer');
(async()=>{
 const browser=await puppeteer.launch({headless:true});
 try{
 const page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(pathToFileURL(path.join(__dirname,'shopify-orders-table-proposal.html')).href);
 assert.equal(await page.$$eval('tr.order',x=>x.length),10);
 for(const width of [1440,1024,768,390,320]){
  await page.setViewport({width,height:1000,deviceScaleFactor:1.5});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Horizontal overflow at ${width}`);
  assert.equal(await page.$$eval('.note',els=>els.every(el=>el.getBoundingClientRect().width>0)),true);
  await page.click('.more');
  assert.equal(await page.$eval('#more-menu',el=>el.hidden),false);
  assert.equal(await page.$eval('#more-menu',el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight}),true);
  if(width===1024)await page.screenshot({path:path.join(__dirname,'shopify-table-more-menu.png'),fullPage:true});
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#more-menu',el=>el.hidden),true);
  await page.evaluate(()=>document.activeElement?.blur());
  if([1440,1024,390].includes(width))await page.screenshot({path:path.join(__dirname,`shopify-table-${width}.png`),fullPage:true});
 }
 await page.setViewport({width:1440,height:1000});
 await page.click('[data-filter="follow"]');
 assert.equal(await page.$$eval('tr.order',x=>x.length),3);
 await page.click('[data-filter="short"]');
 assert.equal(await page.$$eval('tr.order',x=>x.length),2);
 await page.click('[data-filter="all"]');
 await page.type('#search','2971');
 assert.equal(await page.$$eval('tr.order',x=>x.length),1);
 await page.click('.note');
 await page.type('#new-note','تعليق اختبار المعاينة');
 await page.click('#save-note');
 assert.equal(await page.$eval('.note-text',el=>el.textContent),'تعليق اختبار المعاينة');
 await page.click('.amount');
 assert.ok(await page.$eval('#detail-body',el=>el.textContent.includes('الشحن')));
 await page.keyboard.press('Escape');
 await page.click('#select-all');
 assert.equal(await page.$eval('.row-check',el=>el.checked),true);
 await page.click('#density');
 assert.equal(await page.$eval('body',el=>el.classList.contains('compact')),true);
 assert.deepEqual(errors,[]);
 console.log('PASS: 5 viewport widths; no horizontal overflow; visible follow-up; more menu bounds and Escape; filters; search; comments; totals; selection; density.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
