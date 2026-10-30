const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('../../backend/node_modules/puppeteer');
const publicDir = path.resolve(__dirname, '../../frontend/public');
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== 'http://soulia.test') return request.abort();
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(publicDir, relative);
      if (file.startsWith(publicDir + path.sep) && fs.existsSync(file) && ['.html','.css','.js','.svg'].includes(path.extname(file))) {
        return request.respond({ contentType: {'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'}[path.extname(file)], body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ contentType:'text/javascript', body:'window.Chart=class{static register(){} destroy(){}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ contentType:'application/json', body:'[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentUser={_id:'preview',role:'admin',perms:[]};currentLang='ar';
      document.querySelectorAll('link[rel=stylesheet]').forEach(link=>document.head.appendChild(link));
      document.body.innerHTML='<main style="padding:24px;max-width:1800px;margin:auto"><div id="rep-cancellations-body"></div></main>';
      const codes = CANCEL_REASONS.slice(0,10).map(reason=>reason.code);
      const counts=[54,11,8,5,5,5,3,3,1,1];
      const breakdown=codes.flatMap((code,i)=>[{code,stage:'shopify',count:counts[i]-(i===3?1:0),lostValue:counts[i]*1250,refunded:0},...(i===3?[{code,stage:'transaction',count:1,lostValue:1500,refunded:300}]:[])]);
      const recent=breakdown.flatMap(b=>Array.from({length:b.count},(_,i)=>({ref:`${b.code}-${i}`,code:b.code,stage:b.stage,client:'عميل تجريبي',date:'2026-10-20',lostValue:1250,refunded:0,by:'Operator'})));
      const names=['طقم عشاء بورسلين أبيض — 24 قطعة','صينية تقديم خشب','طقم أكواب زجاج','مفرش سفرة قطن','طبق تقديم سيراميك','منظّم أدوات المطبخ','سلّة تخزين','مزهرية زجاج','طقم ملاعق','حامل مناديل','فنجان قهوة','برطمان توابل','طبق حلويات','اسم منتج طويل جدًا لاختبار التفاف النص بدون تداخل مع عدد الطلبات والقطع'];
      const products=names.map((name,i)=>({key:'id:'+i,name,code:'SKU-'+i,breakdown:[{code:codes[0],stage:'shopify',orderCount:30-i,quantity:i===1?120:40-i},{code:codes[3],stage:'transaction',orderCount:1,quantity:2}],orderCount:31-i,quantity:(i===1?120:40-i)+2}));
      window.fixture={cancellations:{total:96,shopifyCount:95,transactionCount:1,lostValue:194000,refunded:300,avgHoursToCancel:12,unspecified:0,breakdown,products,productCoverage:[{code:codes[0],stage:'shopify',orders:54,missingOrders:2,partialOrders:1,excludedOrders:0},{code:codes[3],stage:'transaction',orders:1,missingOrders:0,partialOrders:0,excludedOrders:0}],recent}};
      window.fixtureCodes=codes;
      currentReportData=fixture;
    });

    const results=[];
    for(const lang of ['ar','en'])for(const width of [1440,390]){
      await page.setViewport({width,height:1000});
      await page.evaluate(({lang})=>{
        currentLang=lang;document.documentElement.dir=lang==='ar'?'rtl':'ltr';document.body.classList.remove('dark-mode');
        window.submitted=[];
        window.openDetailModal=()=>_shopifyActionModal({title:currentLang==='en'?'Cancel order':'\u0625\u0644\u063a\u0627\u0621 \u0627\u0644\u0637\u0644\u0628',message:'',reasonStage:'shopify',confirmLabel:currentLang==='en'?'Cancel order':'\u0625\u0644\u063a\u0627\u0621 \u0627\u0644\u0637\u0644\u0628',confirmColor:'#ef4444',onConfirm:async payload=>submitted.push(payload)});
        openDetailModal();
      },{lang});
      assert.equal(await page.$('#crp-sp-main-step [value="customer-refused-deposit"]'),null);
      await page.click('label[for="crp-sp-r-customer-request"]');
      assert.equal(await page.$eval('#crp-sp-detail-step',el=>el.hidden),false);
      assert.equal(await page.$eval('#crp-sp-main-step',el=>el.hidden),true);
      assert.equal(await page.$$eval('[name="crp-sp-detail"]:checked',els=>els.length),0);
      await page.click('#shopify-action-confirm-btn');
      assert.equal(await page.evaluate(()=>submitted.length),0);
      assert.equal(await page.$eval('#crp-sp-err',el=>el.hidden),false);
      await page.screenshot({path:path.join(__dirname,lang+'-'+width+'-required.png')});
      await page.click('label[for="crp-sp-d-customer-refused-deposit"]');
      assert.equal(await page.$eval('#crp-sp-err',el=>el.hidden),true);
      await page.screenshot({path:path.join(__dirname,lang+'-'+width+'-selected.png')});
      assert.equal(await page.$eval('#shopify-action-modal>div',el=>el.scrollWidth<=el.clientWidth+1),true);
      await page.click('#shopify-action-confirm-btn');
      assert.deepEqual(await page.evaluate(()=>submitted),[{code:'customer-refused-deposit',note:''}]);
      await page.evaluate(()=>openDetailModal());
      await page.click('label[for="crp-sp-r-customer-request"]');
      await page.click('label[for="crp-sp-d-customer-request-other"]');
      await page.click('#shopify-action-confirm-btn');assert.equal(await page.evaluate(()=>submitted.length),1);
      await page.type('#crp-sp-note','abc');await page.click('#shopify-action-confirm-btn');assert.equal(await page.evaluate(()=>submitted.length),1);
      await page.$eval('#crp-sp-note',el=>el.value='Customer is travelling before delivery');
      await page.click('#shopify-action-confirm-btn');assert.deepEqual(await page.evaluate(()=>submitted[1]),{code:'customer-request-other',note:'Customer is travelling before delivery'});
      await page.evaluate(()=>openDetailModal());await page.click('label[for="crp-sp-r-customer-request"]');
      await page.click('label[for="crp-sp-d-customer-price-too-high"]');
      await page.click('.crp-step-head button');
      await page.click('label[for="crp-sp-r-customer-request"]');
      assert.equal(await page.$$eval('[name="crp-sp-detail"]:checked',els=>els.length),0);
      await page.click('.crp-step-head button');await page.click('label[for="crp-sp-r-out-of-stock"]');await page.click('#shopify-action-confirm-btn');
      assert.equal(await page.evaluate(()=>submitted[2].code),'out-of-stock');
      results.push({lang,width,requiredStep:true,leafSaved:true,otherRequiresExplanation:true,noStaleSelection:true});
    }
    await page.evaluate(()=>{
      currentLang='ar';document.documentElement.dir='rtl';
      for(const [prefix,stage] of [['crp-cancel','transaction'],['crp-req','transaction'],['crp-bulk','transaction']]){
        const host=document.createElement('div');host.innerHTML=cancelReasonPickerHtml(stage,{idPrefix:prefix});document.body.appendChild(host);
        const parent=document.getElementById(prefix+'-r-customer-request');parent.checked=true;_crpPick(prefix,parent);
        if(readCancelReason(prefix)!==null)throw Error('Parent bypassed '+prefix);
        const detail=document.getElementById(prefix+'-d-customer-wants-inspection');detail.checked=true;_crpDetailPick(prefix,detail);
        if(readCancelReason(prefix).code!=='customer-wants-inspection')throw Error('Detail missing '+prefix);
        host.remove();
      }
      renderCancellationsReport(fixture);
    });
    await page.setViewport({width:1440,height:1000});
    await page.evaluate(()=>setCxrReason('customer-refused-deposit'));
    assert.match(await page.$eval('#cxr-tbody',el=>el.textContent),/\u0627\u0644\u0639\u0645\u064a\u0644 \u0637\u0644\u0628 \u0627\u0644\u0625\u0644\u063a\u0627\u0621/);
    assert.match(await page.$eval('#cxr-tbody',el=>el.textContent),/\u0639\u0631\u0628\u0648\u0646/);
    await page.screenshot({path:path.join(__dirname,'report-detail-ar.png'),fullPage:true});
    await page.evaluate(()=>setCxrReason('customer-request'));
    assert.match(await page.$eval('#cxr-tbody',el=>el.textContent),/\u0633\u062c\u0644 \u0633\u0627\u0628\u0642/);
    fs.writeFileSync(path.join(__dirname,'checks.json'),JSON.stringify(results,null,2));
    console.log('Passed mandatory detail step, note validation, back/reset, direct/request/bulk pickers and detailed/legacy report rendering.');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
