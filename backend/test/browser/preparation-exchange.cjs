/* Intercepted preparation UI: no server or real inventory writes. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), publicDir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/preparation-exchange');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    for (const [lang, width, dark] of [['ar',1600],['en',1600],['ar',390]]) {
      const page = await browser.newPage(), errors = [];
      await page.setViewport({ width, height: 1000 });
      page.on('pageerror', error => errors.push(error.message));
      await page.evaluateOnNewDocument(() => {
        let n = 0;
        if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => `test-${++n}` });
      });
      await page.setRequestInterception(true);
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin === 'http://soulia.test') {
          const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
          const file = path.resolve(publicDir, relative);
          if (file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
            const contentType = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'image/webp';
            return request.respond({ status: 200, contentType, body: fs.readFileSync(file) });
          }
        }
        if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
        return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
      });
      await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
      console.log(`Loaded ${lang} ${width}`);
      await page.evaluate(language => {
        currentLang = language; document.documentElement.lang = language; document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr'; applyLang();
        currentUser = { _id: 'preview', name: 'Preview', role: 'admin', perms: ['movements','pickup-orders','inventory-units-view','inventory-units-allocate'] };
        qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
        onPageEnter = () => {}; window.scanWrites = [];
        const names = ['Oriva Runner', 'Riva Coaster'];
        const items = names.map((name,i) => ({ lineId: 'line-'+i, productId: 'product-'+i, name, code: 'SKU-'+i, qty: i === 0 ? 2 : 1, price: 150, imageUrl: 'http://soulia.test/empty-shipping.webp' }));
        _pickupOrders = Array.from({length:12}, (_,i) => ({ _id:'order-'+i, ref:String(2916-i), client:i === 0 ? 'Marwa Hazem' : 'Customer '+i,
          phone:'01000000000', type:'مبيعات', date:'2026-10-23', total:3600, remaining:2800, pickupStatus:'Preparing',
          pickupRef:'234-24OCT', prepCreatedAt:'2026-10-24T08:00:00Z', prepCreatedBy:'Fares', shipCo:'Bosta',
          notes:'Please pack the glass items separately.', comments:i===0?[{id:'packing-comment',employee:'Shipping team',text:'Use protective wrapping for the glass tray.',timestamp:'2026-10-24T08:30:00Z'}]:[], items:structuredClone(items) }));
        window.caseReads=0; window.failDetails=false;
        _pickupOrders[0].afterSales={caseId:'222222222222222222222222',kind:'exchange',role:'replacement',caseRef:'AS-2026-000005',originalRef:'2817'};
        window.exchangeCase={_id:'222222222222222222222222',requestKind:'exchange',reason:'defect',reasonDetails:'Inspect the returned pieces',items:structuredClone(items),exchangeItems:structuredClone(items),workflow:{stage:'shipping',quote:{credit:2451.35,replacement:2451.35,customerFee:0,collectDue:0,refundDue:0}}};
        transactions = _pickupOrders; _puOrdersLoaded = true; _puLoadPrepGroups(_pickupOrders);
        window.mockSummaries = Object.fromEntries(_pickupOrders.map(order => [order._id, {lines:items.map(item=>({lineId:item.lineId,productId:item.productId,qty:item.qty,units:[],skippedCount:0}))}]));
        api = async (url, options={}) => {
          if(url==='/after-sales/'+exchangeCase._id){caseReads++;if(failDetails)throw Error('Connection interrupted');if(window.holdDetails)await new Promise(resolve=>window.releaseDetails=resolve);return structuredClone(exchangeCase);}
          if (url.endsWith('/picking')) return structuredClone(mockSummaries[url.split('/')[3]]);
          if (url === '/inventory-units/TEST-PIECE') return {unit:{productId:'product-0',status:'available',version:1}};
          if (url.endsWith('/picking/scans')) {
            const payload = JSON.parse(options.body); scanWrites.push(payload);
            const unit = {unitId:payload.identifier,barcode:payload.identifier,status:'picking',version:1};
            mockSummaries[url.split('/')[3]].lines.find(line=>line.lineId===payload.lineId).units.push(unit);
            return {unit,lineId:payload.lineId,transactionId:url.split('/')[3]};
          }
          if (url === '/transactions/pickup-orders') return structuredClone(_pickupOrders);
          return [];
        };
        navigateTo('pickup-orders'); openPuCardOrdersModal('234-24OCT','prep');
      }, lang);
      await page.waitForFunction(() => !!_pwPickState(_pwSelId).summary, {timeout:5000}).catch(async error => {
        console.log(await page.evaluate(()=>({selected:_pwSelId,group:_pucoGetGroup(),state:_pwPickState(_pwSelId)})),errors);
        throw error;
      });

      await page.waitForSelector('[data-as-preparation-content] .as-prep-difference');
      if(width<860)await page.evaluate(()=>pwSelectOrder(_pwSelId));
      const initial=await page.evaluate(async()=>{
        const section=qs('[data-as-preparation]'),content=section.querySelector('[data-as-preparation-content]');
        let mutations=0;const observer=new MutationObserver(records=>mutations+=records.length);observer.observe(content,{childList:true,subtree:true,characterData:true});
        window.stableSection=section;window.stableContent=content;
        for(let i=0;i<12;i++){_pwRenderWork();await new Promise(resolve=>setTimeout(resolve,100));}
        observer.disconnect();
        return {reads:caseReads,mutations,same:section===qs('[data-as-preparation]'),collapsed:!section.querySelector('details').open};
      });
      assert.deepEqual(initial,{reads:1,mutations:0,same:true,collapsed:true});
      assert.equal(await page.$eval('.as-preparation',node=>node.scrollWidth<=node.clientWidth+1),true);
      await page.screenshot({path:path.join(output,'compact-'+lang+'-'+width+'.png')});
      await page.evaluate(()=>{qs('.as-prep-more').open=true;_pwRenderWork();});
      assert.equal(await page.$eval('.as-prep-more',node=>node.open),true,'expansion survives workspace updates');
      await page.evaluate(async()=>{exchangeCase.workflow.quote.collectDue=50;await AfterSales.changed(exchangeCase._id);});
      await page.waitForFunction(()=>document.querySelector('.as-prep-difference').textContent.includes('50'));
      assert.equal(await page.evaluate(()=>caseReads),2,'one fresh read on a real case event');
      assert.equal(await page.$eval('.as-prep-more',node=>node.open),true);
      await page.evaluate(async()=>{failDetails=true;await AfterSales.changed(exchangeCase._id);});
      await page.waitForSelector('[data-as-retry]');
      await page.evaluate(()=>{for(let i=0;i<10;i++)_pwRenderWork();});
      assert.equal(await page.evaluate(()=>caseReads),3,'errors do not create an automatic retry loop');
      assert.match(await page.$eval('.as-prep-difference',node=>node.textContent),/50/,'last known details stay visible on error');
      await page.evaluate(()=>{failDetails=false;qs('[data-as-retry]').click();});
      await page.waitForFunction(()=>!document.querySelector('[data-as-load-error]'));
      assert.equal(await page.evaluate(()=>caseReads),4);
      await page.evaluate(()=>{holdDetails=true;releaseDetails=null;void AfterSales.changed(exchangeCase._id);});
      await page.waitForFunction(()=>typeof releaseDetails==='function');
      await page.evaluate(()=>{for(let i=0;i<8;i++){void AfterSales.changed(exchangeCase._id);_pwRenderWork();}holdDetails=false;releaseDetails();});
      await page.waitForFunction(()=>caseReads===6);
      await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,100)));
      assert.equal(await page.evaluate(()=>caseReads),6,'events during a request coalesce into one follow-up read');
      await page.evaluate(()=>pwSelectOrder('order-1'));
      assert.equal(await page.$('[data-as-preparation]'),null,'another order cannot inherit the previous case');
      await page.evaluate(()=>pwSelectOrder('order-0'));
      await page.waitForSelector('[data-as-preparation-content] .as-prep-difference');
      assert.equal(await page.evaluate(()=>caseReads),7,'returning to the order reads fresh data');
      await page.evaluate(()=>AfterSales.refreshPreparationDetails());
      assert.equal(await page.evaluate(()=>caseReads),8,'explicit refresh still reads current data');
      await page.evaluate(()=>{currentLang=currentLang==='ar'?'en':'ar';_pwRenderWork();});
      await page.waitForFunction(()=>caseReads===9);
      await page.waitForSelector('[data-as-preparation-content] .as-prep-difference');
      assert.equal(await page.evaluate(()=>stableSection===qs('[data-as-preparation]')),false,'language changes recreate the translated section');
      assert.deepEqual(errors,[]);
      console.log('PASS '+lang+'/'+width+': stable details, bounded reads, collapsed summary, update events and retry');
      await page.close();
    }
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
