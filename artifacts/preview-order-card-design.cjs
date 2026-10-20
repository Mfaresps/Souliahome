const path=require('node:path'),assert=require('node:assert/strict'),{pathToFileURL}=require('node:url'),puppeteer=require('../backend/node_modules/puppeteer');
(async()=>{
 const browser=await puppeteer.launch({headless:true});
 try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setViewport({width:1310,height:1120,deviceScaleFactor:1.5});
 await page.goto(pathToFileURL(path.resolve('design-preview/shopify-order-cards-prototype.html')).href);
 assert.equal(await page.$$eval('.card',els=>els.length),12);
 await page.screenshot({path:'design-preview/shopify-order-cards-all-states.png',fullPage:true});
 for(const width of [320,390,430]){
 await page.setViewport({width,height:900,deviceScaleFactor:1.5});
 for(const english of [false,true]){
 if(english)await page.click('#direction');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 const items=await page.$('.items');const height=await page.$eval('.card',el=>el.getBoundingClientRect().height);
 await items.click();assert.equal(await items.evaluate(el=>el.getAttribute('aria-expanded')),'true');
 assert.equal(await page.$eval('.product-list',el=>el.hidden),false);
 assert.ok(await page.$eval('.card',el=>el.getBoundingClientRect().height)>height);
 assert.deepEqual(await page.$$eval('.card',els=>els.filter(el=>el.scrollWidth>el.clientWidth+1).map(el=>el.className)),[]);
 await items.focus();await page.keyboard.press('Enter');assert.equal(await page.$eval('.product-list',el=>el.hidden),true);
 const note=await page.$('.note');await note.click();assert.equal(await note.evaluate(el=>el.getAttribute('aria-expanded')),'true');await note.click();
 if(width===390&&!english)await page.screenshot({path:'design-preview/shopify-order-cards-phone.png',fullPage:true});
 if(english)await page.click('#direction');
 }}
 await page.setViewport({width:390,height:900,deviceScaleFactor:1.5});
 await page.$eval('.sample:nth-child(3) .items',el=>el.click());
 const sample=await page.$('.sample:nth-child(3)');await sample.screenshot({path:'design-preview/shopify-order-card-expanded.png'});
 const ship=await page.$('.ship');await ship.click();assert.equal(await ship.evaluate(el=>el.parentElement.querySelector('.add').disabled),true);await ship.click();assert.equal(await ship.evaluate(el=>el.parentElement.querySelector('.add').disabled),false);
 assert.deepEqual(errors,[]);console.log('PASS: 12 states, RTL/LTR, three phone widths, product expansion with mouse/keyboard, comments and payment controls.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
