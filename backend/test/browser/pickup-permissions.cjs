/* Pick-Up Orders page visibility and read-only controls; all API writes mocked. */
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const puppeteer = require('puppeteer');
const root = path.resolve(__dirname, '../../..'), publicDir = path.join(root, 'frontend/public');
(async () => {
  const browser = await puppeteer.launch({ headless: true, pipe: true });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', request => {
      const url = new URL(request.url());
      const file = path.resolve(publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (url.origin === 'http://soulia.test' && file.startsWith(publicDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return request.respond({ contentType: ({ '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webp':'image/webp' })[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
      }
      if (request.resourceType() === 'script') return request.respond({ contentType:'text/javascript', body:'window.Chart=class{static register(){} destroy(){}};window.XLSX={utils:{}};window.io=()=>({on(){},emit(){},disconnect(){}});' });
      return request.respond({ contentType:'application/json', body:'[]' });
    });
    await page.goto('http://soulia.test/', { waitUntil:'domcontentloaded' });
    await page.evaluate(() => {
      currentLang = 'en'; document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr';
      qs('#app').style.display = ''; qs('#login-page').style.display = 'none'; qs('#splash-screen')?.remove();
      onPageEnter = () => {}; window.pickupWrites = [];
      api = async (url, options = {}) => {
        if (options.method && options.method !== 'GET') pickupWrites.push(url);
        return ['/transactions/pickup-orders', '/transactions/pickup-orders/workspace'].includes(url)
          ? structuredClone(_pickupOrders) : [];
      };
      currentUser = { _id:'operator', role:'staff', perms:['movements','inventory-units-view','inventory-units-allocate'] };
      const base = { type:'مبيعات', client:'Preview Customer', phone:'01000000000', total:500, remaining:0, date:'2026-10-29', createdAt:'2026-10-29T08:00:00Z', shipCo:'Bosta', items:[{name:'Cotton basket', code:'SKU-1', qty:1, price:500, lineId:'line-1'}] };
      _pickupOrders = [
        {...base, _id:'pending', ref:'3201', pickupStatus:'Pending'},
        {...base, _id:'prep', ref:'3202', pickupStatus:'Preparing', pickupRef:'PREP-TEST', prepRef:'PREP-TEST', prepCreatedAt:'2026-10-29T08:00:00Z', prepChecked:false},
        {...base, _id:'ready', ref:'3203', pickupStatus:'Ready', pickupRef:'READY-TEST', bostaOrderId:'b-ready', bostaStatus:'CREATED', shipmentEvents:[{type:'sent',at:'2026-10-29T08:00:00Z'}]},
      ];
      transactions = _pickupOrders.map(row => ({...row})); _puOrdersLoaded = true;
      _puLoadPrepGroups(_pickupOrders); _bpSetRequests([]);
    });
    const hidden = await page.evaluate(() => {
      currentPage = 'movements'; buildSidebar(); navigateTo('pickup-orders');
      return { allowed:_canAccessPage('pickup-orders'), page:currentPage, link:!!document.querySelector('[data-page="pickup-orders"]') };
    });
    assert.equal(hidden.allowed, false); assert.equal(hidden.page, 'movements'); assert.equal(hidden.link, false);
    await page.evaluate(() => {
      currentUser.perms.push('pickup-orders'); buildSidebar(); navigateTo('pickup-orders'); puSwitchView('board');
    });
    for (const width of [1440,390]) {
      await page.setViewport({width,height:950});
      const readOnly = await page.evaluate(async () => {
        _puPaintCurrentView();
        const page = qs('#page-pickup-orders');
        const actions = [...page.querySelectorAll('[data-pu-edit]')];
        const result = {
          allowed:_canAccessPage('pickup-orders'), readonly:!_puCanEdit(),
          actionsHidden:actions.length > 0 && actions.every(el=>getComputedStyle(el).display==='none'),
          draggable:page.querySelectorAll('[draggable="true"]').length,
          filter:!qs('#pu-pending-search')?.disabled, refresh:!qs('#pu-refresh-btn').disabled,
        };
        const group = _puPrepGroups[0];
        if (!group) throw Error('Missing preparation fixture');
        openPuCardOrdersModal(group.prepRef,'prep');
        result.details = !!qs('#pw-work').textContent.trim();
        result.scanTools = !!qs('#pw-work .pw-barcode-tools');
        await openPrepGroupModal(); await puCardSave('prep'); await puBoardDrop();
        await _puReturnReadyOrder('ready','pending'); await submitBostaPickup();
        result.writes = pickupWrites.length;
        closePuCardOrdersModal();
        return result;
      });
      assert(readOnly.allowed && readOnly.readonly && readOnly.actionsHidden && readOnly.filter && readOnly.refresh && readOnly.details,JSON.stringify(readOnly));
      assert.equal(readOnly.draggable,0); assert.equal(readOnly.scanTools,false); assert.equal(readOnly.writes,0);
      const output = path.join(root,'artifacts/pickup-permissions'); fs.mkdirSync(output,{recursive:true});
      await page.evaluate(() => document.querySelectorAll('.toast').forEach(el => el.remove()));
      await page.screenshot({path:path.join(output,'read-only-'+width+'.png')});
      console.log('PASS read-only page, detail viewing, filters and denied writes:',width);
    }
    // Split permissions (Nov 24, 2026): «prepare» only, then «move» only.
    const base = ['movements','inventory-units-view','inventory-units-allocate','pickup-orders'];
    const prepOnly = await page.evaluate(async base => {
      currentUser.perms = [...base, 'pickup-orders-prepare']; buildSidebar(); puSwitchView('board'); _puPaintCurrentView();
      pickupWrites.length = 0; document.querySelectorAll('.toast').forEach(el => el.remove());
      const page = qs('#page-pickup-orders');
      const moveBtns = [...document.querySelectorAll('[data-pu-edit="move"]')].filter(el => el.getClientRects().length);
      const r = {
        readonly: document.body.classList.contains('pu-readonly'),
        classes: ['prepare','move','cancel','bosta','bosta-cancel'].filter(a => document.body.classList.contains('pu-no-' + a)),
        moveDimmed: moveBtns.length > 0 && moveBtns.every(el => getComputedStyle(el).opacity < 0.6),
        draggable: page.querySelectorAll('[draggable="true"]').length,
      };
      await openPrepGroupModal(); await pucoRemoveFromPrep('prep'); await puBoardDrop({preventDefault(){}}, 'pending'); await pwSendToBosta('prep');
      r.blockedWrites = pickupWrites.length;
      r.toast = [...document.querySelectorAll('.toast')].map(el => el.textContent).join(' | ');
      openPuCardOrdersModal('PREP-TEST', 'prep');
      r.scanTools = !!qs('#pw-work .pw-barcode-tools');
      r.offer = await Promise.race([_bsfMaybeOffer(_pickupOrders.find(o => o._id === 'prep')).then(() => 'none'), new Promise(res => setTimeout(() => res('dialog'), 400))]);
      closePuCardOrdersModal();
      await Promise.resolve(_puPersistPrepCheck('prep', true)).catch(() => {}); // the mock answers [] — only the request matters
      r.prepWrite = pickupWrites.length;
      return r;
    }, base);
    assert.equal(prepOnly.readonly, false, 'prepare-only is not read-only');
    assert.deepEqual(prepOnly.classes, ['move','cancel','bosta','bosta-cancel']);
    assert(prepOnly.moveDimmed, 'move buttons stay visible but dimmed');
    assert.equal(prepOnly.draggable, 0, 'cards cannot be dragged without «move»');
    assert.equal(prepOnly.blockedWrites, 0, 'move / cancel / Bosta refused before any request');
    assert(/move cards/.test(prepOnly.toast) && /cancel cards/.test(prepOnly.toast) && /Bosta shipping/.test(prepOnly.toast), prepOnly.toast);
    assert.equal(prepOnly.scanTools, true, 'scanning is available with «prepare»');
    assert.equal(prepOnly.offer, 'none', 'no «send to Bosta» offer without the Bosta permission');
    assert(prepOnly.prepWrite >= 1, 'the preparation tick is saved');
    console.log('PASS prepare-only: dimmed actions, refusals named, scanning and tick allowed.');

    const moveOnly = await page.evaluate(async base => {
      currentUser.perms = [...base, 'pickup-orders-move']; buildSidebar(); puSwitchView('board'); _puPaintCurrentView();
      pickupWrites.length = 0; document.querySelectorAll('.toast').forEach(el => el.remove());
      const r = { draggable: qs('#page-pickup-orders').querySelectorAll('[draggable="true"]').length };
      await pucoRemoveFromPrep('prep'); await Promise.resolve(_puPersistPrepCheck('prep', true)).catch(() => {});
      r.blockedWrites = pickupWrites.length;
      r.toast = [...document.querySelectorAll('.toast')].map(el => el.textContent).join(' | ');
      openPuCardOrdersModal('PREP-TEST', 'prep');
      r.scanTools = !!qs('#pw-work .pw-barcode-tools');
      closePuCardOrdersModal();
      return r;
    }, base);
    assert(moveOnly.draggable > 0, 'cards can be dragged with «move»');
    assert.equal(moveOnly.blockedWrites, 0, 'cancel / prepare refused for move-only');
    assert(/cancel cards/.test(moveOnly.toast) && /prepare orders/.test(moveOnly.toast), moveOnly.toast);
    assert.equal(moveOnly.scanTools, false, 'no scanning without «prepare»');
    console.log('PASS move-only: drag allowed, cancel and preparation refused.');
    await page.evaluate(base => { currentUser.perms = [...base]; }, base);

    const editor = await page.evaluate(() => {
      currentUser.perms.push('pickup-orders-edit'); buildSidebar(); puSwitchView('board');
      return {allowed:_puCanEdit(),readonlyClass:document.body.classList.contains('pu-readonly'),draggable:qs('#page-pickup-orders').querySelectorAll('[draggable="true"]').length};
    });
    assert(editor.allowed && !editor.readonlyClass && editor.draggable > 0,JSON.stringify(editor));
    await page.evaluate(() => openPrepGroupModal());
    await page.waitForFunction(() => qs('#pu-prep-modal')?.classList.contains('active'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'pu-prep-modal-search');
    assert.equal(await page.$eval('#pu-prep-modal-list', el => el.textContent.includes('3201')), true);
    await page.evaluate(() => {
      closePrepGroupModal();
      openPuCardOrdersModal('PREP-TEST', 'prep');
      closePuCardOrdersModal();
      openPuCardOrdersModal('PREP-TEST', 'prep');
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(await page.$eval('#pu-card-orders-modal', el => el.classList.contains('active') && el.style.display !== 'none'), true);
    console.log('PASS hidden page and editable page permission states.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });

