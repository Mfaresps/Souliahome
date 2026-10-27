/* Intercepted preparation UI: no server or real inventory writes. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), publicDir = path.join(root, 'frontend/public');
const output = path.join(root, 'artifacts/preparation-workspace');
fs.mkdirSync(output, { recursive: true });
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    for (const [lang, width, dark] of [['en', 1600], ['ar', 1600], ['en', 1024], ['ar', 390], ['en',1600,true], ['ar',390,true]]) {
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
        const names = ['Woven tissue box', 'Riva dining bowl', 'Glass serving tray', 'Cotton basket', 'Ceramic mug', 'Wooden coaster'];
        const items = names.map((name,i) => ({ lineId: 'line-'+i, productId: 'product-'+i, name, code: 'SKU-'+i, qty: i === 0 ? 4 : i + 1, price: 150, imageUrl: 'http://soulia.test/empty-shipping.webp' }));
        _pickupOrders = Array.from({length:12}, (_,i) => ({ _id:'order-'+i, ref:String(2916-i), client:i === 0 ? 'Marwa Hazem' : 'Customer '+i,
          phone:'01000000000', type:'مبيعات', date:'2026-10-23', total:3600, remaining:2800, pickupStatus:'Preparing',
          pickupRef:'234-24OCT', prepCreatedAt:'2026-10-24T08:00:00Z', prepCreatedBy:'Fares', shipCo:'Bosta',
          notes:'Please pack the glass items separately.', comments:i===0?[{id:'packing-comment',employee:'Shipping team',text:'Use protective wrapping for the glass tray.',timestamp:'2026-10-24T08:30:00Z'}]:[], items:structuredClone(items) }));
        transactions = _pickupOrders; _puOrdersLoaded = true; _puLoadPrepGroups(_pickupOrders);
        window.mockSummaries = Object.fromEntries(_pickupOrders.map(order => [order._id, {lines:items.map(item=>({lineId:item.lineId,productId:item.productId,qty:item.qty,units:[],skippedCount:0}))}]));
        api = async (url, options={}) => {
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
      await page.evaluate(isDark=>document.body.classList.toggle('dark-mode',!!isDark),dark);
      await page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,220)));
      const themeColors=await page.evaluate(()=>{
        const root=qs('#pu-card-orders-modal'),probe=document.createElement('span');root.append(probe);
        probe.style.color='var(--accent)';const accent=getComputedStyle(probe).color;
        probe.style.color='var(--primary)';const primary=getComputedStyle(probe).color;probe.remove();
        return {accent,primary,selected:getComputedStyle(qs('.pw-ocard.is-sel')).borderTopColor,
          prepare:getComputedStyle(qs('.pw-head-tick')).color,send:getComputedStyle(qs('.pw-cmt-send')).backgroundColor};
      });
      assert.equal(themeColors.selected,themeColors.accent,'Selection follows the system green accent');
      const actualGreen=themeColors.prepare.match(/\d+/g).map(Number),expectedGreen=themeColors.accent.match(/\d+/g).map(Number);
      assert.ok(actualGreen.every((value,i)=>Math.abs(value-expectedGreen[i])<=2),'Prepare action follows the system green accent');
      assert.equal(themeColors.send,themeColors.primary,'Primary buttons use the system primary green');
      if (width < 860) await page.evaluate(() => pwSelectOrder(_pwSelId));
      const preservation = await page.evaluate(() => {
        const photo = qs('#pw-work .pw-item-pic'), image = photo.querySelector('img'), draft = qs('#pw-work .pw-cmt-input');
        const items = qs('#pw-work .pw-items-wrap'); items.scrollTop = 80;
        const scroll = items.scrollTop;
        draft.value = 'Keep this packing instruction'; draft.focus();
        const state = _pwPickState(_pwSelId); state.feedback = {pending:true,text:'Checking the piece'};
        const start = performance.now();
        for (let i=0;i<12;i++) _pwRenderWork();
        const result = {elapsed:performance.now()-start,photo:photo===qs('#pw-work .pw-item-pic'),image:image===qs('#pw-work .pw-item-pic img'),
          draft:draft===document.activeElement&&draft.value==='Keep this packing instruction',scroll:scroll===items.scrollTop,hasImage:!!image};
        draft.value = ''; state.feedback = null; _pwRenderWork(); qs('#pw-work').focus();
        return result;
      });
      assert.ok(preservation.photo && preservation.image && preservation.hasImage && preservation.draft && preservation.scroll, JSON.stringify(preservation));
      assert.equal(await page.$$eval('#pw-work .pw-item', items=>items.length),6);
      assert.equal(await page.$$eval('#pw-work .pw-next-label', nodes=>nodes.length),1);
      assert.equal(await page.$eval('.pw-shipping-notes-alert>bdi',node=>node.textContent),'1','Callout counts internal comments only');
      await page.click('.pw-shipping-notes-alert');
      assert.equal(await page.evaluate(()=>document.activeElement.matches('.pw-note.has-comments')),true,'Callout focuses internal comments');
      assert.equal(await page.$eval('.pw-note.is-order',node=>getComputedStyle(node).borderInlineStartWidth),'1px','Customer note has no highlighted rail');
      assert.equal(await page.$$eval('.pw-ocard[data-order-id="order-1"] .is-notes',nodes=>nodes.length),0,'Customer note alone does not trigger a highlighted badge');
      const liveNotes = await page.evaluate(()=>{
        const order=_pucoGetGroup().orders.find(o=>o._id===_pwSelId);
        order.comments.push({id:'second-comment',employee:'Shipping team',text:'Keep the labels visible.',timestamp:'2026-10-24T09:00:00Z'});
        _pwRefreshThread(order);
        return {callout:qs('.pw-shipping-notes-alert>bdi').textContent,nav:qs('.pw-ocard.is-sel [data-pw-cmt-n]').textContent,
          latest:qs('.pw-cmt.is-latest').textContent};
      });
      assert.equal(liveNotes.callout,'2');assert.equal(liveNotes.nav,'2');
      assert.ok(liveNotes.latest.includes('Keep the labels visible.'));
      const layout = await page.evaluate(() => {
        const shell=qs('.pw-shell'),wrap=qs('#pw-work .pw-items-wrap'),rect=wrap.getBoundingClientRect();
        return {fits:shell.scrollWidth<=shell.clientWidth+1&&wrap.scrollWidth<=wrap.clientWidth+1,visible:rect.height, overview:qs('.pw-scan-overview').textContent,
          nav:getComputedStyle(qs('.pw-nav')).backgroundColor,canvas:getComputedStyle(wrap).backgroundColor,
          product:getComputedStyle(qs('#pw-work .pw-item')).backgroundColor};
      });
      assert.ok(layout.fits, 'Workspace fits '+lang+' '+width);
      assert.notEqual(layout.nav,layout.canvas,'Order list has a distinct neutral surface');
      assert.notEqual(layout.product,layout.canvas,'Product cards stand apart from the canvas');
      assert.ok(layout.visible>160, 'Product canvas stays usable '+JSON.stringify(layout));
      await page.evaluate(()=>{qs('#pw-work .pw-side').scrollTop=0;qs('#pw-work .pw-items-wrap').scrollTop=0;});
      await page.screenshot({path:path.join(output,`preparation-${lang}-${width}${dark?'-dark':''}.png`)});
      await page.evaluate(async () => { await _pwSubmitScan(_pwSelId,'TEST-PIECE'); });
      await page.waitForFunction(() => qs('.pw-scan-overview>span:nth-child(2)>b').textContent === '1');
      assert.equal(await page.evaluate(()=>scanWrites.length),1,'One physical piece writes once');
      assert.equal(await page.$$eval('.pw-piece-dots .matched',nodes=>nodes.length),1);
      await page.evaluate(async () => { await _pwSubmitScan(_pwSelId,'TEST-PIECE'); });
      assert.equal(await page.evaluate(()=>scanWrites.length),1,'Duplicate never writes another piece');
      await page.click('.pw-manual-toggle'); await page.type('#pw-order-scan','typed-draft');
      assert.equal(await page.evaluate(()=>{_pwRenderWork();return qs('#pw-order-scan')===document.activeElement&&qs('#pw-order-scan').value==='typed-draft';}),true);
      const afterSales = await page.evaluate(async () => {
        const result=[];
        const originalApi=api, originalOpen=window.open;
        try {
          for(const kind of ['exchange','return']) {
            const order=_pickupOrders[0];
            order.afterSales={caseId:'case-'+kind,caseRef:'AS-1',kind,role:kind==='exchange'?'replacement':'return',originalRef:'2790'};
            const row={_id:order.afterSales.caseId,requestKind:kind,originalRef:'2790',client:'Test customer',reason:'customer-choice',items:[{name:'Returned basket',code:'OLD',qty:1,price:100}],exchangeItems:[{name:'Replacement basket',code:'NEW',qty:2,price:100}],workflow:{ref:'AS-1',stage:'approved',quote:{credit:100,replacement:200,customerFee:0,collectDue:kind==='exchange'?100:0,refundDue:kind==='return'?100:0}}};
            api=async url=>url.startsWith('/after-sales/')?row:originalApi(url);
            const holder=document.createElement('div');
            holder.innerHTML=_pwOrderCardHtml(order,true,false);
            const intact=holder.children.length===1&&holder.firstElementChild.querySelector('.pw-oc-name')?.textContent===order.client&&!holder.querySelector('button button');
            pwSelectOrder(order._id);
            await AfterSales.loadPreparationDetails(qs('#pw-work'));
            const content=qs('[data-as-preparation-content]').textContent;
            const frame=document.createElement('iframe');document.body.append(frame);
            let printed=false;
            window.open=()=>({document:frame.contentDocument,closed:false,focus(){},print(){printed=true;},requestAnimationFrame(fn){fn();}});
            await AfterSales.printOrderCase(row._id);
            result.push({kind,intact,returned:content.includes('Returned basket'),replacement:content.includes('Replacement basket'),printed,printItems:frame.contentDocument.body.textContent.includes('Returned basket')});
            frame.remove();
          }
        } finally {api=originalApi;window.open=originalOpen;}
        return result;
      });
      for(const row of afterSales) {
        assert.equal(row.intact,true,'After-sales badge must not break the order button');
        assert.equal(row.returned,true);
        assert.equal(row.replacement,row.kind==='exchange');
        assert.equal(row.printed,true);
        assert.equal(row.printItems,true);
      }
      assert.deepEqual(errors,[]);
      console.log(`PASS ${lang} ${width}px: retained photos/draft/focus/scroll; 12 UI updates ${Math.round(preservation.elapsed)}ms; scan and duplicate checks.`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
