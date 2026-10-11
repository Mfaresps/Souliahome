const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const http = require('http');
const {Server} = require('socket.io');
const src = fs.readFileSync(path.resolve(__dirname,'../../../frontend/public/index.html'),'utf8').replace(/\r\n/g,'\n');
for (const match of src.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].includes('src=') && !match[1].includes('application/')) new vm.Script(match[2]);
}
function fn(name) {
  const start=src.indexOf(`function ${name}(`);
  return src.slice(start,src.indexOf('\n}',start)+2);
}
const render = new Function(`
  const _spShippingSwitchBusy=new Set(),hasPerm=()=>true,esc=v=>v,t=key=>({spDepWithout:'بدون عربون',spShipWithoutDeposit:'شحن بدون عربون',spDepUpload:'إضافة عربون'}[key]||key);
  const _spReceiptJs=JSON.stringify,_spDepositOf=o=>({deposit:0,pending:[]});
  ${['_spDepIcon','_spHasDepositRecorded','_spCanAddDeposit','_spCanChooseShipping','_spShipsWithoutDeposit','_spShippingSwitchHtml','_spMobileDepositActionHtml','_spDepositCellHtml','_spDepositAddButtonHtml','_spDepositCardClass','_spDepositNeedsFollowup','_spMobileDepositSummaryHtml'].map(fn).join('\n')}
  const o={_id:'o1',status:'pending',shipWithoutDeposit:true};
  return {desktop:_spDepositCellHtml(o),mobile:_spMobileDepositActionHtml(o),summary:_spMobileDepositSummaryHtml(o),cardClass:_spDepositCardClass(o)};
`)();
async function verifyRealtime(browser) {
  const server=http.createServer(),ioServer=new Server(server,{cors:{origin:true}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const pages=[];
  try {
    const socketClient=path.resolve(__dirname,'../../node_modules/socket.io/client-dist/socket.io.js');
    const url=`http://127.0.0.1:${server.address().port}`;
    for (let user=0;user<2;user++) {
      const page=await browser.newPage();pages.push(page);
      await page.setContent('<html><body><div id="card"></div><div id="audit"></div></body></html>');
      await page.addScriptTag({path:socketClient});
      await page.addScriptTag({content:`
        const order={_id:'o1',ref:'2776',status:'pending',shipWithoutDeposit:false};
        const currentAuditData={rows:[{orderNumber:'2776',syncStatus:'pending',registered:false,depositApproved:0,depositPending:0,shipWithoutDeposit:false}]};
        const _spOrderById=()=>order,_spDepositOf=()=>({deposit:0,pending:[]}),esc=String,t=()=> 'شحن بدون عربون',fmtJ=String;
        ${['_spApplyShippingChoice','_spHasDepositRecorded','_spShipsWithoutDeposit','_spDepositCardClass','_auditShipsWithoutDeposit','_auditPaymentCellHtml','matchesAuditPaymentFilter'].map(fn).join('\n')}
        const _spRefreshOrderRow=()=>{document.querySelector('#card').className=_spDepositCardClass(order);};
        const renderAuditTable=()=>{document.querySelector('#audit').innerHTML=_auditPaymentCellHtml(currentAuditData.rows[0]);};
        window.testState={order,audit:currentAuditData.rows[0]};
        window.received=0;
        window.client=io(${JSON.stringify(url)},{transports:['websocket']});
        window.client.on('shopify:shipping-choice-changed',change=>{_spApplyShippingChoice(change);window.received++;});
      `});
      await page.waitForFunction(()=>window.client.connected,{timeout:10000});
    }
    const {ShopifyService}=require('../../dist/shopify/shopify.service');
    const service=Object.create(ShopifyService.prototype);
    service.presence={emitEvent:(event,payload)=>ioServer.emit(event,payload)};
    let saved;
    service.shopifyOrderModel={findById:async()=>({_id:'o1'}),findOneAndUpdate:async(_filter,update)=>{
      saved={_id:'o1',ref:'2776',...update.$set};return saved;
    }};
    for (const enabled of [true,false]) {
      const result=await service.setShipWithoutDeposit('o1',enabled,'Test staff');
      for (const page of pages) {
        await page.waitForFunction(expected=>window.testState.order.shipWithoutDeposit===expected&&window.testState.audit.shipWithoutDeposit===expected,{timeout:10000},enabled);
        const state=await page.evaluate(()=>({card:document.querySelector('#card').className,report:document.querySelector('#audit').textContent,filter:matchesAuditPaymentFilter(window.testState.audit,'ship-without-deposit'),received:window.received}));
        assert.equal(state.card,enabled?'sp-card-deposit-paid':'sp-card-deposit-none');
        assert.equal(state.filter,enabled);
        assert.equal(state.report.includes('شحن بدون عربون'),enabled);
        assert(state.received>0);
      }
      assert.equal(result.shipWithoutDeposit,enabled);
    }
    // A late older event must not restore a state which another user already changed.
    ioServer.emit('shopify:shipping-choice-changed',{orderId:'o1',ref:'2776',shipWithoutDeposit:true,shipWithoutDepositAt:'2020-01-01T00:00:00.000Z'});
    for(const page of pages){
      await page.waitForFunction(()=>window.received>=3,{timeout:10000});
      assert.equal(await page.evaluate(()=>window.testState.order.shipWithoutDeposit),false);
    }
    console.log('PASS two browser sessions: saved events update cards, report payment cells and filters; stale events ignored');
  } finally {
    await Promise.all(pages.map(page=>page.close()));
    await new Promise(resolve=>ioServer.close(resolve));
  }
}
(async()=>{
  const browser=await puppeteer.launch({headless:true});
  try {
    const page=await browser.newPage();
    const styles=[...src.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map(m=>m[0]).join('\n');
    for(const width of [1440,390,320]) {
      await page.setViewport({width,height:800});
      await page.setContent(`<html dir="rtl"><head>${styles}</head><body style="padding:16px"><table><tbody><tr><td style="width:240px">${render.desktop}</td></tr></tbody></table><div id="sp-mobile-list" style="display:flex;margin-top:20px;width:${width<500?width-32:360}px"><div class="sp-card ${render.cardClass}"><div class="sp-card-top"><b>#2770</b><span>EGP 870</span><div class="sp-card-menu"><button class="dd-toggle">⋮</button></div></div><div class="sp-card-subline">Aya Abdelnaby · الجمعة · 2 صنف</div>${render.summary}${render.mobile}<div class="sp-card-actions-row"><div class="sp-card-actions"><button class="spdep-quick-add">✉</button></div><span class="sp-card-assignee-chip"><span class="sp-assignee-avatar">G</span></span><a class="sp-card-vrobo-link">تواصل</a><a class="sp-card-shopify-link">View order</a></div></div><div class="sp-card sp-card-deposit-paid" id="paid-card">عربون مدفوع</div></div></body></html>`);
      const metrics=await page.evaluate(()=>[...document.querySelectorAll('[role=switch]')].map(el=>{
        const r=el.getBoundingClientRect();
        return {width:r.width,height:r.height,right:r.right,left:r.left,checked:el.getAttribute('aria-checked'),color:getComputedStyle(el).color,overflow:el.scrollWidth>el.clientWidth+1};
      }));
      assert.equal(metrics.length,2);
      for(const m of metrics){assert.equal(m.checked,'true');assert.equal(m.color,'rgb(21, 128, 61)');assert.equal(m.overflow,false);assert(m.left>=0&&m.right<=width);}
      assert(metrics[1].height>=44,'mobile touch target');
      const card=await page.evaluate(()=>{
        const el=document.querySelector('.sp-card'),style=getComputedStyle(el),paid=getComputedStyle(document.querySelector('#paid-card'));
        const plus=el.querySelector('.spdep-quick-add'),rect=plus.getBoundingClientRect();
        return {switches:el.querySelectorAll('[role=switch]').length,disabled:plus.disabled,plusWidth:rect.width,plusHeight:rect.height,background:style.backgroundImage,paidBackground:paid.backgroundImage,border:style.borderInlineStartColor,paidBorder:paid.borderInlineStartColor,overflow:el.scrollWidth>el.clientWidth+1,footerHeights:[...el.querySelectorAll('.sp-card-actions-row button,.sp-card-actions-row a')].map(b=>b.getBoundingClientRect().height),menuSize:el.querySelector('.dd-toggle').getBoundingClientRect().height};
      });
      assert.equal(card.switches,1);assert.equal(card.disabled,true);
      assert(card.plusWidth>=44&&card.plusHeight>=44);assert.equal(card.overflow,false);
      assert.equal(card.background,card.paidBackground);assert.equal(card.border,card.paidBorder);
      assert(card.footerHeights.every(h=>h>=36));assert.equal(card.menuSize,36);
      console.log(`PASS RTL layout and switch at ${width}px`);
    }
    console.log('PASS all inline JavaScript parses');
    await verifyRealtime(browser);
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
