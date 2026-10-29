/* Shipped day groups, pickup request badges and order cards against shipped HTML.
 * All requests are intercepted; no shipment or pickup is created.
 */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), publicDir = path.join(root, 'frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const output = path.join(root, 'artifacts/pickup-refresh-stability');
fs.mkdirSync(output, { recursive: true });
const settle = () => new Promise(resolve => setTimeout(resolve, 350));
async function assertStableRefresh(page, selector, table = false) {
  const result = await page.evaluate(async ({ selector, table }) => {
    const host = qs(selector), card = host.querySelector('[data-daily-order="b"]');
    const details = card.querySelector('details'), button = card.querySelector('[data-daily-invoice]');
    details.open = true;
    button.focus();
    const scroll = [];
    for (let el = host; el; el = el.parentElement) {
      if (el.scrollHeight > el.clientHeight) el.scrollTop = Math.min(120, el.scrollHeight - el.clientHeight);
      scroll.push([el, el.scrollTop]);
    }
    const observer = new MutationObserver(() => {});
    observer.observe(host, { childList: true, subtree: true, attributes: true, characterData: true });
    for (let i = 0; i < 5; i++) _puPaintCurrentView();
    const unchangedMutations = observer.takeRecords().length;
    observer.disconnect();
    if (table) {
      // Exercise the snapshot refresh separately from the carrier-sync fixture.
      const secondaryAt = _puSecondaryAt;
      _puSecondaryAt = Date.now();
      try { await loadPickupOrders({ background: true }); }
      finally { _puSecondaryAt = secondaryAt; }
    }
    const stableSnapshot = card.isConnected && details.open && document.activeElement === button &&
      scroll.every(([el, top]) => el.scrollTop === top);
    const original = structuredClone(_pickupOrders.find(o => o._id === 'b'));
    _puMergeLiveTransaction({ ...original, total: 4321, client: 'Live updated customer', bostaStatus: 'DELIVERED' });
    await new Promise(resolve => setTimeout(resolve, 120));
    const liveUpdated = card.isConnected && details.open && document.activeElement === button &&
      card.textContent.includes('Live updated customer') && /4,321|4٬321|4321/.test(card.textContent);
    if (table) {
      _pickupOrders.unshift({ ...original, _id: 'live-new-day', pickupRef: 'NEW-DAY',
        shipmentEvents: [{ type: 'sent', at: '2026-10-26T08:00:00Z' }] });
      _pickupOrders.reverse();
      _puPaintCurrentView();
    }
    const stableReorder = card.isConnected && details.open && document.activeElement === button &&
      (!table || card.closest('.pu-detail-row').style.display !== 'none');
    // Rebinding after each paint must still invoke an action exactly once.
    const saved = table ? showInvoiceDetail : pucoShowInvoice;
    let calls = 0;
    if (table) showInvoiceDetail = () => calls++;
    else pucoShowInvoice = () => calls++;
    button.click();
    if (table) showInvoiceDetail = saved;
    else pucoShowInvoice = saved;
    _pickupOrders = _pickupOrders.filter(o => o._id !== 'live-new-day');
    if (table) _pickupOrders.reverse();
    _puMergeLiveTransaction(original);
    await new Promise(resolve => setTimeout(resolve, 120));
    return { unchangedMutations, stableSnapshot, liveUpdated, stableReorder, calls };
  }, { selector, table });
  assert.deepEqual(result, { unchangedMutations: 0, stableSnapshot: true, liveUpdated: true, stableReorder: true, calls: 1 },
    'Refresh preserves DOM, expanded products, focus and scroll while applying live changes: ' + selector);
}
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(()=>{
      // The intercepted HTTP test origin lacks secure-context randomUUID.
      let sequence=0;
      if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>String(++sequence).padStart(8,'0')+'-0000-4000-8000-000000000000'});
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'http://soulia.test' && url.pathname === '/') return request.respond({ status: 200, contentType: 'text/html', body: html });
      if (['/order-status.js','/order-status.css','/pickup-daily-shipping.js','/pickup-daily-shipping.css','/pickup-workspace.css','/awb-preview.js','/awb-preview.css','/pickup-ready-return.js','/pickup-ready-return.css','/bosta-pickup.js','/bosta-pickup.css','/shopify-edit-approvals.js'].includes(url.pathname)) {
        return request.respond({ status: 200, contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: fs.readFileSync(path.join(publicDir, url.pathname.slice(1))) });
      }
      if (request.resourceType() === 'script') return request.respond({ status: 200, contentType: 'text/javascript', body: 'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      currentUser = { _id: 'employee', role: 'staff', perms: ['movements','pickup-orders','pickup-orders-edit'] }; currentLang = 'ar';
      document.documentElement.lang = 'ar'; document.documentElement.dir = 'rtl';
      qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      onPageEnter = () => {}; window.writes = [];
      api = async (url, options = {}) => { if (options.method && options.method !== 'GET') writes.push(url); return url === '/transactions/pickup-orders' ? structuredClone(_pickupOrders) : []; };
      const make = (id, status, at, extras = {}) => ({ _id: id, ref: id === 'a' ? '2913' : id === 'b' ? '2914' : '2915',
        client: id === 'a' ? 'Lobna Abdelaziz' : id === 'b' ? 'Suzan Atef' : 'Marwa Hazem', phone: '01000000000',
        shipCo: 'Bosta', type: 'مبيعات', total: 2180, remaining: 1680, payStatus: 'معلق', date: '2026-09-01',
        items: [{ name: 'Oriva Dining Set', code: 'OR1', qty: 1, price: 2180 }],
        pickupStatus: status === 'DELIVERED' ? 'Delivered' : status === 'CREATED' ? 'Ready' : 'Shipped',
        bostaOrderId: 'b-' + id, bostaTrackingNumber: 'B-291' + id, bostaStatus: status, pickupRef: 'OLD-' + id,
        shipmentEvents: [{ type: 'sent', at, bostaOrderId: 'b-' + id }], ...extras });
      _pickupOrders = [make('a', 'CREATED', '2026-10-21T08:00:00Z'), make('b', 'IN_TRANSIT', '2026-10-21T10:00:00Z'),
        make('c', 'DELIVERED', '2026-10-21T11:00:00Z'), make('d', 'CREATED', '2026-10-22T08:00:00Z'),
        make('unregistered', '', '', { bostaOrderId: '', bostaTrackingNumber: '', shipmentEvents: [], pickupStatus: 'Ready', pickupRef: 'READY-OLD', pickupDate: '2026-10-20' })];
      transactions = _pickupOrders.map(row => ({ ...row })); _puPrepGroups = []; _puOrdersLoaded = true;
      _bpSetRequests([{ status: 'created', orderIds: ['a','b'], scheduledDate: '2026-10-22', requestedBy: 'Employee' },
        { status: 'pending', orderIds: ['c'], scheduledDate: '2026-10-22' }]);
      navigateTo('pickup-orders'); puSwitchView('board');
    });
    for (const width of [1600, 390]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
      await page.evaluate(() => {
        window.cardPreviewSaved = {orders:_pickupOrders,groups:_puPrepGroups};
        const base=_pickupOrders[0];
        const make=(id,status,ref,extras={})=>({...base,_id:id,ref:id,pickupStatus:status,pickupRef:ref,
          bostaOrderId:'',bostaTrackingNumber:'',bostaStatus:'',shipmentEvents:[],...extras});
        const prep=Array.from({length:30},(_,i)=>make('prep-'+i,'Preparing','234-24OCT',{
          total:i===0?2098:1800,prepChecked:i<27,prepCreatedBy:'Fares',prepCreatedAt:'2026-10-24T08:00:00Z',
          prepNote:'Priority group',shipCo:'Bosta',
        }));
        const ready=Array.from({length:3},(_,i)=>make('ready-'+i,'Ready','105-22OCT',{
          total:2180,prepChecked:true,pickupDate:'2026-10-23',pickupBy:'Fares',bostaOrderId:'ready-bosta-'+i,bostaStatus:'CREATED',
          shipmentEvents:[{type:'sent',at:'2026-10-23T08:00:00Z'}],
        }));
        const shipped=Array.from({length:6},(_,i)=>make('shipped-'+i,'Shipped','SH-2026-10-21',{
          total:1200,bostaOrderId:'shipped-bosta-'+i,bostaStatus:i<4?'DELIVERED':'IN_TRANSIT',
          shipmentEvents:[{type:'sent',at:'2026-10-21T08:00:00Z'}],
        }));
        _pickupOrders=[...prep,...ready,...shipped];
        currentUser={...currentUser,role:'admin'};
        _puLoadPrepGroups(_pickupOrders); puSwitchView('board'); renderPickupBoard();
      });
      await settle();
      const stageSelectors={preparing:'#pu-prep-col .pu-stage-preparing',ready:'#pu-ready-col .pu-stage-ready',shipped:'#pu-shipped-col .pu-stage-shipped'};
      for (const role of ['admin', 'staff', 'manager', 'viewer', 'staff', 'admin']) {
        const allowed = role === 'admin' || role === 'manager';
        const visibility = await page.evaluate(role => {
          currentUser = { ...currentUser, role };
          puSwitchView('board'); renderPickupBoard();
          const cards = ['#pu-prep-col', '#pu-ready-col', '#pu-shipped-col'].map(selector =>
            !!qs(selector + ' .pu-group-total'));
          const amounts = ['pu-pending-col-amt', 'pu-prep-col-amt', 'pu-ready-col-amt', 'pu-shipped-col-amt',
            'bkpi-pending-amt', 'bkpi-prep-amt', 'bkpi-ready-amt', 'bkpi-delivered-amt'].map(id => {
              const el = qs('#' + id);
              return { hidden: el.hidden, empty: el.textContent === '' };
            });
          _puShowQuickTip(qs('#pu-prep-col .pu-group-header'), _puPrepGroups[0]);
          const tipTotal = _puTipEl.textContent.includes(t('puQuickTipValue'));
          _puHideQuickTip();
          puSwitchView('table'); renderPickupRuns();
          const headerHidden = qs('#pu-runs-table thead [data-i18n="total"]').hidden;
          const totals = qsa('#pu-runs-body > .pu-run-row').map(row => ({
            hidden: row.cells[6].hidden, empty: row.cells[6].textContent === '',
          }));
          puSwitchView('board'); renderPickupBoard();
          return { cards, amounts, tipTotal, headerHidden, totals };
        }, role);
        assert.ok(visibility.cards.every(value => value === allowed), role + ': group cards');
        assert.ok(visibility.amounts.every(value => value.hidden === !allowed && value.empty === !allowed), role + ': column and KPI totals');
        assert.equal(visibility.tipTotal, allowed, role + ': tooltip total');
        assert.equal(visibility.headerHidden, !allowed, role + ': table header');
        assert.ok(visibility.totals.length > 0 && visibility.totals.every(value => value.hidden === !allowed && value.empty === !allowed), role + ': table totals');
      }
      await page.focus('#pu-actions-trigger'); await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(()=>document.activeElement===qs('#pu-actions-menu button')),true,'ArrowDown opens Actions and focuses the first option');
      const actionBounds=await page.$eval('.pu-actions-options',menu=>{
        const rect=menu.getBoundingClientRect();return {left:rect.left,right:rect.right,width:innerWidth};
      });
      assert.ok(actionBounds.left>=0&&actionBounds.right<=actionBounds.width,'Actions menu fits the viewport: '+JSON.stringify(actionBounds));
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#pu-actions-menu',menu=>menu.open),false);
      assert.equal(await page.evaluate(()=>document.activeElement.id),'pu-actions-trigger');
      const menuActions=await page.evaluate(()=>{
        const names=['exportPickupExcel','openPickupBulkModal','openPrepGroupModal','openCreatePickupModal'];
        const originals=names.map(name=>window[name]),called=[];
        names.forEach(name=>{window[name]=()=>called.push(name);});
        const menu=qs('#pu-actions-menu');
        const closed=[...menu.querySelectorAll('button')].map(button=>{menu.open=true;button.click();return !menu.open;});
        names.forEach((name,i)=>{window[name]=originals[i];});return {called,closed};
      });
      assert.deepEqual(menuActions.called,['exportPickupExcel','openPickupBulkModal','openPrepGroupModal','openCreatePickupModal']);
      assert.ok(menuActions.closed.every(Boolean),'Every option closes Actions before running');
      await page.$eval('#pu-date-filter>summary',summary=>summary.click());
      const calendar = await page.$eval('#pu-date-filter .pu-date-popover',popover=>{
        const rect=popover.getBoundingClientRect();
        return {visible:rect.height>0,fits:rect.left>=0&&rect.right<=innerWidth};
      });
      assert.ok(calendar.visible&&calendar.fits,'Calendar popover fits viewport');
      await page.focus('#pu-board-date-from'); await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#pu-date-filter',details=>details.open),false,'Escape closes calendar');
      const calendarCount = await page.evaluate(()=>{
        qs('#pu-board-date-from').value='2026-10-24';_puApplyFilters();
        const count=qs('#pu-date-filter-count').textContent;
        clearBoardFilters();return count;
      });
      assert.equal(calendarCount,'1');
      assert.equal(await page.$eval('#pu-date-filter-count',badge=>badge.hidden),true,'Clear resets calendar badge');
      const syncState=await page.evaluate(async()=>{
        const original=_puSyncShippedBostaStatuses;let finish,calls=0;
        _puSyncShippedBostaStatuses=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
        const task=_puManualSyncBostaStatuses(),button=qs('#pu-sync-bosta-btn');
        const busy=button.disabled&&button.getAttribute('aria-busy')==='true';
        await _puManualSyncBostaStatuses();finish();await task;
        _puSyncShippedBostaStatuses=original;
        return {busy,calls,restored:!button.disabled&&!button.hasAttribute('aria-busy')};
      });
      assert.deepEqual(syncState,{busy:true,calls:1,restored:true},'Icon sync remains accessible and prevents duplicate requests');
      assert.match(await page.$eval('#pu-ready-pickup-count', node => node.textContent), /3/, 'Pickup footer counts orders across the Ready group');
      const filteredPickupCount = await page.evaluate(() => {
        qs('#pu-ready-search').value = 'no-matching-ready-order'; renderPickupBoard();
        const text = qs('#pu-ready-pickup-count').textContent;
        qs('#pu-ready-search').value = ''; renderPickupBoard();
        return text;
      });
      assert.match(filteredPickupCount, /3/, 'Pickup footer keeps the full Ready total when search hides the cards');
      const columnSearchLayout = await page.$$eval('#page-pickup-orders .pu-board-col-search input', inputs => inputs.map(input => {
        const rect = input.getBoundingClientRect();
        return { top: rect.top, height: rect.height, fits: input.scrollWidth <= input.clientWidth + 1 };
      }));
      assert.equal(columnSearchLayout.length, 4);
      assert.ok(columnSearchLayout.every(input => input.height === 36 && input.fits), 'All four search fields share one compact size');
      if (width === 1600) assert.ok(columnSearchLayout.every(input => Math.abs(input.top - columnSearchLayout[0].top) < 1), 'All four column search fields align');
      const beforeCards=await page.$$eval('#page-pickup-orders .pu-stage-card',cards=>cards.map(card=>({text:card.textContent,height:card.getBoundingClientRect().height})));
      assert.equal(beforeCards.length,3);
      assert.equal(await page.$$eval('#page-pickup-orders .pu-prep-countdown',nodes=>nodes.length),0);
      for (const [stage,selector] of Object.entries(stageSelectors)) {
        const card=await page.$(selector); assert.ok(card,stage+' card exists');
        const layout=await card.evaluate(el=>({fits:el.scrollWidth<=el.clientWidth+1,height:el.getBoundingClientRect().height,
          accent:getComputedStyle(el.querySelector('.pu-group-accent')).height}));
        assert.equal(layout.fits,true,stage+' card fits'); assert.equal(layout.accent,'3px');
        assert.ok(layout.height<330,stage+' card stays compact');
        await card.screenshot({path:path.join(output,`group-${stage}-${width}.png`)});
      }
      await new Promise(resolve=>setTimeout(resolve,1200));
      const afterCards=await page.$$eval('#page-pickup-orders .pu-stage-card',cards=>cards.map(card=>({text:card.textContent,height:card.getBoundingClientRect().height})));
      assert.deepEqual(afterCards.map(card=>card.text),beforeCards.map(card=>card.text),'No blinking countdown');
      afterCards.forEach((card,i)=>assert.ok(Math.abs(card.height-beforeCards[i].height)<1,'No layout jumps'));
      assert.equal(await page.$eval('#pu-prep-col [role="progressbar"]',el=>el.getAttribute('aria-valuenow')),'27');
      await page.evaluate(()=>{
        const group=_puPrepGroups[0]; group.orders[27].prepChecked=true; _puUpdatePrepGroupProgress(group.prepRef);
      });
      assert.equal(await page.$eval('#pu-prep-col [role="progressbar"]',el=>el.getAttribute('aria-valuenow')),'28');
      assert.match(await page.$eval('#pu-prep-col .pu-prep-move',el=>el.textContent),/28/);
      await page.evaluate(()=>{
        window.undoAttentionApi=api;
        const summary={prepChecked:true,lines:[{lineId:'attention-line',qty:1,units:[{unitId:'attention-piece',status:'prepared',barcode:'SCANNED-1',version:1}]}]};
        api=async(url,options)=>url==='/inventory-units/orders/prep-0/picking'?structuredClone(summary):undoAttentionApi(url,options);
        const order=_pickupOrders.find(row=>row._id==='prep-0');order.items[0].lineId='attention-line';
        _pwBarcodePickStates.delete('prep-0');Object.assign(_pwPickState('prep-0'),{summary,attempted:true});
        openPuCardOrdersModal('234-24OCT','prep');pwSelectOrder('prep-0');
      });
      await page.waitForSelector('#pw-work [data-undo-scan]',{visible:true});
      assert.equal(await page.$('#pw-work .pw-undo-scan-dot'),null);
      await page.click('#puco-tick-wrap-prep-0');
      await page.waitForSelector('#pw-work .pw-undo-scan-dot',{visible:true});
      assert.equal(await page.$eval('#pw-work [data-undo-scan]',el=>el.classList.contains('is-attention')),true);
      assert.equal(await page.$eval('#puco-tick-wrap-prep-0',el=>el.getAttribute('aria-pressed')),'true');
      assert.deepEqual(await page.evaluate(()=>writes),[],'Guiding to Undo does not reset preparation or piece identity');
      await page.screenshot({path:path.join(output,`undo-scan-attention-${width}.png`)});
      await page.evaluate(()=>{closePuCardOrdersModal();api=undoAttentionApi;delete window.undoAttentionApi;});
      await settle();
      await page.evaluate(()=>{
        window.manualReviewMocks={api,offer:_bsfMaybeOffer};window.manualReviewCalls=[];window.manualReviewOffers=[];
        const order=_pickupOrders.find(row=>row._id==='prep-29');order.items=order.items.map(item=>({...item,lineId:'manual-line'}));
        window.manualReviewSummary={prepChecked:false,lines:[{lineId:'manual-line',qty:1,units:[],skippedCount:0,exceptions:[]}]};
        api=async(url,options)=>{
          if(url==='/inventory-units/orders/prep-29/picking')return structuredClone(manualReviewSummary);
          if(url==='/inventory-units/orders/prep-29/picking/exceptions'){
            manualReviewCalls.push(url);
            return new Promise(resolve=>{window.finishManualReviewSave=()=>{
              manualReviewSummary.lines[0].skippedCount=1;manualReviewSummary.lines[0].exceptions=[{id:'manual-exception',active:true}];
              resolve({prepChecked:false});
            };});
          }
          if(url==='/transactions/pickup-orders/prep-29/prep-check'){
            manualReviewCalls.push(url);manualReviewSummary.prepChecked=JSON.parse(options.body).prepChecked;
            return {ok:true,updated:1};
          }
          return manualReviewMocks.api(url,options);
        };
        _bsfMaybeOffer=async order=>{manualReviewOffers.push(order._id);return false;};
        _pwBarcodePickStates.delete('prep-29');Object.assign(_pwPickState('prep-29'),{summary:structuredClone(manualReviewSummary),attempted:true});
        openPuCardOrdersModal('234-24OCT','prep');pwSelectOrder('prep-29');
      });
      const orderBeforeManual=await page.$$eval('#puco-orders-list .pw-ocard',nodes=>nodes.map(el=>el.dataset.orderId));
      await page.waitForSelector('#pw-work .pw-skip-actions button',{visible:true});
      await settle();
      await page.click('#pw-work .pw-skip-actions button');
      await page.waitForFunction(()=>typeof window.finishManualReviewSave==='function',{timeout:5000});
      await page.waitForSelector('#pw-work .pw-scan-feedback.is-pending',{visible:true,timeout:5000});
      await page.evaluate(()=>finishManualReviewSave());
      await page.waitForSelector('#pw-work .is-manual-review',{visible:true});
      assert.equal(await page.evaluate(()=>_pwSelId),'prep-29');
      assert.equal(await page.$eval('#puco-tick-wrap-prep-29',el=>el.getAttribute('aria-pressed')),'false');
      assert.deepEqual(await page.$$eval('#puco-orders-list .pw-ocard',nodes=>nodes.map(el=>el.dataset.orderId)),orderBeforeManual,'Manual preparation does not reorder the list');
      assert.equal(await page.evaluate(()=>manualReviewCalls.length),1,'Only the piece exception was recorded');
      assert.deepEqual(await page.evaluate(()=>manualReviewOffers),[],'Shipping is not offered before approval');
      await page.screenshot({path:path.join(output,`prepare-without-scan-review-${width}.png`)});
      await page.click('#puco-tick-wrap-prep-29');
      await page.waitForFunction(()=>manualReviewSummary.prepChecked&&manualReviewOffers.length===1);
      assert.equal(await page.$eval('#puco-tick-wrap-prep-29',el=>el.getAttribute('aria-pressed')),'true');
      assert.equal(await page.evaluate(()=>manualReviewCalls.length),2,'Approval requires a separate explicit click');
      await page.evaluate(()=>{closePuCardOrdersModal();api=manualReviewMocks.api;_bsfMaybeOffer=manualReviewMocks.offer;delete window.manualReviewMocks;});
      await settle();
      await page.evaluate(()=>{qs('#pu-prep-col').scrollIntoView({block:'start'});});
      await page.screenshot({path:path.join(output,`group-board-${width}.png`)});
      await page.evaluate(()=>{
        _puPrepGroups.push({prepRef:'SECOND-PREP',note:'Second preparation group',orders:[{_id:'temp-prep',pickupStatus:'Preparing'}]});
        openPuCardOrdersModal('105-22OCT','ready');
      });
      if(width<700)await page.evaluate(()=>pwSelectOrder(_pwSelId));
      await page.waitForSelector('#pw-work [data-return-mode="preparing"]',{visible:true});
      assert.equal(await page.$$eval('#pw-work [data-ready-return]',nodes=>nodes.length),2,'Ready order has both return choices');
      await page.click('#pw-work [data-return-mode="preparing"]');
      await page.waitForSelector('#pu-return-prep-select');
      assert.equal(await page.$eval('#pu-return-target [data-return-confirm]',el=>el.disabled),true,'Multiple groups require an explicit selection');
      const destinations=await page.$$eval('#pu-return-prep-select option',nodes=>nodes.map(el=>el.value));
      assert.ok(destinations.includes('234-24OCT'));assert.ok(destinations.includes('SECOND-PREP'));
      await page.select('#pu-return-prep-select','SECOND-PREP');
      assert.equal(await page.$eval('#pu-return-target [data-return-confirm]',el=>el.disabled),false);
      assert.equal(await page.$eval('#pu-return-target>section',el=>el.scrollWidth<=el.clientWidth+1),true);
      await page.screenshot({path:path.join(output,`ready-return-target-${width}.png`)});
      await page.click('#pu-return-target [data-return-cancel]');
      await page.waitForFunction(()=>!qs('#pu-return-target')&&!qs('#pw-work [data-return-mode="pending"]').disabled);
      for(const groupCount of [1,0]){
        await page.evaluate(count=>{
          window.returnChoiceResult=null;
          _puChooseReturnPrepGroup(_pickupOrders.find(order=>order.pickupStatus==='Ready'),_puPrepGroups.slice(0,count)).then(result=>{window.returnChoiceResult=result;});
        },groupCount);
        await page.waitForSelector('#pu-return-target [data-return-create]',{visible:true});
        assert.equal(await page.$eval('#pu-return-prep-select',el=>[...el.options].some(option=>option.value==='__new__')),true,'New group is available even with one existing group');
        await page.click('#pu-return-target [data-return-create]');
        assert.equal(await page.$eval('#pu-return-prep-select',el=>el.value),'__new__');
        assert.equal(await page.$eval('#pu-return-target [data-return-confirm]',el=>el.disabled),false);
        if(groupCount===1)await page.screenshot({path:path.join(output,`ready-return-new-group-${width}.png`)});
        await page.click('#pu-return-target [data-return-confirm]');
        await page.waitForFunction(()=>!!window.returnChoiceResult);
        assert.equal(await page.evaluate(()=>returnChoiceResult.joinExisting),false);
        assert.ok(await page.evaluate(()=>!!returnChoiceResult.prepRef));
      }
      await page.click('#pw-work [data-return-mode="pending"]');
      await page.waitForFunction(()=>qs('#pu-cfdlg').style.display==='flex');
      assert.match(await page.$eval('#pu-cfdlg-msg',el=>el.textContent),/أكواد القطع الممسوحة/);
      await page.evaluate(()=>_puCfdlgResolve(false));
      await page.waitForFunction(()=>!qs('#pw-work [data-return-mode="pending"]').disabled);
      assert.deepEqual(await page.evaluate(()=>writes),[],'Cancelling either return does not modify orders');
      await page.evaluate(()=>{closePuCardOrdersModal();_puPrepGroups=_puPrepGroups.filter(group=>group.prepRef!=='SECOND-PREP');});
      await page.evaluate(()=>{currentLang='en';document.documentElement.dir='ltr';document.body.classList.add('dark-mode');renderPickupBoard();});
      for(const selector of Object.values(stageSelectors)){
        assert.equal(await page.$eval(selector,el=>el.scrollWidth<=el.clientWidth+1),true,'English dark card fits');
      }
      await page.screenshot({path:path.join(output,`group-board-dark-${width}.png`)});
      await page.evaluate(()=>{
        currentLang='ar';document.documentElement.dir='rtl';document.body.classList.remove('dark-mode');
        _pickupOrders=cardPreviewSaved.orders; _puPrepGroups=cardPreviewSaved.groups;
        currentUser={...currentUser,role:'staff'}; delete window.cardPreviewSaved;
        puSwitchView('board'); renderPickupBoard();
      });
      const consistentReady = await page.evaluate(() => {
        const saved = _pickupOrders;
        _pickupOrders = Array.from({ length: 30 }, (_, i) => ({ ...saved[0], _id: 'count-' + i,
          pickupRef: '105-22OCT', pickupDate: '2026-10-23', bostaStatus: 'CREATED',
          total: i === 29 ? 1450 : i === 0 ? 52848 : 0,
          bostaOrderId: i === 29 ? '' : 'count-bosta-' + i, bostaTrackingNumber: '',
          shipmentEvents: i === 29 ? [] : [{ type: 'sent', at: i === 0 ? '2026-10-22T08:00:00Z' : '2026-10-23T08:00:00Z' }],
        }));
        puSwitchView('board'); renderPickupBoard();
        const boardCount = _puBuildGroups(_pickupOrders)[0].orders.length;
        const boardVisible = !!qs('#pu-ready-col [data-group-key="105-22OCT"]');
        puSwitchView('table'); renderPickupRuns();
        const rows = qsa('#pu-runs-body>.pu-run-row');
        rows[0].click();
        const result = { boardCount, boardVisible, rows: rows.length, ref: rows[0]?.dataset.runRef,
          count: rows[0]?.cells[5].textContent.trim(), total: rows[0]?.cells[6].textContent.trim(),
          cards: qsa('#pu-runs-body .pu-daily-order').length,
          edit: !!qs('#pu-runs-body button[onclick*="openPuEditModal"]'),
          returnToPrep: !!qs('#pu-runs-body button[onclick*="puGroupUndoReadyToPrep"]') };
        _puExpandedRunRef = null;
        _pickupOrders = saved; puSwitchView('board'); renderPickupBoard();
        return result;
      });
      assert.equal(consistentReady.boardCount, 30); assert.equal(consistentReady.boardVisible, true);
      assert.equal(consistentReady.rows, 1); assert.equal(consistentReady.ref, '105-22OCT');
      assert.match(consistentReady.count, /30/); assert.equal(consistentReady.total, '', 'Staff cannot see the run total');
      assert.equal(consistentReady.cards, 30); assert.equal(consistentReady.edit, true); assert.equal(consistentReady.returnToPrep, true);
      await page.evaluate(() => { _pickupOrders.find(o => o._id === 'a').bostaStatus = 'CREATED'; puSwitchView('board'); renderPickupBoard(); });
      await settle();
      const groups = await page.$$eval('#pu-shipped-col .pu-daily-group', rows => rows.map(row => ({ key: row.dataset.dailyGroup, text: row.textContent })));
      assert.equal(groups.length, 1, 'Only courier-collected orders appear under Shipped');
      const group = groups.find(row => row.key.includes('2026-10-21'));
      assert.match(group.text, /2 أوردر/); assert.match(group.text, /1\/2/);
      assert.match(group.text, /تم إرسال طلب الاستلام لبوسطة/); assert.match(group.text, /قيد التأكيد/);
      assert.equal(await page.$eval('#pu-shipped-count', el => el.textContent.trim()), '1');
      assert.equal(await page.$eval('#pu-ready-count', el => el.textContent.trim()), '3');
      const readySelector = '#pu-ready-col .pu-group[data-group-key="OLD-a"]';
      assert.equal(await page.$$eval(`${readySelector} button[onclick*="puGroupUndoReadyToPrep"]`, rows => rows.length), 1);
      await page.click(`${readySelector} button[onclick*="puGroupUndoReadyToPrep"]`);
      await page.waitForFunction(() => _puReturnGroupBusy && qs('#pu-cfdlg').style.display === 'flex');
      assert.equal(await page.$eval(`${readySelector} button[onclick*="puGroupUndoReadyToPrep"]`, el => el.disabled), true);
      const returnMessage = await page.$eval('#pu-cfdlg-msg', el => el.textContent);
      assert.match(returnMessage, /OLD-a/); assert.match(returnMessage, /Piece identity/);
      await page.screenshot({ path: path.join(output, `return-confirm-${width}.png`) });
      await page.evaluate(() => { puGroupUndoReadyToPrep('OLD-a'); _puCfdlgResolve(false); });
      await page.waitForFunction(() => !_puReturnGroupBusy);
      assert.equal(await page.$eval(`${readySelector} button[onclick*="puGroupUndoReadyToPrep"]`, el => el.disabled), false);
      assert.deepEqual(await page.evaluate(() => writes), []);
      await page.click(`${readySelector} button[onclick*="openPuEditModal"]`);
      await page.waitForFunction(() => _puEditCurrentRun?.pickupRef === 'OLD-a');
      assert.equal(await page.evaluate(() => _puEditAvailableRuns.some(run => run.pickupRef === 'OLD-d')), true);
      const editorLayout = await page.evaluate(() => {
        const dateInput=qs('#pu-edit-date-val');
        dateInput.value='2026-10-24';dateInput.dispatchEvent(new Event('change',{bubbles:true}));
        const shell=qs('#pu-edit-modal .pu-edit-shell'), row=qs('#pu-edit-current-list .pu-edit-order');
        const fits=el=>el.scrollWidth<=el.clientWidth+1;
        return {fits:fits(shell)&&fits(row),direction:getComputedStyle(row).direction,expected:document.documentElement.dir,
          date:qs('#pu-edit-date-preview time')?.dateTime};
      });
      assert.equal(editorLayout.fits,true,'Run editor and order rows fit the viewport');
      assert.equal(editorLayout.direction,editorLayout.expected,'Editor follows page reading direction');
      assert.equal(editorLayout.date,'2026-10-24','Date preview follows the date control without saving');
      await page.click('#pu-edit-current-list [data-pu-select-id]');
      assert.equal(await page.$eval('#pu-edit-date-val',input=>input.value),'2026-10-24','Selecting transfer orders preserves the edited date');
      assert.equal(await page.$eval('#pu-edit-target-list button',button=>button.disabled),false,'Selecting an order enables transfer');
      await page.screenshot({path:path.join(output,`edit-run-${width}.png`)});
      await page.evaluate(() => closePuEditModal());
      await page.$eval(`#pu-shipped-col [data-daily-group="${group.key}"]`, el => el.scrollIntoView({ block: 'center', inline: 'center' }));
      await page.screenshot({ path: path.join(output, `board-${width}.png`) });
      await page.click(`#pu-shipped-col [data-daily-group="${group.key}"]`); await settle();
      assert.equal(await page.$$eval('#modal-content .pu-daily-order', rows => rows.length), 2);
      assert.equal(await page.$eval('#modal-content', el => el.textContent.includes('بانتظار استلام شركة الشحن')), false);
      assert.equal(await page.$eval('#modal-content [data-daily-order="c"] .is-delivered', el => getComputedStyle(el).color), 'rgb(21, 128, 61)');
      await page.screenshot({ path: path.join(output, `shipped-${width}.png`) });
      const modal = await page.$eval('#modal-content', el => ({ text: el.textContent, count: el.querySelectorAll('.pu-daily-order').length, overflow: el.scrollWidth > el.clientWidth + 1 }));
      assert.equal(modal.count, 2); assert.equal(modal.overflow, false);
      const bostaLink = await page.$eval('#modal-content [data-daily-order="b"] .pu-daily-bosta', el => ({ href: el.href, target: el.target, label: el.textContent }));
      assert.equal(bostaLink.href, 'https://business.bosta.co/orders/B-291b');
      assert.equal(bostaLink.target, '_blank'); assert.match(bostaLink.label, /Open in Bosta/);
      await page.evaluate(()=>{
        window.awbPreviewMocks={fetch:_awbFetchBytes,load:_awbLoadPdfJs,print:printBostaAwb};
        window.awbPreviewPrints=[];window.awbPreviewFetches=0;
        _awbFetchBytes=async()=>{awbPreviewFetches++;return new Uint8Array([37,80,68,70]);};
        _awbLoadPdfJs=async()=>({getDocument:()=>({promise:Promise.resolve({numPages:2,destroy:async()=>{},
          getPage:async n=>({getViewport:()=>({width:420,height:594}),render:({canvasContext})=>{
            canvasContext.fillStyle='#fff';canvasContext.fillRect(0,0,420,594);canvasContext.fillStyle='#111';
            canvasContext.font='bold 30px sans-serif';canvasContext.fillText('BOSTA TEST LABEL',25,60);
            canvasContext.font='20px sans-serif';canvasContext.fillText('Order #2914 - Page '+n,25,100);
            return {promise:Promise.resolve()};
          }}),
        })})});
        printBostaAwb=async id=>{awbPreviewPrints.push(id);return false;};
      });
      await page.click('#modal-content [data-daily-order="b"] [data-daily-awb]');
      await page.waitForFunction(()=>qs('#awb-preview')?.querySelectorAll('canvas').length===2&&qs('#awb-preview .awb-preview-pages').getAttribute('aria-busy')==='false');
      assert.equal(await page.$eval('#awb-preview',el=>Number(getComputedStyle(el).zIndex)>Number(getComputedStyle(qs('#modal-overlay')).zIndex)),true);
      assert.equal(await page.$eval('#awb-preview [data-awb-download]',el=>el.href.startsWith('blob:')&&!el.hidden),true);
      assert.deepEqual(await page.evaluate(()=>awbPreviewPrints),[],'Preview does not print or record a print');
      assert.equal(await page.$eval('#awb-preview>section',el=>el.scrollWidth<=el.clientWidth+1),true,'Preview fits mobile and desktop');
      await page.screenshot({path:path.join(output,`label-preview-${width}.png`)});
      const zoom=await page.evaluate(()=>{
        const canvas=qs('#awb-preview canvas'),before=canvas.getBoundingClientRect().width;
        const input=qs('#awb-preview input');input.value='160';input.dispatchEvent(new Event('input',{bubbles:true}));
        return {before,after:canvas.getBoundingClientRect().width};
      });
      assert.ok(zoom.after>zoom.before,'Label zoom works');
      await page.keyboard.press('Escape');
      assert.equal(await page.$('#awb-preview'),null);
      assert.equal(await page.$eval('#modal-overlay',el=>el.classList.contains('active')),true,'Closing preview keeps group open');
      assert.equal(await page.evaluate(()=>document.activeElement.hasAttribute('data-daily-awb')),true,'Focus returns to the preview button');
      await page.evaluate(()=>{
        const fetchLabel=_awbFetchBytes;let fail=true;
        _awbFetchBytes=async(...args)=>{if(fail){fail=false;throw new Error('Temporary label error');}return fetchLabel(...args);};
      });
      await page.click('#modal-content [data-daily-order="b"] [data-daily-awb]');
      await page.waitForSelector('#awb-preview [role="alert"]');
      assert.match(await page.$eval('#awb-preview [role="alert"]',el=>el.textContent),/Temporary label error/);
      await page.click('#awb-preview .awb-preview-pages button');
      await page.waitForFunction(()=>!qs('#awb-preview [data-awb-print]')?.disabled);
      await page.click('#awb-preview [data-awb-print]');
      assert.deepEqual(await page.evaluate(()=>awbPreviewPrints),['b']);
      assert.equal(await page.$('#awb-preview'),null);
      await page.evaluate(()=>{
        _awbFetchBytes=awbPreviewMocks.fetch;_awbLoadPdfJs=awbPreviewMocks.load;printBostaAwb=awbPreviewMocks.print;
        delete window.awbPreviewMocks;
      });
      assert.ok(modal.text.includes('قيد النقل'));
      assert.equal(await page.$eval('.pu-daily-dialog-head .pu-daily-count>bdi', el => el.textContent), '2');
      await page.screenshot({ path: path.join(output, `orders-${width}.png`) });
      await page.click('#modal-content [data-daily-order="b"] [data-daily-invoice]');
      await page.waitForSelector('#inv-detail-overlay.active.inv-over-modal'); await settle();
      assert.equal(await page.evaluate(() => Number(getComputedStyle(qs('#inv-detail-overlay')).zIndex) > Number(getComputedStyle(qs('#modal-overlay')).zIndex)), true);
      assert.equal(await page.$eval('#modal-overlay', el => el.classList.contains('active')), true);
      await page.screenshot({ path: path.join(output, `invoice-front-${width}.png`) });
      await page.keyboard.press('Escape');
      assert.equal(await page.$eval('#inv-detail-overlay', el => el.classList.contains('active')), false);
      assert.equal(await page.$eval('#modal-overlay', el => el.classList.contains('active')), true);
      await page.evaluate(() => {
        qs('#modal-content [data-daily-order="b"] details').open = true;
        _puPaintCurrentView();
      });
      assert.equal(await page.$eval('#modal-content [data-daily-order="b"] details', el => el.open), true);
      await assertStableRefresh(page, '#modal-content [data-daily-dialog]');
      await page.evaluate(() => { _pickupOrders.find(o => o._id === 'a').bostaStatus = 'PICKED_UP'; _puPaintCurrentView(); });
      assert.equal(await page.$eval('#modal-overlay', el => el.classList.contains('active')), true);
      assert.equal(await page.$$eval('#pu-ready-col .pu-group[data-group-key="OLD-a"]', rows => rows.length), 0);
      await page.evaluate(key => openPuDailyShippingGroup(key, 'shipped'), group.key);
      assert.equal(await page.$$eval('#modal-content .pu-daily-order', rows => rows.length), 3);
      assert.match(await page.$eval('#modal-content [data-daily-order="a"]', el => el.textContent), /استلمتها شركة الشحن/);
      await page.evaluate(() => { closeModal(); puSwitchView('table'); renderPickupRuns(); }); await settle();
      await page.evaluate(() => { currentLang = 'en'; document.documentElement.dir = 'ltr'; renderPickupRuns(); });
      const row = await page.$(`[data-run-ref="${group.key}"]`);
      assert.ok(row, 'Table uses the same daily identity as the board');
      const columns = await row.evaluate(el => {
        const dateCell = el.cells[2], companyCell = el.cells[3];
        const dateText = dateCell.querySelector('.pu-daily-date').getBoundingClientRect();
        const cell = dateCell.getBoundingClientRect();
        return { date: dateCell.textContent, carrier: companyCell.textContent, count: el.cells[5].textContent,
          dateContained: dateText.left >= cell.left && dateText.right <= cell.right,
          carrierAfterDate: companyCell.getBoundingClientRect().left >= cell.right - 1 };
      });
      assert.match(columns.date, /Wednesday/); assert.match(columns.date, /21\/10\/2026/);
      assert.match(columns.count, /3 orders/); assert.equal(columns.carrier, 'Bosta');
      assert.equal(columns.dateContained, true); assert.equal(columns.carrierAfterDate, true);
      await page.screenshot({path:path.join(output,`runs-table-${width}.png`)});
      await page.evaluate(key => {
        const header = qsa('#pu-runs-body>.pu-run-row').find(el => el.dataset.runRef === key);
        const id = header.id.replace('run-header-', '');
        if (qs('#' + id).style.display === 'none') toggleRunExpand(id);
      }, group.key);
      assert.equal(await page.$$eval('#pu-runs-body .pu-detail-row', rows => rows.filter(row => row.style.display !== 'none')[0].querySelectorAll('.pu-daily-order').length), 3);
      await assertStableRefresh(page, '#pu-runs-body', true);
      await page.screenshot({ path: path.join(output, `table-${width}.png`) });
      const filters = await page.evaluate(() => {
        const input = qs('#pu-board-search'), from = qs('#pu-board-date-from'), to = qs('#pu-board-date-to');
        const runCount = () => qsa('#pu-runs-body>.pu-run-row').length;
        const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
        const bars = qsa('#page-pickup-orders .pu-filter-bar').length;
        const retired = ['pu-search', 'pu-filter-date-from', 'pu-filter-date-to', 'pu-filter-shipco', 'pu-ready-tbl-search', 'pu-ready-tbl-shipco'].some(id => !!qs('#' + id));
        input.value = 'Lobna'; fire(input, 'input');
        const tableSearch = runCount();
        input.value = 'no-such-order'; fire(input, 'input');
        const empty = runCount();
        qs('#pu-board-filters-row .pu-filter-clear').click();
        const cleared = runCount();
        from.value = '2026-10-21'; to.value = '2026-10-21'; fire(from, 'change');
        const dateMatches = runCount();
        puSwitchView('board');
        const boardDate = qsa('#pu-shipped-col .pu-daily-group').length;
        puSwitchView('table');
        const keptDate = runCount();
        clearPickupFilters();
        const other = { ..._pickupOrders[0], _id: 'other-carrier', ref: 'OTHER', shipCo: 'Other carrier', bostaOrderId: '', bostaTrackingNumber: '', shipmentEvents: [], pickupStatus: 'Ready', pickupRef: 'OTHER-READY' };
        _pickupOrders.push(other); _puPopulateShipCoFilter();
        qs('#pu-board-shipco').value = 'Other carrier'; fire(qs('#pu-board-shipco'), 'change');
        const carrierMatches = runCount();
        puSwitchView('ready');
        const readyCarrier = qs('#pu-ready-tbl-body').textContent.includes('OTHER');
        input.value = 'no-such-order'; fire(input, 'input');
        const readySearchCleared = !qs('#pu-ready-tbl-body').textContent.includes('OTHER');
        clearBoardFilters();
        const readyRestored = qs('#pu-ready-tbl-body').textContent.includes('OTHER');
        _pickupOrders = _pickupOrders.filter(o => o._id !== 'other-carrier');
        puSwitchView('table');
        return { bars, retired, tableSearch, empty, cleared, dateMatches, boardDate, keptDate, carrierMatches, readyCarrier, readySearchCleared, readyRestored };
      });
      assert.equal(filters.bars, 1); assert.equal(filters.retired, false);
      assert.equal(filters.tableSearch, 1); assert.equal(filters.empty, 0); assert.equal(filters.cleared, 3);
      assert.equal(filters.dateMatches, 1); assert.equal(filters.boardDate, 1); assert.equal(filters.keptDate, 1);
      assert.equal(filters.carrierMatches, 1); assert.equal(filters.readyCarrier, true);
      assert.equal(filters.readySearchCleared, true); assert.equal(filters.readyRestored, true);
      assert.equal(await page.$eval('#pu-board-filters-row', el => el.scrollWidth <= el.clientWidth + 1), true, 'Shared filter bar fits viewport');
      await page.evaluate(() => { currentLang = 'ar'; document.documentElement.dir = 'rtl'; });
    }
    assert.deepEqual(await page.evaluate(() => writes), []);
    assert.equal(await page.evaluate(() => _pickupOrders.find(o => o._id === 'a').pickupStatus), 'Ready');
    console.log('PASS: daily groups, pickup coverage, mobile/desktop cards, stable table/modal refresh, live updates, focus, expanded products and scroll. Screenshots: artifacts/pickup-refresh-stability.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
